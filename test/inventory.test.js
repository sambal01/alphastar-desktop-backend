"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), express = require("express");
const { registerInventoryRoutes } = require("../src/inventory-routes");
const { createStaffAccessGuard } = require("../src/queue-routes");
const NOW = Date.parse("2026-10-25T02:00:00Z");
const MEDICINE = { id: "MED-001", name: "Synthetic medicine", generic: "Synthetic generic", category: "Analgesic",
  unit: "Tablets", stock: 10, reorder: 2, cost: 2.5, price: 4, supplier: "Synthetic supplier", expiry: "2027-10-25", location: "Shelf QA",
  createdAt: "2026-10-01T02:00:00.000Z", privateLegacyField: "not-in-response" };

async function fixture(t) {
  const state = { root: { users: { administrator: { role: "admin" }, operator: { role: "staff" }, patient: { role: "patient" }, doctor: { role: "doctor" } },
    staff: { operator: { status: "active" } }, inventory: { "MED-001": structuredClone(MEDICINE) },
    patientProfiles: { patient: { fullName: "Synthetic private profile" } }, stockTransactions: { old: { id: "old", itemId: "MED-001", quantity: 10 } } },
    requests: [], commits: 0, listeners: 0, failStorage: false, conflict: false, reply: null, beforeTransaction: null, externalRequests: [] };
  const value = path => path ? path.split("/").reduce((current, key) => current?.[key], state.root) ?? null : state.root;
  const database = { ref: (refPath = "") => ({
    async get() { return { val: () => structuredClone(value(refPath)) }; },
    on(_event, listener, fail) { state.listeners++; if (state.failStorage) fail(new Error("Private database failure")); else listener({ val: () => structuredClone(value(refPath)) }); },
    off() { state.listeners--; },
    async transaction(update) {
      if (state.beforeTransaction) state.beforeTransaction(state.root);
      const next = update(structuredClone(state.root));
      if (state.conflict || next === undefined) return { committed: false };
      state.root = structuredClone(next); state.commits++;
      return { committed: true, snapshot: { val: () => structuredClone(state.root) } };
    }
  }) };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { state.requests.push({ method: req.method, path: req.path, body: structuredClone(req.body || {}) }); next(); });
  app.use("/api/staff", createStaffAccessGuard({ getFirebaseApp: () => ({}), getDatabase: () => database,
    getAuth: () => ({ verifyIdToken: async (token, revoked) => {
      assert.equal(revoked, true);
      if (!Object.hasOwn(state.root.users, token)) throw new Error("Private Auth failure");
      return { uid: token, role: "admin" }; // Saved roles, never this claim, must authorize the write.
    } }) }));
  app.use((req, res, next) => {
    if (state.reply && ["PUT", "DELETE", "POST"].includes(req.method)) return res.status(state.reply.status).json(state.reply.body);
    next();
  });
  registerInventoryRoutes(app, { now: () => NOW });
  app.get("/:collection.json", (req, res) => res.json(state.root[req.params.collection] || null));
  app.use((_req, res) => res.status(501).json({ ok: false, error: "Endpoint not modeled by this fixture" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (body, token = "administrator", id = "MED-001", method = "PUT") => fetch(`${base}/api/staff/manage/inventory/${encodeURIComponent(id)}`, {
    method, headers: { Authorization: token ? `Bearer ${token}` : "", "Content-Type": "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify(body) } : {}) });
  const context = vm.createContext({ window: {
    alphaFirebaseConfig: { apiKey: "synthetic", projectId: "alpha-star-clinic-mobile", authDomain: "alpha-star-clinic-mobile.firebaseapp.com", databaseURL: "https://alpha-star-clinic-mobile-default-rtdb.firebaseio.com" },
    alphaApiBaseUrl: base + "/api"
  }, structuredClone, AbortController, TextDecoder, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (input, options) => {
      const url = new URL(input);
      if (url.hostname === "alpha-star-clinic-mobile-default-rtdb.firebaseio.com") return fetch(base + url.pathname + url.search, options);
      if (url.origin !== base) { state.externalRequests.push(url.origin); throw new Error("External network is forbidden in this fixture"); }
      return fetch(input, options);
    } });
  for (const file of ["live-sync.js", "firebase-service.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../../src/js", file), "utf8"), context);
  const api = context.window.AlphaFirebase;
  const load = async (uid = "administrator", role = "admin") => { const data = await api.loadClinicData(uid, uid, role); api.acceptClinicData(data); return data; };
  return { state, request, api, load };
}

test("real desktop HTTP inventory save persists MED-001, confirms its ID, reloads and preserves unrelated data", async t => {
  const { state, api, load } = await fixture(t), original = structuredClone(state.root), data = await load();
  data.inventory[0].name = "Updated synthetic medicine"; data.inventory[0].price = 4.75;
  await api.saveClinicData("administrator", "admin", data, "administrator");
  assert.equal(state.root.inventory["MED-001"].name, data.inventory[0].name);
  assert.equal(state.root.inventory["MED-001"].price, 4.75);
  assert.equal(state.root.inventory["MED-001"].privateLegacyField, MEDICINE.privateLegacyField);
  for (const collection of ["users", "staff", "patientProfiles", "stockTransactions"]) assert.deepEqual(state.root[collection], original[collection]);
  assert.equal((await load()).inventory[0].price, 4.75);
  const audit = Object.values(state.root.auditLogs)[0];
  assert.equal(audit.actorRole, "admin"); assert.equal(audit.action, "inventory_updated"); assert.equal(audit.targetId, "MED-001");
  assert.deepEqual(audit.details.changedFields.sort(), ["name", "price"]);
  assert.ok(!JSON.stringify(audit).includes("Updated synthetic medicine"));
  assert.equal(state.listeners, 0); assert.deepEqual(state.externalRequests, []);
  assert.equal(state.requests.filter(row => row.method === "PUT" && row.path === "/api/staff/manage/inventory/MED-001").length, 1);
});

test("Admin can create and delete a medicine through the actual desktop sync client", async t => {
  const { state, api, load } = await fixture(t), data = await load();
  data.inventory.push({ id: "MED-002", name: "New synthetic medicine", unit: "Vials", stock: 0, expiry: "2028-02-29" });
  await api.saveClinicData("administrator", "admin", data, "administrator");
  assert.equal(state.root.inventory["MED-002"].stock, 0); assert.equal(state.root.inventory["MED-002"].cost, 0);
  assert.equal(state.root.inventory["MED-002"].createdAt, new Date(NOW).toISOString());
  data.inventory = data.inventory.filter(row => row.id !== "MED-002");
  await api.saveClinicData("administrator", "admin", data, "administrator");
  assert.equal(state.root.inventory["MED-002"], undefined); assert.ok(state.root.inventory["MED-001"]);
  assert.deepEqual(Object.values(state.root.auditLogs).map(row => row.action), ["inventory_created", "inventory_deleted"]);
});

test("Staff may save existing stock with unchanged metadata but cannot edit medicine details, create or delete", async t => {
  const { state, api, load, request } = await fixture(t), data = await load("operator", "staff");
  data.inventory[0].stock = 8;
  await api.saveClinicData("operator", "staff", data, "operator");
  assert.equal(state.root.inventory["MED-001"].stock, 8);
  assert.equal(Object.values(state.root.auditLogs)[0].actorRole, "staff");
  for (const fields of [{ price: 1 }, { generic: "Changed" }, { expiry: "2028-01-01" }, { supplier: "Changed" }, { status: "inactive" }, { cost: 1 }, { location: "Other" }]) {
    assert.equal((await request(fields, "operator")).status, 403);
  }
  assert.equal((await request({ name: "Blocked", unit: "Vials" }, "operator", "MED-002")).status, 403);
  assert.equal((await request(null, "operator", "MED-001", "DELETE")).status, 403);
  assert.equal(state.commits, 1);
});

test("Admin and Staff stock movements are atomic, audited and idempotent without remarks", async t => {
  const { state, api, load } = await fixture(t);
  const data = await load("operator", "staff");
  const input = { requestId: "sample_add", mode: "add", quantity: 5 };
  const first = await api.updateInventoryStock("operator", "MED-001", input);
  assert.equal(first.item.stock, 15); assert.equal(first.transaction.quantity, 5); assert.equal(first.transaction.remarks, "");
  assert.equal(first.transaction.actorId, "operator"); assert.equal(first.transaction.actorRole, "staff");
  const again = await api.updateInventoryStock("operator", "MED-001", input);
  assert.equal(again.item.stock, 15); assert.equal(again.transaction.id, first.transaction.id);
  assert.equal(Object.values(state.root.stockTransactions).filter(row => row.requestId === input.requestId).length, 1);
  assert.equal(Object.keys(state.root.auditLogs).length, 1);
  Object.assign(data.inventory[0], first.item); data.transactions.unshift(first.transaction);
  const beforeSave = state.requests.length;
  await api.saveClinicData("operator", "staff", data, "operator");
  assert.equal(state.requests.slice(beforeSave).filter(row => ["PUT", "POST"].includes(row.method)).length, 0, "Confirmed stock must not be synced again as a second stock movement");
  const removed = await api.updateInventoryStock("administrator", "MED-001", { requestId: "sample_remove", mode: "remove", quantity: 4 });
  assert.equal(removed.item.stock, 11); assert.equal(removed.transaction.quantity, -4);
  assert.equal(state.root.inventory["MED-001"].privateLegacyField, MEDICINE.privateLegacyField);
  assert.equal(Object.keys(state.root.auditLogs).length, 2);
});

test("simultaneous stock removals cannot overdraw; duplicate retries cannot subtract twice", async t => {
  const { state, api } = await fixture(t);
  const attempts = await Promise.allSettled([
    api.updateInventoryStock("operator", "MED-001", { requestId: "remove_a", mode: "remove", quantity: 7 }),
    api.updateInventoryStock("administrator", "MED-001", { requestId: "remove_b", mode: "remove", quantity: 7 }),
  ]);
  assert.equal(attempts.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(attempts.find(row => row.status === "rejected").reason.code, "INVENTORY_INSUFFICIENT");
  assert.equal(state.root.inventory["MED-001"].stock, 3);
  const winner = attempts[0].status === "fulfilled" ? ["operator", "remove_a"] : ["administrator", "remove_b"];
  await api.updateInventoryStock(winner[0], "MED-001", { requestId: winner[1], mode: "remove", quantity: 7 });
  assert.equal(state.root.inventory["MED-001"].stock, 3);
  assert.equal(Object.keys(state.root.auditLogs).length, 1);
});

test("invalid stock actions, forged callers and reused requests never change balances", async t => {
  const { state, api } = await fixture(t);
  const valid = { requestId: "stock_test", mode: "add", quantity: 2 };
  for (const input of [{ ...valid, quantity: 0 }, { ...valid, quantity: -2 }, { ...valid, quantity: 1.5 }, { ...valid, quantity: 10000 }, { ...valid, quantity: "2" }, { ...valid, mode: "delete" }, { ...valid, requestId: "__proto__" }, { ...valid, actorId: "administrator" }]) {
    await assert.rejects(api.updateInventoryStock("operator", "MED-001", input), { status: 400 });
  }
  for (const token of ["patient", "doctor", "forged"]) await assert.rejects(api.updateInventoryStock(token, "MED-001", valid));
  assert.equal(state.root.inventory["MED-001"].stock, 10); assert.equal(state.commits, 0);
  await api.updateInventoryStock("operator", "MED-001", valid);
  await assert.rejects(api.updateInventoryStock("operator", "MED-001", { ...valid, quantity: 3 }), { status: 409, code: "INVENTORY_CONFLICT" });
  assert.equal(state.root.inventory["MED-001"].stock, 12);
  state.root.users.operator.role = "patient";
  await assert.rejects(api.updateInventoryStock("operator", "MED-001", { ...valid, requestId: "revoked" }), { status: 403 });
  assert.equal(state.root.inventory["MED-001"].stock, 12);
});

test("stock updates recheck permissions and reject unknown balances inside the transaction", async t => {
  const { state, api } = await fixture(t), input = { requestId: "stock_guard", mode: "add", quantity: 2 };
  state.beforeTransaction = root => { root.users.operator.role = "patient"; };
  await assert.rejects(api.updateInventoryStock("operator", "MED-001", input), { status: 403 });
  assert.equal(state.root.inventory["MED-001"].stock, 10); assert.equal(state.commits, 0);
  state.beforeTransaction = null; state.root.users.operator.role = "staff";
  for (const value of [null, "", "unknown", -1, 1.5]) {
    state.root.inventory["MED-001"].stock = value;
    await assert.rejects(api.updateInventoryStock("operator", "MED-001", input), { status: 409, code: "INVENTORY_CONFLICT" });
    assert.equal(state.root.inventory["MED-001"].stock, value); assert.equal(state.commits, 0);
  }
});

test("the stock client rejects malformed confirmations and gives restart guidance for an older backend", async t => {
  const { state, api } = await fixture(t), input = { requestId: "stock_confirm", mode: "add", quantity: 2 };
  for (const body of [{ ok: true }, { ok: true, item: { id: "wrong", stock: 12 }, transaction: { id: "fake" } }]) {
    state.reply = { status: 200, body };
    await assert.rejects(api.updateInventoryStock("operator", "MED-001", input), /server did not confirm/);
  }
  state.reply = { status: 404, body: { error: "No Alphastar endpoint" } };
  await assert.rejects(api.updateInventoryStock("operator", "MED-001", input), { code: "INVENTORY_BACKEND_OUTDATED" });
  assert.equal(state.root.inventory["MED-001"].stock, 10); assert.equal(state.commits, 0);
  state.reply = null;
  assert.equal((await api.updateInventoryStock("operator", "MED-001", input)).item.stock, 12);
});

test("missing/forged tokens, patient/other roles and inactive accounts cannot write", async t => {
  const { state, request } = await fixture(t);
  for (const [token, status] of [["", 401], ["forged", 401], ["patient", 403], ["doctor", 403]]) {
    assert.equal((await request({ stock: 2 }, token)).status, status);
  }
  for (const invalid of [{ active: false }, { disabled: true }, { deleted: true }, { deletedAt: "2026-10-25" }, { status: "inactive" }, { accountStatus: "blocked" }]) {
    state.root.users.administrator = { role: "admin", ...invalid };
    assert.equal((await request({ stock: 2 })).status, 403);
  }
  state.root.users.administrator = { role: "admin" }; state.root.staff.administrator = { active: false };
  assert.equal((await request({ stock: 2 })).status, 403); assert.equal(state.commits, 0);
});

test("account permissions are rechecked atomically after authentication, not trusted from claims", async t => {
  const { state, request } = await fixture(t);
  state.beforeTransaction = root => { root.users.administrator.role = "patient"; };
  assert.equal((await request({ stock: 2 })).status, 403); assert.equal(state.root.inventory["MED-001"].stock, 10);
  assert.equal(state.commits, 0); assert.equal(state.listeners, 0);
});

test("invalid numbers, dates, unsafe IDs and field injection are rejected without writes", async t => {
  const { state, request } = await fixture(t);
  for (const body of [{}, [], { stock: -1 }, { stock: 0.5 }, { stock: "5" }, { stock: null }, { stock: 1e20 }, { reorder: -2 },
    { cost: -0.1 }, { price: null }, { expiry: "2027-02-29" }, { expiry: "2027-13-01" }, { expiry: "not-a-date" },
    { name: "" }, { name: 1 }, { name: "x".repeat(161) }, { name: ["Not text"] }, { unit: "" }, { id: "other" },
    { role: "admin" }, { userId: "patient" }, { createdBy: "operator" }, { auditLogs: {} }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.equal((await request(body)).status, 400, JSON.stringify(body));
  }
  for (const id of ["__proto__", "constructor", "prototype", "bad.id", "bad/id", "x".repeat(181)]) assert.equal((await request({ stock: 1 }, "administrator", id)).status, 400);
  assert.equal((await request({ stock: 1 }, "administrator", "MED-NEW")).status, 400);
  assert.equal(state.commits, 0); assert.equal(state.root.inventory["MED-001"].stock, 10); assert.equal({}.polluted, undefined);
});

test("public confirmation is sanitized, partial updates preserve fields, and no-op retries do not duplicate audits", async t => {
  const { state, request } = await fixture(t);
  const response = await request({ stock: 0, price: 0, expiry: "", name: "  Synthetic <medicine>  " });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json(); assert.equal(result.ok, true); assert.equal(result.item.id, "MED-001");
  assert.equal(result.item.privateLegacyField, undefined); assert.equal(result.item.updatedBy, undefined);
  assert.equal(result.item.name, "Synthetic medicine"); assert.equal(result.item.stock, 0); assert.equal(result.item.price, 0);
  assert.equal(state.root.inventory["MED-001"].unit, "Tablets");
  await request({ stock: 0, price: 0, expiry: "", name: "Synthetic medicine" });
  assert.equal(Object.keys(state.root.auditLogs).length, 1);
});

test("Admin deletion is retryable and retains stock movement history", async t => {
  const { state, request } = await fixture(t), history = structuredClone(state.root.stockTransactions);
  const response = await request(null, "administrator", "MED-001", "DELETE");
  assert.deepEqual(await response.json(), { ok: true, id: "MED-001" });
  assert.equal(state.root.inventory["MED-001"], undefined); assert.deepEqual(state.root.stockTransactions, history);
  assert.equal((await request(null, "administrator", "MED-001", "DELETE")).status, 200);
  assert.equal(Object.keys(state.root.auditLogs).length, 1);
});

test("database failures and transaction conflicts are sanitized and never acknowledged as saved", async t => {
  const { state, request } = await fixture(t);
  state.failStorage = true;
  const failed = await request({ stock: 1 }); assert.equal(failed.status, 503); assert.equal(failed.headers.get("cache-control"), "no-store");
  const result = await failed.json(); assert.equal(result.ok, false); assert.equal(result.code, "INVENTORY_UNAVAILABLE");
  assert.ok(!JSON.stringify(result).includes("Private database failure")); assert.equal(state.listeners, 0);
  state.failStorage = false; state.conflict = true;
  assert.equal((await request({ stock: 1 })).status, 409);
  assert.equal(state.commits, 0); assert.equal(state.root.inventory["MED-001"].stock, 10); assert.equal(state.root.auditLogs, undefined);
});

test("actual client rejects false/wrong confirmations and retains the change for a successful retry", async t => {
  const { state, api, load } = await fixture(t), data = await load(); data.inventory[0].price = 5;
  for (const body of [{ ok: true }, { ok: false, item: { id: "MED-001" } }, { ok: true, item: { id: "MED-OTHER" } }]) {
    state.reply = { status: 200, body };
    await assert.rejects(api.saveClinicData("administrator", "admin", data, "administrator"), /did not confirm the inventory save/);
  }
  state.reply = null;
  await api.saveClinicData("administrator", "admin", data, "administrator");
  assert.equal(state.root.inventory["MED-001"].price, 5); assert.equal(state.commits, 1);
});

test("an older backend gives actionable restart guidance instead of the raw missing-endpoint message", async t => {
  const { state, api, load } = await fixture(t), data = await load(); data.inventory[0].price = 5;
  state.reply = { status: 404, body: { message: "No Alphastar endpoint for PUT /api/staff/manage/inventory/MED-001" } };
  await assert.rejects(api.saveClinicData("administrator", "admin", data, "administrator"), error =>
    error.code === "INVENTORY_BACKEND_OUTDATED" && /Completely exit and reopen/.test(error.message) && /local changes are kept/.test(error.message));
  assert.equal(state.commits, 0);
});

test("the actual desktop server registers protected inventory routes and advertises its capability", async t => {
  const { app } = require("../src/server");
  const paths = app.router.stack.filter(layer => layer.route).map(layer => ({ path: layer.route.path, methods: layer.route.methods }));
  assert.ok(paths.some(row => row.path === "/api/staff/manage/inventory/:id" && row.methods.put));
  assert.ok(paths.some(row => row.path === "/api/staff/manage/inventory/:id" && row.methods.delete));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(origin + "/api/health")).json();
  assert.equal(health.service, "alphastar-desktop-backend"); assert.equal(health.capabilities.inventoryManagement, 1);
  assert.equal((await fetch(origin + "/api/staff/manage/inventory/MED-001", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stock: 1 }) })).status, 401);
});
