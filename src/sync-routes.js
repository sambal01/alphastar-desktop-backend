"use strict";

const STAFF_ROLES = new Set(["admin", "staff", "doctor", "nurse", "receptionist"]);
const STAFF_PATHS = Object.freeze(["users", "patientProfiles", "staff", "appointments", "appointmentServices", "queueEntries", "medicalRecords", "notifications", "services", "schedules", "clinicSettings", "inventory", "stockTransactions", "auditLogs", "humanChats"]);
const PATIENT_PATHS = Object.freeze(["users", "patientProfiles", "appointments", "appointmentServices", "queueEntries", "medicalRecords", "notifications", "payments"]);

class SyncError extends Error {
  constructor(message, status = 503, code = "SYNC_UNAVAILABLE") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const normalize = (value) => String(value || "").trim().toLowerCase();
const inactive = (record) => Boolean(record?.disabled || record?.deletedAt || record?.active === false || [record?.status, record?.accountStatus].some((value) => ["disabled", "blocked", "inactive", "suspended", "deleted"].includes(normalize(value))));

function accountRole(user, staff, audience) {
  if (!user || typeof user !== "object" || inactive(user) || inactive(staff)) throw new SyncError("This account is inactive or no longer registered.", 403, "SYNC_FORBIDDEN");
  // Saved roles take precedence over token claims, which may outlive a role change.
  const role = normalize(user.role || user.accountRole || staff?.accountRole || staff?.role);
  if ((audience === "staff" && !STAFF_ROLES.has(role)) || (audience === "patient" && role !== "patient")) throw new SyncError("This account cannot access this data connection.", 403, "SYNC_FORBIDDEN");
  return role;
}

function registerSyncRoutes(app, options) {
  const getDatabase = options.getDatabase || require("firebase-admin/database").getDatabase;
  const getAuth = options.getAuth || require("firebase-admin/auth").getAuth;
  const now = options.now || Date.now;
  const debounceMs = options.debounceMs ?? 100;
  const heartbeatMs = options.heartbeatMs ?? 25000;
  const revalidateMs = options.revalidateMs ?? 60000;
  const timeoutMs = options.timeoutMs ?? 15000;

  async function context(req, audience) {
    const token = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) throw new SyncError("Sign in to receive live updates.", 401, "SYNC_UNAUTHENTICATED");
    const firebaseApp = options.getFirebaseApp();
    if (!firebaseApp) throw new SyncError("Live updates are temporarily unavailable.");
    let decoded;
    try { decoded = await getAuth(firebaseApp).verifyIdToken(token, true); }
    catch { throw new SyncError("Your session expired. Sign in again.", 401, "SYNC_UNAUTHENTICATED"); }
    if (!decoded.uid || /[.#$\[\]/]/.test(decoded.uid) || !Number.isFinite(decoded.exp) || now() >= decoded.exp * 1000) throw new SyncError("Your session expired. Sign in again.", 401, "SYNC_UNAUTHENTICATED");
    if (options.assertAuthenticatorAccess) {
      try { await options.assertAuthenticatorAccess(decoded); }
      catch (cause) { throw new SyncError("Sign in again to verify your account security.", cause.status === 401 ? 401 : 503, cause.status === 401 ? "SYNC_UNAUTHENTICATED" : "SYNC_UNAVAILABLE"); }
    }
    const database = getDatabase(firebaseApp);
    const [userSnap, staffSnap] = await Promise.all([database.ref(`users/${decoded.uid}`).get(), database.ref(`staff/${decoded.uid}`).get()]);
    const user = userSnap.val();
    const staff = staffSnap.val();
    return { database, decoded, user, staff, role: accountRole(user, staff, audience) };
  }

  for (const audience of ["staff", "patient"]) {
    app.get(`/api/${audience}/sync/stream`, async (req, res) => {
      let disconnect = () => {};
      try {
        const access = await context(req, audience);
        if (req.aborted || res.destroyed) return;
        const { database, decoded, role } = access;
        const paths = audience === "staff" ? STAFF_PATHS.filter((path) => (path !== "auditLogs" || role === "admin") && (path !== "humanChats" || ["admin", "staff"].includes(role))) : [...PATIENT_PATHS];
        const pending = new Set();
        const ready = new Set();
        const subscriptions = [];
        let ended = false;
        let blocked = false;
        let checking = false;
        let user = access.user;
        let staff = access.staff;
        let debounce;
        let heartbeat;
        let revalidate;
        let expiry;
        let stall;
        let initial;

        const cleanup = () => {
          if (ended) return;
          ended = true;
          [debounce, expiry, stall, initial].forEach(clearTimeout);
          [heartbeat, revalidate].forEach(clearInterval);
          pending.clear();
          for (const { ref, listener } of subscriptions) ref.off("value", listener);
          res.off("drain", drain);
          res.off("close", cleanup);
          res.off("error", cleanup);
          req.off("aborted", cleanup);
        };
        disconnect = cleanup;
        const fail = (error) => {
          if (ended) return;
          if (!blocked && !res.destroyed) {
            try { res.write(`event: error\ndata: ${JSON.stringify({ code: error.code || "SYNC_UNAVAILABLE", error: error instanceof SyncError ? error.message : "Live updates were interrupted. Reconnecting may help." })}\n\n`); }
            catch { /* The transport is already closed. */ }
          }
          const destroy = blocked;
          cleanup();
          if (destroy) res.destroy();
          else res.end();
        };
        const write = (frame) => {
          if (ended || blocked) return false;
          try {
            if (res.write(frame) === false) {
              blocked = true;
              // Stop writing until drain; the pending set is bounded by the path list.
              stall = setTimeout(() => fail(new SyncError("The live connection is too slow. Reconnecting may help.")), timeoutMs);
            }
            return true;
          } catch (error) { fail(error); return false; }
        };
        const publish = () => {
          debounce = undefined;
          if (ended || blocked || ready.size !== paths.length || !pending.size) return;
          const changed = paths.filter((path) => pending.has(path));
          if (write(`event: change\ndata: ${JSON.stringify({ paths: changed })}\n\n`)) changed.forEach((path) => pending.delete(path));
        };
        function drain() {
          blocked = false;
          clearTimeout(stall);
          publish();
        }
        const checkSavedAccess = () => {
          if (accountRole(user, staff, audience) !== role) throw new SyncError("Account permissions changed. Reconnecting with updated access.", 403, "SYNC_FORBIDDEN");
        };
        res.on("close", cleanup);
        res.on("error", cleanup);
        req.on("aborted", cleanup);
        res.on("drain", drain);
        res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        if (!write("retry: 3000\n\n")) return;
        initial = setTimeout(() => fail(new SyncError("Live data could not be loaded. Reconnecting may help.")), timeoutMs);
        for (const path of paths) {
          if (ended) break;
          const ref = audience === "staff" ? database.ref(path) : ["users", "patientProfiles"].includes(path) ? database.ref(`${path}/${decoded.uid}`) : database.ref(path).orderByChild("userId").equalTo(decoded.uid);
          let chatFingerprint;
          const listener = (snapshot) => {
            if (ended) return;
            try {
              if (path === "users") user = audience === "staff" ? snapshot.child(decoded.uid).val() : snapshot.val();
              if (path === "staff") staff = snapshot.child(decoded.uid).val();
              checkSavedAccess();
              if (path === "humanChats") {
                // Only inbox/unread changes invalidate the badge. Heartbeats,
                // drafts/typing and outbox cleanup must not trigger extra reads.
                const fingerprint = JSON.stringify(Object.values(snapshot.val() || {}).filter(row => row.provider === "alphastar" && (row.requestedAt || row.visitorSequence > 0)).map(row => [row.id, row.visitorSequence || 0, row.status, row._readBy?.[decoded.uid] || 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
                if (ready.has(path) && fingerprint === chatFingerprint) return;
                chatFingerprint = fingerprint;
              }
              pending.add(path);
              ready.add(path);
              if (ready.size === paths.length) {
                clearTimeout(initial);
                if (!debounce) debounce = setTimeout(publish, debounceMs);
              }
            } catch (error) { fail(error); }
          };
          subscriptions.push({ ref, listener });
          ref.on("value", listener, (error) => fail(error));
        }
        if (ended) return;
        expiry = setTimeout(() => fail(new SyncError("Your session expired. Reconnecting with your renewed session.", 401, "SYNC_UNAUTHENTICATED")), Math.max(0, decoded.exp * 1000 - now()));
        heartbeat = setInterval(() => {
          if (!blocked) write(`event: heartbeat\ndata: ${JSON.stringify({ serverNow: new Date(now()).toISOString() })}\n\n`);
        }, heartbeatMs);
        revalidate = setInterval(async () => {
          if (ended || checking) return;
          checking = true;
          try {
            const renewed = await context(req, audience);
            if (!ended && renewed.role !== role) throw new SyncError("Account permissions changed. Reconnecting with updated access.", 403, "SYNC_FORBIDDEN");
          } catch (error) { fail(error); }
          finally { checking = false; }
        }, revalidateMs);
      } catch (error) {
        disconnect();
        if (res.headersSent) { res.end(); return; }
        res.set("Cache-Control", "no-store");
        res.status(error instanceof SyncError ? error.status : 503).json({ ok: false, code: error instanceof SyncError ? error.code : "SYNC_UNAVAILABLE", error: error instanceof SyncError ? error.message : "Live updates are temporarily unavailable." });
      }
    });
  }
}

module.exports = { registerSyncRoutes, __test: { accountRole, STAFF_PATHS, PATIENT_PATHS } };
