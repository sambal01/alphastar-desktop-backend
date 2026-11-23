"use strict";

const { randomUUID } = require("node:crypto");
const READ_STATE_PATH = "/api/staff/notifications/read-state";
const READ_COLLECTION = "desktopNotificationReads";
const READ_LIMIT = 1000;
const VALID_ID = /^[A-Za-z0-9_-]{1,256}$/;

function accountReadPath(uid) {
  return `${READ_COLLECTION}/${Buffer.from(uid, "utf8").toString("base64url")}`;
}

async function legacyReadMarks(database, path) {
  const snapshot = await database.ref(path).get();
  return Object.entries(snapshot.val() || {})
    .filter(([id]) => VALID_ID.test(id))
    .map(([id, markedAt]) => ({ id, markedAt: Number.isSafeInteger(markedAt) ? markedAt : 0 }));
}

function savedReadMarks(snapshot) {
  const { marks } = snapshot.data();
  if (!Array.isArray(marks)) throw new Error("Invalid notification read state.");
  return marks;
}

function registerDesktopNotificationRoutes(app, { getFirestore }) {
  const withStaff = (operation) => async (req, res) => {
    const access = req.staffAccess;
    if (!access?.actor?.uid || access.actor.role === "patient" || !access.database) {
      return res.status(403).json({ ok: false, error: "Only clinic staff can manage desktop notifications." });
    }

    try {
      return await operation(req, res, access);
    } catch {
      return res.status(503).json({ ok: false, error: "The clinic could not save or load notifications. Please try again." });
    }
  };

  app.post("/api/staff/notifications", withStaff(async (req, res, { database }) => {
    const input = req.body || {};
    const id = input.id ?? `notice_${randomUUID()}`;
    const content = {
      userId: input.userId,
      title: input.title || "",
      message: input.message || "",
      type: input.type || "general",
      referenceId: input.referenceId || null,
      referenceType: input.referenceType || null,
    };
    if (typeof id !== "string" || !VALID_ID.test(id) || typeof content.userId !== "string" ||
        !content.userId.trim() || Object.values(content).some((value) => value !== null && typeof value !== "string")) {
      return res.status(400).json({ ok: false, error: "Provide a valid notification ID and recipient." });
    }

    const timestamp = new Date().toISOString();
    const notification = { ...content, id, createdAt: timestamp, updatedAt: timestamp, timestamp, isRead: false };
    const result = await database.ref(`notifications/${id}`).transaction(
      (current) => current === null ? notification : undefined,
      undefined,
      false,
    );
    if (result.committed) return res.status(201).json({ ok: true, notification });
    const existing = result.snapshot?.val();
    if (!existing) return res.status(503).json({ ok: false, error: "The notification could not be saved." });
    if (Object.keys(content).some((field) => (existing[field] ?? null) !== content[field])) {
      return res.status(409).json({ ok: false, error: "This notification ID is already in use." });
    }
    return res.json({ ok: true, notification: existing });
  }));

  app.get(READ_STATE_PATH, withStaff(async (_req, res, { actor, database }) => {
    const path = accountReadPath(actor.uid);
    const snapshot = await getFirestore().doc(path).get();
    const marks = snapshot.exists ? savedReadMarks(snapshot) : await legacyReadMarks(database, path);
    return res.json({ ok: true, ids: marks.map(({ id }) => id) });
  }));

  app.patch(READ_STATE_PATH, withStaff(async (req, res, { actor, database }) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > READ_LIMIT ||
        ids.some((id) => typeof id !== "string" || !VALID_ID.test(id))) {
      return res.status(400).json({ ok: false, error: "Choose valid notification IDs to mark as read." });
    }

    const path = accountReadPath(actor.uid);
    const firestore = getFirestore();
    const ref = firestore.doc(path);
    const markedAt = Date.now();
    let legacy;
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      // Read the previous source only when initializing, and reuse it if this
      // transaction is retried before another request creates the document.
      const previous = snapshot.exists ? savedReadMarks(snapshot) : await (legacy ||= legacyReadMarks(database, path));
      const reads = new Map(ids.map((id) => [id, markedAt]));
      for (const mark of previous) {
        reads.set(mark.id, Math.max(reads.get(mark.id) || 0, mark.markedAt));
      }
      const marks = [...reads].sort((a, b) => b[1] - a[1]).slice(0, READ_LIMIT)
        .map(([id, time]) => ({ id, markedAt: time }));
      transaction.set(ref, { marks });
    });
    return res.json({ ok: true });
  }));

  // Older desktops already save these marks on the device. The legacy route
  // has no IDs and must never rewrite or delete the shared notifications.
  app.patch("/api/staff/notifications/read-all", (_req, res) => {
    return res.json({ ok: true, scope: "device" });
  });
}

module.exports = { registerDesktopNotificationRoutes };
