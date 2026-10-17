"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPatientAuthenticatorAccess } = require("../src/patient-authenticator-access");
function fixture(row, failure) {
  const access = createPatientAuthenticatorAccess({ getFirebaseApp: () => ({}), getAuth: () => ({ verifyIdToken: async () => ({ uid: "patient", firebase: { sign_in_provider: "password" } }) }),
    getDatabase: () => ({ ref: path => { assert.equal(path, "patientAuthenticator/patient"); return { get: async () => { if (failure) throw Error(); return { val: () => row }; } }; } }),
  });
  return access;
}
test("shared backend guard preserves disabled accounts and requires exact signed proof when ON", async () => {
  await fixture(null).assertAccess({ uid: "patient" }); await fixture({ version: 1, enabled: false }).assertAccess({ uid: "patient" });
  const row = { version: 1, enabled: true, revision: "a".repeat(64), provider: "password" };
  const proof = { uid: "patient", firebase: { sign_in_provider: "custom" }, alphastarMfaRevision: row.revision, alphastarMfaProvider: "password" };
  await fixture(row).assertAccess(proof);
  for (const decoded of [{ uid: "patient" }, { ...proof, alphastarMfaRevision: "wrong" }, { ...proof, firebase: { sign_in_provider: "password" } }, { ...proof, alphastarMfaProvider: "google.com" }]) await assert.rejects(fixture(row).assertAccess(decoded), error => error.status === 401);
  await assert.rejects(fixture({ ...row, transition: { hash: "pending" } }).assertAccess(proof), error => error.status === 401);
});
test("database errors and malformed policy fail unavailable, never as a successful or expired session", async () => {
  await assert.rejects(fixture(null, true).assertAccess({ uid: "patient" }), error => error.status === 503);
  await assert.rejects(fixture({ enabled: false }).assertAccess({ uid: "patient" }), error => error.status === 503);
});
test("middleware verifies revocation and refuses first-factor API access before the handler executes", async () => {
  const guard = fixture({ version: 1, enabled: true, revision: "a".repeat(64), provider: "password" });
  const response = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
  let next = 0; await guard.middleware({ headers: { authorization: "Bearer primary" } }, response, () => next++);
  assert.equal(next, 0); assert.equal(response.statusCode, 401); assert.equal(response.body.code, "PATIENT_AUTHENTICATOR_REQUIRED");
});
