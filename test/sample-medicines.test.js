"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { SAMPLE_MEDICINES, addSamples, seedSamples } = require("../scripts/seed-sample-medicines");
const NOW = Date.parse("2026-10-25T04:00:00Z");

test("five samples have unique reserved IDs, explicit demo labels and positive whole stock, without invented expiry/prices", () => {
  assert.equal(SAMPLE_MEDICINES.length, 5); assert.equal(new Set(SAMPLE_MEDICINES.map(item => item.id)).size, 5);
  for (const item of SAMPLE_MEDICINES) {
    assert.match(item.id, /^SAMPLE-MED-00[1-5]$/); assert.match(item.name, /^SAMPLE - /);
    assert.ok(Number.isSafeInteger(item.stock) && item.stock > 0); assert.equal(item.sampleData, true);
    assert.match(item.location, /not for patient use/); assert.equal(item.expiry, ""); assert.equal(item.cost, 0); assert.equal(item.price, 0);
  }
});
test("sample insertion preserves real medicines, and reruns never reset quantities or user edits", () => {
  const original = { "MED-001": { name: "Existing medicine", stock: 23, privateLegacyField: "retain" } };
  const first = addSamples(original, NOW); assert.equal(first.added.length, 5); assert.deepEqual(first.inventory["MED-001"], original["MED-001"]);
  assert.deepEqual(original, { "MED-001": { name: "Existing medicine", stock: 23, privateLegacyField: "retain" } });
  first.inventory["SAMPLE-MED-001"].stock = 98; first.inventory["SAMPLE-MED-001"].location = "Edited demo location";
  const retry = addSamples(first.inventory, NOW + 1000);
  assert.equal(retry.added.length, 0); assert.equal(retry.existing.length, 5); assert.deepEqual(retry.inventory, first.inventory);
});
test("an occupied sample ID or malformed inventory aborts without overwriting or inventing entries", () => {
  const original = { "SAMPLE-MED-003": { name: "Real existing item", stock: 12 } };
  assert.throws(() => addSamples(original, NOW), /nothing was overwritten/); assert.equal(Object.keys(original).length, 1);
  for (const input of [[], "invalid", 5]) assert.throws(() => addSamples(input, NOW), /unexpected format/);
});
function fixture() {
  const state = { root: { inventory: { "MED-001": { name: "Existing real medicine", stock: 23 } }, users: { private: { role: "patient" } } }, writes: [], listeners: 0 };
  const database = { ref: path => {
    const get = () => path.split("/").reduce((value, key) => value?.[key], state.root) ?? null;
    return {
      async get() { return { val: () => structuredClone(get()) }; },
      on(_event, listener) { state.listeners++; listener(); }, off() { state.listeners--; },
      async transaction(update) {
        const next = update(structuredClone(get())); if (next === undefined) return { committed: false };
        const parts = path.split("/"), key = parts.pop(); let target = state.root;
        for (const part of parts) target = target[part] ||= {};
        target[key] = structuredClone(next); state.writes.push(path); return { committed: true };
      }
    };
  } };
  return { state, database };
}
test("dry run performs no writes; explicit apply adds only samples and one truthful system audit; retry preserves edits", async () => {
  const { state, database } = fixture(), users = structuredClone(state.root.users);
  const dry = await seedSamples(database, { now: NOW }); assert.equal(dry.mode, "dry-run"); assert.equal(dry.added.length, 5); assert.deepEqual(state.writes, []);
  const first = await seedSamples(database, { apply: true, now: NOW }); assert.equal(first.sampleRecordsVerified, 5);
  assert.deepEqual(state.writes, ["inventory", "auditLogs/inventory-samples-v1"]);
  assert.equal(state.root.inventory["MED-001"].stock, 23); assert.deepEqual(state.root.users, users);
  const audit = structuredClone(state.root.auditLogs); assert.equal(audit["inventory-samples-v1"].actorRole, "system");
  state.root.inventory["SAMPLE-MED-001"].stock = 97;
  const second = await seedSamples(database, { apply: true, now: NOW + 1000 });
  assert.equal(second.added.length, 0); assert.equal(state.root.inventory["SAMPLE-MED-001"].stock, 97);
  assert.deepEqual(state.root.auditLogs, audit); assert.equal(state.writes.filter(path => path === "inventory").length, 1); assert.equal(state.listeners, 0);
});
