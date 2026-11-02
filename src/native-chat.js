"use strict";

const crypto = require("node:crypto");
const { createChatLifecycle, publicSummary } = require("./native-chat-lifecycle");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const { createPatientAuthenticatorAccess } = require("./patient-authenticator-access");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clean = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "";
const problem = (status, message) => Object.assign(Error(message), { status });
const validId = value => /^[a-f0-9]{64}$/.test(value || "");
const noSecrets = value => value.replace(/\b(password|pin|otp|verification code|authenticator code|setup key|recovery code|access token)\s*(?:is\b|:|=)\s*\S+/gi, "$1: [removed]").replace(/otpauth:\/\/\S+/gi, "[removed]");

async function readNativeChat(db, id, before = "", actor, at = Date.now()) {
  const summary = (await db.ref(`humanChats/${id}`).get()).val();
  if (!summary || summary.provider !== "alphastar") throw problem(404, "Conversation not found.");
  let query = db.ref(`nativeChatMessages/${id}`).orderByChild("time");
  if (before) {
    const [time, key] = String(before).split("|");
    if (!Number.isFinite(Date.parse(time)) || !/^[a-f0-9]{64}$/.test(key || "")) throw problem(400, "Invalid message page.");
    query = query.endBefore(time, key);
  }
  const rows = Object.values((await query.limitToLast(101).get()).val() || {}).sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  const messages = rows.slice(-100), first = messages[0];
  return { ...publicSummary(summary, actor, at), messages, before: rows.length > 100 ? `${first.time}|${first.id}` : "" };
}

function registerNativeChatRoutes(app, options) {
  const getDatabase = options.getDatabase || require("firebase-admin/database").getDatabase;
  const getAuth = options.getAuth || require("firebase-admin/auth").getAuth;
  const patientAccess = createPatientAuthenticatorAccess({ getFirebaseApp: options.getFirebaseApp, getAuth, getDatabase });
  const now = options.now || (() => Date.now());
  const limits = new Map();
  const lifecycle = createChatLifecycle(now);
  async function conversation(db, id, before, actor) {
    await lifecycle.prepare(db, id);
    return readNativeChat(db, id, before, actor, now());
  }
  const database = () => { const instance = options.getFirebaseApp(); if (!instance) throw problem(503, "Staff chat is temporarily unavailable."); return getDatabase(instance); };
  const route = handler => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { return await handler(req, res); }
    catch (cause) { return res.status(cause.status || 503).json({ ok: false, error: cause.status ? cause.message : "Unable to connect to staff chat. Please retry." }); }
  };
  function rate(key, max) {
    const at = now();
    for (const [id, row] of limits) if (row.until <= at) limits.delete(id);
    const row = limits.get(key) || { count: 0, until: at + 60000 };
    if (row.count >= max || limits.size >= 10000) throw problem(429, "Please wait a minute before trying again.");
    row.count++; limits.set(key, row);
  }
  const checkId = req => { if (!validId(req.params.id)) throw problem(400, "Invalid conversation."); return req.params.id; };
  async function patient(req, db) {
    const token = String(req.headers.authorization || "").match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw problem(401, "Sign in to chat with staff.");
    let actor;
    try { actor = await getAuth(options.getFirebaseApp()).verifyIdToken(token, true); }
    catch { throw problem(401, "Your sign-in expired. Please sign in again."); }
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(actor.uid || "")) throw problem(401, "Sign in again.");
    const row = (await db.ref(`users/${actor.uid}`).get()).val();
    if (row?.role !== "patient" || row.active === false || row.disabled || row.deleted || [row.accountStatus, row.status].some(value => ["inactive", "disabled", "deleted"].includes(value))) throw problem(403, "Patient access required.");
    await patientAccess.assertAccess(actor);
    return { actor, row };
  }
  function staff(req) {
    if (!req.staffAccess?.actor?.uid || !["admin", "staff"].includes(req.staffAccess.actor.role)) throw problem(403, "Clinic staff access required.");
    return req.staffAccess.actor;
  }
  async function access(req, db, kind) {
    const id = checkId(req), record = (await db.ref(`nativeChatAccess/${id}`).get()).val();
    if (!record) throw problem(404, "Conversation not found.");
    if (kind === "patient") {
      const { actor } = await patient(req, db);
      if (record.kind !== "patient" || record.uid !== actor.uid) throw problem(404, "Conversation not found.");
    } else {
      const token = req.headers["x-alphastar-chat-token"] || (req.allowExitToken ? req.body?.token : "");
      if (record.kind !== "guest" || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !validId(record.tokenHash) || record.expiresAt <= now() || !crypto.timingSafeEqual(Buffer.from(hash(token), "hex"), Buffer.from(record.tokenHash, "hex"))) throw problem(401, "This chat session expired. Open a new staff chat.");
    }
    return record;
  }
  async function send(db, id, actor, body) {
    if (typeof body?.text !== "string" || !clean(body.text, 2000) || body.text.length > 2000 || !/^[a-f0-9-]{20,80}$/i.test(body.clientId || "")) throw problem(400, "Enter a message of up to 2,000 characters.");
    rate(`message:${actor.key}`, 30);
    const text = noSecrets(clean(body.text, 2000));
    if (body.cycle === undefined) {
      // Earlier shipped senders have no cycle field. Preserve first-session
      // chat only; never reopen an ended thread or post into a later cycle.
      const priorId = hash(`${id}:${actor.key}:${body.clientId}`);
      const prior = (await db.ref(`nativeChatMessages/${id}/${priorId}`).get()).val();
      if (prior) {
        if (prior.text !== text || prior.sender !== actor.sender) throw problem(409, "That message reference was already used.");
        return prior;
      }
      const row = await lifecycle.prepare(db, id);
      if (row.cycle !== 1) throw problem(426, "Update Alphastar to continue this conversation.");
      if (actor.sender === "visitor" && row.status === "welcome") await lifecycle.request(db, id, { cycle: 1 }, false, true);
      if (actor.sender === "staff" && row.status === "waiting") await lifecycle.connect(db, id, { uid: actor.key, role: actor.role }, { cycle: 1, identity: "anonymous" }, "Support assistant");
      body = { ...body, cycle: 1 };
    }
    return lifecycle.send(db, id, actor, { ...body, text });
  }
  app.post("/api/support/chats", route(async (req, res) => {
    rate(`open:${hash(String(req.ip || req.socket?.remoteAddress || "unknown"))}`, 10);
    const name = clean(req.body?.name, 100), email = clean(req.body?.email, 255).toLowerCase();
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || req.body?.consent !== true) throw problem(400, "Enter your name and email and agree to staff chat.");
    const db = database(), id = crypto.randomBytes(32).toString("hex"), token = crypto.randomBytes(32).toString("hex"), at = new Date(now()).toISOString();
    await db.ref().update({
      [`nativeChatAccess/${id}`]: { kind: "guest", tokenHash: hash(token), expiresAt: now() + 24 * 3600000 },
      [`humanChats/${id}`]: { id, provider: "alphastar", visitorName: name, visitorEmail: email, source: "website", status: "active", createdAt: at, updatedAt: at, lastMessage: "" },
    });
    return res.json({ ok: true, id, token, expiresAt: now() + 24 * 3600000, conversation: await conversation(db, id) });
  }));
  app.post("/api/patient-support/chats/open", route(async (req, res) => {
    const db = database(), { actor, row } = await patient(req, db);
    rate(`patient-open:${actor.uid}`, 30);
    const id = hash(`alphastar:patient:${actor.uid}`), at = new Date(now()).toISOString();
    const profile = (await db.ref(`patientProfiles/${actor.uid}`).get()).val() || {};
    await transactionWithLiveSnapshot(db.ref(`nativeChatAccess/${id}`), current => current || { kind: "patient", uid: actor.uid });
    await transactionWithLiveSnapshot(db.ref(`humanChats/${id}`), current => current || { id, provider: "alphastar", visitorName: clean(profile.fullName || row.fullName || row.name || "Patient", 100), visitorEmail: clean(actor.email || row.email || "", 255), source: "mobile", _patientUid: actor.uid, status: "active", createdAt: at, updatedAt: at, lastMessage: "" });
    await transactionWithLiveSnapshot(db.ref(`humanChats/${id}`), current => ({ ...current, _patientUid: actor.uid }));
    return res.json({ ok: true, id, conversation: await conversation(db, id) });
  }));
  for (const [prefix, kind] of [["/api/support/chats", "guest"], ["/api/patient-support/chats", "patient"]]) {
    app.get(prefix + "/:id", route(async (req, res) => {
      const db = database(); await access(req, db, kind);
      if (kind === "guest") {
        const row = await lifecycle.prepare(db, req.params.id);
        await lifecycle.heartbeat(db, req.params.id, { cycle: row.cycle });
      }
      return res.json({ ok: true, conversation: await conversation(db, req.params.id, req.query?.before) });
    }));
    app.post(prefix + "/:id/request", route(async (req, res) => {
      const db = database(); await access(req, db, kind);
      rate(`request:${req.params.id}`, 10);
      await lifecycle.request(db, req.params.id, req.body, kind === "patient");
      return res.json({ ok: true, conversation: await conversation(db, req.params.id) });
    }));
    app.post(prefix + "/:id/end", route(async (req, res) => {
      const db = database(); await access(req, db, kind);
      await lifecycle.finish(db, req.params.id, req.body);
      return res.json({ ok: true, conversation: await conversation(db, req.params.id) });
    }));
    app.post(prefix + "/:id/messages", route(async (req, res) => {
      const db = database(), record = await access(req, db, kind), id = req.params.id;
      const message = await send(db, id, { key: kind === "patient" ? record.uid : id, sender: "visitor", name: "", }, req.body);
      return res.json({ ok: true, message });
    }));
    app.post(prefix + "/:id/typing", route(async (req, res) => {
      const db = database(), record = await access(req, db, kind), id = req.params.id;
      rate(`typing:visitor:${id}`, 90);
      await lifecycle.typing(db, id, { key: kind === "patient" ? record.uid : id, sender: "visitor" }, req.body);
      return res.json({ ok: true });
    }));
  }
  app.post("/api/support/chats/:id/heartbeat", route(async (req, res) => {
    const db = database(); await access(req, db, "guest");
    await lifecycle.heartbeat(db, req.params.id, req.body);
    return res.json({ ok: true });
  }));
  app.post("/api/support/chats/:id/exit", route(async (req, res) => {
    if (typeof req.body === "string") { try { req.body = JSON.parse(req.body); } catch { throw problem(400, "Invalid exit request."); } }
    if (!req.body && req[Symbol.asyncIterator]) {
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw problem(400, "Invalid exit request."); }
      try { req.body = JSON.parse(raw); } catch { throw problem(400, "Invalid exit request."); }
    }
    req.allowExitToken = true;
    const db = database(); await access(req, db, "guest");
    await lifecycle.finish(db, req.params.id, req.body, null, "exit");
    return res.json({ ok: true });
  }));
  app.post("/api/staff/human-chats/:id/connect", route(async (req, res) => {
    const actor = staff(req), id = checkId(req), db = database();
    const [staffSnapshot, userSnapshot] = await Promise.all([db.ref(`staff/${actor.uid}`).get(), db.ref(`users/${actor.uid}`).get()]);
    const profile = staffSnapshot.val() || {}, user = userSnapshot.val() || {};
    const name = [profile.fullName, profile.name, profile.displayName, [profile.firstName, profile.lastName].filter(Boolean).join(" "), user.fullName, user.name, user.displayName, [user.firstName, user.lastName].filter(Boolean).join(" ")]
      .map(value => clean(value, 120).replace(/[<>]/g, "").replace(/\s+/g, " ").trim()).find(value => value && !value.includes("@")) || "Support assistant";
    await lifecycle.connect(db, id, actor, req.body, name);
    return res.json({ ok: true, conversation: await conversation(db, id, "", actor) });
  }));
  app.post("/api/staff/human-chats/:id/read", route(async (req, res) => {
    const actor = staff(req), id = checkId(req), db = database();
    await lifecycle.markRead(db, id, actor, req.body?.sequence);
    return res.json({ ok: true });
  }));
  app.post("/api/staff/human-chats/:id/typing", route(async (req, res) => {
    const actor = staff(req), id = checkId(req), db = database();
    rate(`typing:staff:${actor.uid}`, 90);
    await lifecycle.typing(db, id, { key: actor.uid, sender: "staff" }, req.body);
    return res.json({ ok: true });
  }));
  app.post("/api/staff/human-chats/:id/end", route(async (req, res) => {
    const actor = staff(req), id = checkId(req), db = database();
    await lifecycle.finish(db, id, req.body, actor);
    return res.json({ ok: true, conversation: await conversation(db, id, "", actor) });
  }));
  app.post("/api/staff/human-chats/:id/messages", route(async (req, res) => {
    const actor = staff(req), id = checkId(req), db = database();
    const message = await send(db, id, { key: actor.uid, sender: "staff", role: actor.role }, req.body);
    return res.json({ ok: true, message });
  }));
  return { conversation, summary: async (db, row, actor) => row.provider === "alphastar" ? publicSummary(await lifecycle.prepare(db, row.id, row), actor, now()) : row };
}
module.exports = { registerNativeChatRoutes, readNativeChat };
