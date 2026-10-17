const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.NODE_ENV = "test";
process.env.PORT = "0";
process.env.AUTH_CHALLENGE_SECRET = "desktop-test-secret";
process.env.AUTH_CODE_EXPIRES_SECONDS = "300";
process.env.AUTH_CODE_RESEND_SECONDS = "1";
process.env.AUTH_CODE_REQUESTS_PER_HOUR = "20";
process.env.ALPHASTAR_DATA_FILE = path.join(
  os.tmpdir(),
  `alphastar-desktop-challenges-${process.pid}.json`,
);

const {
  __test: {
    accountVerificationOtpEmailHtml,
    accountVerificationPurpose,
    createChallenge,
    readStore,
    securityCodeEmailHtml,
    securityPurposes,
    staffAccountCreatedEmailHtml,
    verifyChallenge,
    writeStore,
  },
} = require("../src/server");

function resetStore() {
  fs.rmSync(process.env.ALPHASTAR_DATA_FILE, { force: true });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test.beforeEach(resetStore);
test.after(resetStore);

test("account verification OTP cannot be used as a security code", () => {
  const challenge = createChallenge({
    email: "juan@example.com",
    purpose: accountVerificationPurpose,
    userId: "admin-1",
  });

  assert.throws(
    () =>
      verifyChallenge({
        challengeToken: challenge.challengeToken,
        code: challenge.code,
        email: "juan@example.com",
        purpose: securityPurposes.staffLogin,
        requireUserId: true,
        userId: "admin-1",
      }),
    /not valid for this verification request/i,
  );

  verifyChallenge({
    challengeToken: challenge.challengeToken,
    code: challenge.code,
    email: "juan@example.com",
    purpose: accountVerificationPurpose,
    requireUserId: true,
    userId: "admin-1",
  });
});

test("codes are one-time use only", () => {
  const challenge = createChallenge({
    email: "staff@example.com",
    purpose: securityPurposes.staffLogin,
    userId: "staff-1",
  });

  verifyChallenge({
    challengeToken: challenge.challengeToken,
    code: challenge.code,
    email: "staff@example.com",
    purpose: securityPurposes.staffLogin,
    requireUserId: true,
    userId: "staff-1",
  });

  assert.throws(
    () =>
      verifyChallenge({
        challengeToken: challenge.challengeToken,
        code: challenge.code,
        email: "staff@example.com",
        purpose: securityPurposes.staffLogin,
        requireUserId: true,
        userId: "staff-1",
      }),
    /already been used/i,
  );
});

test("requesting a new code replaces the previous active code", async () => {
  const first = createChallenge({
    email: "staff@example.com",
    purpose: securityPurposes.staffLogin,
    userId: "staff-2",
  });
  await wait(1100);
  const second = createChallenge({
    email: "staff@example.com",
    purpose: securityPurposes.staffLogin,
    userId: "staff-2",
  });

  assert.notEqual(first.challengeToken, second.challengeToken);
  assert.throws(
    () =>
      verifyChallenge({
        challengeToken: first.challengeToken,
        code: first.code,
        email: "staff@example.com",
        purpose: securityPurposes.staffLogin,
        requireUserId: true,
        userId: "staff-2",
      }),
    /newer code/i,
  );
});

test("code verification checks email and user ID", () => {
  const challenge = createChallenge({
    email: "secure@example.com",
    purpose: securityPurposes.staffEmailChange,
    userId: "staff-3",
  });

  assert.throws(
    () =>
      verifyChallenge({
        challengeToken: challenge.challengeToken,
        code: challenge.code,
        email: "other@example.com",
        purpose: securityPurposes.staffEmailChange,
        requireUserId: true,
        userId: "staff-3",
      }),
    /email address/i,
  );

  assert.throws(
    () =>
      verifyChallenge({
        challengeToken: challenge.challengeToken,
        code: challenge.code,
        email: "secure@example.com",
        purpose: securityPurposes.staffEmailChange,
        requireUserId: true,
        userId: "staff-4",
      }),
    /user account/i,
  );
});

test("expired codes cannot be approved", () => {
  const challenge = createChallenge({
    email: "expired@example.com",
    purpose: securityPurposes.passwordReset,
    userId: "staff-5",
  });
  const store = readStore();
  store.authChallenges[challenge.challengeToken].expiresAt = new Date(Date.now() - 1000).toISOString();
  writeStore(store);

  assert.throws(
    () =>
      verifyChallenge({
        challengeToken: challenge.challengeToken,
        code: challenge.code,
        email: "expired@example.com",
        purpose: securityPurposes.passwordReset,
        requireUserId: true,
        userId: "staff-5",
      }),
    /expired/i,
  );
});

test("templates use saved names and never render placeholders", () => {
  const named = accountVerificationOtpEmailHtml({
    code: "123456",
    recipientName: "Juan Dela Cruz",
  });
  const fallback = securityCodeEmailHtml({ code: "654321" });

  assert.match(named, /Hi, <strong[^>]*>Juan Dela Cruz!<\/strong>/);
  assert.match(fallback, />Hello</);
  assert.doesNotMatch(fallback, /undefined|null|placeholder/i);
});

test("PIN code email matches the mobile dark-and-teal design at desktop and phone widths", () => {
  const email = securityCodeEmailHtml({
    code: "012345", recipientName: "Juan Dela Cruz", expiresLabel: "5 minutes",
  });
  assert.match(email, /background:#252525/);
  assert.match(email, /max-width:900px[^\"]*background:#111111/);
  assert.match(email, /background:#0f8f82/);
  assert.match(email, /font-size:24px[^\"]*letter-spacing:1.5px/);
  assert.match(email, /max-width:480px/);
  assert.match(email, /padding-left:24px !important; padding-right:24px !important/);
  assert.match(email, /Send PIN<\/span><br>Code/);
  assert.match(email, />PIN Code<\/td>/);
  assert.match(email, /012345/);
  assert.match(email, /expires in 5 minutes/);
  assert.match(email, /Never share this code/);
  assert.doesNotMatch(email, /Security OTP|Verification Code|\bOTP\b|Send One-Time/i);
});

test("PIN emails escape names, codes, titles and instructions", () => {
  const email = securityCodeEmailHtml({
    code: '<script>bad()</script>', recipientName: '<img src=x onerror=bad()>',
    title: '<script>title()</script>', appLabel: '<b>App</b>',
    description: '<script>description()</script>', expiresLabel: '<b>5 minutes</b>',
  });
  assert.doesNotMatch(email, /<script>|<img src=x|<b>/);
  assert.match(email, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(email, /&lt;script&gt;title\(\)&lt;\/script&gt;/);
  assert.match(email, />img src=x onerror=bad\(\)!<\/strong>/);
  assert.match(email, /&lt;b&gt;5 minutes&lt;\/b&gt;/);
});

test("recovery verification emails use the mobile heading without calling the emailed code a PIN", () => {
  const email = securityCodeEmailHtml({
    code: "012345", codeType: "verification", recipientName: "Synthetic Staff",
    title: "Reset your password", expiresLabel: "5 minutes",
    description: "Use this one-time verification code to reset your Alphastar password.",
  });
  assert.match(email, /Send Verification<\/span><br>Code/);
  assert.match(email, />Verification Code<\/td>/);
  assert.match(email, /Please enter the verification code below on Alphastar desktop app/);
  assert.match(email, /Reset your password: 012345/);
  assert.match(email, /expires in 5 minutes/);
  assert.match(email, /Never share this code with anyone/);
  assert.doesNotMatch(email, /\bPIN\b|Security OTP|undefined|null/);
  assert.match(securityCodeEmailHtml({ code: "012345", codeType: "verification" }),
    /<title>Alphastar Verification Code<\/title>/);
});

test("PIN and welcome logos are hosted images, not attachments, while other files are retained", () => {
  const { emailAttachmentsForHtml } = require("../src/server").__test;
  const existing = { filename: "clinic-note.txt", content: "Test note" };
  const email = securityCodeEmailHtml({ code: "123456" });
  assert.match(email, /src="https:\/\/[^\"]+" width="86" height="86"/);
  assert.doesNotMatch(email, /cid:alphastar/);
  assert.doesNotMatch(staffAccountCreatedEmailHtml({ recipientName: "Juan" }), /cid:alphastar/);
  const attachments = emailAttachmentsForHtml(email, [existing]);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0], existing);
  assert.deepEqual(emailAttachmentsForHtml("No inline logo", [existing]), [existing]);
  assert.deepEqual(emailAttachmentsForHtml('src="cid:alphastar-logo"'), []);
  assert.deepEqual(emailAttachmentsForHtml(email, [
    { cid: "alphastar-logo", filename: "alpha-star-logo.png" },
    { cid: "<ALPHASTAR-PIN-LOGO>", filename: "alphastar-logo.png" }, existing,
  ]), [existing]);
});

test("staff welcome matches the mobile welcome design without a PIN or password", () => {
  const email = staffAccountCreatedEmailHtml({ recipientName: "Juan Dela Cruz" });

  assert.match(email, /Alphastar Laboratory/);
  assert.match(email, /Welcome to Alphastar/);
  assert.match(email, /Hello, <strong[^>]*>Juan Dela Cruz!<\/strong>/);
  assert.match(email, /Staff Portal account has been successfully created/);
  assert.match(email, /background:#252525/);
  assert.match(email, /max-width:900px[^\"]*background:#111111/);
  assert.match(email, /width="86" height="86"/);
  assert.match(email, /background:#0f8f82/);
  assert.match(email, /max-width:480px/);
  assert.match(email, /does not contain your password/);
  assert.doesNotMatch(email, /Verification Code|PIN Code|One-Time Verification|undefined|null|placeholder/i);
});
