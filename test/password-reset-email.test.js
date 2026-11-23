"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
process.env.NODE_ENV = "test";
const { securityCodeEmailHtml } = require("../src/server").__test;
const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

function fixture({ registered = true, disabled = false, mailFails = false, firebaseFails = false } = {}) {
  const routes = new Map(), mails = [], forgotten = [], resetLinks = [];
  const context = {
    process: { env: {} },
    app: { post: (route, handler) => routes.set(route, handler) },
    normalizeEmail: value => String(value || "").trim().toLowerCase(),
    isValidEmail: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    registeredDatabaseAccount: async (email, audience) => {
      assert.equal(email, "staff@example.invalid"); assert.equal(audience, "staff"); return registered;
    },
    passwordResetEmailNotRegisteredError: () => new Error("Email is not registered."),
    getAuth: () => ({ getUserByEmail: async email => {
      assert.equal(email, "staff@example.invalid");
      return { uid: "synthetic-staff", displayName: "Synthetic Staff", disabled };
    } }),
    firebaseAdminApp: () => ({}),
    createChallenge: options => {
      assert.equal(options.userId, "synthetic-staff");
      assert.equal(options.purpose, "desktop_password_reset_otp");
      return { code: "012345", challengeToken: "synthetic-challenge", expiresAt: "2026-10-15T12:05:00.000Z" };
    },
    challengeDurationLabel: "5 minutes", securityCodeEmailHtml,
    sendMail: async mail => { mails.push(mail); if (mailFails) throw Object.assign(new Error("Synthetic delivery failure"), { code: "EMAIL_DELIVERY_UNAVAILABLE" }); },
    forgetChallenge: token => forgotten.push(token),
    firebaseRequest: async (endpoint, payload) => {
      assert.deepEqual(forgotten, ["synthetic-challenge"]);
      resetLinks.push({ endpoint, ...payload });
      if (firebaseFails) throw new Error("Synthetic Firebase failure");
    },
    console: { warn() {} },
    emailUnavailableError: () => new Error("Email is temporarily unavailable"),
    sendError: (res, error) => res.status(400).json({ ok: false, error: error.message }),
  };
  vm.runInNewContext(source.slice(source.indexOf('const desktopResetPurpose ='),
    source.indexOf('app.post("/api/password-reset/send"')), context);
  return { mails, forgotten, resetLinks, async send(acceptResetLink = false) {
    let status = 200, body;
    const res = { status(value) { status = value; return res; }, json(value) { body = value; } };
    await routes.get("/api/password-reset/otp/send")({ body: { email: " STAFF@example.invalid ", acceptResetLink } }, res);
    return { status, body };
  } };
}

test("Forgot Password sends Verification Code in subject, plaintext and mobile-style HTML", async () => {
  const f = fixture(); const result = await f.send();
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  assert.equal(result.body.challengeToken, "synthetic-challenge");
  assert.equal("code" in result.body, false);
  assert.equal(f.mails.length, 1);
  const mail = f.mails[0];
  assert.equal(mail.to, "staff@example.invalid");
  assert.equal(mail.subject, "Alphastar password reset verification code");
  assert.match(mail.text, /verification code is 012345/);
  assert.match(mail.text, /expires in 5 minutes/);
  assert.match(mail.html, /Send Verification<\/span><br>Code/);
  assert.match(mail.html, />Verification Code<\/td>/);
  assert.match(mail.html, /Hi, <strong[^>]*>Synthetic Staff!<\/strong>/);
  assert.match(mail.html, /one-time verification code to reset your Alphastar password/);
  assert.match(mail.html, /012345/);
  assert.doesNotMatch(mail.subject + mail.text + mail.html, /\bPIN\b/);
  assert.equal("attachments" in mail, false);
  assert.deepEqual(f.forgotten, []);
});

test("Forgot Password still sends nothing for an unregistered email", async () => {
  const f = fixture({ registered: false }); const result = await f.send();
  assert.equal(result.status, 400); assert.equal(result.body.ok, false);
  assert.deepEqual(f.mails, []);
});

test("Forgot Password invalidates the challenge if email delivery fails", async () => {
  const f = fixture({ mailFails: true }); const result = await f.send();
  assert.equal(result.status, 400); assert.equal(result.body.ok, false);
  assert.deepEqual(f.forgotten, ["synthetic-challenge"]);
});

test("offers a Firebase reset link only to clients that accept the fallback", async () => {
  const legacy = fixture({ mailFails: true });
  assert.equal((await legacy.send()).body.ok, false);
  assert.deepEqual(legacy.resetLinks, []);

  const current = fixture({ mailFails: true });
  const result = await current.send(true);
  assert.equal(result.status, 200);
  assert.equal(result.body.delivery, "firebase-reset-link");
  assert.equal("challengeToken" in result.body, false);
  assert.deepEqual(current.resetLinks, [{
    endpoint: "accounts:sendOobCode",
    requestType: "PASSWORD_RESET",
    email: "staff@example.invalid",
  }]);
});

test("does not email a Firebase reset link to an unregistered or disabled account", async () => {
  for (const options of [{ registered: false }, { disabled: true }]) {
    const f = fixture({ ...options, mailFails: true });
    assert.equal((await f.send(true)).body.ok, false);
    assert.deepEqual(f.resetLinks, []);
  }
});

test("reports delivery failure when neither provider can send a recovery email", async () => {
  const f = fixture({ mailFails: true, firebaseFails: true });
  const result = await f.send(true);
  assert.equal(result.body.ok, false);
  assert.equal("delivery" in result.body, false);
});
