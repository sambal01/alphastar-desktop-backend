"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
process.env.NODE_ENV = "test";
const { securityCodeEmailHtml } = require("../src/server").__test;
const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

function fixture({ registered = true, mailFails = false } = {}) {
  const routes = new Map(), mails = [], forgotten = [];
  const context = {
    app: { post: (route, handler) => routes.set(route, handler) },
    normalizeEmail: value => String(value || "").trim().toLowerCase(),
    isValidEmail: value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    registeredDatabaseAccount: async (email, audience) => {
      assert.equal(email, "staff@example.invalid"); assert.equal(audience, "staff"); return registered;
    },
    passwordResetEmailNotRegisteredError: () => new Error("Email is not registered."),
    getAuth: () => ({ getUserByEmail: async email => {
      assert.equal(email, "staff@example.invalid");
      return { uid: "synthetic-staff", displayName: "Synthetic Staff", disabled: false };
    } }),
    firebaseAdminApp: () => ({}),
    createChallenge: options => {
      assert.equal(options.userId, "synthetic-staff");
      assert.equal(options.purpose, "desktop_password_reset_otp");
      return { code: "012345", challengeToken: "synthetic-challenge", expiresAt: "2026-10-15T12:05:00.000Z" };
    },
    challengeDurationLabel: "5 minutes", securityCodeEmailHtml,
    sendMail: async mail => { mails.push(mail); if (mailFails) throw new Error("Synthetic delivery failure"); },
    forgetChallenge: token => forgotten.push(token),
    sendError: (res, error) => res.status(400).json({ ok: false, error: error.message }),
  };
  vm.runInNewContext(source.slice(source.indexOf('const desktopResetPurpose ='),
    source.indexOf('app.post("/api/password-reset/send"')), context);
  return { mails, forgotten, async send() {
    let status = 200, body;
    const res = { status(value) { status = value; return res; }, json(value) { body = value; } };
    await routes.get("/api/password-reset/otp/send")({ body: { email: " STAFF@example.invalid " } }, res);
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
