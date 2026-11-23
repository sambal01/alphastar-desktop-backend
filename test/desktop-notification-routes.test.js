"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { registerDesktopNotificationRoutes } = require("../src/desktop-notification-routes");

const notificationPath = "/api/staff/notifications";
const readsPath = `${notificationPath}/read-state`;
const storePath = `desktopNotificationReads/${Buffer.from("staff-a").toString("base64url")}`;

function fixture() {
  const handlers = new Map();
  const entries = new Map([["notifications/patient-copy", { userId: "patient", isRead: false }]]);
  const documents = new Map();
  const legacyReads = [];
  const database = {
    failed: false,
    failedReads: false,
    ref(path) {
      const snapshot = () => ({ val: () => entries.get(path) ?? null });
      return {
        async get() {
          legacyReads.push(path);
          if (database.failedReads) throw new Error("Synthetic legacy read failure");
          return snapshot();
        },
        async transaction(operation) {
          if (database.failed) throw new Error("Synthetic cloud write failure");
          const next = operation(snapshot().val());
          if (next === undefined) return { committed: false, snapshot: snapshot() };
          entries.set(path, next);
          return { committed: true, snapshot: snapshot() };
        },
      };
    },
  };
  let tail = Promise.resolve();
  const firestore = {
    failed: false,
    failedReads: false,
    doc(path) {
      return {
        path,
        async get() {
          if (firestore.failedReads) throw new Error("Synthetic Firestore read failure");
          const document = structuredClone(documents.get(path));
          return { exists: document !== undefined, data: () => document };
        },
      };
    },
    runTransaction(operation) {
      const result = tail.then(async () => {
        const writes = new Map();
        await operation({ get: (ref) => ref.get(), set: (ref, value) => writes.set(ref.path, value) });
        if (firestore.failed) throw new Error("Synthetic Firestore commit failure");
        for (const [path, value] of writes) documents.set(path, structuredClone(value));
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  const app = Object.fromEntries(["get", "patch", "post", "delete"].map((method) => [method,
    (path, handler) => handlers.set(`${method}:${path}`, handler),
  ]));
  registerDesktopNotificationRoutes(app, { getFirestore: () => firestore });

  async function request(method, path, { uid = "staff-a", role = "staff", body = {} } = {}) {
    const route = handlers.get(`${method}:${path}`);
    const reply = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { return { status: this.statusCode, body: value }; },
    };
    const staffAccess = uid ? { database, actor: { uid, role } } : undefined;
    return route ? route({ staffAccess, body }, reply) : { status: 404 };
  }
  return { database, entries, documents, firestore, legacyReads, request };
}

test("desktop read marks accumulate for the signed-in account without editing shared notices", async () => {
  const { documents, entries, request } = fixture();
  const initialPatient = structuredClone(entries.get("notifications/patient-copy"));
  entries.set("notifications/newer-notice", { userId: "desktop-staff", isRead: false });
  const responses = await Promise.all(["first", "newer-notice"].map((id) => request("patch", readsPath, {
    body: { ids: [id], userId: "staff-b" },
  })));
  assert.deepEqual(responses.map((reply) => reply.status), [200, 200]);
  const own = await request("get", readsPath);
  assert.deepEqual(own.body.ids.sort(), ["first", "newer-notice"]);
  assert.deepEqual((await request("get", readsPath, { uid: "staff-b" })).body.ids, []);
  assert.deepEqual(documents.get(storePath).marks.map(({ id }) => id).sort(), ["first", "newer-notice"]);
  assert.equal(entries.has(storePath), false);
  assert.deepEqual(entries.get("notifications/patient-copy"), initialPatient);
  assert.equal(entries.get("notifications/newer-notice").isRead, false);
});

test("read state validates scope and reports failed writes", async () => {
  const { documents, firestore, legacyReads, request } = fixture();
  const body = { ids: ["notice"] };
  assert.equal((await request("get", readsPath, { uid: "" })).status, 403);
  assert.equal((await request("patch", readsPath, { role: "patient", body })).status, 403);
  assert.equal((await request("patch", readsPath, { body: { ids: ["../other"] } })).status, 400);
  firestore.failed = true;
  assert.equal((await request("patch", readsPath, { body })).status, 503);
  assert.equal(documents.has(storePath), false);
  assert.deepEqual((await request("get", readsPath)).body.ids, []);
  const oldReadCount = legacyReads.length;
  firestore.failedReads = true;
  assert.equal((await request("get", readsPath)).status, 503);
  assert.equal(legacyReads.length, oldReadCount, "An unavailable Firestore must not load possibly stale legacy receipts.");
});

test("existing RTDB marks load before migration and carry forward on the first Firestore save", async () => {
  const { database, documents, entries, legacyReads, request } = fixture();
  const legacy = { savedEarlier: 1650000000000, "../invalid": 1 };
  entries.set(storePath, legacy);
  assert.deepEqual((await request("get", readsPath)).body.ids, ["savedEarlier"]);
  assert.equal(documents.has(storePath), false, "Reading legacy state does not start a migration.");

  database.failedReads = true;
  assert.equal((await request("patch", readsPath, { body: { ids: ["justRead"] } })).status, 503);
  assert.equal(documents.has(storePath), false, "A failed legacy read cannot lose earlier marks.");
  database.failedReads = false;
  assert.equal((await request("patch", readsPath, { body: { ids: ["justRead"] } })).status, 200);
  assert.deepEqual(documents.get(storePath).marks.find(({ id }) => id === "savedEarlier"), { id: "savedEarlier", markedAt: legacy.savedEarlier });
  assert.deepEqual(entries.get(storePath), legacy);

  const oldReadCount = legacyReads.length;
  entries.set(storePath, { obsoleteBackend: 2 });
  database.failedReads = true;
  assert.equal((await request("patch", readsPath, { body: { ids: ["another"] } })).status, 200);
  assert.deepEqual((await request("get", readsPath)).body.ids.sort(), ["another", "justRead", "savedEarlier"]);
  assert.equal(legacyReads.length, oldReadCount, "The Firestore document is authoritative after migration.");
});

test("Firestore limits migrated read marks and keeps newer marks", async () => {
  const { documents, entries, request } = fixture();
  entries.set(storePath, Object.fromEntries(Array.from({ length: 1000 }, (_, time) => [`legacy-${time}`, time])));
  assert.equal((await request("patch", readsPath, { body: { ids: ["new-mark"] } })).status, 200);
  const { marks } = documents.get(storePath);
  assert.equal(marks.length, 1000);
  assert.equal(marks[0].id, "new-mark");
  assert.equal(marks.at(-1).id, "legacy-1");
});

test("legacy read-all makes no cloud changes and the shared delete route is absent", async () => {
  const { documents, entries, request } = fixture();
  const original = structuredClone(entries);
  assert.deepEqual(await request("patch", `${notificationPath}/read-all`), { status: 200, body: { ok: true, scope: "device" } });
  assert.equal((await request("delete", notificationPath)).status, 404);
  assert.deepEqual(entries, original);
  assert.equal(documents.size, 0);
});

test("notification creation acknowledges the cloud write and preserves existing state on retry", async () => {
  const { database, entries, request } = fixture();
  const body = { id: "notice-1", userId: "patient", title: "Clinic update", message: "A new record is available." };
  const send = (value = body) => request("post", notificationPath, { body: value });
  database.failed = true;
  assert.equal((await send()).status, 503);
  assert.equal(entries.has("notifications/notice-1"), false);
  database.failed = false;
  assert.equal((await send()).status, 201);
  const saved = entries.get("notifications/notice-1");
  saved.isRead = true;
  saved.read = true;
  assert.equal((await send()).status, 200);
  assert.equal(entries.get("notifications/notice-1").isRead, true);
  assert.equal((await send({ ...body, userId: "different" })).status, 409);
  assert.deepEqual(entries.get("notifications/notice-1"), saved);
});
