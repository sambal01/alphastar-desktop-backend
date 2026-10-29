"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const express = require("express"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { registerPatientRecordRoutes, __test } = require("../src/patient-record-routes");
const { registerInventoryRoutes } = require("../src/inventory-routes");
const NOW = Date.parse("2026-10-22T03:00:00Z");
async function fixture(t) {
  const state = { root: {
    users: { administrator: { role: "admin" }, patient_one: { role: "patient", email: "one@example.test" }, patient_two: { role: "patient", email: "two@example.test" } },
    patientProfiles: { patient_one: { userId: "patient_one", fullName: "Same Name", phone: "09111111111", contactNumber: "09111111111", privateField: "must-not-return" },
      patient_two: { userId: "patient_two", fullName: "Same Name", phone: "09222222222" } },
    medicalRecords: { form: { userId: "patient_one", physicalAssessment: { temperature: "36.5" } } }
  }, requests: [], commits: 0, listeners: 0, missingAuth: false, failStorage: false, conflict: false, wrongReply: false };
  const database = { ref: () => ({
    on(_event, listener, fail) { state.listeners++; if (state.failStorage) fail(new Error("private storage failure")); else listener({ val: () => structuredClone(state.root) }); },
    off() { state.listeners--; },
    async transaction(update) {
      const next = update(structuredClone(state.root));
      if (state.conflict || next === undefined) return { committed: false };
      state.root = structuredClone(next); state.commits++;
      return { committed: true };
    }
  }) };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { state.requests.push({ method: req.method, path: req.path, body: structuredClone(req.body || {}) }); next(); });
  app.use('/api/staff', (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!['test-admin', 'test-staff', 'test-patient'].includes(token)) return res.status(401).json({ ok: false, error: "Sign in again." });
    req.staffAccess = { database, actor: { uid: 'administrator', role: token === 'test-admin' ? 'admin' : token.slice(5) } };
    if (state.wrongReply) return res.json({ ok: true, profile: { userId: 'patient_two', fullName: 'Wrong account' } });
    next();
  });
  registerPatientRecordRoutes(app, { now: () => NOW, verifyPatientUid: async uid => {
    if (state.missingAuth || !Object.hasOwn(state.root.users, uid)) throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
    return { uid };
  } });
  app.get('/:collection.json', (req, res) => res.json(state.root[req.params.collection] || null));
  registerInventoryRoutes(app, { now: () => NOW });
  app.use((_req, res) => res.status(501).json({ ok: false, error: 'Endpoint not modeled by this local fixture' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (uid, body, token = 'test-admin') => fetch(`${base}/api/staff/patients/${encodeURIComponent(uid)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const context = vm.createContext({ window: {
    alphaFirebaseConfig: { apiKey: 'synthetic', projectId: 'alpha-star-clinic-mobile', authDomain: 'alpha-star-clinic-mobile.firebaseapp.com', databaseURL: 'https://alpha-star-clinic-mobile-default-rtdb.firebaseio.com' },
    alphaApiBaseUrl: base + '/api'
  }, structuredClone, AbortController, TextDecoder, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    // Redirect only the Firebase RTDB fixture host; all calls use real local HTTP.
    fetch: (input, options) => { const url = new URL(input); if (url.hostname === 'alpha-star-clinic-mobile-default-rtdb.firebaseio.com') return fetch(base + url.pathname + url.search, options);
      if (url.origin !== base) throw new Error('External network is forbidden in this fixture'); return fetch(input, options); }
  });
  for (const file of ['live-sync.js', 'firebase-service.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/js', file), 'utf8'), context);
  const clinicRequest = (id, body, token = 'test-admin') => fetch(`${base}/api/staff/clinic-patients/${encodeURIComponent(id)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { state, request, clinicRequest, api: context.window.AlphaFirebase };
}
test('real desktop client PATCH saves only the explicit UID and preserves clinical/security data', async t => {
  const { api, state } = await fixture(t), originalOther = structuredClone(state.root.patientProfiles.patient_two), originalUsers = structuredClone(state.root.users), originalRecords = structuredClone(state.root.medicalRecords);
  const remote = await api.loadClinicData('test-admin', 'administrator', 'admin'); api.acceptClinicData(remote);
  const result = await api.updatePatientProfile('test-admin', 'patient_one', { fullName: ' Updated Patient ', phone: '09999999999', birthDate: '2004-10-21', gender: 'Female', address: 'Test City' });
  assert.equal(result.saved.name, 'Updated Patient'); assert.equal(result.saved.contact, '09999999999');
  for (const field of ['phone', 'contactNumber', 'contactPhone', 'mobileNumber']) assert.equal(state.root.patientProfiles.patient_one[field], '09999999999');
  assert.deepEqual(state.root.patientProfiles.patient_two, originalOther); assert.deepEqual(state.root.users, originalUsers); assert.deepEqual(state.root.medicalRecords, originalRecords);
  assert.equal(result.profile.privateField, undefined); assert.equal(state.commits, 1); assert.equal(state.listeners, 0);
  const audit = Object.values(state.root.auditLogs)[0]; assert.equal(audit.targetId, 'patient_one'); assert.ok(!JSON.stringify(audit).includes('09999999999'));
  const writes = state.requests.filter(item => item.method === 'PATCH'); assert.equal(writes.length, 1); assert.equal(writes[0].path, '/api/staff/patients/patient_one');
});
test('an unlinked local patient no longer blocks unrelated inventory saves or auto-matches a same-name account', async t => {
  const { api, state } = await fixture(t), remote = await api.loadClinicData('test-admin', 'administrator', 'admin'); api.acceptClinicData(remote);
  remote.patients.push({ id: 'PAT-LOCAL', name: 'Same Name', contact: '09000000000' });
  remote.inventory.push({ id: 'MED-QA', name: 'Synthetic item', unit: 'Tablets', stock: 1 });
  await api.saveClinicData('test-admin', 'admin', remote, 'administrator');
  assert.equal(state.requests.filter(item => item.path.startsWith('/api/staff/patients/')).length, 0);
  assert.equal(state.requests.filter(item => item.path === '/api/staff/manage/inventory/MED-QA').length, 1);
  assert.equal(remote.patients.at(-1).userId, undefined); assert.equal(state.commits, 1);
  assert.equal(state.root.inventory['MED-QA'].stock, 1);
});
test('generic profile synchronization sends changed fields only, never stale medical/profile values', async t => {
  const { api, state } = await fixture(t), remote = await api.loadClinicData('test-admin', 'administrator', 'admin'); api.acceptClinicData(remote);
  remote.patients.find(item => item.userId === 'patient_one').contact = '09333333333';
  await api.saveClinicData('test-admin', 'admin', remote, 'administrator');
  const writes = state.requests.filter(item => item.method === 'PATCH'); assert.equal(writes.length, 1); assert.deepEqual(writes[0].body, { phone: '09333333333' });
});
test('missing sessions, non-admin callers, stale admin roles, and inactive administrators cannot write', async t => {
  const { state, request } = await fixture(t);
  for (const token of ['', 'test-staff', 'test-patient']) assert.ok([401,403].includes((await request('patient_one', { phone: '09999999999' }, token)).status));
  state.root.users.administrator.role = 'staff'; assert.equal((await request('patient_one', { phone: '09999999999' })).status, 403);
  state.root.users.administrator.role = 'admin'; state.root.users.administrator.disabled = true;
  assert.equal((await request('patient_one', { phone: '09999999999' })).status, 403); assert.equal(state.commits, 0);
});
test('unknown/non-patient/Auth-missing targets and identity/security/medical field injection are rejected atomically', async t => {
  const { state, request } = await fixture(t);
  assert.equal((await request('unknown', { phone: '09999999999' })).status, 404);
  assert.equal((await request('administrator', { phone: '09999999999' })).status, 404);
  assert.equal((await request('__proto__', { phone: '09999999999' })).status, 400);
  state.missingAuth = true; assert.equal((await request('patient_one', { phone: '09999999999' })).status, 404); state.missingAuth = false;
  for (const key of ['userId','email','role','patientNumber','password','pin','authenticator','physicalAssessment','medicalHistory']) {
    assert.equal((await request('patient_one', { [key]: 'blocked' })).status, 400);
  }
  assert.equal(state.commits, 0); assert.equal(state.listeners, 0);
});
test('storage/conflict errors are non-cacheable and sanitized; real client rejects an unconfirmed/wrong-account save', async t => {
  const { state, request, api } = await fixture(t);
  state.failStorage = true; const failed = await request('patient_one', { phone: '09999999999' });
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('cache-control'), 'no-store'); assert.ok(!(await failed.text()).includes('private storage failure'));
  state.failStorage = false; state.conflict = true; assert.equal((await request('patient_one', { phone: '09999999999' })).status, 409);
  state.conflict = false; state.wrongReply = true;
  await assert.rejects(api.updatePatientProfile('test-admin', 'patient_one', { phone: '09999999999' }), /did not confirm/);
  assert.equal(state.commits, 0); assert.equal(state.listeners, 0);
});
test('profile validation rejects invalid/future dates, unknown sex, oversized/nontext input and empty patches', () => {
  for (const input of [{}, [], { fullName: '' }, { fullName: 5 }, { phone: 'x'.repeat(41) }, { birthDate: '2004-02-30' }, { birthDate: '2026-10-23' }, { gender: 'unknown' }]) assert.throws(() => __test.patientPatch(input, NOW));
  assert.equal(__test.patientPatch({ birthDate: '2004-02-29', fullName: '  Test <patient>  ' }, NOW).fullName, 'Test patient');
});

const CLINIC_ID = 'clinic_1234567890abcdef1234567890abcdef';
const CLINIC_INPUT = { fullName: 'Same Name', birthDate: '2004-10-21', phone: '09000000000', gender: 'Female', address: 'Synthetic City', email: '' };

test('real desktop client creates/reloads/edits a clinic-only patient without Auth or changing a same-name mobile account', async t => {
  const { api, state } = await fixture(t);
  const originalUsers = structuredClone(state.root.users), originalProfiles = structuredClone(state.root.patientProfiles);
  // A missing Auth account must not prevent a clinic-only record save.
  state.missingAuth = true;
  const result = await api.saveClinicPatientRecord('test-admin', CLINIC_ID, CLINIC_INPUT);
  assert.equal(result.saved.clinicRecordId, CLINIC_ID); assert.equal(result.saved.userId, '');
  assert.match(result.saved.id, /^PAT-C-/); assert.equal(result.saved.name, 'Same Name');
  assert.deepEqual(state.root.users, originalUsers);
  for (const id of Object.keys(originalProfiles)) assert.deepEqual(state.root.patientProfiles[id], originalProfiles[id]);
  assert.equal(state.root.patientProfiles[CLINIC_ID].userId, undefined);
  const remote = await api.loadClinicData('test-admin', 'administrator', 'admin');
  const patient = remote.patients.find(row => row.clinicRecordId === CLINIC_ID);
  assert.equal(patient.id, result.saved.id); assert.equal(patient.userId, ''); assert.equal(patient.email, ''); assert.equal(patient.age, 22);
  assert.equal(remote.patients.filter(row => row.userId).length, 2);
  const second = await api.saveClinicPatientRecord('test-admin', CLINIC_ID, { ...CLINIC_INPUT, email: ' Contact@Example.test ', phone: '09333333333' });
  assert.equal(second.saved.id, result.saved.id); assert.equal(second.saved.email, 'contact@example.test');
  assert.equal(state.root.patientProfiles[CLINIC_ID].phone, '09333333333');
  const audits = Object.values(state.root.auditLogs);
  assert.deepEqual(audits.map(row => row.action), ['patient_record_created', 'patient_record_updated']);
  assert.ok(!JSON.stringify(audits).includes('09333333333')); assert.ok(!JSON.stringify(audits).includes('Same Name'));
  assert.equal(state.listeners, 0);
});

test('clinic-only retries retain one ID and creation audit; no fields can turn the record into an account', async t => {
  const { clinicRequest, state } = await fixture(t);
  const first = await (await clinicRequest(CLINIC_ID, CLINIC_INPUT)).json();
  const retry = await (await clinicRequest(CLINIC_ID, CLINIC_INPUT)).json();
  assert.deepEqual(retry, first); assert.equal(Object.keys(state.root.patientProfiles).length, 3); assert.equal(Object.keys(state.root.auditLogs).length, 1);
  for (const key of ['userId', 'role', 'recordKind', 'recordId', 'patientNumber', 'password', 'pin', 'medicalHistory', 'physicalAssessment']) {
    assert.equal((await clinicRequest(CLINIC_ID, { ...CLINIC_INPUT, [key]: 'blocked' })).status, 400);
  }
  assert.equal(Object.keys(state.root.auditLogs).length, 1);
});

test('clinic-only route enforces current Admin permissions and refuses linked/unknown/invalid record references', async t => {
  const { clinicRequest, state } = await fixture(t);
  for (const token of ['', 'test-staff', 'test-patient']) assert.ok([401, 403].includes((await clinicRequest(CLINIC_ID, CLINIC_INPUT, token)).status));
  state.root.users.administrator.role = 'staff'; assert.equal((await clinicRequest(CLINIC_ID, CLINIC_INPUT)).status, 403);
  state.root.users.administrator.role = 'admin'; state.root.users.administrator.disabled = true;
  assert.equal((await clinicRequest(CLINIC_ID, CLINIC_INPUT)).status, 403); state.root.users.administrator.disabled = false;
  for (const id of ['patient_one', '__proto__', 'clinic_bad']) assert.equal((await clinicRequest(id, CLINIC_INPUT)).status, 400);
  state.root.patientProfiles[CLINIC_ID] = { userId: 'patient_one' };
  assert.equal((await clinicRequest(CLINIC_ID, CLINIC_INPUT)).status, 409);
  assert.equal(state.commits, 0); assert.equal(state.listeners, 0);
});

test('clinic-only validation/storage/conflict errors preserve retryability and client rejects wrong confirmation', async t => {
  const { clinicRequest, state, api } = await fixture(t);
  for (const fields of [{ fullName: '' }, { birthDate: '' }, { birthDate: '2004-02-30' }, { phone: '' }, { address: '' }, { email: 'not-email' }, { email: null }]) {
    assert.equal((await clinicRequest(CLINIC_ID, { ...CLINIC_INPUT, ...fields })).status, 400);
  }
  state.failStorage = true;
  const failed = await clinicRequest(CLINIC_ID, CLINIC_INPUT);
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('cache-control'), 'no-store'); assert.ok(!(await failed.text()).includes('private storage failure'));
  state.failStorage = false; state.conflict = true;
  await assert.rejects(api.saveClinicPatientRecord('test-admin', CLINIC_ID, CLINIC_INPUT), /changed/);
  state.conflict = false; state.wrongReply = true;
  await assert.rejects(api.saveClinicPatientRecord('test-admin', CLINIC_ID, CLINIC_INPUT), /did not confirm/);
  assert.equal(state.commits, 0); assert.equal(state.listeners, 0);
});
