"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const files = require("../src/clinical-files"), { firestoreFileStore, CHUNK_BYTES, COLLECTION, CHUNKS } = require("../src/private-clinical-files");
const { registerClinicalRoutes, __test: clinical } = require("../src/clinical-records");
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD3sAAAAASUVORK5CYII=";
const pdf = Buffer.from("%PDF-1.7\nSynthetic test document only.\n%%EOF\n").toString("base64");
const NOW = Date.parse("2026-11-19T00:00:00Z");
const clone = value => value === undefined ? undefined : structuredClone(value);
function input(extra = {}) { return { name: "Result.png", mime: "image/png", base64: image, ...extra }; }
function stored(extra = {}) { const file = input(extra); return { ...files.checkedFile(file), objectPath: "clinical-results/visit/file", uploadedBy: "doctor", serviceId: "xray" }; }
function fakeFirestore() {
  const documents = new Map(), stats = { writes: 0, reads: 0, batchReads: 0 }, state = { failCommit: 0, failRead: 0 };
  let queue = Promise.resolve();
  const snapshot = ref => ({ id: ref.id, ref, exists: documents.has(ref.path), data: () => clone(documents.get(ref.path)) });
  const collection = path => ({ doc: id => reference(path + "/" + id) });
  const reference = path => ({ path, id: path.split("/").at(-1), collection: name => collection(path + "/" + name), async get() { stats.reads++; if (state.failRead) throw { code: state.failRead }; return snapshot(this); } });
  return { documents, stats, state, collection,
    async getAll(...refs) { stats.batchReads++; return refs.map(snapshot).reverse(); },
    runTransaction(work) {
      const next = queue.then(async () => {
        const pending = [];
        const result = await work({ async get(ref) { stats.reads++; return snapshot(ref); }, create(ref, data) { pending.push([ref.path, clone(data)]); } });
        if (state.failCommit) throw { code: state.failCommit };
        assert.equal(new Set(pending.map(([path]) => path)).size, pending.length);
        for (const [path] of pending) if (documents.has(path)) throw { code: 6 };
        for (const [path, data] of pending) { documents.set(path, data); stats.writes++; }
        return result;
      });
      queue = next.catch(() => {}); return next;
    },
  };
}
function facade(database, env = {}, legacy = { async put() {}, async read() { return image; } }) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/private-clinical-files"), "utf8"), { module, Buffer, Uint8Array, process: { env }, require(name) {
    if (name === "node:crypto") return require(name);
    if (name === "./clinical-files") return { ...files, firebaseFileStore: () => legacy };
    if (name === "firebase-admin/firestore") return { getFirestore: () => database };
    throw Error("Unexpected dependency: " + name);
  } });
  return module.exports.privateFileStore({ options: { projectId: "synthetic" } });
}

test("new PNG, JPEG and PDF results use private Firestore without requiring a Storage bucket", async () => {
  for (const extra of [{}, { name: "Result.pdf", mime: "application/pdf", base64: pdf }, { name: "Result.jpg", mime: "image/jpeg", base64: Buffer.from("ffd8ffc0000b080001000103011100ffd9", "hex").toString("base64") }]) {
    const database = fakeFirestore(), store = facade(database), file = stored(extra);
    const location = await store.put(file);
    assert.equal(location.storageBackend, "firestore");
    assert.equal(await store.read({ ...file, ...location }), file.base64);
    assert.equal(database.documents.size, 2);
    for (const [path, data] of database.documents) {
      assert.match(path, new RegExp("^" + COLLECTION + "/[a-f0-9]{64}(?:/" + CHUNKS + "/000)?$"));
      assert.equal(data.name, undefined); assert.equal(data.base64, undefined); assert.equal(data.objectPath, undefined);
    }
  }
});

test("a 2 MB PDF uses eight bounded chunks, atomic writes and ordered hash-verified reconstruction", async () => {
  const bytes = Buffer.alloc(files.MAX_FILE_BYTES, 32); bytes.write("%PDF-1.7\n"); bytes.write("\n%%EOF\n", bytes.length - 7);
  const file = stored({ name: "Large.pdf", mime: "application/pdf", base64: bytes.toString("base64") }), database = fakeFirestore(), store = firestoreFileStore(database);
  await store.put(file);
  assert.equal(database.documents.size, 9); assert.equal(database.stats.writes, 9);
  for (const [path, row] of database.documents) if (path.includes("/" + CHUNKS + "/")) assert.ok(row.bytes.length <= CHUNK_BYTES && row.bytes.length < 1048576);
  assert.equal(await store.read(file), file.base64);
  assert.equal(database.stats.batchReads, 1);
});

test("identical/concurrent retries are idempotent and a reused reference cannot overwrite a different result", async () => {
  const database = fakeFirestore(), store = firestoreFileStore(database), file = stored();
  await Promise.all([store.put(file), store.put(file)]); assert.equal(database.stats.writes, 2);
  for (const changed of [{ name: "Other.png" }, { uploadedBy: "other" }, { serviceId: "ecg" }]) await assert.rejects(store.put({ ...file, ...changed }), error => error instanceof files.ClinicalFileError && error.status === 400);
  assert.equal(database.stats.writes, 2); assert.equal(await store.read(file), image);
});

test("denied, unavailable or quota-limited storage fails closed with no partial file and permits a later retry", async () => {
  for (const code of [7, 8, 14]) {
    const database = fakeFirestore(), store = facade(database), file = stored(); database.state.failCommit = code;
    await assert.rejects(store.put(file), error => error.status === 503 && error.code === "CLINICAL_STORAGE_UNAVAILABLE");
    assert.equal(database.documents.size, 0); assert.equal(database.stats.writes, 0);
    database.state.failCommit = 0; await store.put(file); assert.equal(database.documents.size, 2);
    database.state.failRead = code; await assert.rejects(store.read({ ...file, storageBackend: "firestore" }), error => error.status === 503);
  }
});

test("missing, corrupted or excessive stored chunks/metadata never return unverified bytes", async () => {
  for (const mutate of [
    database => database.documents.clear(),
    database => { const row = [...database.documents.values()].find(row => row.version); row.chunkCount = 999999; },
    database => { const row = [...database.documents.values()].find(row => row.version); row.fingerprint = "invalid"; },
    database => { const row = [...database.documents.values()].find(row => row.bytes); row.bytes[0] ^= 1; },
    database => { const entry = [...database.documents].find(([, row]) => row.bytes); database.documents.delete(entry[0]); },
    database => { const row = [...database.documents.values()].find(row => row.bytes); row.bytes = Buffer.alloc(CHUNK_BYTES + 1); },
  ]) {
    const database = fakeFirestore(), store = firestoreFileStore(database), file = stored(); await store.put(file); mutate(database);
    await assert.rejects(store.read(file), error => error.status === 503);
  }
});

test("bad input and forged byte/hash metadata are rejected before writing private documents", async () => {
  const database = fakeFirestore(), store = firestoreFileStore(database), file = stored();
  for (const changed of [{ base64: "AAAA" }, { mime: "text/html" }, { name: "../file.png" }, { hash: "invalid" }, { size: 0 }, { objectPath: "../private" }]) await assert.rejects(store.put({ ...file, ...changed }), error => error instanceof files.ClinicalFileError);
  assert.equal(database.stats.writes, 0);
});

test("existing Storage files remain readable and new pointers determine reads even after configuration changes", async () => {
  const database = fakeFirestore(), env = {}, calls = [], legacy = { async put(file) { calls.push("put"); }, async read(file) { calls.push("read"); return image; } }, store = facade(database, env, legacy), file = stored();
  await store.put(file); assert.equal(await store.read(file), image); assert.deepEqual(calls, ["read"]);
  env.CLINICAL_FILE_STORAGE = "storage"; assert.equal((await store.put(file)).storageBackend, "storage");
  assert.equal(await store.read({ ...file, storageBackend: "firestore" }), image); assert.deepEqual(calls, ["read", "put"]);
  env.CLINICAL_FILE_STORAGE = "invalid"; await assert.rejects(store.put(file), error => error.status === 503);
  await assert.rejects(store.read({ ...file, storageBackend: "public" }), error => error.status === 503);
});

test("doctor upload, saved review and patient delivery use private bytes without exposing storage pointers", async () => {
  const root = { users: { patient: { role: "patient" }, other: { role: "patient" }, doctor: { role: "doctor", name: "Synthetic Doctor" } }, patientAdmissions: { patient: { firstApprovedAt: "2026-11-01T00:00:00Z" } }, services: { xray: { status: "active", service_name: "Digital X-Ray" } } };
  clinical.createVisit(root, { id: "visit", userId: "patient", serviceIds: ["xray"] }, { uid: "doctor" }, NOW);
  const rootBefore = JSON.stringify(root), handlers = new Map(), database = fakeFirestore();
  const realtime = { ref(path = "") { return {
    async get() { return { val: () => clone(path ? path.split("/").reduce((value, key) => value?.[key], root) : root) }; },
    on(_event, listener) { listener({ val: () => clone(root) }); }, off() {},
    async transaction(update) { const next = update(clone(root)); if (next === undefined) return { committed: false }; for (const key of Object.keys(root)) delete root[key]; Object.assign(root, next); return { committed: true }; },
  }; } };
  registerClinicalRoutes(Object.fromEntries(["get", "post", "put"].map(method => [method, (path, handler) => handlers.set(method + " " + path, handler)])), {
    getFirebaseApp: () => ({}), getDatabase: () => realtime, getAuth: () => ({ verifyIdToken: async token => ({ uid: token }) }),
    assertAuthenticatorAccess: async actor => { if (actor.uid === "mfa") throw { status: 401 }; }, now: () => NOW, fileStore: facade(database),
  });
  async function request(route, actor, body) {
    let status = 200, result;
    const res = { set(_name, value) { assert.equal(value, "no-store"); return res; }, status(value) { status = value; return res; }, json(value) { result = value; } };
    await handlers.get(route)({ params: { id: "visit", fileId: "file" }, headers: { authorization: "Bearer " + actor }, body, staffAccess: { database: realtime, actor: { uid: actor } } }, res);
    return { status, body: result };
  }
  const upload = { ...input(), id: "file", serviceId: "xray", expectedRevision: 1 }, uploadRoute = "post /api/staff/clinical-records/:id/attachments", patientRoute = "get /api/patient/clinical-records/:id/attachments/:fileId";
  assert.equal((await request(uploadRoute, "patient", upload)).status, 403); assert.equal(database.stats.writes, 0);
  assert.equal((await request(uploadRoute, "doctor", { ...upload, storageBackend: "public" })).status, 400); assert.equal(database.stats.writes, 0);
  database.state.failCommit = 8; assert.equal((await request(uploadRoute, "doctor", upload)).status, 503); assert.equal(JSON.stringify(root), rootBefore);
  database.state.failCommit = 0; assert.equal((await request(uploadRoute, "doctor", upload)).status, 200);
  assert.equal(root.clinicalVisitFiles.visit.file.storageBackend, "firestore"); assert.equal(root.clinicalVisitFiles.visit.file.base64, undefined);
  const writes = database.stats.writes; assert.equal((await request(uploadRoute, "doctor", upload)).body.duplicate, true); assert.equal(database.stats.writes, writes);
  const readsBefore = database.stats.reads; assert.equal((await request(patientRoute, "patient")).status, 404); assert.equal(database.stats.reads, readsBefore);
  assert.equal((await request("put /api/staff/clinical-records/:id", "doctor", { expectedRevision: 2, status: "awaiting_review", vitals: {}, notes: {} })).status, 200);
  assert.equal((await request("post /api/staff/clinical-records/:id/release", "doctor", { expectedRevision: 3 })).status, 200);
  for (const actor of ["other", "mfa"]) { const reads = database.stats.reads; assert.equal((await request(patientRoute, actor)).status, actor === "mfa" ? 401 : 404); assert.equal(database.stats.reads, reads); }
  const own = await request(patientRoute, "patient"); assert.equal(own.status, 200); assert.equal(own.body.attachment.base64, image);
  assert.doesNotMatch(JSON.stringify(own), /storageBackend|objectPath|uploadedBy|fingerprint|hash/);
  assert.equal(clinical.releasedHistory(root.clinicalVisits, "patient")[0].attachments[0].name, "Result.png");
  root.users.patient.disabled = true; const reads = database.stats.reads; assert.equal((await request(patientRoute, "patient")).status, 403); assert.equal(database.stats.reads, reads);
});
