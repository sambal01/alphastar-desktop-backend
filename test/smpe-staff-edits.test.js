'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSmpeRoutes, submitSmpe, mutateSmpe, __test: smpe } = require('../src/smpe-routes');
const { createStaffAccessGuard } = require('../src/queue-routes');
const NOW = Date.parse('2026-10-19T02:00:00Z');
const payload = { personalBackground: { firstName: 'Synthetic', lastName: 'Patient', sex: 'Female', age: '18', dateOfBirth: '2008-01-01' }, medicalHistory: { tuberculosis: 'yes' }, medicalHistoryDetails: { tuberculosis: 'Fictional earlier answer' }, physicalAssessment: { height: '158', weight: '52' } };
function seed() {
  const root = { users: { patient: { role: 'patient' }, other: { role: 'patient' }, reviewer: { role: 'staff', name: 'Synthetic Reviewer' }, second: { role: 'staff', name: 'Second Reviewer' } } };
  submitSmpe(root, payload, { uid: 'patient' }, { recordKey: 'test_record', medicalRecordId: 'SMPE-TEST' }, NOW);
  return root;
}
function input(root, extra = {}) {
  return { expectedRevision: smpe.revision(root.medicalRecords.test_record), expectedSubmittedAt: smpe.submittedAt(root.medicalRecords.test_record), reason: 'Corrected a fictional entry after checking the form.', physicalAssessment: { height: '160' }, ...extra };
}
function fixture(initial = seed()) {
  let state = structuredClone(initial), chain = Promise.resolve(), listeners = 0;
  const database = { ref(path = '') {
    const snapshot = () => ({ val: () => structuredClone(path ? path.split('/').reduce((value, key) => value?.[key], state) ?? null : state) });
    return { get: async () => snapshot(), on: (_, callback) => { listeners++; callback(snapshot()); }, off: () => { listeners--; }, transaction: update => {
      const job = chain.then(() => { assert.ok(listeners > 0); const next = update(structuredClone(state)); if (next === undefined) return { committed: false }; state = next; return { committed: true }; });
      chain = job.catch(() => {}); return job;
    } };
  } };
  const routes = new Map(); registerSmpeRoutes({ patch: (route, callback) => routes.set(route, callback) }, { now: () => NOW + 1000 });
  const guard = createStaffAccessGuard({ getFirebaseApp: () => ({}), getDatabase: () => database, getAuth: () => ({ verifyIdToken: async (token, revoked) => { assert.equal(revoked, true); if (!state.users[token]) throw new Error('Private failure'); return { uid: token, role: 'admin' }; } }) });
  return { read: () => structuredClone(state), database, count: () => listeners, async request(body = input(state), token = 'reviewer', withGuard = true, key = 'test_record') {
    let status = 200, response, allowed = false, cache;
    const req = { params: { recordId: key }, body, headers: token ? { authorization: 'Bearer ' + token } : {} };
    const res = { set: (name, value) => { if (name === 'Cache-Control') cache = value; return res; }, status: code => { status = code; return res; }, json: value => { response = value; return res; } };
    if (withGuard) await guard(req, res, () => { allowed = true; });
    if (!withGuard || allowed) await routes.get('/api/staff/medical-records/:recordId/assessment')(req, res);
    return { status, body: response, cache };
  } };
}
test('staff corrections preserve original answers, ownership, submission time and saved review history', async () => {
  const root = seed();
  smpe.approveSmpe(root, 'test_record', { ...input(root), remarks: 'Fictional review' }, { uid: 'reviewer' }, NOW + 1000);
  submitSmpe(root, payload, { uid: 'patient' }, { recordKey: 'test_record', editing: true }, NOW + 2000);
  const old = structuredClone(root.medicalRecords.test_record), f = fixture(root);
  const response = await f.request(input(root));
  assert.equal(response.status, 200); assert.equal(response.cache, 'no-store');
  const record = f.read().medicalRecords.test_record;
  assert.equal(record.revision, 3); assert.equal(record.status, 'Pending Review'); assert.equal(record.userId, 'patient');
  assert.equal(record.submittedAt, old.submittedAt); assert.equal(record.source, 'mobile');
  assert.deepEqual(record.personalBackground, old.personalBackground); assert.deepEqual(record.medicalHistory, old.medicalHistory); assert.deepEqual(record.medicalHistoryDetails, old.medicalHistoryDetails);
  assert.equal(record.physicalAssessment.height, '160'); assert.equal(record.physicalAssessment.weight, '52');
  assert.deepEqual(record.reviewHistory, old.reviewHistory); assert.equal(record.revisionHistory.at(-1).physicalAssessment.height, '158');
  assert.equal(record.revisionHistory.at(-1).personalBackground.firstName, 'Synthetic');
  assert.equal(record.lastEditedBy, 'reviewer'); assert.equal(record.lastEditorName, 'Synthetic Reviewer');
  assert.equal(record.reviewedBy, undefined); assert.equal(response.body.record.recordKey, 'test_record'); assert.equal(f.count(), 0);
});
test('updates notify only the patient and audit changed field names without medical values or reason', async () => {
  const f = fixture(), result = await f.request(input(f.read(), { reason: 'Private fictional correction reason', physicalAssessment: { remarks: 'Private fictional clinical value' } }));
  assert.equal(result.status, 200);
  const root = f.read(), notice = root.notifications['smpe-edit-test_record-r2'];
  assert.equal(notice.userId, 'patient'); assert.equal(notice.source, 'desktop'); assert.equal(notice.referenceId, 'test_record');
  assert.equal(notice.revision, 2); assert.equal(notice.type, 'medical_record_updated');
  const audit = root.auditLogs['smpe-edit-test_record-r2']; assert.deepEqual(audit.details.changedFields, ['physicalAssessment.remarks']);
  assert.doesNotMatch(JSON.stringify(root.notifications) + JSON.stringify(root.auditLogs), /Private fictional/);
});
test('the correction reason is optional and blank reasons do not leave an empty saved comment', async () => {
  for (const mode of ['empty', 'omitted']) {
    const f = fixture(), body = input(f.read(), { reason: '', physicalAssessment: { weight: '53' } });
    if (mode === 'omitted') delete body.reason;
    const result = await f.request(body);
    assert.equal(result.status, 200, mode);
    const record = f.read().medicalRecords.test_record;
    assert.equal(record.physicalAssessment.weight, '53');
    assert.equal(record.lastEditReason, undefined);
  }
});
test('patients, missing guards, invalid tokens and inactive or revoked staff cannot update records', async () => {
  for (const mode of ['patient', 'missing', 'middleware', 'disabled', 'blocked', 'deleted', 'staff-disabled']) {
    const root = seed();
    if (mode === 'disabled') root.users.reviewer.disabled = true;
    if (mode === 'blocked') root.users.reviewer.status = 'blocked';
    if (mode === 'deleted') root.users.reviewer.deletedAt = 'date';
    if (mode === 'staff-disabled') root.staff = { reviewer: { accountStatus: 'inactive' } };
    const f = fixture(root), before = f.read();
    const result = await f.request(input(root), mode === 'patient' ? 'patient' : mode === 'missing' ? '' : 'reviewer', mode !== 'middleware');
    assert.ok([401, 403].includes(result.status), mode); assert.deepEqual(f.read(), before); assert.equal(f.count(), 0);
  }
  const root = seed(); root.users.reviewer.role = 'patient';
  assert.throws(() => smpe.updateSmpe(root, 'test_record', input(root), { uid: 'reviewer', role: 'admin' }, NOW), error => error.code === 'SMPE_FORBIDDEN');
});
test('unknown fields, forged metadata, invalid values and unsafe references never write', async () => {
  const cases = [
    { userId: 'other' }, { status: 'Approved' }, { lastEditedBy: 'other' }, { physicalAssessment: [] }, { medicalHistory: { tuberculosis: 'maybe' } },
    { physicalAssessment: { height: 160 } }, { physicalAssessment: { unknown: 'value' } }, { physicalAssessment: { height: 'x'.repeat(121) } },
    { personalBackground: { firstName: '' } }, { personalBackground: { emailAddress: 'invalid' } }, { personalBackground: { sex: 'unknown choice' } },
    { personalBackground: { dateOfBirth: '2026-02-31' } }, { personalBackground: { age: '-1' } }, { personalBackground: { guardianContactNumber: 'not a phone' } },
    { medicalHistory: { tuberculosis: '' } }, { reason: 42 }, { reason: 'x'.repeat(501) }, { expectedRevision: 1.1 },
    { physicalAssessment: JSON.parse('{"__proto__":"not allowed"}') }, { physicalAssessment: { height: { nested: 'value' } } },
  ];
  for (const extra of cases) {
    const f = fixture(), before = f.read(), result = await f.request(input(before, extra));
    assert.equal(result.status, 400, JSON.stringify(extra)); assert.deepEqual(f.read(), before); assert.equal(f.count(), 0);
  }
  for (const key of ['../test_record', '__proto__', 'constructor', 'missing_record']) {
    const f = fixture(), before = f.read(), result = await f.request(input(before), 'reviewer', true, key);
    assert.ok([400, 404].includes(result.status)); assert.deepEqual(f.read(), before);
  }
});
test('patient and guardian information and every medical-history field remain read-only in the API', async () => {
  for (const extra of [{ personalBackground: { firstName: 'Changed' } }, { personalBackground: { guardianName: 'Changed' } }, { medicalHistory: { tuberculosis: 'no' } }, { medicalHistoryDetails: { tuberculosis: 'Changed' } }]) {
    const f = fixture(), before = f.read(), result = await f.request(input(before, extra));
    assert.equal(result.status, 400); assert.deepEqual(f.read(), before);
  }
});
test('no-op edits preserve the record and do not create revisions, audit entries or notifications', async () => {
  const f = fixture(), before = f.read();
  const result = await f.request(input(before, { physicalAssessment: { height: '158', temperature: '' } }));
  assert.equal(result.status, 200); assert.equal(result.body.unchanged, true); assert.deepEqual(f.read(), before);
});
test('concurrent edits keep one new revision and reject the stale second update', async () => {
  const f = fixture(), first = input(f.read()), second = { ...first, physicalAssessment: { height: '161' } };
  const results = await Promise.all([f.request(first), f.request(second, 'second')]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(f.read().medicalRecords.test_record.revision, 2); assert.equal(f.read().medicalRecords.test_record.revisionHistory.length, 1);
  assert.equal(f.read().medicalRecords.test_record.physicalAssessment.height, '160'); assert.equal(f.count(), 0);
});
test('completed history and stale timestamps are read-only; edits never silently approve a form', async () => {
  const root = seed(), expected = input(root);
  smpe.approveSmpe(root, 'test_record', { ...expected, remarks: 'Fictional review' }, { uid: 'reviewer' }, NOW + 1000);
  const f = fixture(root), before = f.read(), completed = await f.request(expected);
  assert.equal(completed.status, 409); assert.equal(completed.body.code, 'SMPE_COMPLETED'); assert.deepEqual(f.read(), before);
  const staleRoot = seed(); staleRoot.medicalRecords.test_record.submittedAt = new Date(NOW + 2000).toISOString();
  assert.equal((await fixture(staleRoot).request(expected)).body.code, 'SMPE_STALE');
  const editRoot = seed(); smpe.updateSmpe(editRoot, 'test_record', input(editRoot), { uid: 'reviewer' }, NOW + 1000);
  assert.throws(() => smpe.approveSmpe(editRoot, 'test_record', { ...expected, remarks: 'Old review' }, { uid: 'reviewer' }, NOW + 2000), error => error.code === 'SMPE_STALE');
  assert.equal(editRoot.medicalRecords.test_record.status, 'Pending Review');
});
test('later patient resubmissions keep the clinic correction snapshot without impersonating its editor', () => {
  const root = seed(); smpe.updateSmpe(root, 'test_record', input(root), { uid: 'reviewer' }, NOW + 1000);
  submitSmpe(root, payload, { uid: 'patient' }, { recordKey: 'test_record', editing: true }, NOW + 2000);
  const record = root.medicalRecords.test_record;
  assert.equal(record.revision, 3); assert.equal(record.lastEditedBy, undefined);
  assert.equal(record.revisionHistory.at(-1).lastEditedBy, 'reviewer');
  assert.equal(record.revisionHistory.at(-1).physicalAssessment.height, '160');
});
