"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const delivery = require("../src/email-delivery");

const env = { EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "test-secret", EMAIL_FROM_ADDRESS: "clinic@example.test" };
const message = { to: "patient@example.test", subject: "Test OTP", html: "<p>123456</p>", text: "123456" };

test("Brevo selection requires a key and sender and preserves explicit SMTP selection", () => {
  assert.equal(delivery.emailProvider({}), "smtp");
  assert.equal(delivery.emailProvider({ BREVO_API_KEY: "key" }), "brevo");
  assert.equal(delivery.emailProvider({ ...env, EMAIL_PROVIDER: "smtp" }), "smtp");
  assert.equal(delivery.brevoReady(env), true);
  for (const patch of [{ BREVO_API_KEY: "" }, { EMAIL_FROM_ADDRESS: "" }, { EMAIL_FROM_ADDRESS: "not-an-email" }]) {
    assert.equal(delivery.brevoReady({ ...env, ...patch }), false);
  }
});

test("Brevo delivers through HTTPS with the server's verified sender, not a caller override", async () => {
  let calls = 0;
  const id = await delivery.sendMailViaBrevo({ ...message, fromEmail: "other@example.test" }, {
    env,
    fetchImpl: async (url, request) => {
      calls++;
      assert.equal(url, "https://api.brevo.com/v3/smtp/email");
      assert.equal(request.method, "POST");
      assert.equal(request.headers["api-key"], env.BREVO_API_KEY);
      assert.ok(request.signal instanceof AbortSignal);
      const body = JSON.parse(request.body);
      assert.deepEqual(body.sender, { email: env.EMAIL_FROM_ADDRESS, name: "Alphastar Laboratory" });
      assert.deepEqual(body.to, [{ email: message.to }]);
      assert.equal(body.htmlContent, message.html);
      assert.equal(body.textContent, message.text);
      assert.equal(body.subject, message.subject);
      assert.equal(body.attachment, undefined);
      return { ok: true, json: async () => ({ messageId: "accepted-id" }) };
    },
  });
  assert.equal(id, "accepted-id");
  assert.equal(calls, 1);
});

test("missing Brevo config never makes a network request", async () => {
  await assert.rejects(delivery.sendMailViaBrevo(message, {
    env: {}, fetchImpl: () => assert.fail("Unconfigured delivery must not send"),
  }), { code: "EMAIL_DELIVERY_UNAVAILABLE", status: 503 });
});

for (const failure of ["unauthorized", "quota", "timeout", "network", "invalid-json", "missing-id"]) {
  test(`Brevo ${failure} is sanitized and never retried or falsely reported as sent`, async () => {
    let calls = 0;
    await assert.rejects(delivery.sendMailViaBrevo(message, {
      env,
      fetchImpl: async () => {
        calls++;
        if (["timeout", "network"].includes(failure)) throw new Error(`${env.BREVO_API_KEY} ${message.to} ${message.text}`);
        if (["unauthorized", "quota"].includes(failure)) return { ok: false, status: failure === "quota" ? 429 : 401 };
        return { ok: true, json: async () => {
          if (failure === "invalid-json") throw new Error("Private provider body");
          return {};
        } };
      },
    }), (error) => {
      assert.equal(error.code, "EMAIL_DELIVERY_UNAVAILABLE");
      assert.equal(error.status, 503);
      for (const secret of [env.BREVO_API_KEY, message.to, message.text, "Private provider body"]) {
        assert.ok(!error.message.includes(secret));
      }
      return true;
    });
    assert.equal(calls, 1);
  });
}

const serverSource = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
const declarations = [...serverSource.matchAll(/^(?:async )?function (\w+)\(/gm)];
function mailRuntime(environment, overrides = {}) {
  const names = new Set(["smtpConfig", "smtpReady", "emailReady", "emailSender", "sendMail", "escapeHtml", "emailAttachmentsForHtml"]);
  const code = declarations.flatMap((match, index) => names.has(match[1])
    ? [serverSource.slice(match.index, declarations[index + 1]?.index ?? serverSource.length)] : []).join("\n");
  return vm.runInNewContext(`${code}; ({emailReady, emailSender, sendMail})`, {
    ...delivery,
    emailProvider: () => delivery.emailProvider(environment),
    brevoReady: () => delivery.brevoReady(environment),
    brevoConfig: () => delivery.brevoConfig(environment),
    process: { env: environment }, alphastarSenderEmail: "legacy@example.test", console,
    securityCodeEmailLogoUrl: () => "https://example.test/logo.png",
    shouldUseDirectGmailSmtp: () => false,
    mailTransporter: () => ({ sendMail: () => assert.fail("Brevo must not use SMTP") }),
    ...overrides,
  });
}

test("server mail readiness and signup/reset delivery accept Brevo without SMTP credentials", async () => {
  const mail = mailRuntime(env, { sendMailViaBrevo: async received => {
    assert.equal(received.html, '<img src="https://example.test/logo.png">');
    assert.equal(received.to, message.to);
    assert.equal(received.attachments.length, 0);
    return "accepted-id";
  } });
  assert.equal(mail.emailReady(), true);
  assert.equal(mail.emailSender(), env.EMAIL_FROM_ADDRESS);
  await mail.sendMail({ ...message, html: '<img src="cid:alphastar-logo">' });
  await mail.sendMail({ ...message, html: '<img src="cid:alphastar-pin-logo">', fromEmail: "legacy@example.test", attachments: [{ cid: "alphastar-pin-logo", filename: "alphastar-logo.png" }] });
});

for (const direct of [false, true]) {
  test(`${direct ? "direct Gmail" : "Nodemailer"} SMTP shows the logo in HTML without attaching a picture`, async () => {
    const sent = [];
    const mail = mailRuntime({ EMAIL_PROVIDER: "smtp", SMTP_USER: "sender@example.test", SMTP_PASS: "password" }, {
      shouldUseDirectGmailSmtp: () => direct,
      sendMailViaDirectSmtp: async payload => sent.push(payload),
      mailTransporter: () => ({ sendMail: async payload => sent.push(payload) }),
    });
    await mail.sendMail({ ...message, html: '<img src="cid:alphastar-pin-logo">' });
    await mail.sendMail({ ...message, html: '<img src="cid:alphastar-logo">', attachments: [{ cid: "alphastar-logo", filename: "alpha-star-logo.png" }] });
    assert.equal(sent.length, 2);
    for (const payload of sent) {
      assert.equal(payload.html, '<img src="https://example.test/logo.png">');
      assert.equal((payload.attachments || []).length, 0);
    }
    const report = { filename: "clinic-report.pdf", content: "Fake test report" };
    await mail.sendMail({ ...message, attachments: [report, { cid: "alphastar-pin-logo", filename: "alphastar-logo.png" }] });
    assert.equal(sent[2].attachments.length, 1);
    assert.equal(sent[2].attachments[0], report);
  });
}

test("SMTP still works on supported hosts and invalid providers cannot silently fall back", async () => {
  let sent = false;
  const mail = mailRuntime({ EMAIL_PROVIDER: "smtp", SMTP_USER: "sender@example.test", SMTP_PASS: "password" }, {
    mailTransporter: () => ({ sendMail: async () => { sent = true; } }),
  });
  assert.equal(mail.emailReady(), true);
  await mail.sendMail(message);
  assert.equal(sent, true);
  const invalid = mailRuntime({ ...env, EMAIL_PROVIDER: "typo" });
  assert.equal(invalid.emailReady(), false);
  await assert.rejects(invalid.sendMail(message), { status: 503 });
});

test("Brevo readiness reports blocked egress without sending an email or exposing provider details", async () => {
  const { createBrevoStatusCheck } = require("../src/email-delivery");
  let requests = 0;
  const check = createBrevoStatusCheck({
    env: { EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "synthetic", EMAIL_FROM_ADDRESS: "clinic@example.invalid" },
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url, "https://api.brevo.com/v3/senders");
      assert.equal(options.method, undefined);
      return { status: 401, json: async () => ({ message: "Unrecognized IP address 192.0.2.4" }) };
    },
  });
  assert.deepEqual(await Promise.all([check(), check()]), ["outbound-ip-rejected", "outbound-ip-rejected"]);
  assert.equal(await check(), "outbound-ip-rejected");
  assert.equal(requests, 1);
});
