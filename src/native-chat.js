"use strict";

const crypto = require("node:crypto");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const { createPatientAuthenticatorAccess } = require("./patient-authenticator-access");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const clean = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "";
const problem = (status, message) => Object.assign(Error(message), { status });
const validId = value => /^[a-f0-9]{64}$/.test(value || "");
const noSecrets = value => value.replace(/\b(password|pin|otp|verification code|authenticator code|setup key|recovery code|access token)\s*(?:is\b|:|=)\s*\S+/gi, "$1: [removed]").replace(/otpauth:\/\/\S+/gi, "[removed]");

async function readNativeChat(db, id, before = "") {
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
  return { ...summary, messages, before: rows.length > 100 ? `${first.time}|${first.id}` : "" };
}

function registerNativeChatRoutes(app, options) {
  const getDatabase = options.getDatabase || require("firebase-admin/database").getDatabase;
  const getAuth = options.getAuth || require("firebase-admin/auth").getAuth;
  const patientAccess = createPatientAuthenticatorAccess({ getFirebaseApp: options.getFirebaseApp, getAuth, getDatabase });
  const now = options.now || (() => Date.now());
  const limits = new Map();
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
    if (!req.staffAccess?.actor?.uid) throw problem(403, "Clinic staff access required.");
    return req.staffAccess.actor;
  }
  async function access(req, db, kind) {
    const id = checkId(req), record = (await db.ref(`nativeChatAccess/${id}`).get()).val();
    if (!record) throw problem(404, "Conversation not found.");
    if (kind === "patient") {
      const { actor } = await patient(req, db);
      if (record.kind !== "patient" || record.uid !== actor.uid) throw problem(404, "Conversation not found.");
    } else {
      const token = req.headers["x-alphastar-chat-token"];
      if (record.kind !== "guest" || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !validId(record.tokenHash) || record.expiresAt <= now() || !crypto.timingSafeEqual(Buffer.from(hash(token), "hex"), Buffer.from(record.tokenHash, "hex"))) throw problem(401, "This chat session expired. Open a new staff chat.");
    }
    return record;
  }
  async function send(db, id, actor, body) {
    if (typeof body?.text !== "string" || !clean(body.text, 2000) || body.text.length > 2000 || !/^[a-f0-9-]{20,80}$/i.test(body.clientId || "")) throw problem(400, "Enter a message of up to 2,000 characters.");
    rate(`message:${actor.key}`, 30);
    const messageId = hash(`${id}:${actor.key}:${body.clientId}`);
    const ref = db.ref(`nativeChatMessages/${id}/${messageId}`);
    const result = await transactionWithLiveSnapshot(ref, current => current || { id: messageId, sender: actor.sender, name: actor.name, text: noSecrets(clean(body.text, 2000)), time: new Date(now()).toISOString() });
    const message = result.snapshot.val();
    if (message.text !== noSecrets(clean(body.text, 2000)) || message.sender !== actor.sender) throw problem(409, "That message reference was already used. Try a new message.");
    const summaryRef = db.ref(`humanChats/${id}`);
    await transactionWithLiveSnapshot(summaryRef, current => {
      if (!current || current.provider !== "alphastar") return;
      return current.updatedAt > message.time ? current : { ...current, status: "active", lastMessage: message.text, updatedAt: message.time };
    });
    const record = (await db.ref(`nativeChatAccess/${id}`).get()).val();
    const staffNotice = actor.sender !== "staff";
    if (staffNotice || record.kind === "patient") {
      const noticeId = `native_chat_${id}_${messageId}`;
      await transactionWithLiveSnapshot(db.ref(`notifications/${noticeId}`), current => current || {
        id: noticeId, userId: staffNotice ? "desktop-staff" : record.uid,
        ...(staffNotice ? { targetRole: "staff", targetRoles: ["admin", "staff"] } : {}),
        type: "human_chat", title: staffNotice ? "New staff chat message" : "Clinic staff replied",
        message: staffNotice ? "A visitor sent a message in Human Chat." : "Open Chat with Us to read your staff message.",
        referenceType: "humanChats", referenceId: id, source: record.kind === "patient" ? "mobile" : "website",
        createdAt: message.time, timestamp: message.time, isRead: false, read: false,
      });
    }
    return message;
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
    return res.json({ ok: true, id, token, expiresAt: now() + 24 * 3600000, conversation: await readNativeChat(db, id) });
  }));
  app.post("/api/patient-support/chats/open", route(async (req, res) => {
    const db = database(), { actor, row } = await patient(req, db);
    rate(`patient-open:${actor.uid}`, 30);
    const id = hash(`alphastar:patient:${actor.uid}`), at = new Date(now()).toISOString();
    const profile = (await db.ref(`patientProfiles/${actor.uid}`).get()).val() || {};
    await transactionWithLiveSnapshot(db.ref(`nativeChatAccess/${id}`), current => current || { kind: "patient", uid: actor.uid });
    await transactionWithLiveSnapshot(db.ref(`humanChats/${id}`), current => current || { id, provider: "alphastar", visitorName: clean(profile.fullName || row.fullName || row.name || "Patient", 100), visitorEmail: clean(actor.email || row.email || "", 255), source: "mobile", status: "active", createdAt: at, updatedAt: at, lastMessage: "" });
    return res.json({ ok: true, id, conversation: await readNativeChat(db, id) });
  }));
  for (const [prefix, kind] of [["/api/support/chats", "guest"], ["/api/patient-support/chats", "patient"]]) {
    app.get(prefix + "/:id", route(async (req, res) => {
      const db = database(); await access(req, db, kind);
      return res.json({ ok: true, conversation: await readNativeChat(db, req.params.id, req.query?.before) });
    }));
    app.post(prefix + "/:id/messages", route(async (req, res) => {
      const db = database(), record = await access(req, db, kind), id = req.params.id;
      const message = await send(db, id, { key: kind === "patient" ? record.uid : id, sender: "visitor", name: "", }, req.body);
      return res.json({ ok: true, message });
    }));
  }
  app.post("/api/staff/human-chats/:id/messages", route(async (req, res) => {
    const actor = staff(req), id = checkId(req), db = database();
    const summary = (await db.ref(`humanChats/${id}`).get()).val();
    if (summary?.provider !== "alphastar") throw problem(409, "This is a legacy Tawk conversation. Start a new Alphastar chat to reply here.");
    const message = await send(db, id, { key: actor.uid, sender: "staff", name: "Clinic staff" }, req.body);
    return res.json({ ok: true, message });
  }));
}
module.exports = { registerNativeChatRoutes, readNativeChat };
