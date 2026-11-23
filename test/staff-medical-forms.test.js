"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const forms = require('../src/staff-medical-forms'), smpe = require('../src/smpe-routes');
const { __test: clinical } = require('../src/clinical-records');
const { createStaffAccessGuard } = require('../src/queue-routes');
const NOW = Date.parse('2026-11-16T01:00:00Z'), KEY = 'form_' + '1'.repeat(32), CLINIC = 'clinic_' + '2'.repeat(32);
function seed() {
  return { users: { admin: { role: 'admin', name: 'Synthetic Administrator' }, staff: { role: 'staff', name: 'Synthetic Staff' }, doctor: { role: 'doctor' }, patient: { role: 'patient' }, other: { role: 'patient' } },
    patientProfiles: { [CLINIC]: { recordKind: 'clinic_only', recordId: CLINIC, patientNumber: 'PAT-CLINIC', createdAt: '2026-10-01T00:00:00Z', fullName: 'Original Name' } },
    patientAdmissions: { patient: { userId: 'patient', firstApprovedAt: '2026-10-02T00:00:00Z' } }, clinicalVisits: { saved: { id: 'saved', clinicRecordId: CLINIC, status: 'released' } } };
}
function input(type = 'smape', mobile = false) { return { ...(mobile ? { userId: 'patient' } : { clinicRecordId: CLINIC }), examinationType: type,
  personalBackground: { firstName: 'Synthetic', lastName: 'Patient', age: '20', sex: 'Female', dateOfBirth: '2006-01-01', contactNumber: '09123456789', presentAddress: 'Synthetic Address', ...(type === 'smape' ? { guardianName: 'Synthetic Guardian' } : { requestedBy: '' }) },
  medicalHistory: { asthmaLungDisease: 'yes' }, medicalHistoryDetails: { asthmaLungDisease: 'Synthetic history' }, physicalAssessment: { weight: '60', bloodPressure: '120/80' } }; }
function edit(record, values = {}) { return { expectedRevision: record.revision, expectedSubmittedAt: record.submittedAt,
  personalBackground: { ...record.personalBackground, firstName: 'Updated' }, medicalHistory: { ...record.medicalHistory, asthmaLungDisease: 'no' }, medicalHistoryDetails: { asthmaLungDisease: '' }, physicalAssessment: { ...record.physicalAssessment, weight: '65' }, reason: 'Synthetic correction', ...values }; }
for (const type of ['smape', 'mape']) for (const mobile of [false, true]) test(type + ' returning-patient form accepts only new vitals and copies its own saved information (' + (mobile ? 'mobile' : 'clinic-only') + ')', () => {
  const root = seed(), first = forms.create(root, KEY, input(type, mobile), { uid: 'staff' }, NOW).record;
  const before = structuredClone(root.medicalRecords[KEY]), key = 'form_' + '4'.repeat(32);
  const payload = { ...(mobile ? { userId: 'patient' } : { clinicRecordId: CLINIC }), sourceFormKey: KEY, expectedSourceRevision: 1, expectedSourceSubmittedAt: first.submittedAt, physicalAssessment: { height: '165', weight: '65', bloodPressure: '110/70' } };
  const next = forms.create(root, key, payload, { uid: 'staff' }, NOW + 1000).record;
  assert.equal(next.examinationType, type); assert.deepEqual(next.personalBackground, first.personalBackground);
  assert.deepEqual(next.medicalHistory, first.medicalHistory); assert.deepEqual(next.medicalHistoryDetails, first.medicalHistoryDetails);
  assert.deepEqual(next.physicalAssessment, payload.physicalAssessment); assert.deepEqual(root.medicalRecords[KEY], before);
  assert.deepEqual(next.copiedFrom, { recordKey: KEY, revision: 1, submittedAt: first.submittedAt });
  const unchanged = structuredClone(root); assert.equal(forms.create(root, key, payload, { uid: 'staff' }, NOW + 2000).unchanged, true); assert.deepEqual(root, unchanged);
  root.services = { check: { service_name: 'Consultation', status: 'active' } };
  const visit = clinical.createVisit(root, { id: 'followup_visit', ...(mobile ? { userId: 'patient' } : { clinicRecordId: CLINIC }), serviceId: 'check' }, { uid: 'staff' }, NOW + 3000).record;
  assert.equal(visit.vitals.weight, '65'); assert.equal(visit.vitalsSource.recordKey, key);
});
test('vitals-only new forms reject stale or foreign sources, field tampering and blank measurements without changing stored data', () => {
  const root = seed(), first = forms.create(root, KEY, input(), { uid: 'staff' }, NOW).record;
  const payload = { clinicRecordId: CLINIC, sourceFormKey: KEY, expectedSourceRevision: 1, expectedSourceSubmittedAt: first.submittedAt, physicalAssessment: { weight: '65' } };
  for (const patch of [{ expectedSourceRevision: 2 }, { expectedSourceSubmittedAt: 'wrong' }, { userId: 'patient', clinicRecordId: undefined }, { personalBackground: { firstName: 'Forged' } }, { examinationType: 'mape' }, { patientPhoto: '' }, { physicalAssessment: {} }, { physicalAssessment: { remarks: 'No measurements' } }, { physicalAssessment: { weight: '-1' } }]) {
    const before = structuredClone(root); assert.throws(() => forms.create(root, 'form_' + '5'.repeat(32), { ...payload, ...patch }, { uid: 'staff' }, NOW + 1000)); assert.deepEqual(root, before);
  }
  forms.update(root, KEY, edit(first), { uid: 'staff' }, NOW + 1000);
  assert.throws(() => forms.create(root, 'form_' + '5'.repeat(32), payload, { uid: 'staff' }, NOW + 2000), error => error.code === 'SMPE_STALE');
});
for (const type of ['smape', 'mape']) for (const mobile of [false, true]) {
  test(type + ' staff creation, complete editing and soft deletion preserve patient identity and immutable history (' + (mobile ? 'mobile' : 'clinic-only') + ')', () => {
    const root = seed(), originalUsers = structuredClone(root.users), visits = structuredClone(root.clinicalVisits);
    const created = forms.create(root, KEY, input(type, mobile), { uid: 'staff' }, NOW).record;
    assert.equal(created.clinicRecordId, mobile ? undefined : CLINIC); assert.equal(created.userId, mobile ? 'patient' : undefined);
    assert.equal(created.source, 'desktop'); assert.equal(created.status, 'Approved'); assert.equal(created.revision, 1);
    const changed = forms.update(root, KEY, edit(created), { uid: 'admin' }, NOW + 1000).record;
    assert.equal(changed.personalBackground.firstName, 'Updated'); assert.equal(changed.medicalHistory.asthmaLungDisease, 'no'); assert.equal(changed.physicalAssessment.weight, '65');
    assert.equal(changed.submittedAt, created.submittedAt); assert.equal(changed.reviewedAt, created.reviewedAt); assert.equal(changed.revision, 2);
    assert.equal(changed.revisionHistory[0].personalBackground.firstName, 'Synthetic'); assert.equal(changed.reviewHistory[0].physicalAssessment.weight, '60');
    const profile = structuredClone(root.patientProfiles), admissions = structuredClone(root.patientAdmissions);
    const removed = forms.remove(root, KEY, { expectedRevision: 2, expectedSubmittedAt: created.submittedAt, confirm: true }, { uid: 'staff' }, NOW + 2000).record;
    assert.ok(removed.deletedAt); assert.equal(removed.revisionHistory.at(-1).personalBackground.firstName, 'Updated');
    assert.deepEqual(root.users, originalUsers); assert.deepEqual(root.clinicalVisits, visits); assert.deepEqual(root.patientProfiles, profile); assert.deepEqual(root.patientAdmissions, admissions);
    assert.equal(Object.values(root.notifications || {}).some(notice => !notice.userId || notice.userId !== 'patient'), false);
    assert.ok(!JSON.stringify(root.auditLogs).includes('Synthetic history'));
  });
}
test('duplicate creation is idempotent, a new form keeps the old form and clinic registration month, and new visits copy clinic-only form vitals', () => {
  const root = seed(), payload = input(), created = forms.create(root, KEY, payload, { uid: 'staff' }, NOW);
  const snapshot = structuredClone(root); assert.equal(forms.create(root, KEY, payload, { uid: 'staff' }, NOW + 1000).unchanged, true); assert.deepEqual(root, snapshot);
  forms.create(root, 'form_' + '3'.repeat(32), input('mape'), { uid: 'staff' }, NOW + 2000);
  assert.equal(Object.keys(root.medicalRecords).length, 2); assert.deepEqual(root.medicalRecords[KEY], snapshot.medicalRecords[KEY]);
  assert.equal(root.patientProfiles[CLINIC].createdAt, '2026-10-01T00:00:00Z');
  root.services = { ecg: { service_id: 'ecg', service_name: 'ECG', status: 'active' } };
  const visit = clinical.createVisit(root, { id: 'visit_synthetic', clinicRecordId: CLINIC, serviceId: 'ecg' }, { uid: 'staff' }, NOW + 3000);
  assert.equal(visit.record.vitals.weight, '60'); assert.equal(visit.record.vitals.bloodPressure, '120/80');
});
test('forged identities, protected metadata, unknown fields, invalid measurements, unsafe keys and unconfirmed deletion never write', () => {
  for (const extra of [{ userId: 'other' }, { clinicRecordId: 'clinic_missing' }, { status: 'Approved' }, { revision: 99 }, { examinationType: 'unknown' }, { personalBackground: { firstName: 'Only', lastName: '' } }, { physicalAssessment: { bloodPressure: 'wrong' } }, { medicalHistory: { tuberculosis: 'maybe' } }, { patientPhoto: 'https://example.test/private.png' }]) {
    const root = seed(), before = structuredClone(root); assert.throws(() => forms.create(root, KEY, { ...input(), ...extra }, { uid: 'staff' }, NOW)); assert.deepEqual(root, before);
  }
  for (const key of ['__proto__', 'constructor', '../form', 'bad.key', 'form_wrong']) { const root = seed(); assert.throws(() => forms.create(root, key, input(), { uid: 'staff' }, NOW)); }
  const root = seed(); const record = forms.create(root, KEY, input(), { uid: 'staff' }, NOW).record;
  const before = structuredClone(root);
  for (const extra of [{ userId: 'other' }, { examinationType: 'mape' }, { reviewedBy: 'patient' }, { physicalAssessment: { weight: '-3' } }, { personalBackground: { ...record.personalBackground, dateOfBirth: '2030-01-01' } }]) assert.throws(() => forms.update(root, KEY, edit(record, extra), { uid: 'staff' }, NOW));
  assert.throws(() => forms.remove(root, KEY, { expectedRevision: 1, expectedSubmittedAt: record.submittedAt, confirm: false }, { uid: 'staff' }, NOW)); assert.deepEqual(root, before);
});
test('current saved roles are authoritative, including revocation, and stale saves/deletes cannot overwrite a newer form', () => {
  for (const uid of ['patient', 'missing']) { const root = seed(), before = structuredClone(root); assert.throws(() => forms.create(root, KEY, input(), { uid, role: 'admin' }, NOW), { code: 'SMPE_FORBIDDEN' }); assert.deepEqual(root, before); }
  const root = seed(), record = forms.create(root, KEY, input(), { uid: 'staff' }, NOW).record;
  const saved = forms.update(root, KEY, edit(record), { uid: 'doctor' }, NOW + 1);
  assert.equal(saved.record.lastEditedBy, 'doctor');
  const before = structuredClone(root);
  assert.throws(() => forms.update(root, KEY, edit(record), { uid: 'staff' }, NOW + 2), { code: 'SMPE_STALE' });
  assert.throws(() => forms.remove(root, KEY, { expectedRevision: 1, expectedSubmittedAt: record.submittedAt, confirm: true }, { uid: 'staff' }, NOW + 2), { code: 'SMPE_STALE' }); assert.deepEqual(root, before);
  root.users.staff.disabled = true; assert.throws(() => forms.update(root, KEY, edit(root.medicalRecords[KEY]), { uid: 'staff' }, NOW), { code: 'SMPE_FORBIDDEN' });
});
test('pending mobile forms remain pending after a full edit', () => {
  const root = seed(); smpe.submitSmpe(root, { ...input(), physicalAssessment: {} }, { uid: 'patient' }, { recordKey: 'pending', medicalRecordId: 'SMAPE-PENDING' }, NOW);
  const changed = forms.update(root, 'pending', edit(root.medicalRecords.pending), { uid: 'staff' }, NOW + 1).record;
  assert.equal(changed.status, 'Pending Review'); assert.equal(changed.reviewedAt, undefined); assert.equal(changed.revisionHistory[0].physicalAssessment.weight, undefined);
});
test('editing a rejected application never admits it, while removing an approved form retains its original admission month', () => {
  const root = seed();
  smpe.submitSmpe(root, { ...input(), physicalAssessment: {} }, { uid: 'other' }, { recordKey: 'rejected', medicalRecordId: 'SMAPE-REJECTED' }, NOW);
  root.medicalRecords.rejected.status = 'Rejected'; root.medicalRecords.rejected.reviewedAt = new Date(NOW).toISOString();
  forms.update(root, 'rejected', edit(root.medicalRecords.rejected), { uid: 'staff' }, NOW + 1);
  assert.equal(root.patientAdmissions.other, undefined); assert.equal(root.patientProfiles.other, undefined);
  const created = forms.create(root, KEY, input('mape', true), { uid: 'staff' }, NOW).record;
  forms.remove(root, KEY, { expectedRevision: created.revision, expectedSubmittedAt: created.submittedAt, confirm: true }, { uid: 'staff' }, NOW + 2);
  assert.equal(root.patientAdmissions.patient.firstApprovedAt, '2026-10-02T00:00:00.000Z');
  assert.equal(root.patientProfiles.patient.firstApprovedAt, '2026-10-02T00:00:00.000Z');
});
test('new routes require verified staff middleware and return non-cacheable, sanitized failures', async () => {
  const routes = new Map(), app = Object.fromEntries(['put', 'patch', 'delete'].map(method => [method, (url, handler) => routes.set(method + url, handler)]));
  smpe.registerSmpeRoutes(app, { now: () => NOW });
  let root = seed(), listeners = 0;
  const database = { ref: (path = '') => ({ get: async () => ({ val: () => structuredClone(path ? path.split('/').reduce((value, key) => value?.[key], root) ?? null : root) }), on: (_, callback) => { listeners++; callback({ val: () => root }); }, off: () => listeners--, transaction: async update => { const next = update(structuredClone(root)); if (!next) return { committed: false }; root = next; return { committed: true }; } }) };
  const guard = createStaffAccessGuard({ getFirebaseApp: () => ({}), getDatabase: () => database, getAuth: () => ({ verifyIdToken: async (token, revoked) => { assert.equal(revoked, true); return { uid: token, role: 'admin' }; } }) });
  async function request(method, body, token = 'staff', guarded = true) {
    let status = 200, result, cache, allowed = false;
    const req = { params: { recordId: KEY }, body, headers: { authorization: 'Bearer ' + token } }, res = { set: (_, value) => cache = value, status: code => { status = code; return res; }, json: value => result = value };
    if (guarded) await guard(req, res, () => allowed = true);
    if (!guarded || allowed) await routes.get(method + '/api/staff/medical-records/:recordId' + (method === 'put' ? '' : '/form'))(req, res);
    return { status, result, cache };
  }
  assert.equal((await request('put', input(), 'staff', false)).status, 401);
  assert.equal((await request('put', input(), 'patient')).status, 403);
  const created = await request('put', input()); assert.equal(created.status, 200); assert.equal(created.cache, 'no-store'); assert.equal(created.result.record.clinicRecordId, CLINIC);
  const updated = await request('patch', edit(created.result.record)); assert.equal(updated.status, 200);
  assert.equal((await request('delete', { expectedRevision: 2, expectedSubmittedAt: created.result.record.submittedAt, confirm: true })).status, 200); assert.equal(listeners, 0);
});
