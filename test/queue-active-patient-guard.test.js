"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { __test: queue } = require("../src/queue-routes");
const CLINIC = "clinic_1234567890abcdef1234567890abcdef";
const now = Date.parse("2026-10-24T08:00:00+08:00"), actor = { uid: "synthetic-staff", role: "staff" };
function seed() {
  return { users: { one: { role: "patient", fullName: "Synthetic Patient" }, two: { role: "patient", fullName: "Synthetic Patient" } },
    patientProfiles: { [CLINIC]: { recordId: CLINIC, recordKind: "clinic_only", fullName: "Synthetic Patient" } }, queueEntries: {} };
}
function input(identity = {}) { return { ...identity, patientName: "Synthetic Patient", serviceName: "ECG", floor: "1st Floor", room: "Room 101" }; }
test("active patient identity blocks another service/day without adding a ticket or audit record", () => {
  for (const identity of [{ userId: "one" }, { clinicRecordId: CLINIC }]) for (const status of ["waiting", "called", "in_service", "in_consultation", "proceed_to_floor"]) {
    const root = seed(); queue.addQueueEntry(root, input(identity), actor, now, "first"); root.queueEntries.first.status = status;
    const before = JSON.stringify(root);
    assert.throws(() => queue.addQueueEntry(root, { ...input(identity), serviceName: "X-Ray" }, actor, now + 86400000, "second"), error => error.code === "QUEUE_PATIENT_ALREADY_QUEUED" && error.status === 409);
    assert.equal(JSON.stringify(root), before);
    const retry = queue.addQueueEntry(root, input(identity), actor, now + 86400000, "first");
    assert.equal(retry.duplicate, true); assert.equal(retry.entry.id, "first");
  }
});
test("completed/cancelled/skipped/deleted tickets do not block a new visit", () => {
  for (const status of ["done", "completed", "cancelled", "canceled", "skipped"]) {
    const root = seed(); queue.addQueueEntry(root, input({ userId: "one" }), actor, now, "first"); root.queueEntries.first.status = status;
    assert.equal(queue.addQueueEntry(root, { ...input({ userId: "one" }), serviceName: "X-Ray" }, actor, now, "second").duplicate, false);
  }
  const root = seed(); queue.addQueueEntry(root, input({ userId: "one" }), actor, now, "first"); root.queueEntries.first.deletedAt = new Date(now).toISOString();
  assert.equal(queue.addQueueEntry(root, input({ userId: "one" }), actor, now, "second").duplicate, false);
});
test("walk-in duplicate names ignore case/spacing, but distinct saved identities can share a name", () => {
  const root = seed(); queue.addQueueEntry(root, input(), actor, now, "walkin");
  assert.throws(() => queue.addQueueEntry(root, { ...input(), patientName: "  SYNTHETIC   patient ", serviceName: "X-Ray" }, actor, now, "repeat"), error => error.code === "QUEUE_PATIENT_ALREADY_QUEUED");
  assert.equal(queue.addQueueEntry(root, input({ userId: "one" }), actor, now, "one").duplicate, false);
  assert.equal(queue.addQueueEntry(root, input({ userId: "two" }), actor, now, "two").duplicate, false);
  assert.equal(queue.addQueueEntry(root, input({ clinicRecordId: CLINIC }), actor, now, "clinic").duplicate, false);
  assert.equal(Object.keys(root.queueEntries).length, 4);
});
