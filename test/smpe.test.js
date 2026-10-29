"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { registerSmpeRoutes, submitSmpe, mutateSmpe, __test: smpe } = require("../src/smpe-routes");
const { createStaffAccessGuard } = require("../src/queue-routes");
const NOW = Date.parse("2026-10-13T04:00:00Z");
const payload = { personalBackground: { firstName: "Synthetic", lastName: "Patient", sex: "Female" },
  medicalHistory: { tuberculosis: "yes", previousOperations: "no" }, medicalHistoryDetails: { tuberculosis: "Patient-provided detail" },
  physicalAssessment: { height: "158", remarks: "Patient-provided measurements" } };
function seed() {
  const root = { users: { patient_one: { role: "patient" }, patient_two: { role: "patient" },
    staff_one: { role: "staff", name: "Test Reviewer" }, staff_two: { role: "staff", name: "Second Reviewer" } } };
  submitSmpe(root, payload, { uid: "patient_one" }, { recordKey: "canonical_one", medicalRecordId: "SMPE-TEST-001" }, NOW);
  root.medicalRecords.canonical_one.id = "untrusted_embedded_id";
  return root;
}
function input(root) {
  return { expectedRevision: smpe.revision(root.medicalRecords.canonical_one),
    expectedSubmittedAt: smpe.submittedAt(root.medicalRecords.canonical_one), remarks: "Checked submitted form." };
}
function fixture(initial = seed()) {
  let state = structuredClone(initial), chain = Promise.resolve(), listenerCount = 0;
  const database = { ref(path = "") {
    const snapshot = () => ({ val: () => structuredClone(path ? path.split("/").reduce((value, key) => value?.[key], state) ?? null : state) });
    return {
      get: async () => snapshot(),
      on: (_, callback) => { listenerCount++; callback(snapshot()); },
      off: () => { listenerCount--; },
      transaction: update => {
        const job = chain.then(() => {
          assert.ok(listenerCount > 0, "live root snapshot must survive the transaction");
          const next = update(structuredClone(state));
          if (next === undefined) return { committed: false };
          state = next; return { committed: true };
        });
        chain = job.catch(() => {}); return job;
      },
    };
  } };
  let handler;
  registerSmpeRoutes({ patch: (_, callback) => { handler = callback; } }, { now: () => NOW + 1000 });
  const guard = createStaffAccessGuard({ getFirebaseApp: () => ({}), getDatabase: () => database,
    getAuth: () => ({ verifyIdToken: async (token, revoked) => {
      assert.equal(revoked, true);
      if (!state.users[token]) throw new Error("private auth failure");
      return { uid: token, role: "admin" }; // forged claim must not override saved role
    } }) });
  return { database, read: () => structuredClone(state), count: () => listenerCount, replace: next => { state = structuredClone(next); },
    async request(body = input(state), token = "staff_one", key = "canonical_one", withGuard = true) {
      let status = 200, response, allowed = false;
      const req = { body, params: { recordId: key }, headers: token ? { authorization: "Bearer " + token } : {} };
      const res = { set: () => res, status: code => { status = code; return res; }, json: value => { response = value; return res; } };
      if (withGuard) await guard(req, res, () => { allowed = true; });
      if (!withGuard || allowed) await handler(req, res);
      return { status, body: response };
    },
  };
}
test("approval stores an immutable full version and notifies only the owner", async () => {
  const f = fixture();
  const response = await f.request({ ...input(f.read()), reviewedBy: "forged", reviewerName: "forged", userId: "patient_two", status: "Rejected", personalBackground: {} });
  assert.equal(response.status, 200);
  const root = f.read(), record = root.medicalRecords.canonical_one;
  assert.equal(record.status, "Approved");
  assert.equal(record.reviewedBy, "staff_one");
  assert.equal(record.reviewerName, "Test Reviewer");
  assert.equal(record.reviewHistory.length, 1);
  assert.deepEqual(record.reviewHistory[0].medicalHistoryDetails, payload.medicalHistoryDetails);
  assert.deepEqual(record.reviewHistory[0].personalBackground, payload.personalBackground);
  assert.equal(response.body.record.recordKey, "canonical_one");
  assert.equal(root.notifications["smpe-review-canonical_one-r1"].userId, "patient_one");
  assert.equal(root.notifications["smpe-review-canonical_one-r1"].referenceId, "canonical_one");
  assert.equal(root.medicalRecords.untrusted_embedded_id, undefined);
  assert.ok(!JSON.stringify(root.auditLogs).includes("Patient-provided"));
  assert.ok(!JSON.stringify(root.notifications).includes("Patient-provided detail"));
  assert.equal(f.count(), 0);
});
test("patients, absent middleware, disabled, blocked and deleted staff cannot approve", async () => {
  for (const mode of ["patient", "missing-token", "missing-middleware", "disabled", "blocked", "deleted"]) {
    const root = seed();
    if (mode === "disabled") root.users.staff_one.active = false;
    if (mode === "blocked") root.users.staff_one.accountStatus = "blocked";
    if (mode === "deleted") root.users.staff_one.deletedAt = new Date(NOW).toISOString();
    const f = fixture(root), before = f.read();
    const response = await f.request(input(root), mode === "patient" ? "patient_one" : mode === "missing-token" ? "" : "staff_one",
      "canonical_one", mode !== "missing-middleware");
    assert.ok([401, 403].includes(response.status), mode);
    assert.deepEqual(f.read(), before);
  }
});
test("saved-role recheck rejects access revoked between auth and transaction", () => {
  const root = seed(); root.users.staff_one.role = "patient";
  assert.throws(() => smpe.approveSmpe(root, "canonical_one", input(root), { uid: "staff_one", role: "admin" }, NOW), error => error.status === 403);
});
test("canonical keys and valid expected versions are required; unsafe or missing IDs never write", async () => {
  for (const [key, body] of [["../canonical_one", input(seed())], ["__proto__", input(seed())], ["untrusted_embedded_id", input(seed())], ["canonical_one", {}],
    ["canonical_one", { expectedRevision: 1.1, expectedSubmittedAt: smpe.submittedAt(seed().medicalRecords.canonical_one) }],
    ["canonical_one", { ...input(seed()), remarks: "x".repeat(2001) }]]) {
    const f = fixture(), before = f.read(), result = await f.request(body, "staff_one", key);
    assert.ok([400, 404].includes(result.status)); assert.deepEqual(f.read(), before); assert.equal(f.count(), 0);
  }
});
test("legacy pending forms without revision are reviewable as revision one", async () => {
  const root = seed(); delete root.medicalRecords.canonical_one.revision;
  const f = fixture(root); assert.equal((await f.request(input(root))).status, 200);
  assert.equal(f.read().medicalRecords.canonical_one.reviewHistory[0].revision, 1);
});
test("two concurrent staff approvals are idempotent and keep the first reviewer", async () => {
  const f = fixture(), expected = input(f.read());
  const replies = await Promise.all([f.request(expected, "staff_one"), f.request(expected, "staff_two")]);
  assert.equal(replies.filter(reply => reply.body.duplicate).length, 1);
  assert.equal(f.read().medicalRecords.canonical_one.reviewHistory.length, 1);
  assert.equal(f.read().medicalRecords.canonical_one.reviewedBy, "staff_one");
  assert.equal(Object.values(f.read().auditLogs).filter(row => row.action === "smpe_approved").length, 1);
  assert.equal(Object.keys(f.read().auditLogs).length, 2); // Submission + one approval.
  assert.equal(f.count(), 0);
});
test("patient resubmission preserves the exact approved history while current form becomes pending", async () => {
  const f = fixture(); await f.request();
  await mutateSmpe(f.database, root => submitSmpe(root, { ...payload, personalBackground: { firstName: "Updated", lastName: "Patient" } },
    { uid: "patient_one" }, { recordKey: "canonical_one", editing: true }, NOW + 2000));
  const record = f.read().medicalRecords.canonical_one;
  assert.equal(record.revision, 2); assert.equal(record.status, "Pending Review");
  assert.equal(record.reviewedAt, undefined); assert.equal(record.reviewedBy, undefined);
  assert.equal(record.reviewHistory[0].personalBackground.firstName, "Synthetic");
  assert.equal(record.reviewHistory[0].reviewedBy, "staff_one");
  assert.equal(record.personalBackground.firstName, "Updated");
  assert.equal(record.revisionHistory.length, 1);
  assert.ok(f.read().notifications["smpe-canonical_one-r2"]);
});
test("resubmission followed by an approval of the old version returns conflict, not a false approval", async () => {
  const f = fixture(), expected = input(f.read());
  await mutateSmpe(f.database, root => submitSmpe(root, payload, { uid: "patient_one" }, { recordKey: "canonical_one", editing: true }, NOW + 2000));
  const before = f.read(), result = await f.request(expected);
  assert.equal(result.status, 409); assert.equal(result.body.code, "SMPE_STALE"); assert.deepEqual(f.read(), before);
});
test("same revision with a changed submission timestamp cannot be approved", async () => {
  const f = fixture(), old = input(f.read()), root = f.read(); root.medicalRecords.canonical_one.submittedAt = new Date(NOW + 2000).toISOString(); f.replace(root);
  assert.equal((await f.request(old)).status, 409);
});
test("a patient cannot edit another patient's form or inject review metadata", () => {
  const root = seed(), before = structuredClone(root);
  assert.throws(() => submitSmpe(root, payload, { uid: "patient_two" }, { recordKey: "canonical_one", editing: true }, NOW), error => error.status === 403);
  assert.deepEqual(root, before);
  const result = submitSmpe(root, { ...payload, status: "Approved", reviewHistory: [{}], reviewedBy: "forged", userId: "patient_two" },
    { uid: "patient_one" }, { recordKey: "new_record", medicalRecordId: "SMPE-TEST-002" }, NOW);
  assert.equal(result.record.status, "Pending Review"); assert.equal(result.record.reviewedBy, undefined); assert.equal(result.record.reviewHistory, undefined);
  assert.equal(result.record.userId, "patient_one");
});
test("completed legacy forms are captured on edit, with all answers, no duplicate history", () => {
  const root = seed(); root.medicalRecords.canonical_one.status = "Approved"; root.medicalRecords.canonical_one.reviewedBy = "old_reviewer";
  submitSmpe(root, payload, { uid: "patient_one" }, { recordKey: "canonical_one", editing: true }, NOW + 1000);
  assert.equal(root.medicalRecords.canonical_one.reviewHistory.length, 1);
  smpe.approveSmpe(root, "canonical_one", input(root), { uid: "staff_one" }, NOW + 2000);
  assert.equal(root.medicalRecords.canonical_one.reviewHistory.length, 2);
});
test("mobile submissions create separate patient and staff notices with stable version IDs", () => {
  const root = seed();
  assert.equal(root.notifications["smpe-canonical_one-r1"].userId, "desktop-staff");
  assert.equal(root.notifications["smpe-canonical_one-r1-patient"].userId, "patient_one");
  assert.equal(root.notifications["smpe-canonical_one-r1"].referenceId, "canonical_one");
  assert.equal(Object.keys(root.notifications).length, 2);
});
