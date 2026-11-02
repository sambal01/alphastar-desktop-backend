"use strict";
const crypto = require("node:crypto");
const { transactionWithLiveSnapshot: transact } = require("./realtime-transaction");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (status, message) => { throw Object.assign(Error(message), { status }); };
const WELCOME = "Hello! 👋 Welcome to AlphaStar Clinic Support. Would you like to connect with a support assistant for help with your appointment, clinic services, account, or another concern?";
const ACK = "Thank you! 😊 We’ve received your request. Please wait while an AlphaStar Clinic support assistant reviews your message. We’ll respond as soon as possible. During busy periods, replies may take 24 hours or longer.";
const LEASE_MS = 90000;
const publicKeys = ["id", "provider", "visitorName", "visitorEmail", "source", "status", "createdAt", "updatedAt", "lastMessage", "requestedAt", "connectedAt", "endedAt", "connectedName", "connectedRole", "cycle", "visitorSequence"];
function publicSummary(row, actor) {
  const result = Object.fromEntries(publicKeys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
  if (actor) {
    result.canConnect = row.status === "waiting";
    result.canReply = row.status === "connected" && row._connection?.uid === actor.uid;
    result.canEnd = ["waiting", "connected"].includes(row.status) && (actor.role === "admin" || row._connection?.uid === actor.uid);
    result.unread = (row.visitorSequence || 0) > (row._readBy?.[actor.uid] || 0);
    if (row._feedback?.[row.cycle]) result.feedback = row._feedback[row.cycle];
  }
  return result;
}
function createChatLifecycle(now = () => Date.now()) {
  function stamp(row) {
    const milliseconds = Math.max(now(), (row._lastEventAtMs || Date.parse(row.updatedAt) || 0) + 1);
    row._lastEventAtMs = milliseconds;
    row.updatedAt = new Date(milliseconds).toISOString();
    return row.updatedAt;
  }
  function notice(row, message, staff) {
    return { id: `native_chat_${row.id}_${message.id}`, userId: staff ? "desktop-staff" : row._patientUid,
      ...(staff ? { targetRole: "staff", targetRoles: ["admin", "staff"] } : {}),
      type: "human_chat", title: staff ? "Human chat request" : "Clinic support update",
      message: staff ? "Open Human Chat to read the new support message." : "Open Chat with Us to read your support message.",
      referenceType: "humanChats", referenceId: row.id, source: row.source,
      createdAt: message.time, timestamp: message.time, isRead: false, read: false };
  }
  function enqueue(row, key, sender, text, identity = {}, notify) {
    const id = hash(`${row.id}:${row.cycle}:${key}`), time = stamp(row);
    const message = { id, sender, name: sender === "system" ? "System" : sender === "visitor" ? row.visitorName : identity.name,
      ...(identity.role ? { staffRole: identity.role } : {}), text, time, cycle: row.cycle };
    row._outbox ||= {};
    row._outbox[id] = { message, ...(notify === "staff" || notify === "patient" && row._patientUid ? { notice: notice(row, message, notify === "staff") } : {}) };
    row.lastMessage = text;
    return message;
  }
  function end(row, reason) {
    row.status = "ended";
    row.endedAt = stamp(row);
    enqueue(row, "ended", "system", reason === "exit" ? "The visitor left. This conversation has ended." : "This conversation has ended.");
    if (!row.requestedAt) row.updatedAt = "";
  }
  function upgrade(row) {
    if (row.lifecycleVersion === 2) return;
    row.lifecycleVersion = 2; row.cycle = 1; row.visitorSequence ||= row.lastMessage ? 1 : 0;
    row.status = row.status === "ended" ? "ended" : row.lastMessage ? "waiting" : "welcome";
    if (row.lastMessage) row.requestedAt ||= row.createdAt;
    if (row.source === "website") row._guestLeaseUntil = now() + LEASE_MS;
    if (row.status === "welcome") {
      enqueue(row, "welcome", "system", WELCOME);
      // Unrequested greetings must not displace real requests in the inbox index.
      row.updatedAt = "";
    }
  }
  async function flush(db, id) {
    const row = (await db.ref(`humanChats/${id}`).get()).val();
    const batch = Object.entries(row?._outbox || {});
    for (const [key, event] of batch) {
      await transact(db.ref(`nativeChatMessages/${id}/${key}`), current => current || event.message);
      if (event.notice) await transact(db.ref(`notifications/${event.notice.id}`), current => current || event.notice);
    }
    if (batch.length) await transact(db.ref(`humanChats/${id}`), current => {
      if (!current) return;
      for (const [key] of batch) delete current._outbox?.[key];
      return current;
    });
  }
  async function change(db, id, operation = () => {}) {
    // Lifecycle checks and accepted events share one transaction boundary.
    // The durable outbox makes a failed transcript/notification write retryable.
    await flush(db, id);
    let answer, rejection;
    const result = await transact(db.ref(`humanChats/${id}`), row => {
      answer = undefined; rejection = undefined;
      if (!row || row.provider !== "alphastar") return;
      upgrade(row);
      if (row.source === "website" && row.status !== "ended" && row._guestLeaseUntil <= now()) end(row, "exit");
      try { answer = operation(row); } catch (error) { rejection = error; }
      return row;
    });
    const row = result.snapshot.val();
    if (!row || row.provider !== "alphastar") fail(404, "Conversation not found.");
    await flush(db, id);
    if (rejection) throw rejection;
    return { row, answer };
  }
  const cycle = (row, body) => { if (!Number.isInteger(body?.cycle) || body.cycle !== row.cycle) fail(409, "This conversation has changed. Reopen it and try again."); };
  async function prepare(db, id, known) {
    const row = known || (await db.ref(`humanChats/${id}`).get()).val();
    if (!row || row.provider !== "alphastar") fail(404, "Conversation not found.");
    if (row.lifecycleVersion !== 2 || row.source === "website" && row.status !== "ended" && row._guestLeaseUntil <= now()) return (await change(db, id)).row;
    if (Object.keys(row._outbox || {}).length) { await flush(db, id); return (await db.ref(`humanChats/${id}`).get()).val(); }
    return row;
  }
  async function request(db, id, body, patient, legacy = false) {
    return change(db, id, row => {
      cycle(row, body);
      if (row.status === "ended") {
        if (!patient) fail(409, "This conversation has ended. Open a new chat.");
        row.cycle++; row.status = "welcome";
        delete row._connection; delete row.connectedAt; delete row.connectedName; delete row.connectedRole; delete row.endedAt;
      }
      if (row.status !== "welcome") return;
      row.status = "waiting"; row.requestedAt = stamp(row);
      if (!legacy) {
        row.visitorSequence++;
        enqueue(row, "request", "visitor", "Yes, connect me to support", {}, "staff");
      }
      enqueue(row, "acknowledgement", "system", ACK);
    });
  }
  async function connect(db, id, actor, body, firstName) {
    if (!["anonymous", "first_name"].includes(body?.identity)) fail(400, "Choose Anonymous or First name.");
    return change(db, id, row => {
      cycle(row, body);
      if (row.status === "connected" && row._connection?.uid === actor.uid) return;
      if (row.status !== "waiting") fail(409, "This chat is no longer waiting for a connection.");
      const name = body.identity === "anonymous" ? "Support assistant" : firstName;
      row._connection = { uid: actor.uid, identity: body.identity, name, role: actor.role === "admin" ? "admin" : "staff" };
      row.status = "connected"; row.connectedName = name; row.connectedRole = row._connection.role; row.connectedAt = stamp(row);
      enqueue(row, "connected", "system", `${name} has connected to help you.`, {}, "patient");
    });
  }
  async function send(db, id, actor, body) {
    const messageId = hash(`${id}:${actor.key}:${body.clientId}`), fingerprint = hash(body.text);
    const { answer } = await change(db, id, row => {
      const accepted = row._accepted?.[messageId];
      if (accepted) {
        if (accepted.fingerprint !== fingerprint || accepted.cycle !== body.cycle) fail(409, "That message reference was already used.");
        return accepted.id;
      }
      cycle(row, body);
      if (actor.sender === "staff") {
        if (row.status !== "connected" || row._connection?.uid !== actor.key) fail(403, "Connect to this chat before replying.");
      } else if (!["waiting", "connected"].includes(row.status)) fail(409, "Request support before sending a message.");
      if (actor.sender === "visitor") row.visitorSequence++;
      const identity = actor.sender === "staff" ? row._connection : {};
      const message = enqueue(row, messageId, actor.sender, body.text, identity, actor.sender === "staff" ? "patient" : "staff");
      row._accepted ||= {}; row._accepted[messageId] = { id: message.id, cycle: row.cycle, fingerprint };
      return message.id;
    });
    return (await db.ref(`nativeChatMessages/${id}/${answer}`).get()).val();
  }
  async function finish(db, id, body, actor, reason = "manual") {
    return change(db, id, row => {
      cycle(row, body);
      if (actor && row.status !== "ended" && actor.role !== "admin" && row._connection?.uid !== actor.uid) fail(403, "Only the connected assistant or an administrator can end this chat.");
      if (!actor && reason === "manual") {
        if (!["up", "down"].includes(body.rating)) fail(400, "Select a rating before ending the conversation.");
        const comment = typeof body.comment === "string" ? body.comment.trim() : "";
        if (comment.length > 1000) fail(400, "Use up to 1,000 characters for feedback.");
        row._feedback ||= {};
        const previous = row._feedback[row.cycle];
        if (previous && (previous.rating !== body.rating || previous.comment !== comment)) fail(409, "Feedback was already submitted.");
        row._feedback[row.cycle] ||= { rating: body.rating, comment, time: new Date(now()).toISOString() };
      }
      if (row.status !== "ended") end(row, reason);
    });
  }
  async function heartbeat(db, id, body) {
    return change(db, id, row => {
      cycle(row, body);
      if (row.status !== "ended") row._guestLeaseUntil = now() + LEASE_MS;
    });
  }
  async function markRead(db, id, actor, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) fail(400, "Invalid read marker.");
    return change(db, id, row => {
      row._readBy ||= {};
      row._readBy[actor.uid] = Math.max(row._readBy[actor.uid] || 0, Math.min(sequence, row.visitorSequence || 0));
    });
  }
  return { prepare, request, connect, send, finish, heartbeat, markRead, publicSummary };
}
module.exports = { createChatLifecycle, publicSummary, LEASE_MS };
