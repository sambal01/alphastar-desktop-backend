"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStaffAccountPin, ITERATIONS } = require("../src/staff-account-pin");

const password = { uid: "password-patient", authProviderId: "password" };
const google = { uid: "second-staff", authProviderId: "password" };
function fixture() {
  const records = new Map();
  let time = 1_000_000;
  const database = { ref: key => ({ key, get: async () => ({ val: () => structuredClone(records.get(key) || null) }) }) };
  const transact = async (ref, update) => {
    const value = update(structuredClone(records.get(ref.key) || null));
    if (value === undefined) return { committed: false };
    records.set(ref.key, structuredClone(value));
    return { committed: true };
  };
  const options = { enabled: true, pepper: "a".repeat(64), getDatabase: () => database, now: () => time, transact };
  return { records, options, pins: createStaffAccountPin(options), advance: ms => { time += ms; } };
}

test("account PIN stores only a salted, slow, UID-bound peppered verifier", async () => {
  const f = fixture();
  await f.pins.create(password, "012345");
  const stored = [...f.records.values()][0];
  assert.equal(stored.iterations, ITERATIONS);
  assert.equal(stored.iterations, 600_000);
  assert.match(stored.salt, /^[a-f0-9]{64}$/);
  assert.match(stored.verifier, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(stored).includes("012345"), false);
  assert.deepEqual(await f.pins.status(password), { configured: true });
  assert.deepEqual(await f.pins.status(google), { configured: false });
  await f.pins.verify(password, "012345");
  await assert.rejects(f.pins.verify(password, "012346"), { code: "STAFF_PIN_INCORRECT" });
});

test("PIN survives a service restart/new device; staff accounts remain isolated", async () => {
  const f = fixture();
  await f.pins.create(password, "012345");
  await f.pins.create(google, "987654");
  const fresh = createStaffAccountPin(f.options);
  await fresh.verify(password, "012345");
  await fresh.verify(google, "987654");
  await assert.rejects(fresh.verify(google, "012345"), { code: "STAFF_PIN_INCORRECT" });
  const otherAccount = { ...password, uid: "another-staff" };
  assert.deepEqual(await fresh.status(otherAccount), { configured: false });
});

test("enrollment cannot replace an existing PIN, including concurrent create requests", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.pins.create(password, "123456"), f.pins.create(password, "654321")]);
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(results.find(value => value.status === "rejected").reason.code, "STAFF_PIN_EXISTS");
  const accepted = results[0].status === "fulfilled" ? "123456" : "654321";
  await f.pins.verify(password, accepted);
});

test("invalid input and disabled/missing pepper never create a record", async () => {
  const f = fixture();
  for (const value of [123456, "12345", "1234567", "abc123", ""]) {
    await assert.rejects(f.pins.create(password, value), { code: "STAFF_PIN_INVALID" });
  }
  for (const options of [{ enabled: false }, { pepper: "" }, { pepper: "short" }]) {
    await assert.rejects(createStaffAccountPin({ ...f.options, ...options }).status(password), { code: "STAFF_ACCOUNT_PIN_UNAVAILABLE" });
  }
  assert.equal(f.records.size, 0);
});

test("persistent attempt limits survive restart and serialize simultaneous checks", async () => {
  const f = fixture();
  await f.pins.create(password, "123456");
  const requests = await Promise.allSettled(Array.from({ length: 4 }, () => f.pins.verify(password, "000000")));
  assert.equal(requests.filter(value => value.reason.code === "STAFF_PIN_INCORRECT").length, 1);
  assert.equal([...f.records.values()][0].failures, 1);
  for (let failure = 2; failure <= 10; failure++) {
    f.advance(900_001);
    await assert.rejects(createStaffAccountPin(f.options).verify(password, "000000"), { code: "STAFF_PIN_INCORRECT" });
  }
  f.advance(900_001);
  await assert.rejects(f.pins.verify(password, "123456"), { code: "STAFF_PIN_LOCKED" });
  const grant = await f.pins.issueResetGrant(password);
  await f.pins.reset(password, "654321", grant);
  await f.pins.verify(password, "654321");
});

test("delay applies after five failures and a successful allowed check clears counters", async () => {
  const f = fixture();
  await f.pins.create(password, "123456");
  for (let i = 0; i < 5; i++) await assert.rejects(f.pins.verify(password, "000000"));
  await assert.rejects(f.pins.verify(password, "123456"), { code: "STAFF_PIN_LOCKED" });
  f.advance(30_001);
  await f.pins.verify(password, "123456");
  const stored = [...f.records.values()][0];
  assert.equal(stored.failures, 0); assert.equal(stored.blockedUntil, 0);
});

test("reset grants are one-use, expire, and cannot reset another UID", async () => {
  const f = fixture();
  await f.pins.create(password, "123456");
  await f.pins.create(google, "111111");
  const token = await f.pins.issueResetGrant(password);
  assert.equal(JSON.stringify([...f.records.values()]).includes(token), false);
  await assert.rejects(f.pins.reset(google, "222222", token), { code: "STAFF_PIN_RESET_REQUIRED" });
  await assert.rejects(f.pins.reset(password, "222222", ""), { code: "STAFF_PIN_RESET_REQUIRED" });
  await f.pins.reset(password, "222222", token);
  await assert.rejects(f.pins.reset(password, "333333", token), { code: "STAFF_PIN_RESET_REQUIRED" });
  await assert.rejects(f.pins.verify(password, "123456"), { code: "STAFF_PIN_INCORRECT" });
  await f.pins.verify(password, "222222");
  await f.pins.verify(google, "111111");
  const expired = await f.pins.issueResetGrant(password);
  f.advance(300_001);
  await assert.rejects(f.pins.reset(password, "333333", expired), { code: "STAFF_PIN_RESET_REQUIRED" });
});

test("simultaneous resets consume a grant only once", async () => {
  const f = fixture();
  const token = await f.pins.issueResetGrant(password);
  const attempts = await Promise.allSettled([f.pins.reset(password, "123456", token), f.pins.reset(password, "654321", token)]);
  assert.equal(attempts.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(attempts.find(value => value.status === "rejected").reason.code, "STAFF_PIN_RESET_REQUIRED");
});

test("changing the pepper does not accept the old verifier; recovery can restore access", async () => {
  const f = fixture(); await f.pins.create(password, "123456");
  const changed = createStaffAccountPin({ ...f.options, pepper: "b".repeat(64) });
  await assert.rejects(changed.verify(password, "123456"), { code: "STAFF_PIN_INCORRECT" });
  await changed.reset(password, "123456", await changed.issueResetGrant(password));
  await changed.verify(password, "123456");
});

test("a reset racing verification cannot unlock using the previous PIN", async () => {
  const f = fixture(); await f.pins.create(password, "123456");
  const token = await f.pins.issueResetGrant(password);
  const checking = f.pins.verify(password, "123456");
  // Replace the revision inside the final verification transaction to model a
  // concurrent reset; the reserved check must fail closed, not enter Home.
  const altered = createStaffAccountPin({ ...f.options, transact: async (ref, updater) => {
    const current = f.records.get(ref.key);
    if (current?.attempt) f.records.set(ref.key, { ...current, revision: "f".repeat(32) });
    return f.options.transact(ref, updater);
  } });
  await checking;
  await assert.rejects(altered.verify(password, "123456"), { code: "STAFF_PIN_CHANGED" });
  await f.pins.reset(password, "654321", token);
});

test("changing a PIN requires a correct current PIN and consumes its approval once", async () => {
  const f = fixture(); await f.pins.create(password, "012345");
  await assert.rejects(f.pins.change(password, "654321", "a".repeat(64)), { code: "STAFF_PIN_CHANGE_REQUIRED" });
  await assert.rejects(f.pins.beginChange(password, "012346"), { code: "STAFF_PIN_INCORRECT" });
  assert.equal([...f.records.values()][0].changeGrant, undefined);
  const grant = await f.pins.beginChange(password, "012345");
  assert.match(grant.changeToken, /^[a-f0-9]{64}$/);
  assert.equal(grant.expiresAt, 1_300_000);
  const row = [...f.records.values()][0];
  assert.equal(JSON.stringify(row).includes(grant.changeToken), false);
  assert.equal(row.changeGrant.revision, row.revision);
  await f.pins.change(password, "654321", grant.changeToken);
  assert.equal([...f.records.values()][0].changeGrant, undefined);
  await f.pins.verify(password, "654321");
  await assert.rejects(f.pins.verify(password, "012345"), { code: "STAFF_PIN_INCORRECT" });
  await assert.rejects(f.pins.change(password, "111111", grant.changeToken), { code: "STAFF_PIN_CHANGE_REQUIRED" });
});

test("change approval survives restart but is isolated by UID and expires", async () => {
  const f = fixture(); await f.pins.create(password, "012345"); await f.pins.create(google, "234567");
  const grant = await f.pins.beginChange(password, "012345");
  const restarted = createStaffAccountPin(f.options);
  await assert.rejects(restarted.change(google, "654321", grant.changeToken), { code: "STAFF_PIN_CHANGE_REQUIRED" });
  await assert.rejects(restarted.change({ ...password, uid: "another-staff" }, "654321", grant.changeToken), { code: "STAFF_PIN_CHANGE_REQUIRED" });
  f.advance(300_000);
  await assert.rejects(restarted.change(password, "654321", grant.changeToken), { code: "STAFF_PIN_CHANGE_REQUIRED" });
  await restarted.verify(password, "012345");
});

test("a recovery or competing change invalidates old approvals and concurrent changes have one winner", async () => {
  const f = fixture(); await f.pins.create(password, "012345");
  const old = await f.pins.beginChange(password, "012345");
  await f.pins.reset(password, "654321", await f.pins.issueResetGrant(password));
  await assert.rejects(f.pins.change(password, "111111", old.changeToken), { code: "STAFF_PIN_CHANGE_REQUIRED" });
  const grant = await f.pins.beginChange(password, "654321");
  const results = await Promise.allSettled([f.pins.change(password, "112233", grant.changeToken), f.pins.change(password, "332211", grant.changeToken)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected")[0].reason.code, "STAFF_PIN_CHANGE_REQUIRED");
});

test("ordinary verify and forged extra arguments never issue a change approval", async () => {
  const f = fixture(); await f.pins.create(password, "012345");
  assert.equal(await f.pins.verify(password, "012345", true), undefined);
  assert.equal([...f.records.values()][0].changeGrant, undefined);
  const grant = await f.pins.beginChange(password, "012345");
  const key = [...f.records.keys()][0];
  f.records.set(key, { ...f.records.get(key), revision: "a".repeat(32) });
  await assert.rejects(f.pins.change(password, "654321", grant.changeToken), { code: "STAFF_PIN_CHANGE_REQUIRED" });
});
