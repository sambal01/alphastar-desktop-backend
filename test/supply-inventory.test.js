"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { registerSupplyRoutes } = require("../src/supply-routes");

async function fixture(t) {
  const state = {
    root: {
      users: { admin: { role: "admin" }, staff: { role: "staff" }, doctor: { role: "doctor" }, patient: { role: "patient" } },
      staff: { staff: { status: "active" } }, supplies: {},
    },
    commits: 0,
  };
  const database = {
    ref: () => ({
      on(_event, listener) { listener({ val: () => structuredClone(state.root) }); },
      off() {},
      async transaction(update) {
        const next = update(structuredClone(state.root));
        if (next === undefined) return { committed: false };
        state.root = structuredClone(next); state.commits++;
        return { committed: true, snapshot: { val: () => structuredClone(state.root) } };
      },
    }),
  };
  const app = express(); app.use(express.json());
  app.use("/api/staff", (req, _res, next) => {
    const uid = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    req.staffAccess = uid && Object.hasOwn(state.root.users, uid) ? { database, actor: { uid } } : {};
    next();
  });
  registerSupplyRoutes(app, { now: () => Date.parse("2026-11-10T04:00:00.000Z") });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/staff/manage/supplies`;
  const request = (uid, id, method, body) => fetch(`${base}/${encodeURIComponent(id)}${method === "POST" ? "/stock" : ""}`, {
    method, headers: { Authorization: uid ? `Bearer ${uid}` : "", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { state, request };
}

test("Supply records are separate, sanitized, and created or edited by Admin only", async t => {
  const { state, request } = await fixture(t);
  const added = await request("admin", "SUP-001", "PUT", {
    name: " Gloves ", category: " PPE ", unit: " boxes ", stock: 12, reorder: 4,
    supplier: "Clinic supplier", location: "Cabinet 2", ignored: "must not persist",
  });
  assert.equal(added.status, 400, "unknown fields are rejected");
  assert.equal(state.commits, 0);
  const response = await request("admin", "SUP-001", "PUT", {
    name: " Gloves ", category: " PPE ", unit: " boxes ", stock: 12, reorder: 4,
    supplier: "Clinic supplier", location: "Cabinet 2",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json();
  assert.deepEqual(result.item, {
    id: "SUP-001", name: "Gloves", category: "PPE", unit: "boxes", stock: 12,
    reorder: 4, supplier: "Clinic supplier", location: "Cabinet 2",
    createdAt: new Date("2026-11-10T04:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-11-10T04:00:00.000Z").toISOString(),
  });
  assert.equal(state.root.inventory, undefined, "supply entries never enter medicine inventory");
  assert.equal((await request("admin", "SUP-001", "PUT", { stock: 13 })).status, 409, "existing stock must use a stock-movement action");
  assert.equal(state.root.supplies["SUP-001"].stock, 12);
  assert.equal((await request("staff", "SUP-001", "PUT", { name: "Changed" })).status, 403);
  assert.equal(state.root.supplies["SUP-001"].name, "Gloves");
  assert.equal(state.commits, 1);
});

test("Staff stock updates are atomic, idempotent and never overdraw supply stock", async t => {
  const { state, request } = await fixture(t);
  await request("admin", "SUP-001", "PUT", { name: "Gloves", unit: "boxes", stock: 10, reorder: 2 });
  const removeA = { requestId: "remove_a", mode: "remove", quantity: 7 };
  const removeB = { requestId: "remove_b", mode: "remove", quantity: 7 };
  const attempts = await Promise.all([
    request("staff", "SUP-001", "POST", removeA),
    request("admin", "SUP-001", "POST", removeB),
  ]);
  assert.deepEqual(attempts.map(row => row.status).sort(), [200, 409]);
  assert.equal(state.root.supplies["SUP-001"].stock, 3);
  const winner = attempts[0].status === 200 ? removeA : removeB;
  const retried = await request(winner === removeA ? "staff" : "admin", "SUP-001", "POST", winner);
  assert.equal(retried.status, 200);
  const transaction = (await retried.json()).transaction;
  assert.equal(transaction.quantity, -7);
  assert.equal(Object.keys(state.root.supplyStockTransactions).length, 1);
  assert.equal(state.root.auditLogs[transaction.id].action, "supply_stock_removed");
  assert.equal(state.root.inventory, undefined);
});

test("Invalid roles, identifiers, quantities, and reused request IDs cannot mutate supplies", async t => {
  const { state, request } = await fixture(t);
  await request("admin", "SUP-001", "PUT", { name: "Gloves", unit: "boxes", stock: 5, reorder: 1 });
  for (const uid of ["", "patient", "doctor"]) {
    const response = await request(uid, "SUP-001", "POST", { requestId: "valid", mode: "add", quantity: 1 });
    assert.ok([401, 403].includes(response.status));
  }
  for (const [body, expectedStatus] of [
    [{ requestId: "bad", mode: "add", quantity: 0 }, 400],
    [{ requestId: "bad", mode: "remove", quantity: 6 }, 409],
    [{ requestId: "bad", mode: "delete", quantity: 1 }, 400],
    [{ requestId: "bad", mode: "add", quantity: 1.5 }, 400],
    [{ requestId: "__proto__", mode: "add", quantity: 1 }, 400],
    [{ requestId: "bad", mode: "add", quantity: 1, actorId: "admin" }, 400],
  ]) assert.equal((await request("staff", "SUP-001", "POST", body)).status, expectedStatus);
  assert.equal((await request("admin", "bad/id", "PUT", { name: "Other", unit: "each" })).status, 400);
  assert.equal((await request("staff", "SUP-001", "POST", { requestId: "repeat", mode: "add", quantity: 1 })).status, 200);
  assert.equal((await request("staff", "SUP-001", "POST", { requestId: "repeat", mode: "add", quantity: 2 })).status, 409);
  assert.equal(state.root.supplies["SUP-001"].stock, 6);
  assert.equal(Object.keys(state.root.supplyStockTransactions || {}).length, 1);
  assert.equal({}.polluted, undefined);
});
