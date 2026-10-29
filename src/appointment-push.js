"use strict";
const crypto = require("node:crypto");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const keyFor = value => crypto.createHash("sha256").update(value).digest("hex");
const validToken = token => typeof token === "string" && /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{8,200}\]$/.test(token);
const owner = row => row?.userId || row?.patientUserId || row?.patientId;
const approved = new Set(["approved", "confirmed", "scheduled"]);
function queuePush(root, notice, recordId, kind, now) {
  if (!notice.userId || notice.userId === "desktop-staff") return;
  root.pushOutbox ||= {};
  root.pushOutbox[notice.id] ||= { id: notice.id, userId: notice.userId, recordId, kind,
    scheduledAt: root.appointments?.[recordId]?.scheduledAt || "", createdAt: now, expiresAt: now + 24 * 3600000, deliveries: {} };
}
function currentJob(root, job, now) {
  const row = root.appointments?.[job.recordId];
  if (job.cancelled || !row || row.deleted || row.deletedAt || owner(row) !== job.userId || now >= job.expiresAt) return false;
  const status = String(row.status || row.appointmentStatus || "").toLowerCase();
  if (job.kind === "cancelled") return ["cancelled", "canceled"].includes(status);
  if (row.scheduledAt !== job.scheduledAt) return false;
  if (job.kind === "reminder") return (approved.has(status) || status === "on_the_way") && now < Date.parse(row.scheduledAt);
  if (job.kind === "on_the_way") return status === "on_the_way";
  return approved.has(status) || status === "on_the_way";
}
function registerDevice(root, uid, input, now) {
  if (!validToken(input.token) || typeof input.enabled !== "boolean") throw Object.assign(Error("Provide a valid push token and permission state."), { status: 400, code: "PUSH_DEVICE_INVALID" });
  root.patientPushDevices ||= {};
  const key = keyFor(input.token), previous = root.patientPushDevices[key];
  if (!input.enabled) {
    if (previous?.userId === uid && (!input.bindingId || previous.bindingId === input.bindingId)) delete root.patientPushDevices[key];
  } else root.patientPushDevices[key] = { token: input.token, bindingId: String(input.bindingId || "").slice(0, 160), userId: uid, enabled: true, updatedAt: now };
  return { ok: true };
}

function createPushDispatcher({ database, now = Date.now, fetchImpl = fetch, baseUrl = "https://exp.host/--/api/v2/push", accessToken = process.env.EXPO_ACCESS_TOKEN }) {
  let running = false;
  async function change(apply) {
    let result;
    await transactionWithLiveSnapshot(database.ref(), current => {
      const root = structuredClone(current || {}); result = apply(root); return root;
    });
    return result;
  }
  async function request(path, body) {
    const response = await fetchImpl(baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error("PUSH_PROVIDER_UNAVAILABLE");
    return response.json();
  }
  return { async dispatch() {
    if (running) return; running = true;
    try {
      const snapshot = (await database.ref().get()).val() || {};
      const devices = Object.entries(snapshot.patientPushDevices || {}).filter(([, device]) => device.enabled);
      const ready = delivery => !["sent", "failed"].includes(delivery?.state) && !(delivery?.leaseUntil > now()) && !(delivery?.retryAt > now());
      // Bound pending work, not the final database keys: completed history must
      // never starve a new notification whose hash sorts before old jobs.
      const jobs = Object.entries(snapshot.pushOutbox || {}).filter(([id, job]) =>
        snapshot.notifications?.[id] && currentJob(snapshot, job, now()) &&
        devices.some(([key, device]) => device.userId === job.userId && ready(job.deliveries?.[key])))
        .sort((a, b) => a[1].createdAt - b[1].createdAt).slice(0, 200);
      for (const [id, job] of jobs) {
        for (const [deviceKey, device] of Object.entries(snapshot.patientPushDevices || {})) {
          if (!device.enabled || device.userId !== job.userId) continue;
          const delivery = job.deliveries?.[deviceKey];
          if (delivery?.state === "sent" || delivery?.state === "failed" || delivery?.leaseUntil > now() || delivery?.retryAt > now()) continue;
          const claimId = crypto.randomUUID();
          const claim = await change(root => {
            const live = root.pushOutbox?.[id], token = root.patientPushDevices?.[deviceKey];
            if (!live || !currentJob(root, live, now())) { if (live) live.cancelled = true; return null; }
            if (!token?.enabled || token.userId !== live.userId) return null;
            const last = live.deliveries?.[deviceKey];
            if (["sent", "failed"].includes(last?.state) || last?.leaseUntil > now() || last?.retryAt > now()) return null;
            live.deliveries ||= {};
            live.deliveries[deviceKey] = { state: "sending", claimId, leaseUntil: now() + 60000, attempts: Number(last?.attempts || 0) + 1 };
            return { notice: root.notifications[id], job: live, token: token.token };
          });
          if (!claim?.notice) continue;
          let ticket;
          try {
            // Recheck after claiming; cancellation/rescheduling invalidates queued work.
            const liveRoot = (await database.ref().get()).val() || {};
            if (!currentJob(liveRoot, claim.job, now()) || !liveRoot.patientPushDevices?.[deviceKey]?.enabled || liveRoot.patientPushDevices[deviceKey].userId !== claim.job.userId) continue;
            const ttl = claim.job.kind === "reminder" ? Math.max(1, Math.min(3600, Math.floor((Date.parse(claim.job.scheduledAt) - now()) / 1000))) : 3600;
            const displayTag = keyFor(id);
            const result = await request("/send", { to: claim.token, title: claim.notice.title, body: claim.notice.message, sound: "default", channelId: "appointments", priority: "high", ttl, data: { notificationId: id, userId: claim.job.userId, referenceId: claim.job.recordId }, collapseId: displayTag, tag: displayTag });
            ticket = Array.isArray(result.data) ? result.data[0] : result.data;
            if (!ticket || !["ok", "error"].includes(ticket.status)) throw Error("PUSH_PROVIDER_INVALID_RESPONSE");
          } catch { ticket = { status: "retry" }; }
          await change(root => {
            const state = root.pushOutbox?.[id]?.deliveries?.[deviceKey];
            if (state?.claimId !== claimId) return;
            delete state.leaseUntil;
            state.state = ticket.status === "ok" ? "sent" : ticket.status === "retry" || ticket.details?.error === "MessageRateExceeded" ? "pending" : "failed";
            if (state.state === "pending") state.retryAt = now() + Math.min(3600000, 30000 * 2 ** Math.min(state.attempts, 6));
            if (ticket.id) { state.ticketId = ticket.id; state.sentAt = now(); }
            if (ticket.details?.error === "DeviceNotRegistered" && root.patientPushDevices?.[deviceKey]?.userId === claim.job.userId) root.patientPushDevices[deviceKey].enabled = false;
          });
        }
      }
      // Provider receipts acknowledge delivery to FCM/APNs, not display on a phone.
      const latest = (await database.ref().get()).val() || {};
      const pending = Object.entries(latest.pushOutbox || {}).flatMap(([id, job]) => Object.entries(job.deliveries || {}).filter(([, delivery]) => delivery.ticketId && !delivery.receiptChecked && now() - delivery.sentAt >= 900000).map(([deviceKey, delivery]) => ({ id, deviceKey, ticketId: delivery.ticketId, userId: job.userId }))).slice(0, 100);
      if (pending.length) {
        const result = await request("/getReceipts", { ids: pending.map(item => item.ticketId) });
        await change(root => {
          for (const item of pending) {
            const receipt = result.data?.[item.ticketId], delivery = root.pushOutbox?.[item.id]?.deliveries?.[item.deviceKey];
            if (!receipt || !delivery || delivery.ticketId !== item.ticketId) continue;
            delivery.receiptChecked = true; delivery.receiptStatus = receipt.status;
            if (receipt.details?.error === "DeviceNotRegistered" && root.patientPushDevices?.[item.deviceKey]?.userId === item.userId) root.patientPushDevices[item.deviceKey].enabled = false;
          }
        });
      }
    } finally { running = false; }
  } };
}
module.exports = { queuePush, currentJob, registerDevice, createPushDispatcher, validToken };
