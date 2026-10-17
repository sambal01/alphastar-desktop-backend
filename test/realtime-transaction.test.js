"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { transactionWithLiveSnapshot } = require("../src/realtime-transaction");

test("transaction waits for a complete value, retains its listener through retries, and cleans up", async () => {
  let listener;
  let started = false;
  const snapshots = [{ revision: 1, appointments: { apt: { status: "pending" } } }, { revision: 2, appointments: { apt: { status: "approved" } } }];
  const seen = [];
  const ref = {
    on(event, callback) { assert.equal(event, "value"); listener = callback; },
    off(event, callback) { assert.equal(event, "value"); assert.equal(callback, listener); listener = null; },
    async transaction(update, onComplete, applyLocally) {
      started = true;
      assert.equal(typeof listener, "function");
      assert.equal(applyLocally, false);
      update(structuredClone(snapshots[0])); // This proposal loses a server race.
      await Promise.resolve();
      assert.equal(typeof listener, "function", "the cache stays available during a retry");
      const committed = update(structuredClone(snapshots[1]));
      return { committed: true, snapshot: { val: () => committed } };
    },
  };
  const pending = transactionWithLiveSnapshot(ref, (current) => {
    seen.push(current.revision);
    current.appointments.apt.status = "completed";
    return current;
  });
  await Promise.resolve();
  assert.equal(started, false, "an initial empty or partial cache must not reach validation");
  listener({ val: () => snapshots[0] });
  const result = await pending;
  assert.deepEqual(seen, [1, 2]);
  assert.equal(result.snapshot.val().revision, 2);
  assert.equal(result.snapshot.val().appointments.apt.status, "completed");
  assert.equal(listener, null);
});

test("a confirmed empty database is passed to validation instead of being mistaken for an unloaded cache", async () => {
  let detached = false;
  const ref = {
    on(event, callback) { callback({ val: () => null }); },
    off() { detached = true; },
    async transaction(update) {
      const next = update(null);
      return { committed: next !== undefined, snapshot: { val: () => next } };
    },
  };
  const result = await transactionWithLiveSnapshot(ref, (current) => {
    assert.equal(current, null);
    return { services: { consultation: { status: "active" } } };
  });
  assert.equal(result.committed, true);
  assert.equal(detached, true);
});

test("an aborted transaction releases its retained listener", async () => {
  let detached = false;
  const ref = {
    on(event, callback) { callback({ val: () => ({ appointments: {} }) }); },
    off() { detached = true; },
    async transaction(update) { return { committed: update({ appointments: {} }) !== undefined }; },
  };
  const result = await transactionWithLiveSnapshot(ref, () => undefined);
  assert.equal(result.committed, false);
  assert.equal(detached, true);
});

test("transaction connection failures release their retained listener", async () => {
  let detached = false;
  const failure = new Error("connection lost");
  const ref = {
    on(event, callback) { callback({ val: () => ({}) }); },
    off() { detached = true; },
    async transaction() { throw failure; },
  };
  await assert.rejects(transactionWithLiveSnapshot(ref, () => ({})), failure);
  assert.equal(detached, true);
});

test("initial read failures release their listener without running a mutation", async () => {
  let detached = false;
  let mutated = false;
  const failure = new Error("permission denied");
  const ref = {
    on(event, callback, cancel) { queueMicrotask(() => cancel(failure)); },
    off() { detached = true; },
    async transaction() { mutated = true; },
  };
  await assert.rejects(transactionWithLiveSnapshot(ref, () => ({})), failure);
  assert.equal(mutated, false);
  assert.equal(detached, true);
});
