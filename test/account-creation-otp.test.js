"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
process.env.NODE_ENV = "test";
process.env.AUTH_CHALLENGE_SECRET = "synthetic-account-creation-secret";
process.env.AUTH_CODE_RESEND_SECONDS = "1";
process.env.ALPHASTAR_DATA_FILE = path.join(os.tmpdir(), `alphastar-create-otp-${process.pid}.json`);
const { __test: helpers } = require("../src/server");
const { requireAdministrator, accountType } = require("../src/account-service");
const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
test.beforeEach(() => helpers.writeStore({ authChallenges: {}, authChallengeRequests: {}, authChallengeReceipts: {}, registrationTokens: {} }));
test.after(() => {
  for (const file of [process.env.ALPHASTAR_DATA_FILE, process.env.ALPHASTAR_DATA_FILE + ".bak"]) fs.rmSync(file, { force: true });
});
function runtime(options = {}) {
  const routes = new Map(), mail = [], writes = [];
  const context = vm.createContext({
    ...helpers, app: { post: (route, handler) => routes.set(route, handler) },
    accountVerificationPurpose: helpers.accountVerificationPurpose, requireAdministrator, desktopAccountType: accountType,
    actorFromRequest: req => req.staffAccess.actor, normalizeEmail: value => String(value || "").trim().toLowerCase(),
    isValidEmail: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), sanitizePlainText: value => String(value || "").replace(/[<>]/g, ""),
    emailReady: () => !options.emailUnavailable, emailUnavailableError: () => Object.assign(new Error("Email is unavailable."), { status: 503 }),
    emailSender: () => "clinic@example.invalid", registeredDatabaseAccount: async () => options.existing ? {} : null,
    sendMail: async message => { mail.push(message); if (options.failMail) throw Object.assign(new Error("Synthetic delivery failure"), { status: 503 }); },
    sendStaffAccountCreatedEmail: async () => {}, challengeDurationLabel: "10 minutes", resendDelaySeconds: 1,
    desktopAccounts: () => ({ create: async (input, actor, trusted) => {
      writes.push({ input: { ...input }, actor: { ...actor }, trusted: { ...trusted } });
      if (options.failCreate) throw Object.assign(new Error("Synthetic database failure"), { status: 503 });
      const user = { userId: "created-uid", email: input.email, fullName: input.name, publicId: "TEST-001", role: input.accountType === "admin" ? "admin" : "staff", accountType: input.accountType };
      return { user, staff: { ...user } };
    } }),
    sendError: (res, error) => res.status(error.status || 500).json({ ok: false, code: error.code, error: error.message, resendAfterSeconds: error.resendAfterSeconds }),
    console: { warn() {} },
  });
  const start = source.indexOf('app.post("/api/staff-auth/account-verification/start",');
  vm.runInContext(source.slice(start, source.indexOf("function desktopAccounts()", start)), context);
  const createStart = source.indexOf('app.post("/api/staff/accounts",');
  vm.runInContext(source.slice(createStart, source.indexOf('app.patch("/api/staff/patient-accounts', createStart)), context);
  async function request(route, body, actor = { uid: "synthetic-admin", role: "admin", email: "admin@example.invalid" }) {
    let status = 200, result;
    const res = { set() { return res; }, status(code) { status = code; return res; }, json(value) { result = value; return res; } };
    await routes.get(route)({ body, staffAccess: actor ? { actor } : null }, res);
    return { status, result };
  }
  const input = (type = "staff") => ({ accountType: type, name: "Synthetic Team Member", contact: "09990000000", email: "new@example.invalid", password: "Synthetic-password123!", pin: "012345", confirmPin: "012345" });
  const startCode = async (body = input()) => {
    const response = await request("/api/staff-auth/account-verification/start", body);
    const code = mail.at(-1)?.text.match(/code is (\d{6})/)?.[1];
    return { response, code, body: { email: body.email, code, challengeToken: response.result.challengeToken } };
  };
  return { request, mail, writes, input, startCode };
}
const startRoute = "/api/staff-auth/account-verification/start", verifyRoute = "/api/staff-auth/account-verification/verify", createRoute = "/api/staff/accounts";

test("Add Account sends only an email OTP; a valid one-time proof creates each requested account type", async () => {
  for (const type of ["staff", "doctor", "admin"]) {
    helpers.writeStore({ authChallenges: {}, authChallengeRequests: {}, authChallengeReceipts: {}, registrationTokens: {} });
    const f = runtime(), input = f.input(type), sent = await f.startCode(input);
    assert.equal(sent.response.status, 200); assert.match(sent.code, /^\d{6}$/); assert.equal(f.writes.length, 0);
    assert.equal(f.mail[0].to, input.email); assert.match(f.mail[0].html, /Verification Code/);
    assert.equal(JSON.stringify(sent.response.result).includes(sent.code), false);
    const stored = Object.values(helpers.readStore().authChallenges)[0];
    assert.equal(stored.code, undefined); assert.ok(stored.codeHash); assert.deepEqual(stored.metadata, { adminUid: "synthetic-admin", accountType: type });
    const verified = await f.request(verifyRoute, sent.body);
    assert.equal(verified.status, 200); assert.equal(f.writes.length, 0);
    const created = await f.request(createRoute, { ...input, registrationToken: verified.result.registrationToken });
    assert.equal(created.status, 201); assert.equal(created.result.account.accountType, type);
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].trusted.emailVerified, true);
    assert.notEqual((await f.request(createRoute, { ...input, registrationToken: verified.result.registrationToken })).status, 201);
    assert.equal(f.writes.length, 1);
  }
});

test("missing OTP proof, forged verification, patients and staff cannot create accounts", async () => {
  const f = runtime();
  assert.equal((await f.request(createRoute, { ...f.input(), emailVerified: true })).status, 401);
  for (const actor of [null, { uid: "staff", role: "staff" }, { uid: "patient", role: "patient" }]) {
    for (const route of [startRoute, verifyRoute, createRoute]) assert.equal((await f.request(route, f.input(), actor)).status, 403);
  }
  assert.equal(f.mail.length, 0); assert.equal(f.writes.length, 0);
});

test("incorrect, expired, already-used and cross-administrator OTPs never create accounts", async () => {
  const f = runtime(), sent = await f.startCode();
  assert.equal((await f.request(verifyRoute, { ...sent.body, code: sent.code === "999999" ? "888888" : "999999" })).status, 401);
  assert.equal((await f.request(verifyRoute, sent.body, { uid: "another-admin", role: "admin" })).status, 400);
  assert.equal((await f.request(verifyRoute, { ...sent.body, email: "other@example.invalid" })).status, 400);
  assert.equal((await f.request(verifyRoute, sent.body)).status, 200);
  assert.notEqual((await f.request(verifyRoute, sent.body)).status, 200);
  assert.equal(f.writes.length, 0);
  const store = helpers.readStore(); store.authChallengeRequests = {}; helpers.writeStore(store);
  const expired = await f.startCode();
  const expiredStore = helpers.readStore(); expiredStore.authChallenges[expired.body.challengeToken].expiresAt = new Date(Date.now() - 1).toISOString(); helpers.writeStore(expiredStore);
  assert.equal((await f.request(verifyRoute, expired.body)).status, 410);
});

test("proofs bind the verified recipient, administrator, purpose and account type", async () => {
  const f = runtime(), sent = await f.startCode(), proof = (await f.request(verifyRoute, sent.body)).result.registrationToken;
  for (const [patch, actor] of [[{ accountType: "admin" }], [{ email: "other@example.invalid" }], [{}, { uid: "another-admin", role: "admin" }]]) {
    assert.equal((await f.request(createRoute, { ...f.input(), ...patch, registrationToken: proof }, actor)).status, 401);
  }
  const patientProof = helpers.createRegistrationToken({ email: f.input().email, purpose: "patient_signup", metadata: { adminUid: "synthetic-admin", accountType: "staff" } });
  assert.equal((await f.request(createRoute, { ...f.input(), registrationToken: patientProof.token })).status, 401);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.request(createRoute, { ...f.input(), registrationToken: proof })).status, 201);
});

test("resend cooldown is enforced, failed delivery invalidates its challenge, and duplicate creates cannot replay proof", async () => {
  const failed = runtime({ failMail: true });
  assert.equal((await failed.request(startRoute, failed.input())).status, 503);
  assert.equal(Object.keys(helpers.readStore().authChallenges).length, 0);
  helpers.writeStore({ authChallenges: {}, authChallengeRequests: {}, authChallengeReceipts: {}, registrationTokens: {} });
  const f = runtime(), sent = await f.startCode();
  assert.equal((await f.request(startRoute, f.input())).status, 429); assert.equal(f.mail.length, 1);
  const proof = (await f.request(verifyRoute, sent.body)).result.registrationToken;
  const responses = await Promise.all([f.request(createRoute, { ...f.input(), registrationToken: proof }), f.request(createRoute, { ...f.input(), registrationToken: proof })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 401]); assert.equal(f.writes.length, 1);
});

test("delivery configuration failures and duplicate emails leave no account and no usable challenge", async () => {
  for (const options of [{ emailUnavailable: true }, { existing: true }]) {
    const f = runtime(options);
    assert.notEqual((await f.request(startRoute, f.input())).status, 200);
    assert.equal(f.mail.length, 0); assert.equal(f.writes.length, 0);
  }
});
