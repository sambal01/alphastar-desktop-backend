"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { createStaffAccountPin } = require("../src/staff-account-pin");
const { createStaffAccessGuard } = require("../src/queue-routes");
const { emailUnavailableError } = require("../src/email-delivery");
process.env.NODE_ENV = "test";
process.env.AUTH_CHALLENGE_SECRET = "synthetic-staff-recovery-test";
process.env.AUTH_CODE_EXPIRES_SECONDS = "300";
process.env.AUTH_CODE_RESEND_SECONDS = "1";
process.env.AUTH_CODE_REQUESTS_PER_HOUR = "3";
process.env.ALPHASTAR_DATA_FILE = path.join(os.tmpdir(), `alphastar-staff-recovery-${process.pid}.json`);
const challenge = require("../src/server").__test;
const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
const alice = "staff-one", bob = "staff-two";
const identity = uid => ({ uid, authProviderId: "password" });
function clean() {
  for (const suffix of ["", ".bak"]) fs.rmSync(process.env.ALPHASTAR_DATA_FILE + suffix, { force: true });
}
test.beforeEach(clean);
test.after(clean);
function fixture() {
  const routes = new Map(), mails = [], records = new Map();
  const users = { [alice]: { role: "staff", accountStatus: "active" }, [bob]: { role: "admin" }, patient: { role: "patient" } };
  const authUsers = { [alice]: { uid: alice, email: "staff.one@example.invalid", displayName: "Synthetic Staff" },
    [bob]: { uid: bob, email: "admin.two@example.invalid" }, patient: { uid: "patient", email: "patient@example.invalid" } };
  let now = Date.now(), mailAvailable = true, mailFailure = false;
  const database = { ref: key => ({ key, get: async () => ({ val: () => {
    if (key.startsWith("users/")) return structuredClone(users[key.slice(6)] || null);
    return structuredClone(records.get(key) || null);
  } }) }) };
  const transact = async (ref, update) => {
    const value = update(structuredClone(records.get(ref.key) || null));
    if (value === undefined) return { committed: false };
    records.set(ref.key, structuredClone(value)); return { committed: true };
  };
  const pins = createStaffAccountPin({ getDatabase: () => database, enabled: true,
    pepper: "a".repeat(64), now: () => now, transact });
  const auth = { verifyIdToken: async token => {
    if (!authUsers[token]) throw new Error("invalid synthetic token");
    return { uid: token, auth_time: now / 1000, email: "stale@example.invalid" };
  }, getUser: async uid => {
    if (!authUsers[uid]) throw new Error("missing synthetic user"); return structuredClone(authUsers[uid]);
  } };
  const guard = createStaffAccessGuard({ getFirebaseApp: () => ({}), getDatabase: () => database, getAuth: () => auth });
  const context = vm.createContext({
    app: { post: (route, handler) => routes.set(route, handler) }, process: { env: {} }, Date,
    ...challenge, emailUnavailableError, emailReady: () => mailAvailable, getAuth: () => auth,
    staffRoles: new Set(["admin", "staff", "doctor", "nurse", "receptionist"]),
    firebaseAdminApp: () => ({}), normalizeEmail: email => String(email || "").trim().toLowerCase(),
    isValidEmail: email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    challengeDurationLabel: "5 minutes", resendDelaySeconds: 1,
    sendError: (res, error) => res.status(error.status || 500).json({ ok: false, error: error.message,
      code: error.code, ...(error.resendAfterSeconds ? { resendAfterSeconds: error.resendAfterSeconds } : {}) }),
    sendMail: async mail => { mails.push(mail); if (mailFailure) throw new Error("private provider response must not leak"); },
    createFirebaseCustomToken: () => assert.fail("Recovery must not unlock or issue a sign-in token"),
    console: { log: () => assert.fail("Recovery must not log mail content or grants"), warn: () => assert.fail("Recovery must not log mail content or grants") },
  });
  vm.runInContext(source.slice(source.indexOf("function desktopPins()"), source.indexOf('app.post("/api/staff-auth/session/renew"')), context);
  context.desktopPins.service = pins;
  return { pins, users, authUsers, mails, records,
    setUnavailable: () => { mailAvailable = false; }, setMailFailure: () => { mailFailure = true; }, advance: ms => { now += ms; },
    latestCode: () => mails.at(-1).text.match(/OTP is (\d{6})/)[1],
    async request(action, body = {}, uid = alice) {
      const req = { body, headers: uid ? { authorization: `Bearer ${uid}` } : {} };
      let status = 200, result, cacheControl;
      const res = { set: (key, value) => { if (key === "Cache-Control") cacheControl = value; },
        status(code) { status = code; return res; }, json(value) { result = value; } };
      let allowed = false; await guard(req, res, () => { allowed = true; });
      if (allowed) await routes.get(`/api/staff-auth/pin/recovery/${action}`)(req, res);
      return { status, result, cacheControl };
    },
  };
}
async function approved(f) {
  const sent = await f.request("send"); assert.equal(sent.status, 200);
  const verified = await f.request("verify", { challengeToken: sent.result.challengeToken, code: f.latestCode() });
  assert.equal(verified.status, 200); return verified.result.resetToken;
}
function allowResend() {
  const store = challenge.readStore();
  for (const key of Object.keys(store.authChallengeRequests || {})) {
    store.authChallengeRequests[key] = store.authChallengeRequests[key].map(timestamp => timestamp - 1100);
  }
  challenge.writeStore(store);
}
test("Forgot PIN sends an OTP only to current Auth email and resets without unlocking", async () => {
  const f = fixture(); await f.pins.create(identity(alice), "012345");
  const sent = await f.request("send", { email: "STAFF.ONE@example.invalid" });
  assert.equal(sent.status, 200); assert.equal(sent.cacheControl, "no-store");
  assert.equal(sent.result.resendAfterSeconds, 1); assert.equal(sent.result.maskedEmail, "s***@example.invalid");
  assert.ok(Date.parse(sent.result.expiresAt) > Date.now());
  assert.equal(f.mails[0].to, "staff.one@example.invalid");
  assert.match(f.mails[0].html, /Reset your PIN/); assert.match(f.mails[0].text, /existing PIN is never emailed/);
  assert.match(f.mails[0].html, /Send Verification<\/span><br>Code/);
  assert.match(f.mails[0].html, />Verification Code<\/td>/);
  assert.doesNotMatch(f.mails[0].html, /Send PIN|>PIN Code<|enter the PIN code below/);
  const stored = challenge.readStore().authChallenges[sent.result.challengeToken];
  assert.equal(stored.userId, alice); assert.equal(stored.metadata.uid, alice);
  assert.equal(stored.purpose, "staff_pin_recovery_otp");
  assert.equal("code" in stored, false); assert.equal("code" in sent.result, false);
  const verified = await f.request("verify", { challengeToken: sent.result.challengeToken, code: f.latestCode() });
  assert.equal(verified.status, 200); assert.match(verified.result.resetToken, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(verified.result.expiresAt) > Date.now());
  assert.equal(JSON.stringify([...f.records.values()]).includes(verified.result.resetToken), false);
  const result = await f.request("confirm", { resetToken: verified.result.resetToken, pin: "654321", confirmPin: "654321" });
  assert.equal(result.status, 200); assert.equal(result.result.configured, true);
  assert.equal("customToken" in result.result, false);
  await assert.rejects(f.pins.verify(identity(alice), "012345"), { code: "STAFF_PIN_INCORRECT" });
  await f.pins.verify(identity(alice), "654321");
});
test("every recovery endpoint rejects forged recipients, UID targets, anonymous and patient callers", async () => {
  const f = fixture();
  for (const action of ["send", "verify", "confirm"]) {
    for (const body of [{ uid: bob }, { userId: bob }, { targetUserId: bob }, { email: "admin.two@example.invalid" }]) {
      assert.equal((await f.request(action, body)).status, 403);
    }
    assert.equal((await f.request(action, {}, "patient")).status, 403);
    assert.equal((await f.request(action, {}, "")).status, 401);
  }
  assert.equal(f.mails.length, 0); assert.equal(f.records.size, 0);
});
test("disabled, removed and non-staff records are rechecked at every stage", async () => {
  const f = fixture(); const token = await approved(f);
  for (const action of ["send", "verify", "confirm"]) {
    f.authUsers[alice].disabled = true;
    assert.equal((await f.request(action, { resetToken: token, pin: "654321", confirmPin: "654321" })).status, 403);
    f.authUsers[alice].disabled = false;
    f.users[alice].accountStatus = "inactive";
    assert.equal((await f.request(action)).status, 403);
    f.users[alice].accountStatus = "active";
    const saved = f.users[alice]; delete f.users[alice];
    assert.equal((await f.request(action)).status, 403); f.users[alice] = saved;
  }
});
test("OTP is isolated by purpose and UID; wrong codes, replay and expiry cannot mint grants", async () => {
  const f = fixture(), sent = await f.request("send"), token = sent.result.challengeToken;
  const code = f.latestCode();
  assert.equal((await f.request("verify", { challengeToken: token, code }, bob)).result.code, "AUTH_CODE_EMAIL_MISMATCH");
  f.authUsers[bob].email = f.authUsers[alice].email;
  assert.equal((await f.request("verify", { challengeToken: token, code }, bob)).result.code, "AUTH_CODE_USER_MISMATCH");
  const other = challenge.createChallenge({ email: f.authUsers[alice].email, userId: alice, purpose: "desktop_password_reset_otp" });
  assert.equal((await f.request("verify", { challengeToken: other.challengeToken, code: other.code })).result.code, "AUTH_CODE_PURPOSE_MISMATCH");
  assert.equal((await f.request("verify", { challengeToken: token, code: code === "000000" ? "111111" : "000000" })).result.code, "AUTH_CODE_INCORRECT");
  assert.equal((await f.request("verify", { challengeToken: token, code })).status, 200);
  assert.equal((await f.request("verify", { challengeToken: token, code })).result.code, "AUTH_CODE_ALREADY_USED");
  allowResend(); const fresh = await f.request("send");
  const store = challenge.readStore(); store.authChallenges[fresh.result.challengeToken].expiresAt = new Date(Date.now() - 1).toISOString(); challenge.writeStore(store);
  assert.equal((await f.request("verify", { challengeToken: fresh.result.challengeToken, code: f.latestCode() })).result.code, "AUTH_CODE_EXPIRED");
});
test("resend cooldown, replacement, hourly limit and max wrong-code attempts remain enforced", async () => {
  const f = fixture(), first = await f.request("send"), firstCode = f.latestCode();
  const early = await f.request("send"); assert.equal(early.status, 429); assert.ok(early.result.resendAfterSeconds >= 1);
  allowResend(); const second = await f.request("send"); assert.equal(second.status, 200);
  assert.equal((await f.request("verify", { challengeToken: first.result.challengeToken, code: firstCode })).result.code, "AUTH_CODE_REPLACED");
  for (let n = 0; n < 3; n++) assert.equal((await f.request("verify", { challengeToken: second.result.challengeToken, code: "000000" })).status, 401);
  assert.equal((await f.request("verify", { challengeToken: second.result.challengeToken, code: "000000" })).status, 429);
  allowResend(); assert.equal((await f.request("send")).status, 200);
  allowResend(); assert.equal((await f.request("send")).result.code, "AUTH_CODE_RATE_LIMIT");
});
test("mail not configured or provider failure leaves no usable OTP and leaks no provider content", async () => {
  const unavailable = fixture(); unavailable.setUnavailable();
  assert.equal((await unavailable.request("send")).status, 503);
  assert.equal(Object.keys(challenge.readStore().authChallenges).length, 0);
  const failed = fixture(); failed.setMailFailure();
  const result = await failed.request("send"); assert.equal(result.status, 503);
  assert.equal(result.result.code, "EMAIL_DELIVERY_UNAVAILABLE"); assert.doesNotMatch(result.result.error, /private provider/);
  assert.equal(Object.keys(challenge.readStore().authChallenges).length, 0);
  assert.equal(failed.records.size, 0);
});
test("malformed/mismatched new PIN leaves grant valid; replay, expiry and cross-UID resets fail", async () => {
  const f = fixture(); await f.pins.create(identity(alice), "012345"); const token = await approved(f);
  for (const pin of [123456, "12345", "1234567", "abc123", "", null]) {
    assert.equal((await f.request("confirm", { resetToken: token, pin, confirmPin: pin })).status, 400);
  }
  assert.equal((await f.request("confirm", { resetToken: token, pin: "654321", confirmPin: "111111" })).result.code, "STAFF_PIN_MISMATCH");
  assert.equal((await f.request("confirm", { resetToken: token, pin: "654321", confirmPin: "654321" }, bob)).status, 403);
  assert.equal((await f.request("confirm", { resetToken: token, pin: "654321", confirmPin: "654321" })).status, 200);
  assert.equal((await f.request("confirm", { resetToken: token, pin: "111111", confirmPin: "111111" })).status, 403);
  allowResend(); const expired = await approved(f); f.advance(300_001);
  assert.equal((await f.request("confirm", { resetToken: expired, pin: "111111", confirmPin: "111111" })).status, 403);
  await f.pins.verify(identity(alice), "654321");
});
test("simultaneous confirmation has one winner and consumes all previous PIN approvals", async () => {
  const f = fixture(); await f.pins.create(identity(alice), "012345");
  const oldChange = await f.pins.beginChange(identity(alice), "012345"), token = await approved(f);
  const results = await Promise.all([f.request("confirm", { resetToken: token, pin: "654321", confirmPin: "654321" }),
    f.request("confirm", { resetToken: token, pin: "111111", confirmPin: "111111" })]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 403).length, 1);
  await assert.rejects(f.pins.change(identity(alice), "222222", oldChange.changeToken), { code: "STAFF_PIN_CHANGE_REQUIRED" });
  assert.equal([...f.records.values()][0].failures, 0);
});
test("invalid OTP formats never consume a valid challenge; backend advertises recovery capability under staff guard", async () => {
  const f = fixture(), sent = await f.request("send");
  for (const code of [123456, "12345", "1234567", "abc123", ""]) {
    assert.equal((await f.request("verify", { challengeToken: sent.result.challengeToken, code })).status, 400);
  }
  assert.equal((await f.request("verify", { challengeToken: sent.result.challengeToken, code: f.latestCode() })).status, 200);
  assert.ok(source.indexOf('app.use(["/api/staff", "/api/staff-auth"], createStaffAccessGuard') < source.indexOf('app.post("/api/staff-auth/pin/recovery/send"'));
  const advertisedCapabilities = source.match(/capabilities: \{([^}]+)\}/)?.[1] || "";
  assert.match(advertisedCapabilities, /\bstaffAccountPin: 1\b/);
  assert.match(advertisedCapabilities, /\bstaffPinRecovery: 1\b/);
});
test("a reset grant is never issued when the grant transaction does not commit", async () => {
  const pins = createStaffAccountPin({ enabled: true, pepper: "a".repeat(64),
    getDatabase: () => ({ ref: key => ({ key }) }), transact: async () => ({ committed: false }) });
  await assert.rejects(pins.issueResetGrant(identity(alice)), { code: "STAFF_PIN_RESET_UNAVAILABLE" });
});
