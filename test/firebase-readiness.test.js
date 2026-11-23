const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createFirebaseReadiness } = require("../src/firebase-readiness");

function request(check) {
  const res = {
    set() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      return { statusCode: this.statusCode, body };
    },
  };
  return check({}, res);
}

const settleProbe = () => new Promise(resolve => setImmediate(resolve));

test("responds during a cold probe and waits for both databases to become ready", async () => {
  let finishFirestore;
  const firestore = new Promise(resolve => { finishFirestore = resolve; });
  let databaseReads = 0;
  const check = createFirebaseReadiness({
    getFirebaseApp: () => ({}),
    getDatabase: () => ({
      ref: () => ({ get: () => { databaseReads += 1; return Promise.resolve(); } }),
    }),
    getFirestore: () => ({ doc: () => ({ get: () => firestore }) }),
  });

  assert.equal(request(check).statusCode, 503);
  await settleProbe();
  assert.equal(request(check).statusCode, 503);
  assert.equal(databaseReads, 1);

  finishFirestore();
  await settleProbe();
  assert.deepEqual(request(check), {
    statusCode: 200,
    body: { ok: true, realtimeDatabase: true, firestore: true },
  });
  assert.equal(databaseReads, 1);
});

test("reports the failed database and retries so health can recover", async ({ mock }) => {
  let now = 1_000;
  mock.method(Date, "now", () => now);
  mock.method(console, "warn", () => {});
  mock.method(console, "info", () => {});
  let firestoreReady = false;
  const check = createFirebaseReadiness({
    getFirebaseApp: () => ({}),
    getDatabase: () => ({ ref: () => ({ get: async () => {} }) }),
    getFirestore: () => ({
      doc: () => ({
        async get() {
          if (!firestoreReady) throw new Error("Unavailable");
        },
      }),
    }),
  });

  assert.equal(request(check).statusCode, 503);
  await settleProbe();
  assert.deepEqual(request(check), {
    statusCode: 503,
    body: { ok: false, realtimeDatabase: true, firestore: false },
  });

  now += 5_000;
  firestoreReady = true;
  assert.equal(request(check).statusCode, 503);
  await settleProbe();
  assert.equal(request(check).statusCode, 200);
});
