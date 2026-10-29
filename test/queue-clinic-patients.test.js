"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { __test: queue } = require("../src/queue-routes");
const ID = "clinic_1234567890abcdef1234567890abcdef", OTHER = "clinic_abcdef1234567890abcdef1234567890";
const NOW = Date.parse("2026-10-24T08:00:00+08:00"), actor = { uid: "synthetic-staff", role: "staff" };
function seed() {
  return { users: { "synthetic-staff": { role: "staff" }, patient_one: { role: "patient" } },
    patientProfiles: { [ID]: { recordId: ID, recordKind: "clinic_only", patientNumber: "PAT-C-ONE", fullName: "Same Synthetic Name" },
      [OTHER]: { recordId: OTHER, recordKind: "clinic_only", patientNumber: "PAT-C-TWO", fullName: "Same Synthetic Name" } }, queueEntries: {} };
}
function input(patch = {}) { return { clinicRecordId: ID, patientName: "Forged Name", serviceName: "ECG", floor: "1st Floor", room: "Room 101", ...patch }; }
test("clinic-only queue link preserves the real patient record ID/name without inventing a mobile UID/account", () => {
  const root = seed(), users = structuredClone(root.users), profiles = structuredClone(root.patientProfiles);
  const { entry } = queue.addQueueEntry(root, input(), actor, NOW, "queue_1");
  assert.equal(entry.clinicRecordId, ID); assert.equal(entry.userId, ""); assert.equal(entry.patientName, "Same Synthetic Name"); assert.equal(entry.patientNumber, "PAT-C-ONE");
  assert.deepEqual(root.users, users); assert.deepEqual(root.patientProfiles, profiles);
});
test("same patient/service/day retries return one queue; namesakes stay separate and a second active service is blocked", () => {
  const root = seed(), first = queue.addQueueEntry(root, input(), actor, NOW, "queue_1");
  const duplicate = queue.addQueueEntry(root, input(), actor, NOW, "queue_retry"); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.entry.id, first.entry.id);
  const other = queue.addQueueEntry(root, input({ clinicRecordId: OTHER }), actor, NOW, "queue_2"); assert.equal(other.duplicate, false);
  assert.throws(() => queue.addQueueEntry(root, input({ serviceName: "X-Ray" }), actor, NOW, "queue_3"), error => error.code === "QUEUE_PATIENT_ALREADY_QUEUED" && error.status === 409);
  assert.equal(Object.keys(root.queueEntries).length, 2);
});
test("unsafe/missing/deleted/linked/conflicting clinic identities cannot create or retarget a queue", () => {
  for (const clinicRecordId of [false, 0, {}, [], "patient_one", "__proto__", "clinic_missing", "clinic_" + "0".repeat(32)]) {
    const root = seed(); assert.throws(() => queue.addQueueEntry(root, input({ clinicRecordId }), actor, NOW, "queue_1")); assert.equal(Object.keys(root.queueEntries).length, 0);
  }
  for (const profilePatch of [{ userId: "patient_one" }, { deletedAt: "2026-10-23T00:00:00Z" }, { recordKind: "mobile" }, { recordId: OTHER }]) {
    const root = seed(); Object.assign(root.patientProfiles[ID], profilePatch);
    assert.throws(() => queue.addQueueEntry(root, input(), actor, NOW, "queue_1"));
  }
  const root = seed(); assert.throws(() => queue.addQueueEntry(root, input({ userId: "patient_one" }), actor, NOW, "queue_1"));
  queue.addQueueEntry(root, input(), actor, NOW, "queue_1"); root.queueEntries.queue_1.status = "cancelled";
  assert.throws(() => queue.addQueueEntry(root, input({ clinicRecordId: OTHER }), actor, NOW, "queue_1"), /already in use/);
});
test("public queue data does not expose clinic record identity or patient numbers", () => {
  const root = seed(); queue.addQueueEntry(root, input(), actor, NOW, "queue_1");
  const publicData = JSON.stringify(queue.liveSnapshot(root, "another-patient", NOW));
  assert.ok(!publicData.includes(ID)); assert.ok(!publicData.includes("PAT-C-ONE"));
});
