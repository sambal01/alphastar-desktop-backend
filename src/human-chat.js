"use strict";

const crypto = require("node:crypto");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const { registerNativeChatRoutes, readNativeChat } = require("./native-chat");
const PROPERTY_ID = "69c333b43508461c3360e229";
const idFor = (property, chat) => crypto.createHash("sha256").update(`${property}:${chat}`).digest("hex");
const clean = (value, max = 255) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "";
const messageText = value => clean(value, 4000)
  .replace(/\b(password|pin|otp|verification code|authenticator code|setup key|recovery code|access token)\s*(?:is\b|:|=)\s*\S+/gi, "$1: [removed]")
  .replace(/\b\d{6}\b|\b[a-f0-9]{8}(?:-[a-f0-9]{8}){3}\b|otpauth:\/\/\S+/gi, "[removed]");
const timestamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";

function verifySignature(raw, signature, secret) {
  if (!secret || !Buffer.isBuffer(raw) || !/^[a-f0-9]{40}$/i.test(signature || "")) return false;
  const expected = crypto.createHmac("sha1", secret).update(raw).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function normalizeEvent(body, propertyId) {
  if (!body || typeof body !== "object" || body.property?.id !== propertyId) throw Object.assign(Error("Unknown chat property."), { status: 403 });
  if (!["chat:start", "chat:end", "chat:transcript_created", "ticket:create"].includes(body.event)) throw Object.assign(Error("Unsupported chat event."), { status: 400 });
  const chatId = clean(body.chat?.id || body.chatId || body.ticket?.id, 180), at = timestamp(body.time);
  if (!chatId || !at) throw Object.assign(Error("Invalid chat event."), { status: 400 });
  const visitor = body.chat?.visitor || body.visitor || body.requester || {};
  const email = clean(visitor.email).toLowerCase();
  const messages = body.event === "chat:transcript_created" ? body.chat?.messages : body.event === "chat:start" ? [{ time: at, msg: body.message?.text, sender: { t: body.message?.sender?.type === "agent" ? "a" : "v" } }] : body.event === "ticket:create" ? [{ time: at, msg: body.ticket?.message, sender: { t: "v" } }] : [];
  if (!Array.isArray(messages) || messages.length > 5000) throw Object.assign(Error("Invalid chat transcript."), { status: 400 });
  return { id: idFor(propertyId, chatId), chatId, propertyId, event: body.event, at,
    visitorName: clean(visitor.name) || "Website visitor", visitorEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
    source: /^(?:www\.)?alphastarkasiglahan\.com$|^alpha-star-clinic-mobile\.web\.app$/i.test(clean(body.domain)) ? "website" : "tawk",
    messages: messages.filter(row => row?.type == null || row.type === "msg").map(row => {
      const text = messageText(row.msg), time = timestamp(row.time) || at, sender = ({ a: "staff", v: "visitor", s: "system" })[row.sender?.t] || "system";
      return { id: idFor(chatId, `${time}:${sender}:${text}`), text, time, sender, name: sender === "staff" ? clean(row.sender?.n) || "Clinic staff" : "" };
    }).filter(row => row.text) };
}

function applyEvent(root, event) {
  root.humanChats ||= {};
  root.humanChatMessages ||= {};
  root.notifications ||= {};
  const previous = root.humanChats[event.id] || {};
  const messages = new Map((root.humanChatMessages[event.id] || previous.messages || []).map(row => [row.id, row]));
  event.messages.forEach(row => messages.set(row.id, row));
  const ordered = [...messages.values()].sort((a, b) => a.time.localeCompare(b.time));
  const newer = !previous.updatedAt || event.at > previous.updatedAt || event.at === previous.updatedAt && event.event !== "chat:start";
  const status = event.event === "chat:start" ? "active" : event.event === "ticket:create" ? "offline" : "ended";
  const row = { ...previous, id: event.id, provider: "tawk", chatId: event.chatId, propertyId: event.propertyId,
    visitorName: newer ? event.visitorName : previous.visitorName, visitorEmail: newer ? event.visitorEmail : previous.visitorEmail,
    source: newer ? event.source : previous.source, status: newer ? status : previous.status,
    createdAt: previous.createdAt && previous.createdAt < event.at ? previous.createdAt : event.at,
    updatedAt: newer ? event.at : previous.updatedAt, lastMessage: ordered.at(-1)?.text || previous.lastMessage || "",
    ...(event.event === "chat:transcript_created" ? { transcriptSaved: true } : {}) };
  root.humanChats[event.id] = row;
  delete row.messages;
  root.humanChatMessages[event.id] = ordered;
  if (event.event === "chat:start" || event.event === "ticket:create") {
    const noticeId = `human_chat_${event.id}`;
    if (!root.notifications[noticeId]) root.notifications[noticeId] = { id: noticeId, userId: "desktop-staff", type: "human_chat", targetRole: "staff", targetRoles: ["admin", "staff"],
      title: "Human chat request", message: "A visitor is waiting for clinic staff in Human Chat.", referenceType: "humanChats", referenceId: event.id,
      source: event.source, createdAt: event.at, timestamp: event.at, isRead: false, read: false };
  }
  return row;
}

function registerHumanChatRoutes(app, options) {
  const getDatabase = options.getDatabase || require("firebase-admin/database").getDatabase;
  const propertyId = String(options.propertyId || process.env.TAWK_PROPERTY_ID || PROPERTY_ID).trim();
  const secret = String(options.webhookSecret ?? process.env.TAWK_WEBHOOK_SECRET ?? "").trim();
  const identityKey = String(options.identityKey ?? process.env.TAWK_API_KEY ?? "").trim();
  const receiverConfigured = process.env.TAWK_WEBHOOK_RECEIVER_CONFIGURED === "true";
  const guestLimits = new Map();
  const database = () => { const instance = options.getFirebaseApp(); if (!instance) throw Error("Unavailable"); return getDatabase(instance); };
  const failure = (res, cause) => res.status(cause.status || 503).json({ ok: false, error: cause.status ? cause.message : "Human Chat is temporarily unavailable." });
  app.post("/api/support/guest-identity", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!identityKey) return res.status(503).json({ ok: false, error: "Staff chat is not configured yet. Please use the clinic contact links." });
    const name = clean(req.body?.name, 100), email = clean(req.body?.email, 255).toLowerCase();
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || req.body?.consent !== true) return res.status(400).json({ ok: false, error: "Enter your name and email, then agree to share them for staff chat." });
    const now = Date.now();
    for (const [key, row] of guestLimits) if (row.until <= now) guestLimits.delete(key);
    // Never accept a caller-selected userId: guest emails cannot access patient chat history.
    const key = crypto.createHash("sha256").update(String(req.ip || req.socket?.remoteAddress || "unknown")).digest("hex");
    const limit = guestLimits.get(key) || { count: 0, until: now + 60000 };
    if (limit.count >= 30 || guestLimits.size >= 2000) return res.status(429).json({ ok: false, error: "Please wait a minute before opening another staff chat." });
    limit.count++; guestLimits.set(key, limit);
    const userId = `website_guest_${crypto.randomBytes(24).toString("hex")}`;
    return res.json({ ok: true, userId, name, email, hash: crypto.createHmac("sha256", identityKey).update(userId).digest("hex") });
  });
  app.post("/api/support/tawk/webhook", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!secret) return res.status(503).json({ ok: false, error: "The chat webhook is not configured." });
    if (!verifySignature(req.rawBody, req.headers["x-tawk-signature"], secret)) return res.status(401).json({ ok: false, error: "Invalid chat signature." });
    try {
      const event = normalizeEvent(req.body, propertyId);
      await transactionWithLiveSnapshot(database().ref(), current => {
        const root = structuredClone(current || {}); applyEvent(root, event); return root;
      });
      return res.json({ ok: true });
    } catch (cause) { return failure(res, cause); }
  });
  const staffRoute = handler => async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.staffAccess?.actor?.uid) return res.status(403).json({ ok: false, error: "Clinic staff access required." });
    try { return await handler(req, res); } catch (cause) { return failure(res, cause); }
  };
  app.get("/api/staff/human-chats", staffRoute(async (_req, res) => {
    const snapshot = await database().ref("humanChats").orderByChild("updatedAt").limitToLast(50).get();
    const conversations = Object.values(snapshot.val() || {}).map(({ messages, ...summary }) => summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return res.json({ ok: true, conversations, configured: true });
  }));
  app.get("/api/staff/human-chats/:id", staffRoute(async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.id || "")) return res.status(400).json({ ok: false, error: "Invalid chat reference." });
    const db = database();
    const conversation = (await db.ref(`humanChats/${req.params.id}`).get()).val();
    if (!conversation) return res.status(404).json({ ok: false, error: "This conversation is no longer available." });
    if (conversation.provider === "alphastar") return res.json({ ok: true, conversation: await readNativeChat(db, req.params.id, req.query?.before) });
    const messages = (await db.ref(`humanChatMessages/${req.params.id}`).get()).val() || [];
    return res.json({ ok: true, conversation: { ...conversation, messages } });
  }));
  registerNativeChatRoutes(app, options);
}

module.exports = { registerHumanChatRoutes, verifySignature, normalizeEvent, applyEvent };
