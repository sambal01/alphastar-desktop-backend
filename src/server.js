const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const tls = require("node:tls");
const cors = require("cors");
const dotenv = require("dotenv");
const express = require("express");
const { registerBookingRoutes } = require("./scheduling-routes");
const { registerQueueRoutes, createStaffAccessGuard } = require("./queue-routes");
const { registerSmpeRoutes } = require("./smpe-routes");
const { registerSyncRoutes } = require("./sync-routes");
const { createPatientAuthenticatorAccess } = require("./patient-authenticator-access");
const { accountType: desktopAccountType, requireAdministrator, createAccountService } = require("./account-service");
const { createStaffAccountPin } = require("./staff-account-pin");
const { cert, getApp, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const nodemailer = require("nodemailer");
const { emailProvider, brevoConfig, brevoReady, emailUnavailableError, sendMailViaBrevo } = require("./email-delivery");

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });
dotenv.config({ override: false, quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), "../.env"), override: false, quiet: true });

const app = express();
const port = Number(process.env.PORT || 4100);
const firebaseApiKey =
  process.env.FIREBASE_API_KEY ||
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY ||
  "";
const firebaseProjectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ||
  "";
const firebaseDatabaseUrl =
  process.env.FIREBASE_DATABASE_URL ||
  process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL ||
  "";
const configuredChallengeDurationSeconds = Number(process.env.AUTH_CODE_EXPIRES_SECONDS || 600);
const maxChallengeDurationSeconds = 10 * 60;
const challengeDurationSeconds = Number.isFinite(configuredChallengeDurationSeconds)
  ? Math.min(maxChallengeDurationSeconds, Math.max(1, configuredChallengeDurationSeconds))
  : maxChallengeDurationSeconds;
const challengeDurationMs = challengeDurationSeconds * 1000;
const challengeDurationMinutes = Math.max(1, Math.round(challengeDurationSeconds / 60));
const challengeDurationLabel =
  challengeDurationSeconds < 120
    ? `${challengeDurationSeconds} seconds`
    : `${challengeDurationMinutes} minutes`;
const configuredPasswordResetDurationSeconds = Number(
  process.env.AUTH_PASSWORD_RESET_EXPIRES_SECONDS || 600,
);
const passwordResetDurationSeconds = Number.isFinite(configuredPasswordResetDurationSeconds)
  ? Math.min(maxChallengeDurationSeconds, Math.max(1, configuredPasswordResetDurationSeconds))
  : maxChallengeDurationSeconds;
const passwordResetDurationMs = passwordResetDurationSeconds * 1000;
const passwordResetDurationMinutes = Math.max(1, Math.round(passwordResetDurationMs / 60000));
const passwordResetDurationLabel =
  passwordResetDurationMs < 120000
    ? `${Math.round(passwordResetDurationMs / 1000)} seconds`
    : `${passwordResetDurationMinutes} minutes`;
const configuredChallengeMaxAttempts = Number(process.env.AUTH_CODE_MAX_ATTEMPTS || 3);
const challengeMaxAttempts = Number.isFinite(configuredChallengeMaxAttempts)
  ? Math.max(1, configuredChallengeMaxAttempts)
  : 3;
const configuredOtpRequestsPerHour = Number(process.env.AUTH_CODE_REQUESTS_PER_HOUR || 5);
const otpRequestsPerHour = Number.isFinite(configuredOtpRequestsPerHour)
  ? Math.max(1, configuredOtpRequestsPerHour)
  : 5;
const otpRequestWindowMs = 60 * 60 * 1000;
const configuredResendDelaySeconds = Number(process.env.AUTH_CODE_RESEND_SECONDS || 60);
const minimumResendDelaySeconds = process.env.NODE_ENV === "test" ? 1 : 30;
const resendDelaySeconds = Number.isFinite(configuredResendDelaySeconds)
  ? Math.min(challengeDurationSeconds, Math.max(minimumResendDelaySeconds, configuredResendDelaySeconds))
  : 60;
const configuredLoginFailureLimit = Number(process.env.AUTH_LOGIN_FAILURE_LIMIT || 5);
const loginFailureLimit = Number.isFinite(configuredLoginFailureLimit)
  ? Math.max(1, configuredLoginFailureLimit)
  : 5;
const configuredLoginLockSeconds = Number(process.env.AUTH_LOGIN_LOCK_SECONDS || 900);
const loginLockMs = (Number.isFinite(configuredLoginLockSeconds) ? configuredLoginLockSeconds : 900) * 1000;
const challengeSecret =
  process.env.AUTH_CHALLENGE_SECRET ||
  process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString("hex");
const accountVerificationPurpose = "desktop_account_verification_otp";
const securityPurposes = {
  accountInvite: "desktop_security_account_invite",
  emailChange: "desktop_security_email_change",
  login: "desktop_security_login",
  passwordReset: "desktop_security_password_reset",
  accountDeletion: "desktop_security_account_deletion",
  staffEmailChange: "desktop_security_staff_email_change",
  staffLogin: "desktop_security_staff_login",
};
const authChallengeReceiptRetentionMs = 24 * 60 * 60 * 1000;
const staffRoles = new Set(["admin", "staff", "doctor", "nurse", "receptionist"]);
const alphastarSenderEmail = "alphastar.laboratory1@gmail.com";
const dataFile = path.resolve(
  path.resolve(__dirname, ".."),
  process.env.ALPHASTAR_DATA_FILE || "./data/local-store.json",
);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
const patientAuthenticatorAccess = createPatientAuthenticatorAccess({ getFirebaseApp: firebaseAdminApp, getAuth, getDatabase });
app.use("/api", patientAuthenticatorAccess.middleware);
app.use((req, res, next) => {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(req.hostname);
  if (
    process.env.NODE_ENV === "production" &&
    !req.secure &&
    forwardedProto !== "https" &&
    !localHost
  ) {
    return res.status(403).json({ error: "HTTPS is required.", ok: false });
  }
  next();
});

const emptyStore = {
  appointments: {},
  auditLogs: {},
  clinicSettings: {},
  emailRegistry: {},
  inventory: {},
  medicalRecords: {},
  notifications: {},
  patientProfiles: {},
  profiles: {},
  queueEntries: {},
  schedules: {},
  services: {},
  staff: {},
  stockTransactions: {},
  authChallenges: {},
  authChallengeReceipts: {},
  authChallengeRequests: {},
  registrationTokens: {},
  loginSecurity: {},
  passwordResetLinks: {},
  users: {},
};

function ensureDataFile() {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(emptyStore, null, 2));
  }
}

const persistentStore = require("./persistent-store");
function readStore() { return persistentStore.read(dataFile, emptyStore); }
function writeStore(store) { persistentStore.write(dataFile, store); }

function normalizeEmail(email = "") {
  return String(email || "").trim().toLowerCase();
}

const RFC_5322_EMAIL_REGEX =
  /^(?:[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}|\[(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?|[a-zA-Z0-9-]*[a-zA-Z0-9]:[^\[\]\s]+)\])$/;

function isValidEmail(email = "") {
  const normalized = normalizeEmail(email);
  return normalized.length <= 254 && RFC_5322_EMAIL_REGEX.test(normalized);
}

function sanitizePlainText(value = "", maxLength = 160) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function maskEmail(email = "") {
  const normalized = normalizeEmail(email);
  return normalized.replace(/^(.).+(@.+)$/, "$1***$2");
}

function emailRegistryKey(email = "") {
  return crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

function localEmailRegistered(email = "") {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const store = readStore();
  const registryKey = emailRegistryKey(normalized);
  if (store.emailRegistry?.[registryKey]) return true;
  return Object.values(store.users || {}).some(
    (user) =>
      normalizeEmail(user?.email) === normalized ||
      normalizeEmail(user?.normalizedEmail) === normalized,
  );
}

function claimLocalEmailRegistry(email = "", uid = "", options = {}) {
  const normalized = normalizeEmail(email);
  const registryKey = emailRegistryKey(normalized);
  if (!normalized || !uid) return false;

  const store = readStore();
  store.emailRegistry ||= {};
  const existing = store.emailRegistry[registryKey];
  if (existing && existing.uid !== uid && !options.allowReplace) {
    throw duplicateEmailError();
  }

  store.emailRegistry[registryKey] = {
    createdAt: existing?.createdAt || new Date().toISOString(),
    emailHash: registryKey,
    maskedEmail: maskEmail(normalized),
    uid,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
  return true;
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function smtpConfig() {
  const user =
    process.env.SMTP_USER ||
    process.env.GMAIL_USER ||
    process.env.MAIL_USER ||
    "";
  const pass = String(
    process.env.SMTP_PASS ||
    process.env.SMTP_PASSWORD ||
    process.env.GMAIL_APP_PASSWORD ||
    process.env.GMAIL_PASS ||
    "",
  ).replace(/\s+/g, "");
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false";
  const fromEmail = process.env.SMTP_FROM_EMAIL || user || alphastarSenderEmail;
  const fromName = process.env.SMTP_FROM_NAME || "Alphastar Laboratory";

  return { fromEmail, fromName, host, pass, port, secure, user };
}

function smtpReady() {
  const config = smtpConfig();
  return Boolean(config.user && config.pass && config.fromEmail);
}

function emailReady() {
  const provider = emailProvider();
  return provider === "brevo" ? brevoReady() : provider === "smtp" && smtpReady();
}

function emailSender() {
  return emailProvider() === "brevo" ? brevoConfig().fromEmail : smtpConfig().fromEmail;
}

function securityCodeEmailLogoUrl() {
  const configuredUrl = String(process.env.ALPHASTAR_EMAIL_LOGO_URL || "").trim();
  if (configuredUrl) {
    try {
      const parsedUrl = new URL(configuredUrl);
      if (parsedUrl.protocol === "https:") return parsedUrl.toString();
    } catch {
      // Use the same public clinic emblem as mobile when an override is invalid.
    }
  }
  return "https://alpha-star-clinic-mobile.web.app/assets/images/alphastarlogo.png";
}

function mailTransporter() {
  const config = smtpConfig();
  if (!smtpReady()) {
    throw new Error(
      "Gmail SMTP is not configured. Add SMTP_USER and SMTP_PASS/GMAIL_APP_PASSWORD to alphastar-desktop/backend/.env.",
    );
  }

  return nodemailer.createTransport({
    auth: {
      pass: config.pass,
      user: config.user,
    },
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 12000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 12000),
    host: config.host,
    port: config.port,
    secure: config.secure,
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
  });
}

function alphaStarEmailLogoPath() {
  return [
    path.resolve(__dirname, "../../src/assets/logo.png"),
    path.resolve(__dirname, "../../src/assets/logoalphastarr.png"),
    path.resolve(__dirname, "../../src/assets/alphastar picture.png"),
  ].find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || "";
}

function alphaStarEmailLogoMarkup() {
  return `<img src="${escapeHtml(securityCodeEmailLogoUrl())}" width="126" alt="Alphastar Laboratory" style="border:0;display:block;height:auto;margin:0 auto;max-width:126px;outline:none;text-decoration:none;width:126px;">`;
}

function emailAttachmentsForHtml(_html = "", attachments = []) {
  // Hosted logos must not become downloadable pictures. Preserve unrelated files.
  const logoCids = new Set(["alphastar-logo", "alphastar-pin-logo"]);
  return attachments.filter((attachment) => !logoCids.has(
    String(attachment.cid || "").replace(/[<>]/g, "").toLowerCase(),
  ));
}

function cleanMailHeader(value = "") {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function encodeMimeHeader(value = "") {
  const clean = cleanMailHeader(value);
  if (!clean) return "";
  return /^[\x20-\x7e]+$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function formatMailbox(email = "", name = "") {
  const cleanEmail = normalizeEmail(email);
  const cleanName = encodeMimeHeader(name);
  return cleanName ? `${cleanName} <${cleanEmail}>` : cleanEmail;
}

function wrapBase64(value) {
  return Buffer.from(value).toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function smtpAttachmentContentType(filename = "") {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".svg") return "image/svg+xml";
  return "image/png";
}

function createMimeMessage({ attachments = [], fromEmail, fromName, html, subject, text, to }) {
  const relatedBoundary = `alpha_related_${crypto.randomBytes(12).toString("hex")}`;
  const alternativeBoundary = `alpha_alt_${crypto.randomBytes(12).toString("hex")}`;
  const recipients = Array.isArray(to)
    ? to.map((item) => normalizeEmail(item)).filter(Boolean)
    : String(to || "")
        .split(",")
        .map((item) => normalizeEmail(item))
        .filter(Boolean);
  const safeAttachments = attachments.filter((attachment) => {
    try {
      return attachment?.path && fs.existsSync(attachment.path);
    } catch {
      return false;
    }
  });

  const headers = [
    `From: ${formatMailbox(fromEmail, fromName)}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodeMimeHeader(subject || "Alpha Star verification")}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${crypto.randomBytes(8).toString("hex")}@alphastar.local>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
  ];

  const parts = [
    headers.join("\r\n"),
    "",
    `--${relatedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(text || ""),
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(html || ""),
    `--${alternativeBoundary}--`,
  ];

  safeAttachments.forEach((attachment) => {
    const filename = cleanMailHeader(attachment.filename || path.basename(attachment.path));
    const cid = cleanMailHeader(attachment.cid || filename);
    parts.push(
      `--${relatedBoundary}`,
      `Content-Type: ${smtpAttachmentContentType(filename)}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${cid}>`,
      `Content-Disposition: inline; filename="${filename}"`,
      "",
      wrapBase64(fs.readFileSync(attachment.path)),
    );
  });

  parts.push(`--${relatedBoundary}--`, "");
  return { message: parts.join("\r\n"), recipients };
}

function createSmtpResponseReader(socket) {
  let buffer = "";
  let currentLines = [];
  const responses = [];
  let waiter = null;

  function flush() {
    if (!waiter || !responses.length) return;
    const next = responses.shift();
    const resolve = waiter.resolve;
    clearTimeout(waiter.timer);
    waiter = null;
    resolve(next);
  }

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
      buffer = buffer.slice(lineEnd + 1);
      if (/^\d{3}[ -]/.test(line)) {
        currentLines.push(line);
        if (line[3] === " ") {
          responses.push({
            code: Number(line.slice(0, 3)),
            lines: currentLines,
          });
          currentLines = [];
          flush();
        }
      }
      lineEnd = buffer.indexOf("\n");
    }
  });

  socket.on("error", (error) => {
    if (!waiter) return;
    const reject = waiter.reject;
    clearTimeout(waiter.timer);
    waiter = null;
    reject(error);
  });

  return {
    read(timeoutMs = 12000) {
      if (responses.length) return Promise.resolve(responses.shift());
      return new Promise((resolve, reject) => {
        waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            waiter = null;
            reject(new Error("SMTP server did not respond in time."));
          }, timeoutMs),
        };
      });
    },
  };
}

function assertSmtpCode(response, expectedCodes, label) {
  if (expectedCodes.includes(response.code)) return;

  const error = new Error(`SMTP ${label} failed with status ${response.code}.`);
  error.smtpCode = response.code;
  throw error;
}

async function smtpCommand(socket, reader, command, expectedCodes, label = command) {
  socket.write(`${command}\r\n`);
  const response = await reader.read();
  assertSmtpCode(response, expectedCodes, label);
  return response;
}

function connectSecureSmtpSocket(config) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: config.host,
        port: config.port,
        servername: config.host,
        timeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
      },
      () => resolve(socket),
    );
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("SMTP connection timed out."));
    });
  });
}

async function sendMailViaDirectSmtp({ attachments = [], fromEmail, fromName, html, subject, text, to }) {
  const config = smtpConfig();
  if (!config.secure) {
    throw new Error("Direct Gmail SMTP sending requires SMTP_SECURE=true on port 465.");
  }

  const senderEmail = fromEmail || config.fromEmail;
  const senderName = fromName || config.fromName;
  const { message, recipients } = createMimeMessage({
    attachments,
    fromEmail: senderEmail,
    fromName: senderName,
    html,
    subject,
    text,
    to,
  });
  if (!recipients.length) {
    throw new Error("Email recipient is missing.");
  }

  const socket = await connectSecureSmtpSocket(config);
  const reader = createSmtpResponseReader(socket);

  try {
    assertSmtpCode(await reader.read(), [220], "greeting");
    await smtpCommand(socket, reader, "EHLO alphastar.local", [250], "hello");
    await smtpCommand(socket, reader, "AUTH LOGIN", [334], "auth start");
    await smtpCommand(
      socket,
      reader,
      Buffer.from(config.user).toString("base64"),
      [334],
      "auth user",
    );
    await smtpCommand(
      socket,
      reader,
      Buffer.from(config.pass).toString("base64"),
      [235],
      "auth password",
    );
    await smtpCommand(socket, reader, `MAIL FROM:<${normalizeEmail(senderEmail)}>`, [250], "sender");
    for (const recipient of recipients) {
      await smtpCommand(socket, reader, `RCPT TO:<${recipient}>`, [250, 251], "recipient");
    }
    await smtpCommand(socket, reader, "DATA", [354], "data");
    const safeMessage = message.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    socket.write(`${safeMessage}\r\n.\r\n`);
    assertSmtpCode(await reader.read(), [250], "message");
    await smtpCommand(socket, reader, "QUIT", [221], "quit").catch(() => {});
  } finally {
    socket.end();
  }
}

function shouldUseDirectGmailSmtp(config) {
  return /(^|\.)gmail\.com$/i.test(String(config.host || "").trim()) && config.secure;
}

async function sendMail({ attachments = [], fromEmail, fromName, html, subject, text, to }) {
  if (!emailReady()) throw emailUnavailableError();
  // Normalize older templates too, for both SMTP and Brevo; never attach the logo.
  const emailHtml = String(html || "")
    .replaceAll("cid:alphastar-pin-logo", escapeHtml(securityCodeEmailLogoUrl()))
    .replaceAll("cid:alphastar-logo", escapeHtml(securityCodeEmailLogoUrl()));
  const mailAttachments = emailAttachmentsForHtml(emailHtml, attachments);
  if (emailProvider() === "brevo") {
    // As in mobile, Brevo uses only the server's verified sender, including for resets.
    return sendMailViaBrevo({
      attachments: mailAttachments,
      html: emailHtml,
      subject,
      text,
      to,
    });
  }
  const config = smtpConfig();
  const senderEmail = fromEmail || config.fromEmail;
  const senderName = fromName || config.fromName;
  try {
    if (shouldUseDirectGmailSmtp(config)) {
      await sendMailViaDirectSmtp({
        attachments: mailAttachments,
        fromEmail: senderEmail,
        fromName: senderName,
        html: emailHtml,
        subject,
        text,
        to,
      });
      return;
    }

    await mailTransporter().sendMail({
      ...(mailAttachments.length ? { attachments: mailAttachments } : {}),
      from: `"${senderName}" <${senderEmail}>`,
      html: emailHtml,
      subject,
      text,
      to,
    });
  } catch (error) {
    const message = String(error?.message || "");
    const friendlyError = new Error(
      message.includes("Username and Password not accepted") ||
      message.includes("Invalid login") ||
      message.includes("EAUTH")
        ? "Unable to send email from Gmail. Check alphastar-desktop/backend/.env Gmail app password and Gmail 2-Step Verification."
        : "Unable to send email from Gmail. Check alphastar-desktop/backend/.env SMTP settings and internet connection.",
    );
    friendlyError.status = 503;
    throw friendlyError;
  }
}

function escapeHtml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function brandedEmailHtml({
  body,
  footerNote = "If you did not request this, you can safely ignore this email.",
  greeting = "Hello,",
  preview = "",
  kicker = "ALPHASTAR LABORATORY",
  title,
}) {
  const safePreview = escapeHtml(preview || title || "Alphastar notification");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;background:#202422;padding:0;font-family:Poppins,Arial,Helvetica,sans-serif;color:#c9fff6;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safePreview}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#202422;">
      <tr>
        <td align="center" style="padding:0 18px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:780px;border-collapse:collapse;">
            <tr>
              <td style="padding:0;background:#0f1211;border-left:1px solid #153f38;border-right:1px solid #153f38;box-shadow:0 0 0 1px rgba(84,219,204,.12),0 24px 70px rgba(0,0,0,.42);">
                <div style="padding:58px 92px 52px;">
                  <div style="margin:0 0 30px;font-size:22px;line-height:1.2;font-weight:800;letter-spacing:7px;color:#11b8a8;">${escapeHtml(kicker)}</div>
                  <h1 style="margin:0;font-size:66px;line-height:1.12;color:#c9fff6;font-weight:900;letter-spacing:-1.8px;">${escapeHtml(title)}</h1>
                  <div style="width:100%;max-width:560px;height:8px;background:linear-gradient(90deg,#12c7b6 0%,#0b8b80 70%,rgba(18,199,182,0) 100%);border-radius:999px;margin:46px 0 72px;"></div>
                  <p style="margin:0 0 46px;font-size:36px;line-height:1.45;color:#c9fff6;font-weight:400;">${escapeHtml(greeting)}</p>
                  ${body}
                  <p style="margin:76px 0 0;text-align:center;font-size:24px;line-height:1.45;color:#8fbab3;">${escapeHtml(footerNote)}</p>
                  <p style="margin:32px 0 0;text-align:center;font-size:18px;line-height:1.45;color:#607a76;">Sender: ${escapeHtml(emailSender() || "alphastar.laboratory1@gmail.com")}</p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 10px 42px;text-align:center;color:#8fbab3;font-size:16px;line-height:1.5;">
                Alphastar Laboratory Diagnostic & Multispecialty Clinic
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function emailGreetingName(value = "") {
  const cleaned = sanitizePlainText(value, 120)
    .replace(/^hello\s*,?\s*/i, "")
    .replace(/^hi\s*,?\s*/i, "")
    .replace(/[!,]+$/g, "")
    .trim();
  return cleaned;
}

function registeredNameFromRecord(record = {}) {
  if (!record || typeof record !== "object") return "";

  return [
    record.fullName,
    record.firstName,
    record.givenName,
    record.displayName,
    record.patientName,
    record.name,
    record.profileName,
    record.registeredName,
  ]
    .map((value) => sanitizePlainText(value, 120))
    .find(Boolean) || "";
}

function staffAccountCreatedEmailHtml({ recipientName = "" } = {}) {
  const safeName = escapeHtml(emailGreetingName(recipientName));
  const safePreview = escapeHtml("Your Alphastar Staff Portal account is ready.");
  const safeTitle = escapeHtml("Welcome to Alphastar");
  const logoUrl = escapeHtml(securityCodeEmailLogoUrl());
  const accentColor = "#0f8f82";
  const greetingMarkup = safeName
    ? `Hello, <strong style="color:#ffffff;font-weight:700;">${safeName}!</strong>`
    : "Hello!";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      @media only screen and (max-width:480px) {
        .email-content { padding-left:24px !important; padding-right:24px !important; }
        .email-title { font-size:28px !important; line-height:36px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#252525;font-family:Arial,Helvetica,sans-serif;color:#f2f2f2;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safePreview}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#252525;margin:0;padding:0;">
      <tr>
        <td align="center" style="padding:12px 14px 20px;">
          <table role="presentation" width="900" cellspacing="0" cellpadding="0" style="width:100%;max-width:900px;border-collapse:collapse;background:#111111;border:1px solid #3a3a3a;">
            <tr>
              <td align="center" style="padding:38px 64px 20px;">
                <img src="${logoUrl}" width="86" height="86" alt="Alphastar" style="border:0;display:block;height:86px;margin:0 auto;max-width:86px;outline:none;text-decoration:none;width:86px;">
              </td>
            </tr>
            <tr>
              <td class="email-content" style="padding:4px 64px 48px;">
                <h1 class="email-title" style="margin:0;color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;font-size:38px;font-weight:400;line-height:46px;">Welcome to Alphastar</h1>
                <div style="height:2px;background:${accentColor};margin:28px 0 20px;font-size:0;line-height:0;">&nbsp;</div>
                <p style="margin:0 0 20px;color:#dedede;font-size:16px;font-weight:400;line-height:24px;text-align:left;">
                  ${greetingMarkup}
                </p>
                <p style="margin:0;color:#d0d0d0;font-size:16px;font-weight:400;line-height:25px;text-align:left;">
                  Your Alphastar Staff Portal account has been successfully created. Sign in with your registered email address and the password provided by your administrator. For your security, this email does not contain your password.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:36px 0 0;">
                  <tr>
                    <td style="color:#969696;font-size:14px;font-weight:400;line-height:22px;">
                      This is an automated welcome email from Alphastar Laboratory.<br>
                      We’re glad you’re here.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendStaffAccountCreatedEmail({ email, recipientName }) {
  await sendMail({
    html: staffAccountCreatedEmailHtml({ recipientName }),
    subject: "Your AlphaStar Staff Portal account is ready",
    text: `${recipientName ? `Hello, ${recipientName}!` : "Hello,"}\n\nYour account has been successfully created in the AlphaStar Staff Portal. You can now sign in with your registered email address and the password provided by your administrator. For your security, this email does not include your password.`,
    to: email,
  });
}

function accountVerificationOtpEmailHtml({
  appLabel = "Alphastar desktop app",
  code,
  expiresLabel = challengeDurationLabel,
  recipientName = "",
}) {
  return securityCodeEmailHtml({
    appLabel,
    code,
    expiresLabel,
    intro: "Use this one-time PIN code to verify the email address for your Alphastar desktop account.",
    recipientName,
    title: "Verify your Alphastar account",
  });
}

function securityCodeEmailHtml({
  appLabel = "Alphastar desktop app",
  code,
  codeType = "pin",
  description = "",
  expiresLabel = challengeDurationLabel,
  greeting = "",
  intro = "",
  recipientName = "",
  title = "",
}) {
  const isVerificationCode = codeType === "verification";
  const codeName = isVerificationCode ? "verification code" : "PIN code";
  const codeLabel = isVerificationCode ? "Verification Code" : "PIN Code";
  const heading = isVerificationCode ? "Send Verification" : "Send PIN";
  const emailTitle = title || `Alphastar ${codeLabel}`;
  const safeCode = escapeHtml(String(code || ""));
  const safeName = escapeHtml(emailGreetingName(recipientName || greeting));
  const safeAppLabel = escapeHtml(appLabel || "Alphastar desktop app");
  const safeExpiresLabel = escapeHtml(expiresLabel);
  const safeIntro = escapeHtml(
    description ||
      intro ||
      `Use this one-time ${codeName} to finish signing in to your Alphastar account.`,
  );
  const safePreview = escapeHtml(`${emailTitle}: ${code}`);
  const safeTitle = escapeHtml(emailTitle);
  const logoUrl = escapeHtml(securityCodeEmailLogoUrl());
  const accentColor = "#0f8f82";
  const greetingMarkup = safeName
    ? `Hi, <strong style="color:#ffffff;font-weight:700;">${safeName}!</strong>`
    : "Hello";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      @media only screen and (max-width:480px) {
        .email-content { padding-left:24px !important; padding-right:24px !important; }
        .email-title { font-size:28px !important; line-height:36px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#252525;font-family:Arial,Helvetica,sans-serif;color:#f2f2f2;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safePreview}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#252525;margin:0;padding:0;">
      <tr>
        <td align="center" style="padding:12px 14px 20px;">
          <table role="presentation" width="900" cellspacing="0" cellpadding="0" style="width:100%;max-width:900px;border-collapse:collapse;background:#111111;border:1px solid #3a3a3a;">
            <tr>
              <td align="center" style="padding:38px 64px 20px;">
                <img src="${logoUrl}" width="86" height="86" alt="Alphastar" style="border:0;display:block;height:86px;margin:0 auto;max-width:86px;outline:none;text-decoration:none;width:86px;">
              </td>
            </tr>
            <tr>
              <td class="email-content" style="padding:4px 64px 48px;">
                <h1 class="email-title" style="margin:0;color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;font-size:38px;font-weight:400;line-height:46px;"><span style="white-space:nowrap;">${heading}</span><br>Code</h1>
                <div style="height:2px;background:${accentColor};margin:28px 0 20px;font-size:0;line-height:0;">&nbsp;</div>

                <p style="margin:0 0 20px;color:#dedede;font-size:16px;font-weight:400;line-height:24px;text-align:left;">${greetingMarkup}</p>
                <p style="margin:0;color:#d0d0d0;font-size:16px;font-weight:400;line-height:25px;text-align:left;">
                  ${safeIntro} Please enter the ${codeName} below on ${safeAppLabel}. It expires in ${safeExpiresLabel}. Never share this code with anyone.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:74px 0 0;">
                  <tr>
                    <td align="center" style="padding:0 0 12px;color:#bcbcbc;font-size:14px;font-weight:400;line-height:22px;">${codeLabel}</td>
                  </tr>
                  <tr>
                    <td align="center">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;background:#111111;border:3px solid #3a3a3a;">
                        <tr>
                          <td align="center" style="padding:0 32px;color:${accentColor};font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:800;line-height:28px;letter-spacing:1.5px;">
                            ${safeCode}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:36px 0 0;">
                  <tr>
                    <td style="color:#969696;font-size:14px;font-weight:400;line-height:22px;">
                      This is an automated email from Alphastar Laboratory.<br>
                      If you did not request this code, you can safely ignore this email.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function passwordResetEmailHtml({ accountLabel = "mobile patient account", email, link, recipientName = "", title }) {
  const safeAccountLabel = escapeHtml(accountLabel);
  const safeLink = escapeHtml(link);
  const safeName = escapeHtml(emailGreetingName(recipientName));
  const safeTitle = escapeHtml(title || "Send Password Reset Link");
  const safeResetDurationLabel = escapeHtml(passwordResetDurationLabel);
  const accentColor = "#c8efe6";
  const greetingMarkup = safeName
    ? `Hi, <strong style="color:#222222;font-weight:700;">${safeName}!</strong>`
    : "Hello";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#222222;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Use this secure Alphastar password reset link.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#ffffff;margin:0;padding:0;">
      <tr>
        <td align="center" style="padding:12px 14px 20px;">
          <table role="presentation" width="900" cellspacing="0" cellpadding="0" style="width:100%;max-width:900px;border-collapse:collapse;background:#ffffff;border:1px solid #dddddd;">
            <tr>
              <td style="padding:36px 64px 48px;">
                <div style="margin:0 0 30px;text-align:left;color:${accentColor};font-family:Poppins,Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;line-height:22px;letter-spacing:1.2px;white-space:nowrap;">Alphastar Laboratory</div>

                <h1 style="margin:0;color:#222222;font-family:Arial,Helvetica,sans-serif;font-size:48px;font-weight:400;line-height:58px;">Send Password<br>Reset<br>Link</h1>
                <div style="height:4px;background:${accentColor};margin:28px 0 38px;font-size:0;line-height:0;">&nbsp;</div>

                <p style="margin:0 0 28px;color:#333333;font-size:25px;font-weight:400;line-height:34px;">
                  ${greetingMarkup}
                </p>
                <p style="margin:0;color:#4b4b4b;font-size:25px;font-weight:400;line-height:46px;">
                  Click the secure button below to reset the password for your Alphastar ${safeAccountLabel}. This link is valid for ${safeResetDurationLabel}.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:46px 0 0;">
                  <tr>
                    <td align="center" style="padding:0 0 18px;color:#666666;font-size:26px;font-weight:400;line-height:32px;">Password Reset Link</td>
                  </tr>
                  <tr>
                    <td align="center">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:separate;background:#18b6a8;border-radius:28px;">
                        <tr>
                          <td align="center" height="90" style="height:90px;padding:0 18px;font-family:Poppins,Arial,Helvetica,sans-serif;line-height:90px;white-space:nowrap;">
                            <a href="${safeLink}" target="_blank" style="display:block;color:#ffffff;font-family:Poppins,Arial,Helvetica,sans-serif;font-size:30px;font-weight:600;line-height:90px;letter-spacing:0;text-decoration:none;white-space:nowrap;">Reset Password</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:36px 0 0;">
                  <tr>
                    <td style="color:#888888;font-size:20px;font-weight:400;line-height:34px;">
                      * This is an automated e-mail from Alphastar Laboratory.<br>
                      * If you did not request this link, please ignore this email.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function challengeHash(challengeToken, code) {
  return crypto
    .createHmac("sha256", challengeSecret)
    .update(`${challengeToken}:${String(code || "").trim()}`)
    .digest("hex");
}

function codeFingerprint(code) {
  return crypto
    .createHmac("sha256", challengeSecret)
    .update(`auth-code:${String(code || "").trim()}`)
    .digest("hex");
}

function securityKey(...parts) {
  return crypto
    .createHmac("sha256", challengeSecret)
    .update(parts.map((part) => String(part || "").trim().toLowerCase()).join(":"))
    .digest("hex");
}

function normalizeUserId(userId = "") {
  return String(userId || "").trim();
}

function challengeReceiptKey(challengeToken = "") {
  return securityKey("auth-challenge-receipt", challengeToken);
}

function rememberChallengeReceipt(store, challengeToken = "", challenge = {}, reason = "used") {
  if (!challengeToken) return;

  store.authChallengeReceipts ||= {};
  const now = new Date().toISOString();
  store.authChallengeReceipts[challengeReceiptKey(challengeToken)] = {
    email: normalizeEmail(challenge.email),
    purpose: sanitizePlainText(challenge.purpose, 64),
    reason,
    recordedAt: now,
    userId: normalizeUserId(challenge.userId || challenge.metadata?.uid),
  };
}

function challengeReceiptError(receipt) {
  if (!receipt) return null;

  const reason = String(receipt.reason || "").toLowerCase();
  const error =
    reason === "used"
      ? new Error("This code has already been used. Please request a new code if needed.")
      : reason === "replaced"
        ? new Error("A newer code was requested. Please use the latest code sent to your email.")
        : new Error("This code has expired. Please request a new code.");
  error.status = reason === "used" ? 409 : 410;
  error.code =
    reason === "used"
      ? "AUTH_CODE_ALREADY_USED"
      : reason === "replaced"
        ? "AUTH_CODE_REPLACED"
        : "AUTH_CODE_EXPIRED";
  return error;
}

function requestCooldownError(remainingSeconds) {
  const seconds = Math.max(1, Math.ceil(remainingSeconds));
  const error = new Error(`Please wait ${seconds} seconds before requesting another code.`);
  error.status = 429;
  error.code = "AUTH_CODE_COOLDOWN";
  error.resendAfterSeconds = seconds;
  throw error;
}

function requestLimitError() {
  const error = new Error("Too many code requests. Please try again later.");
  error.status = 429;
  error.code = "AUTH_CODE_RATE_LIMIT";
  error.resendAfterSeconds = resendDelaySeconds;
  throw error;
}

function cleanupChallenges(store) {
  const now = Date.now();
  store.authChallenges ||= {};
  store.authChallengeReceipts ||= {};
  store.authChallengeRequests ||= {};
  store.registrationTokens ||= {};
  store.loginSecurity ||= {};
  Object.entries(store.authChallenges).forEach(([key, value]) => {
    if (!value?.expiresAt || new Date(value.expiresAt).getTime() <= now) {
      rememberChallengeReceipt(store, key, value, "expired");
      delete store.authChallenges[key];
    }
  });
  Object.entries(store.authChallengeReceipts).forEach(([key, value]) => {
    const recordedAt = new Date(value?.recordedAt || 0).getTime();
    if (!Number.isFinite(recordedAt) || recordedAt + authChallengeReceiptRetentionMs <= now) {
      delete store.authChallengeReceipts[key];
    }
  });
  const requestCutoff = now - otpRequestWindowMs;
  Object.entries(store.authChallengeRequests).forEach(([key, values]) => {
    const recent = Array.isArray(values)
      ? values.filter((timestamp) => Number(timestamp) >= requestCutoff)
      : [];
    if (recent.length) {
      store.authChallengeRequests[key] = recent;
    } else {
      delete store.authChallengeRequests[key];
    }
  });
  Object.entries(store.registrationTokens).forEach(([key, value]) => {
    if (!value?.expiresAt || new Date(value.expiresAt).getTime() <= now) {
      delete store.registrationTokens[key];
    }
  });
  Object.entries(store.loginSecurity).forEach(([key, value]) => {
    if (!value?.lockedUntil && !Number(value?.failedAttempts || 0)) {
      delete store.loginSecurity[key];
      return;
    }
    if (value?.lockedUntil && Number(value.lockedUntil) <= now && !Number(value.failedAttempts || 0)) {
      delete store.loginSecurity[key];
    }
  });
}

function challengeRequestKey({ email, purpose, userId = "" }) {
  return securityKey("auth-code-request", purpose, normalizeEmail(email), normalizeUserId(userId));
}

function enforceOtpRateLimit(store, { email, purpose, userId = "" }) {
  store.authChallengeRequests ||= {};
  const key = challengeRequestKey({ email, purpose, userId });
  const now = Date.now();
  const cutoff = now - otpRequestWindowMs;
  const recent = Array.isArray(store.authChallengeRequests[key])
    ? store.authChallengeRequests[key].filter((timestamp) => Number(timestamp) >= cutoff)
    : [];
  const lastRequestAt = recent.length ? Number(recent[recent.length - 1]) : 0;
  const cooldownRemainingSeconds = (lastRequestAt + resendDelaySeconds * 1000 - now) / 1000;

  if (cooldownRemainingSeconds > 0) {
    store.authChallengeRequests[key] = recent;
    writeStore(store);
    requestCooldownError(cooldownRemainingSeconds);
  }

  if (recent.length >= otpRequestsPerHour) {
    store.authChallengeRequests[key] = recent;
    writeStore(store);
    requestLimitError();
  }

  store.authChallengeRequests[key] = [...recent, now];
}

function invalidateExistingChallenges(store, { email, purpose, userId = "" }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUserId = normalizeUserId(userId);

  Object.entries(store.authChallenges || {}).forEach(([token, challenge]) => {
    const challengeUserId = normalizeUserId(challenge?.userId || challenge?.metadata?.uid);
    const sameUser =
      normalizedUserId || challengeUserId ? challengeUserId === normalizedUserId : true;
    if (
      challenge?.purpose === purpose &&
      challenge?.email === normalizedEmail &&
      sameUser
    ) {
      rememberChallengeReceipt(store, token, challenge, "replaced");
      delete store.authChallenges[token];
    }
  });
}

function activeCodeFingerprints(store, { email, purpose, userId = "" }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUserId = normalizeUserId(userId);
  return new Set(
    Object.values(store.authChallenges || {})
      .filter((challenge) => {
        const challengeUserId = normalizeUserId(challenge?.userId || challenge?.metadata?.uid);
        const sameUser =
          normalizedUserId || challengeUserId ? challengeUserId === normalizedUserId : true;
        return (
          challenge?.purpose === purpose &&
          challenge?.email === normalizedEmail &&
          sameUser
        );
      })
      .map((challenge) => challenge.codeFingerprint)
      .filter(Boolean),
  );
}

function loginSecurityKey(email, audience = "patient") {
  return securityKey("login", audience, normalizeEmail(email));
}

function assertLoginAllowed(store, email, audience = "patient") {
  store.loginSecurity ||= {};
  const key = loginSecurityKey(email, audience);
  const state = store.loginSecurity[key];
  if (state?.lockedUntil && Number(state.lockedUntil) <= Date.now()) {
    delete store.loginSecurity[key];
    writeStore(store);
    return;
  }
  if (state?.lockedUntil && Number(state.lockedUntil) > Date.now()) {
    const error = new Error("Too many failed login attempts. Please try again in 15 minutes.");
    error.status = 429;
    throw error;
  }
}

function recordLoginFailure(email, audience = "patient") {
  const store = readStore();
  cleanupChallenges(store);
  store.loginSecurity ||= {};
  const key = loginSecurityKey(email, audience);
  const prior = store.loginSecurity[key] || {};
  const current =
    prior.lockedUntil && Number(prior.lockedUntil) <= Date.now()
      ? {}
      : prior;
  const failedAttempts = Number(current.failedAttempts || 0) + 1;
  const lockedUntil =
    failedAttempts >= loginFailureLimit ? Date.now() + loginLockMs : Number(current.lockedUntil || 0);

  store.loginSecurity[key] = {
    failedAttempts,
    lastFailedAt: Date.now(),
    lockedUntil,
  };
  writeStore(store);
  return failedAttempts >= loginFailureLimit;
}

function clearLoginFailures(email, audience = "patient") {
  const store = readStore();
  store.loginSecurity ||= {};
  delete store.loginSecurity[loginSecurityKey(email, audience)];
  writeStore(store);
}

function saveLocalPatientAccount({ email, fullName = "", phone = "", uid }) {
  const userId = String(uid || "").trim();
  const normalizedEmail = normalizeEmail(email);
  if (!userId || !normalizedEmail) return null;

  const now = new Date().toISOString();
  const store = readStore();
  const previousUser = store.users?.[userId] || {};
  const previousProfile = store.patientProfiles?.[userId] || {};
  const cleanFullName =
    sanitizePlainText(fullName, 120) ||
    sanitizePlainText(previousUser.fullName || previousProfile.fullName, 120) ||
    normalizedEmail.split("@")[0] ||
    "Alphastar Patient";
  const contactNumber =
    sanitizePlainText(phone, 40) ||
    sanitizePlainText(
      previousUser.contactNumber ||
        previousUser.contactPhone ||
        previousUser.mobileNumber ||
        previousUser.phone ||
        previousProfile.contactNumber ||
        previousProfile.contactPhone ||
        previousProfile.mobileNumber ||
        previousProfile.phone,
      40,
    );
  const phoneDigits = contactNumber.replace(/\D/g, "");
  const contactFields = contactNumber
    ? {
        contactNumber,
        contactPhone: contactNumber,
        mobileNumber: contactNumber,
        phone: contactNumber,
        phoneDigits,
      }
    : {};

  const user = {
    ...previousUser,
    ...contactFields,
    accountStatus: previousUser.accountStatus || "active",
    authProviderId: previousUser.authProviderId || "password",
    createdAt: previousUser.createdAt || now,
    email: normalizedEmail,
    emailVerified: previousUser.emailVerified ?? true,
    fullName: cleanFullName,
    id: userId,
    lastLoginAt: now,
    normalizedEmail,
    role: "patient",
    updatedAt: now,
  };
  const profile = {
    ...previousProfile,
    ...contactFields,
    createdAt: previousProfile.createdAt || now,
    email: normalizedEmail,
    fullName: cleanFullName,
    id: userId,
    normalizedEmail,
    patientNumber: previousProfile.patientNumber || `PAT-${Date.now().toString().slice(-6)}`,
    updatedAt: now,
    userId,
  };

  store.users ||= {};
  store.patientProfiles ||= {};
  store.users[userId] = user;
  store.patientProfiles[userId] = profile;
  writeStore(store);

  return { profile, user };
}

function createChallenge({ email, metadata = {}, purpose, userId = "" }) {
  const store = readStore();
  cleanupChallenges(store);
  const normalizedEmail = normalizeEmail(email);
  const normalizedUserId = normalizeUserId(userId || metadata.uid);
  enforceOtpRateLimit(store, { email: normalizedEmail, purpose, userId: normalizedUserId });
  const previousFingerprints = activeCodeFingerprints(store, {
    email: normalizedEmail,
    purpose,
    userId: normalizedUserId,
  });
  invalidateExistingChallenges(store, { email: normalizedEmail, purpose, userId: normalizedUserId });
  const challengeToken = id("challenge");
  let code = crypto.randomInt(100000, 1000000).toString();
  while (previousFingerprints.has(codeFingerprint(code))) {
    code = crypto.randomInt(100000, 1000000).toString();
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + challengeDurationMs).toISOString();

  store.authChallenges[challengeToken] = {
    attempts: 0,
    codeFingerprint: codeFingerprint(code),
    codeHash: challengeHash(challengeToken, code),
    createdAt: now.toISOString(),
    email: normalizedEmail,
    expiresAt,
    metadata,
    purpose,
    userId: normalizedUserId,
  };
  writeStore(store);

  return { challengeToken, code, expiresAt };
}

function forgetChallenge(challengeToken = "", reason = "replaced") {
  const store = readStore();
  store.authChallenges ||= {};
  const challenge = store.authChallenges[challengeToken];
  if (challenge) {
    rememberChallengeReceipt(store, challengeToken, challenge, reason);
    delete store.authChallenges[challengeToken];
    writeStore(store);
  }
}

function createRegistrationToken({ email, metadata = {}, purpose }) {
  const store = readStore();
  cleanupChallenges(store);
  const token = `${id("registration")}_${crypto.randomBytes(24).toString("base64url")}`;
  const tokenHash = securityKey("registration-token", token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + challengeDurationMs).toISOString();

  store.registrationTokens ||= {};
  store.registrationTokens[tokenHash] = {
    createdAt: now.toISOString(),
    email: normalizeEmail(email),
    expiresAt,
    metadata,
    purpose,
  };
  writeStore(store);

  return { expiresAt, token };
}

function consumeRegistrationToken({ email = "", purpose, token = "" }) {
  const store = readStore();
  cleanupChallenges(store);
  const tokenHash = securityKey("registration-token", token);
  const registrationToken = store.registrationTokens?.[tokenHash];

  if (!registrationToken) {
    writeStore(store);
    const error = new Error("Please verify your email security code before creating the account.");
    error.status = 401;
    throw error;
  }

  if (registrationToken.purpose !== purpose || registrationToken.email !== normalizeEmail(email)) {
    const error = new Error("This verified registration session is not valid for this email.");
    error.status = 401;
    throw error;
  }

  if (new Date(registrationToken.expiresAt).getTime() <= Date.now()) {
    delete store.registrationTokens[tokenHash];
    writeStore(store);
    const error = new Error("Your verified registration session expired. Please request a new code.");
    error.status = 410;
    throw error;
  }

  delete store.registrationTokens[tokenHash];
  writeStore(store);
  return registrationToken;
}

function verifyChallenge({
  challengeToken,
  code,
  email = "",
  purpose,
  requireUserId = false,
  resetLinkHash: expectedResetLinkHash = "",
  userId = "",
}) {
  const store = readStore();
  store.authChallenges ||= {};
  store.authChallengeReceipts ||= {};
  const challenge = store.authChallenges?.[challengeToken];

  if (!challenge) {
    writeStore(store);
    const receipt = store.authChallengeReceipts[challengeReceiptKey(challengeToken)];
    const receiptError = challengeReceiptError(receipt);
    if (receiptError) throw receiptError;

    const error = new Error("This code is invalid, expired, or has been replaced. Please request a new code.");
    error.status = 410;
    error.code = "AUTH_CODE_INVALID_OR_EXPIRED";
    throw error;
  }

  if (challenge.purpose !== purpose) {
    const error = new Error("This code is not valid for this verification request.");
    error.status = 400;
    error.code = "AUTH_CODE_PURPOSE_MISMATCH";
    throw error;
  }

  if (email && challenge.email !== normalizeEmail(email)) {
    const error = new Error("This code does not match the requested email address.");
    error.status = 400;
    error.code = "AUTH_CODE_EMAIL_MISMATCH";
    throw error;
  }

  const expectedUserId = normalizeUserId(challenge.userId || challenge.metadata?.uid);
  const requestedUserId = normalizeUserId(userId);
  if (requireUserId && (!expectedUserId || !requestedUserId)) {
    const error = new Error("This verification request is missing the required user ID.");
    error.status = 400;
    error.code = "AUTH_CODE_USER_REQUIRED";
    throw error;
  }

  if (requestedUserId && expectedUserId && requestedUserId !== expectedUserId) {
    const error = new Error("This code does not match the requested user account.");
    error.status = 400;
    error.code = "AUTH_CODE_USER_MISMATCH";
    throw error;
  }

  if (
    expectedResetLinkHash &&
    challenge.metadata?.resetLinkHash !== expectedResetLinkHash
  ) {
    const error = new Error("This code does not match the password reset request.");
    error.status = 400;
    error.code = "AUTH_CODE_RESET_LINK_MISMATCH";
    throw error;
  }

  if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
    rememberChallengeReceipt(store, challengeToken, challenge, "expired");
    delete store.authChallenges[challengeToken];
    writeStore(store);
    const error = new Error("This code has expired. Please request a new code.");
    error.status = 410;
    error.code = "AUTH_CODE_EXPIRED";
    throw error;
  }

  challenge.attempts = Number(challenge.attempts || 0) + 1;
  if (challenge.attempts > challengeMaxAttempts) {
    rememberChallengeReceipt(store, challengeToken, challenge, "expired");
    delete store.authChallenges[challengeToken];
    writeStore(store);
    const error = new Error("Too many incorrect codes. Please request a new code.");
    error.status = 429;
    error.code = "AUTH_CODE_TOO_MANY_ATTEMPTS";
    throw error;
  }

  if (challenge.codeHash !== challengeHash(challengeToken, code)) {
    store.authChallenges[challengeToken] = challenge;
    writeStore(store);
    const error = new Error("Incorrect code. Please check the latest email and try again.");
    error.status = 401;
    error.code = "AUTH_CODE_INCORRECT";
    throw error;
  }

  rememberChallengeReceipt(store, challengeToken, challenge, "used");
  delete store.authChallenges[challengeToken];
  writeStore(store);
  return challenge;
}

function readActiveChallenge({
  challengeToken,
  email = "",
  purpose,
  requireUserId = false,
  resetLinkHash: expectedResetLinkHash = "",
  userId = "",
}) {
  const store = readStore();
  cleanupChallenges(store);
  const challenge = store.authChallenges?.[challengeToken];

  if (!challenge) {
    writeStore(store);
    const receipt = store.authChallengeReceipts?.[challengeReceiptKey(challengeToken)];
    const receiptError = challengeReceiptError(receipt);
    if (receiptError) throw receiptError;

    const error = new Error("This verification request is invalid or expired. Please request a new code.");
    error.status = 410;
    error.code = "AUTH_CODE_INVALID_OR_EXPIRED";
    throw error;
  }

  if (challenge.purpose !== purpose) {
    const error = new Error("This code is not valid for this verification request.");
    error.status = 400;
    error.code = "AUTH_CODE_PURPOSE_MISMATCH";
    throw error;
  }

  if (email && challenge.email !== normalizeEmail(email)) {
    const error = new Error("This code does not match the requested email address.");
    error.status = 400;
    error.code = "AUTH_CODE_EMAIL_MISMATCH";
    throw error;
  }

  const expectedUserId = normalizeUserId(challenge.userId || challenge.metadata?.uid);
  const requestedUserId = normalizeUserId(userId);
  if (requireUserId && (!expectedUserId || !requestedUserId)) {
    const error = new Error("This verification request is missing the required user ID.");
    error.status = 400;
    error.code = "AUTH_CODE_USER_REQUIRED";
    throw error;
  }

  if (requestedUserId && expectedUserId && requestedUserId !== expectedUserId) {
    const error = new Error("This code does not match the requested user account.");
    error.status = 400;
    error.code = "AUTH_CODE_USER_MISMATCH";
    throw error;
  }

  if (
    expectedResetLinkHash &&
    challenge.metadata?.resetLinkHash !== expectedResetLinkHash
  ) {
    const error = new Error("This code does not match the password reset request.");
    error.status = 400;
    error.code = "AUTH_CODE_RESET_LINK_MISMATCH";
    throw error;
  }

  writeStore(store);
  return challenge;
}

function isStrongPassword(password = "") {
  return (
    String(password).length >= 8 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function passwordRulesMessage() {
  return "Use at least 8 characters with uppercase, lowercase, number, and special character.";
}

function resetLinkHash(oobCode = "") {
  const cleanCode = String(oobCode || "").trim();
  if (!cleanCode) return "";

  return crypto
    .createHash("sha256")
    .update(cleanCode)
    .digest("hex");
}

function cleanupPasswordResetLinks(store) {
  const now = Date.now();
  const retentionMs = 24 * 60 * 60 * 1000;
  Object.entries(store.passwordResetLinks || {}).forEach(([key, record]) => {
    const expiresAt = new Date(record?.expiresAt || 0).getTime();
    const usedAt = new Date(record?.usedAt || 0).getTime();
    const purgeAt = Math.max(expiresAt, usedAt) + retentionMs;
    if (!Number.isFinite(purgeAt) || purgeAt <= now) {
      delete store.passwordResetLinks[key];
    }
  });
}

function rememberPasswordResetLink({
  audience = "patient",
  email,
  oobCode,
  securityChallengeToken = "",
  userId = "",
}) {
  const codeHash = resetLinkHash(oobCode);
  if (!codeHash || !email) return null;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + passwordResetDurationMs);
  const store = readStore();
  store.passwordResetLinks ||= {};
  cleanupPasswordResetLinks(store);
  store.passwordResetLinks[codeHash] = {
    audience: sanitizePlainText(audience, 24),
    createdAt: now.toISOString(),
    email: normalizeEmail(email),
    expiresAt: expiresAt.toISOString(),
    securityChallengeToken,
    updatedAt: now.toISOString(),
    userId: normalizeUserId(userId),
  };
  writeStore(store);
  return store.passwordResetLinks[codeHash];
}

function trackedPasswordResetLink(oobCode = "") {
  const codeHash = resetLinkHash(oobCode);
  if (!codeHash) return null;

  const store = readStore();
  cleanupPasswordResetLinks(store);
  const record = store.passwordResetLinks?.[codeHash] || null;
  writeStore(store);
  return record;
}

function passwordResetAlreadyChangedError() {
  const error = new Error("You already changed your password with this reset link.");
  error.status = 409;
  error.code = "PASSWORD_RESET_ALREADY_USED";
  return error;
}

function passwordResetLinkExpiredError() {
  const error = new Error(
    `Your password reset link has expired. Password reset links are valid for ${passwordResetDurationLabel}.`,
  );
  error.status = 410;
  error.code = "PASSWORD_RESET_EXPIRED";
  return error;
}

function passwordResetLinkUnknownError() {
  const error = new Error("This password reset link is invalid or expired. Please request a new reset link.");
  error.status = 400;
  error.code = "PASSWORD_RESET_INVALID";
  return error;
}

function requireUsablePasswordResetLink(oobCode = "") {
  const record = trackedPasswordResetLink(oobCode);
  if (!record) throw passwordResetLinkUnknownError();
  if (record.usedAt) throw passwordResetAlreadyChangedError();
  if (new Date(record.expiresAt || 0).getTime() <= Date.now()) {
    throw passwordResetLinkExpiredError();
  }
  return record;
}

function markPasswordResetLinkUsed(oobCode = "", email = "") {
  const codeHash = resetLinkHash(oobCode);
  if (!codeHash) return false;

  const store = readStore();
  store.passwordResetLinks ||= {};
  cleanupPasswordResetLinks(store);
  const record = store.passwordResetLinks[codeHash];
  if (!record) return false;

  const now = new Date().toISOString();
  store.passwordResetLinks[codeHash] = {
    ...record,
    email: normalizeEmail(email || record.email),
    usedAt: record.usedAt || now,
    updatedAt: now,
  };
  writeStore(store);
  return true;
}

function cleanPublicOrigin(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    url.pathname = url.pathname.replace(/\/api\/?$/i, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function backendPublicOrigin(req) {
  const configuredOrigin =
    process.env.ALPHASTAR_RESET_BASE_URL ||
    process.env.ALPHASTAR_PUBLIC_BASE_URL ||
    process.env.EXPO_PUBLIC_ALPHASTAR_API_BASE_URL ||
    "";
  const configured = cleanPublicOrigin(configuredOrigin);
  if (configured) return configured;

  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || req?.protocol || "http";
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").trim();
  return `${proto}://${host || `127.0.0.1:${port}`}`.replace(/\/+$/, "");
}

function queryParamFromUrl(urlString = "", name = "", depth = 0) {
  if (!urlString || !name || depth > 2) return "";

  try {
    const url = new URL(urlString);
    const direct = url.searchParams.get(name);
    if (direct) return direct;

    for (const nestedParam of ["link", "continueUrl"]) {
      const nested = url.searchParams.get(nestedParam);
      if (!nested) continue;
      const nestedValue = queryParamFromUrl(nested, name, depth + 1);
      if (nestedValue) return nestedValue;
    }
  } catch {
    return "";
  }

  return "";
}

function customPasswordResetLink(firebaseLink, email, audience, req, options = {}) {
  const oobCode = queryParamFromUrl(firebaseLink, "oobCode");
  if (!oobCode) return firebaseLink;

  const resetUrl = new URL("/reset-password", `${backendPublicOrigin(req)}/`);
  resetUrl.searchParams.set("oobCode", oobCode);
  resetUrl.searchParams.set("email", normalizeEmail(email));
  resetUrl.searchParams.set("audience", sanitizePlainText(audience || "patient", 24));
  if (options.securityChallengeToken) {
    resetUrl.searchParams.set("challengeToken", String(options.securityChallengeToken));
  }
  return resetUrl.toString();
}

let cachedLogoDataUri;

function logoImageDataUri() {
  if (cachedLogoDataUri !== undefined) return cachedLogoDataUri;

  try {
    const logoPath = alphaStarEmailLogoPath();
    if (!logoPath) {
      cachedLogoDataUri = "";
      return cachedLogoDataUri;
    }
    cachedLogoDataUri = `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`;
  } catch (error) {
    console.warn("Unable to load Alpha Star logo for reset page.", error.message);
    cachedLogoDataUri = "";
  }

  return cachedLogoDataUri;
}

function resetPasswordPageHtml() {
  const logoSrc = logoImageDataUri();
  const logoMarkup = logoSrc
    ? `<img class="logo" src="${logoSrc}" alt="Alphastar Laboratory">`
    : `<p class="brand-fallback">Alphastar Laboratory</p>`;
  const resetDurationLabel = JSON.stringify(passwordResetDurationLabel);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Reset Password | Alphastar Laboratory</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      * {
        box-sizing: border-box;
      }

      html,
      body {
        margin: 0;
        min-height: 100%;
      }

      body {
        align-items: flex-start;
        background: #c3ebe2;
        color: #173f3c;
        display: flex;
        font-family: Poppins, Arial, Helvetica, sans-serif;
        justify-content: center;
        overflow-x: hidden;
        padding: 0;
      }

      .phone-frame {
        background: #c3ebe2;
        max-width: 430px;
        min-height: 100vh;
        min-height: 100svh;
        padding: 0 20px;
        width: 100%;
      }

      .shell {
        background: transparent;
        min-height: 100vh;
        min-height: 100svh;
        padding: 72px 0 32px;
        width: 100%;
      }

      .logo {
        display: block;
        height: auto;
        margin: 0 auto 66px;
        max-width: 74%;
        width: 282px;
      }

      .brand-fallback {
        color: #031311;
        font-size: 34px;
        font-weight: 700;
        line-height: 1.1;
        margin: 0 auto 66px;
        text-align: center;
      }

      h1 {
        color: #031311;
        font-size: 38px;
        font-weight: 600;
        line-height: 1.16;
        margin: 0 0 44px;
        text-align: center;
      }

      .subtitle,
      .email,
      .expiry-text,
      .status,
      .success-text {
        color: #6f8782;
        font-size: 16px;
        line-height: 1.55;
        margin: 0;
        text-align: center;
      }

      .subtitle {
        display: none;
      }

      .email {
        color: #173f3c;
        font-size: 15px;
        font-weight: 600;
        margin: -32px 0 28px;
        overflow-wrap: anywhere;
      }

      .email:empty,
      .status:empty {
        display: none;
      }

      .status {
        margin: -24px 0 28px;
      }

      .expiry-text {
        color: #108979;
        font-size: 15px;
        font-weight: 600;
        margin: -14px 0 26px;
      }

      .form {
        display: grid;
        gap: 0;
        margin-top: 0;
      }

      .input-shell {
        align-items: center;
        background: #e7f8f6;
        border-radius: 28px;
        display: flex;
        height: 74px;
        margin-bottom: 18px;
        overflow: hidden;
        position: relative;
        width: 100%;
      }

      .input-icon {
        align-items: center;
        color: #0f8f82;
        display: flex;
        flex: 0 0 64px;
        justify-content: center;
        padding-left: 6px;
      }

      input {
        background: transparent;
        border: 0;
        color: #6f8782;
        flex: 1 1 auto;
        font: 400 22px/1.2 Poppins, Arial, Helvetica, sans-serif;
        height: 100%;
        min-width: 0;
        outline: none;
        padding: 0 60px 0 0;
        width: 100%;
      }

      input::placeholder {
        color: #7f9c98;
        opacity: 1;
      }

      input:focus {
        box-shadow: none;
      }

      .input-shell:focus-within {
        box-shadow: 0 0 0 3px rgba(24, 182, 168, 0.22);
      }

      .toggle-password {
        align-items: center;
        background: transparent;
        border: 0;
        color: #7f9c98;
        cursor: pointer;
        display: flex;
        height: 44px;
        justify-content: center;
        margin: 0;
        padding: 0;
        position: absolute;
        right: 16px;
        top: 50%;
        transform: translateY(-50%);
        width: 44px;
      }

      .toggle-password svg {
        display: block;
      }

      .toggle-password .eye-off,
      .toggle-password.shown .eye-open {
        display: none;
      }

      .toggle-password.shown .eye-off {
        display: block;
      }

      .rules {
        display: grid;
        gap: 12px;
        margin: 2px 0 38px;
        padding: 0;
      }

      .rule {
        align-items: center;
        color: #6f8782;
        display: flex;
        font-size: 16px;
        font-weight: 400;
        gap: 18px;
        line-height: 1.35;
      }

      .rule-dot {
        background: rgba(127, 156, 152, 0.22);
        border: 0;
        border-radius: 999px;
        flex: 0 0 10px;
        height: 10px;
        width: 10px;
      }

      .rule.met {
        color: #108979;
        font-weight: 600;
      }

      .rule.met .rule-dot {
        background: #20c66b;
        border-color: #18b6a8;
        box-shadow: 0 0 0 4px rgba(32, 198, 107, 0.13);
      }

      .message {
        border-radius: 16px;
        display: none;
        font-size: 14px;
        font-weight: 600;
        line-height: 1.45;
        padding: 13px 15px;
        text-align: center;
      }

      .message.show {
        display: block;
      }

      .message.error {
        background: #fee2e2;
        color: #b91c1c;
      }

      .message.ok {
        background: #d9fbef;
        color: #108979;
      }

      .submit-button {
        background: #18b6a8;
        border: 0;
        border-radius: 30px;
        color: #ffffff;
        cursor: pointer;
        font: 600 24px/1 Poppins, Arial, Helvetica, sans-serif;
        height: 76px;
        margin-top: 0;
        width: 100%;
      }

      .submit-button:disabled {
        background: rgba(24, 182, 168, 0.35);
        color: rgba(255, 255, 255, 0.78);
        cursor: not-allowed;
      }

      .state-panel {
        align-items: flex-start;
        background: #ffffff;
        border: 1px solid rgba(15, 143, 130, 0.12);
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(3, 19, 17, 0.16);
        display: none;
        flex-direction: column;
        margin: 10px auto 0;
        padding: 30px 28px 32px;
        text-align: left;
        width: 100%;
      }

      .state-panel.show {
        display: flex;
      }

      .state-title {
        color: #031311;
        font-size: 28px;
        font-weight: 700;
        line-height: 1.22;
        margin: 0 0 18px;
      }

      .state-message {
        color: #222222;
        font-size: 19px;
        font-weight: 400;
        line-height: 1.55;
        margin: 0;
      }

      .state-panel.warning .state-title {
        color: #8a2d1f;
      }

      body.final-reset-state #pageTitle,
      body.final-reset-state #emailText,
      body.final-reset-state #statusText,
      body.final-reset-state #expiryText,
      body.final-reset-state #resetForm,
      body.final-reset-state #message {
        display: none !important;
      }

      body.final-reset-state .logo {
        margin-bottom: 48px;
      }

      body.final-reset-state .state-panel.show {
        display: flex !important;
      }

      @media (max-width: 430px) {
        .shell {
          padding: 70px 0 34px;
        }

        .logo {
          margin-bottom: 64px;
          width: 270px;
        }

        h1 {
          font-size: 36px;
          margin-bottom: 42px;
        }

        .input-shell {
          border-radius: 27px;
          height: 72px;
          margin-bottom: 17px;
        }

        input {
          font-size: 22px;
        }

        .rules {
          margin-bottom: 36px;
        }

        .rule {
          font-size: 16px;
        }

        .submit-button {
          border-radius: 29px;
          font-size: 20px;
          height: 72px;
        }
      }

      body.desktop-site-mobile {
        display: block;
        min-width: 100vw;
      }

      body.desktop-site-mobile .phone-frame {
        margin: 0 auto;
        max-width: 430px;
        transform: scale(var(--mobile-scale, 1));
        transform-origin: top center;
        width: 430px;
      }

      @supports (zoom: 1) {
        body.desktop-site-mobile .phone-frame {
          transform: none;
          zoom: var(--mobile-scale, 1);
        }
      }
    </style>
  </head>
  <body>
    <div class="phone-frame">
      <main class="shell">
        ${logoMarkup}
        <h1 id="pageTitle">Reset Password</h1>
        <p class="subtitle">Create a new password that meets all requirements.</p>
        <p id="emailText" class="email"></p>
        <p id="statusText" class="status">Checking reset link...</p>
        <p id="expiryText" class="expiry-text"></p>

        <form id="resetForm" class="form" hidden>
        <label class="input-shell">
          <span class="input-icon" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <rect x="5" y="10" width="14" height="10" rx="2"></rect>
              <path d="M8 10V7a4 4 0 0 1 8 0v3"></path>
            </svg>
          </span>
          <input id="password" autocomplete="new-password" minlength="8" type="password" required>
          <button class="toggle-password" type="button" data-target="password" aria-label="Show password">
            <svg class="eye-open" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <svg class="eye-off" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3l18 18"></path>
              <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path>
              <path d="M9.9 4.4A10.7 10.7 0 0 1 12 4c6.5 0 10 8 10 8a18.2 18.2 0 0 1-3.1 4.4"></path>
              <path d="M6.1 6.1C3.5 7.8 2 12 2 12s3.5 8 10 8c1.4 0 2.7-.3 3.9-.9"></path>
            </svg>
          </button>
        </label>
        <label class="input-shell">
          <span class="input-icon" aria-hidden="true">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <rect x="5" y="10" width="14" height="10" rx="2"></rect>
              <path d="M8 10V7a4 4 0 0 1 8 0v3"></path>
            </svg>
          </span>
          <input id="confirmPassword" autocomplete="new-password" minlength="8" type="password" required>
          <button class="toggle-password" type="button" data-target="confirmPassword" aria-label="Show password">
            <svg class="eye-open" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
            <svg class="eye-off" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3l18 18"></path>
              <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path>
              <path d="M9.9 4.4A10.7 10.7 0 0 1 12 4c6.5 0 10 8 10 8a18.2 18.2 0 0 1-3.1 4.4"></path>
              <path d="M6.1 6.1C3.5 7.8 2 12 2 12s3.5 8 10 8c1.4 0 2.7-.3 3.9-.9"></path>
            </svg>
          </button>
        </label>

        <div class="rules" aria-live="polite">
          <div class="rule" data-rule="length"><span class="rule-dot"></span><span>8 characters minimum</span></div>
          <div class="rule" data-rule="number"><span class="rule-dot"></span><span>At least one number</span></div>
          <div class="rule" data-rule="case"><span class="rule-dot"></span><span>Upper &amp; lowercase letters</span></div>
          <div class="rule" data-rule="special"><span class="rule-dot"></span><span>At least one special character</span></div>
        </div>

        <div id="message" class="message"></div>
        <button id="submitButton" class="submit-button" type="submit" disabled>Reset Password</button>
      </form>

      <section id="statePanel" class="state-panel" hidden>
        <h2 id="stateTitle" class="state-title"></h2>
        <p id="stateMessage" class="state-message"></p>
      </section>
      </main>
    </div>

    <script>
      function applyForcedMobileView() {
        const frameWidth = 430;
        const layoutWidth = Math.max(
          window.innerWidth || 0,
          document.documentElement.clientWidth || 0,
        );
        const screenShortSide = Math.min(screen.width || layoutWidth, screen.height || layoutWidth);
        const touchDevice =
          navigator.maxTouchPoints > 0 ||
          (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
        const phoneInDesktopMode =
          touchDevice &&
          layoutWidth > frameWidth + 80 &&
          layoutWidth <= 1100 &&
          screenShortSide <= 1100;

        if (!phoneInDesktopMode) {
          document.documentElement.style.setProperty("--mobile-scale", "1");
          document.body.classList.remove("desktop-site-mobile");
          document.body.style.minHeight = "";
          return;
        }

        const scale = Math.min(3, Math.max(1, layoutWidth / frameWidth));
        const frame = document.querySelector(".phone-frame");
        document.documentElement.style.setProperty("--mobile-scale", String(scale));
        document.body.classList.add("desktop-site-mobile");
        if (frame) {
          document.body.style.minHeight = String(Math.ceil(frame.scrollHeight * scale)) + "px";
        }
      }

      window.addEventListener("resize", applyForcedMobileView);
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", applyForcedMobileView);
      }

      const params = new URLSearchParams(window.location.search);
      const oobCode = params.get("oobCode") || "";
      const emailHint = params.get("email") || "";
      const pageTitle = document.getElementById("pageTitle");
      const emailText = document.getElementById("emailText");
      const statusText = document.getElementById("statusText");
      const expiryText = document.getElementById("expiryText");
      const form = document.getElementById("resetForm");
      const passwordInput = document.getElementById("password");
      const confirmInput = document.getElementById("confirmPassword");
      const submitButton = document.getElementById("submitButton");
      const message = document.getElementById("message");
      const statePanel = document.getElementById("statePanel");
      const stateTitle = document.getElementById("stateTitle");
      const stateMessage = document.getElementById("stateMessage");
      const resetDurationLabel = ${resetDurationLabel};
      let expiresAtMs = 0;
      let expiryTimer = null;

      const rules = {
        length: (value) => value.length >= 8,
        number: (value) => /\\d/.test(value),
        case: (value) => /[a-z]/.test(value) && /[A-Z]/.test(value),
        special: (value) => /[^A-Za-z0-9]/.test(value),
      };

      function setMessage(text, type) {
        message.textContent = text || "";
        message.className = text ? "message show " + type : "message";
        requestAnimationFrame(applyForcedMobileView);
      }

      function clearFinalState() {
        document.body.classList.remove("final-reset-state");
        statePanel.hidden = true;
        statePanel.className = "state-panel";
        stateTitle.textContent = "";
        stateMessage.textContent = "";
      }

      function showFinalState(title, text, tone) {
        stopExpiryTimer();
        document.body.classList.add("final-reset-state");
        pageTitle.textContent = title;
        emailText.textContent = "";
        statusText.textContent = "";
        expiryText.textContent = "";
        form.hidden = true;
        submitButton.disabled = true;
        setMessage("", "");
        stateTitle.textContent = title;
        stateMessage.textContent = text;
        statePanel.hidden = false;
        statePanel.className = "state-panel show " + (tone || "success");
        requestAnimationFrame(applyForcedMobileView);
      }

      function showExpiredState() {
        showFinalState(
          "Reset Link Expired",
          "Your password reset link has expired. Please request a new reset link.",
          "warning",
        );
      }

      function showAlreadyChangedState() {
        showFinalState(
          "Password Already Changed",
          "You already changed your password with this reset link.",
          "success",
        );
      }

      function showLinkErrorState(error) {
        if (error?.code === "PASSWORD_RESET_ALREADY_USED") {
          showAlreadyChangedState();
          return true;
        }
        if (error?.code === "PASSWORD_RESET_EXPIRED") {
          showExpiredState();
          return true;
        }
        if (error?.code === "PASSWORD_RESET_INVALID") {
          showUnavailableState(error.message);
          return true;
        }
        return false;
      }

      function showUnavailableState(text) {
        showFinalState(
          "Reset Link Unavailable",
          text || "This password reset link is invalid or expired. Please request a new reset link.",
          "warning",
        );
      }

      function formatCountdown(totalSeconds) {
        const safeSeconds = Math.max(0, Number(totalSeconds) || 0);
        const minutes = Math.floor(safeSeconds / 60);
        const seconds = safeSeconds % 60;
        return String(minutes) + ":" + String(seconds).padStart(2, "0");
      }

      function stopExpiryTimer() {
        if (!expiryTimer) return;
        clearInterval(expiryTimer);
        expiryTimer = null;
      }

      function updateExpiryCountdown() {
        if (!expiresAtMs) {
          expiryText.textContent = "";
          return;
        }

        const remainingSeconds = Math.ceil((expiresAtMs - Date.now()) / 1000);
        if (remainingSeconds <= 0) {
          showExpiredState();
          return;
        }

        expiryText.textContent = "Reset link expires in " + formatCountdown(remainingSeconds);
      }

      function startExpiryCountdown(expiresAt, expiresInSeconds) {
        const serverRemainingSeconds = Number(expiresInSeconds);
        if (Number.isFinite(serverRemainingSeconds) && serverRemainingSeconds > 0) {
          expiresAtMs = Date.now() + serverRemainingSeconds * 1000;
        } else {
          expiresAtMs = new Date(expiresAt || "").getTime();
        }
        if (!Number.isFinite(expiresAtMs)) return;
        stopExpiryTimer();
        updateExpiryCountdown();
        expiryTimer = setInterval(updateExpiryCountdown, 1000);
      }

      function setRule(name, met) {
        const item = document.querySelector('[data-rule="' + name + '"]');
        if (item) item.classList.toggle("met", Boolean(met));
      }

      function updateRules() {
        const value = passwordInput.value;
        const results = {
          length: rules.length(value),
          number: rules.number(value),
          case: rules.case(value),
          special: rules.special(value),
        };
        const passwordsMatch = value.length > 0 && value === confirmInput.value;

        Object.entries(results).forEach(([name, met]) => setRule(name, met));
        submitButton.disabled = !Object.values(results).every(Boolean) || !passwordsMatch;

        if (confirmInput.value && !passwordsMatch) {
          setMessage("Password and confirm password must match.", "error");
        } else if (message.textContent === "Password and confirm password must match.") {
          setMessage("", "");
        }
      }

      document.querySelectorAll(".toggle-password").forEach((button) => {
        const target = document.getElementById(button.dataset.target);
        if (!target) return;

        button.addEventListener("click", () => {
          const shouldShow = target.type === "password";
          target.type = shouldShow ? "text" : "password";
          button.classList.toggle("shown", shouldShow);
          button.setAttribute("aria-label", shouldShow ? "Hide password" : "Show password");
        });
      });

      async function api(path, body) {
        const response = await fetch(path, {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok === false) {
          const error = new Error(result.error || "Request failed. Please try again.");
          error.code = result.code || "";
          throw error;
        }
        return result;
      }

      async function verifyLink() {
        if (!oobCode) {
          showUnavailableState("This reset link is missing its security code.");
          return;
        }

        try {
          const result = await api("/api/password-reset/verify", { oobCode });
          clearFinalState();
          pageTitle.textContent = "Reset Password";
          emailText.textContent = result.email || emailHint;
          statusText.textContent = "";
          startExpiryCountdown(result.expiresAt, result.expiresInSeconds);
          form.hidden = false;
          passwordInput.placeholder = "Password";
          confirmInput.placeholder = "Confirm Password";
          updateRules();
          requestAnimationFrame(applyForcedMobileView);
        } catch (error) {
          if (!showLinkErrorState(error)) {
            showUnavailableState(error.message);
          }
        }
      }

      passwordInput.addEventListener("input", updateRules);
      confirmInput.addEventListener("input", updateRules);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setMessage("", "");
        submitButton.disabled = true;
        submitButton.textContent = "Please wait...";

        try {
          await api("/api/password-reset/confirm", {
            oobCode,
            password: passwordInput.value,
          });
          showFinalState(
            "Password Changed Successfully",
            "Your Alphastar password has been changed successfully.",
            "success",
          );
        } catch (error) {
          if (!showLinkErrorState(error)) {
            setMessage(error.message, "error");
            updateRules();
          }
        } finally {
          submitButton.textContent = "Reset Password";
        }
      });

      applyForcedMobileView();
      verifyLink();
    </script>
  </body>
</html>`;
}

function passwordResetCodeError(error) {
  const message = String(error?.message || "").toUpperCase();
  if (message.includes("EXPIRED_OOB_CODE")) {
    const next = new Error("Your password reset link has expired. Please request a new reset link.");
    next.status = 410;
    next.code = "PASSWORD_RESET_EXPIRED";
    return next;
  }
  if (message.includes("INVALID_OOB_CODE") || message.includes("MISSING_OOB_CODE")) {
    const next = new Error("This reset link is invalid or already used. Please request a new reset link.");
    next.status = 400;
    next.code = "PASSWORD_RESET_INVALID";
    return next;
  }
  if (message.includes("WEAK_PASSWORD")) {
    const next = new Error(passwordRulesMessage());
    next.status = 400;
    return next;
  }
  return null;
}

async function firebaseRequest(pathName, body) {
  if (!firebaseApiKey) {
    const error = new Error("Firebase API key is not configured on the backend.");
    error.status = 503;
    throw error;
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/${pathName}?key=${encodeURIComponent(
      firebaseApiKey,
    )}`,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(result?.error?.message || `Firebase request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return result;
}

async function firebaseEmailRegistered(email) {
  if (!firebaseApiKey) return null;

  try {
    const result = await firebaseRequest("accounts:createAuthUri", {
      continueUri: "https://alphastar.local",
      identifier: normalizeEmail(email),
    });
    return Boolean(result.registered);
  } catch {
    return null;
  }
}

function isFirebaseInvalidCredentials(error) {
  const message = String(error?.message || "").toUpperCase();
  return (
    message.includes("EMAIL_NOT_FOUND") ||
    message.includes("INVALID_PASSWORD") ||
    message.includes("INVALID_LOGIN_CREDENTIALS") ||
    message.includes("USER_DISABLED") ||
    message.includes("MISSING_PASSWORD") ||
    message.includes("INVALID_EMAIL")
  );
}

function isFirebaseEmailNotFound(error) {
  const message = String(error?.message || "").toUpperCase();
  return message.includes("EMAIL_NOT_FOUND") || message.includes("USER_NOT_FOUND");
}

function passwordResetEmailNotRegisteredError(audience = "patient") {
  const error = new Error(
    audience === "staff"
      ? "This email is not registered in the Alphastar desktop system."
      : "This email is not registered in the Alphastar mobile app.",
  );
  error.status = 404;
  return error;
}

function customPasswordResetEmailUnavailableError() {
  const error = new Error(
    "The Alpha Star reset email design is not ready yet. Add Firebase Admin credentials to alphastar-desktop/backend/.env, then restart the desktop backend.",
  );
  error.status = 503;
  return error;
}

async function firebaseSignInWithPassword(email, password) {
  return firebaseRequest("accounts:signInWithPassword", {
    email: normalizeEmail(email),
    password: String(password || ""),
    returnSecureToken: true,
  });
}

function duplicateEmailError() {
  const error = new Error("Email is already registered. Please use a different email or login instead.");
  error.status = 409;
  return error;
}

function unfinishedSignupError() {
  const error = new Error(
    "This email has an unfinished signup. Use the same password you first entered, then continue creating your account.",
  );
  error.status = 409;
  return error;
}

function isFirebaseEmailExists(error) {
  return String(error?.message || "").toUpperCase().includes("EMAIL_EXISTS");
}

function recordHasEmail(record, email) {
  const normalized = normalizeEmail(email);
  if (!record || typeof record !== "object" || !normalized) return false;

  return [
    record.email,
    record.normalizedEmail,
    record.userEmail,
    record.contactEmail,
    record.patientEmail,
  ].some((value) => normalizeEmail(value) === normalized);
}

function collectionHasEmail(collection, email, ownUid = "") {
  return Boolean(collectionEmailOwner(collection, email, ownUid));
}

function collectionEmailOwner(collection, email, ownUid = "") {
  const normalized = normalizeEmail(email);
  if (!collection || typeof collection !== "object" || !normalized) return "";

  for (const [uid, record] of Object.entries(collection)) {
    const ownerUid = String(record?.uid || record?.userId || uid);
    if (ownUid && String(uid) === String(ownUid)) continue;
    if (ownUid && ownerUid === String(ownUid)) continue;
    if (recordHasEmail(record, normalized)) return ownerUid || String(uid);
  }

  return "";
}

function accountRole(record = {}) {
  return String(record?.role || record?.accountRole || record?.userRole || record?.accountType || "")
    .trim()
    .toLowerCase();
}

function isStaffRole(role = "") {
  return staffRoles.has(String(role || "").trim().toLowerCase());
}

function collectionEmailMatch(collection, email, ownUid = "", collectionName = "") {
  const normalized = normalizeEmail(email);
  if (!collection || typeof collection !== "object" || !normalized) return null;

  for (const [uid, record] of Object.entries(collection)) {
    const ownerUid = String(record?.uid || record?.userId || uid);
    if (ownUid && String(uid) === String(ownUid)) continue;
    if (ownUid && ownerUid === String(ownUid)) continue;
    if (recordHasEmail(record, normalized)) {
      return {
        collection: collectionName,
        record,
        role: accountRole(record),
        uid: ownerUid || String(uid),
      };
    }
  }

  return null;
}

function emailRegistryMatch(emailRegistry, email) {
  const normalized = normalizeEmail(email);
  const registryKey = emailRegistryKey(normalized);
  const record = emailRegistry?.[registryKey];
  if (!record) return null;

  return {
    collection: "emailRegistry",
    record,
    role: "patient",
    uid: String(record.uid || ""),
  };
}

function databaseAccountFromCollections(
  collections,
  email,
  audience = "patient",
  source = "local",
  options = {},
) {
  const normalized = normalizeEmail(email);
  if (!normalized || !collections || typeof collections !== "object") return null;
  const includePatientRegistry = options.includePatientRegistry !== false;

  const usersMatch = collectionEmailMatch(collections.users, normalized, "", "users");
  const staffMatch = collectionEmailMatch(collections.staff, normalized, "", "staff");
  const patientProfileMatch = collectionEmailMatch(
    collections.patientProfiles,
    normalized,
    "",
    "patientProfiles",
  );
  const profileMatch = collectionEmailMatch(collections.profiles, normalized, "", "profiles");

  if (audience === "staff") {
    const account = [staffMatch, usersMatch].find((candidate) => {
      if (!candidate) return false;
      const role = candidate.role || (candidate.collection === "staff" ? "staff" : "");
      return isStaffRole(role);
    });
    if (!account) return null;

    return {
      ...account,
      role: account.role || "staff",
      source,
    };
  }

  const profileAccount = [patientProfileMatch, profileMatch, usersMatch].find((candidate) => {
    if (!candidate) return false;
    return !isStaffRole(candidate.role);
  });
  const registryMatch = includePatientRegistry
    ? emailRegistryMatch(collections.emailRegistry, normalized)
    : null;
  const account = profileAccount || registryMatch;
  if (!account) return null;

  return {
    ...account,
    role: "patient",
    source,
  };
}

function localDatabaseAccount(email, audience = "patient", options = {}) {
  return databaseAccountFromCollections(readStore(), email, audience, "local", options);
}

function realtimeUrl(pathName, idToken = "") {
  if (!firebaseDatabaseUrl) return "";
  const baseUrl = firebaseDatabaseUrl.replace(/\/+$/, "");
  const cleanPath = String(pathName || "").replace(/^\/+/, "");
  const authQuery = idToken ? `?auth=${encodeURIComponent(idToken)}` : "";
  return `${baseUrl}/${cleanPath}.json${authQuery}`;
}

async function realtimeGet(pathName, idToken = "") {
  const url = realtimeUrl(pathName, idToken);
  if (!url) return null;

  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Firebase Realtime Database request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }

  return response.json().catch(() => null);
}

async function realtimePut(pathName, idToken = "", value = {}) {
  const url = realtimeUrl(pathName, idToken);
  if (!url) return null;

  const response = await fetch(url, {
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) {
    const error = new Error(`Firebase Realtime Database write failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }

  return response.json().catch(() => null);
}

async function realtimeSet(pathName, value, idToken = "") {
  if (!firebaseDatabaseUrl) return false;

  const appInstance = firebaseAdminApp();
  if (appInstance) {
    await getDatabase(appInstance).ref(pathName).set(value);
    return true;
  }

  if (!idToken) return false;
  await realtimePut(pathName, idToken, value);
  return true;
}

function sharedPatientUserId(row = {}) {
  return String(row.userId || row.patientUserId || row.patientId || "").trim();
}

function normalizeSharedRealtimeRow(collection, row = {}) {
  const next = { ...row };
  const patientUserId = sharedPatientUserId(next);

  if (
    patientUserId &&
    ["appointments", "queueEntries", "medicalRecords", "notifications", "payments"].includes(
      collection,
    )
  ) {
    next.userId = next.userId || patientUserId;
  }

  if (collection === "appointments" && patientUserId) {
    next.patientUserId = next.patientUserId || patientUserId;
    next.patientId = next.patientId || patientUserId;
  }

  if (collection === "notifications" && !next.createdAt && next.timestamp) {
    next.createdAt = next.timestamp;
  }

  return next;
}

async function mirrorRealtimeRow(collection, row, idToken = "") {
  if (!row?.id) return false;

  const value = normalizeSharedRealtimeRow(collection, row);
  try {
    return await realtimeSet(`${collection}/${value.id}`, value, idToken);
  } catch (error) {
    console.warn(`Unable to mirror ${collection}/${value.id} to Firebase.`, error.message);
    return false;
  }
}

async function mirrorRealtimeCollection(collection, value, idToken = "") {
  try {
    return await realtimeSet(collection, value, idToken);
  } catch (error) {
    console.warn(`Unable to mirror ${collection} to Firebase.`, error.message);
    return false;
  }
}

async function databaseEmailRegistered(email, idToken = "", ownUid = "") {
  return Boolean(await databaseEmailOwner(email, idToken, ownUid));
}

async function databaseEmailOwner(email, idToken = "", ownUid = "") {
  if (!firebaseDatabaseUrl || !idToken) return null;
  const normalized = normalizeEmail(email);
  if (!normalized) return "";

  try {
    const [users, profiles] = await Promise.all([
      realtimeGet("users", idToken),
      realtimeGet("patientProfiles", idToken),
    ]);

    return (
      collectionEmailOwner(users, normalized, ownUid) ||
      collectionEmailOwner(profiles, normalized, ownUid) ||
      ""
    );
  } catch (error) {
    console.warn("Unable to check Firebase database email duplicates.", error.message);
    return null;
  }
}

async function claimDatabaseEmailRegistry(email, uid, idToken = "", options = {}) {
  if (!firebaseDatabaseUrl || !idToken || !uid) return false;

  const normalized = normalizeEmail(email);
  const registryKey = emailRegistryKey(normalized);
  const registryPath = `emailRegistry/${registryKey}`;
  const existing = await realtimeGet(registryPath, idToken).catch((error) => {
    console.warn("Unable to read Firebase email registry.", error.message);
    return null;
  });

  if (existing && existing.uid && existing.uid !== uid && !options.allowReplace) {
    throw duplicateEmailError();
  }

  await realtimePut(registryPath, idToken, {
    createdAt: existing?.createdAt || new Date().toISOString(),
    emailHash: registryKey,
    maskedEmail: maskEmail(normalized),
    uid,
    updatedAt: new Date().toISOString(),
  }).catch((error) => {
    console.warn("Unable to update Firebase email registry.", error.message);
  });

  return true;
}

async function deleteFirebaseAuthSessionUser(idToken = "") {
  if (!idToken) return false;
  try {
    await firebaseRequest("accounts:delete", { idToken });
    return true;
  } catch (error) {
    console.warn("Unable to roll back duplicate Firebase Auth account.", error.message);
    return false;
  }
}

function firebaseAdminApp() {
  if (getApps().length) return getApp();

  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
    const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
    const credential = serviceAccountJson
      ? cert(JSON.parse(serviceAccountJson))
      : serviceAccountPath
        ? cert(require(path.resolve(serviceAccountPath)))
        : null;

    if (!credential) return null;

    return initializeApp({
      credential,
      databaseURL: firebaseDatabaseUrl || undefined,
      projectId: firebaseProjectId || undefined,
    });
  } catch (error) {
    console.warn("Firebase Admin is not available.", error.message);
    return null;
  }
}

async function adminDatabaseEmailOwner(email, ownUid = "") {
  const appInstance = firebaseAdminApp();
  if (!appInstance || !firebaseDatabaseUrl) return null;

  const normalized = normalizeEmail(email);
  if (!normalized) return "";

  try {
    const [usersSnapshot, profilesSnapshot] = await Promise.all([
      getDatabase(appInstance).ref("users").once("value"),
      getDatabase(appInstance).ref("patientProfiles").once("value"),
    ]);
    return (
      collectionEmailOwner(usersSnapshot.val(), normalized, ownUid) ||
      collectionEmailOwner(profilesSnapshot.val(), normalized, ownUid) ||
      ""
    );
  } catch (error) {
    console.warn("Unable to check Firebase Admin database email duplicates.", error.message);
    return null;
  }
}

async function adminDatabaseAccount(email, audience = "patient", options = {}) {
  const appInstance = firebaseAdminApp();
  if (!appInstance || !firebaseDatabaseUrl) return null;

  try {
    const [usersSnapshot, profilesSnapshot, staffSnapshot, emailRegistrySnapshot] =
      await Promise.all([
        getDatabase(appInstance).ref("users").once("value"),
        getDatabase(appInstance).ref("patientProfiles").once("value"),
        getDatabase(appInstance).ref("staff").once("value"),
        getDatabase(appInstance).ref("emailRegistry").once("value"),
      ]);

    return databaseAccountFromCollections(
      {
        emailRegistry: emailRegistrySnapshot.val(),
        patientProfiles: profilesSnapshot.val(),
        staff: staffSnapshot.val(),
        users: usersSnapshot.val(),
      },
      email,
      audience,
      "firebase",
      options,
    );
  } catch (error) {
    console.warn("Unable to check Firebase Admin account records.", error.message);
    return null;
  }
}

async function registeredDatabaseAccount(email, audience = "patient", options = {}) {
  const localAccount = localDatabaseAccount(email, audience, options);
  if (localAccount && localAccount.collection !== "emailRegistry") {
    return localAccount;
  }

  return (await adminDatabaseAccount(email, audience, options)) || localAccount;
}

function collectionRecordByUserId(collection, userId = "") {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId || !collection || typeof collection !== "object") return null;

  const direct = collection[normalizedUserId];
  if (direct && typeof direct === "object") return direct;

  return Object.values(collection).find((record) => {
    if (!record || typeof record !== "object") return false;
    return [record.uid, record.userId, record.id, record.localId].some(
      (value) => normalizeUserId(value) === normalizedUserId,
    );
  }) || null;
}

function localAccountRecordByUserId(userId = "") {
  const store = readStore();
  for (const collectionName of ["users", "staff", "profiles", "patientProfiles"]) {
    const record = collectionRecordByUserId(store[collectionName], userId);
    if (record) {
      return {
        collection: collectionName,
        record,
        source: "local",
        uid: normalizeUserId(record.uid || record.userId || record.id || userId),
      };
    }
  }
  return null;
}

async function adminAccountRecordByUserId(userId = "") {
  const normalizedUserId = normalizeUserId(userId);
  const appInstance = firebaseAdminApp();
  if (!normalizedUserId || !appInstance || !firebaseDatabaseUrl) return null;

  try {
    const database = getDatabase(appInstance);
    for (const collectionName of ["users", "staff", "profiles", "patientProfiles"]) {
      const snapshot = await database.ref(`${collectionName}/${normalizedUserId}`).once("value");
      const record = snapshot.val();
      if (record && typeof record === "object") {
        return {
          collection: collectionName,
          record,
          source: "firebase",
          uid: normalizeUserId(record.uid || record.userId || record.id || normalizedUserId),
        };
      }
    }

    const snapshots = await Promise.all(
      ["users", "staff", "profiles", "patientProfiles"].map(async (collectionName) => [
        collectionName,
        (await database.ref(collectionName).once("value")).val(),
      ]),
    );
    for (const [collectionName, collection] of snapshots) {
      const record = collectionRecordByUserId(collection, normalizedUserId);
      if (record) {
        return {
          collection: collectionName,
          record,
          source: "firebase",
          uid: normalizeUserId(record.uid || record.userId || record.id || normalizedUserId),
        };
      }
    }
  } catch (error) {
    console.warn("Unable to read Firebase account profile by user ID.", error.message);
  }

  return null;
}

async function recipientNameForAccount({
  audience = "staff",
  email = "",
  fallbackName = "",
  userId = "",
} = {}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUserId = normalizeUserId(userId);
  const fallback = sanitizePlainText(fallbackName, 120);

  const localByUserId = localAccountRecordByUserId(normalizedUserId);
  const localName = registeredNameFromRecord(localByUserId?.record);
  if (localName) return localName;

  const adminByUserId = await adminAccountRecordByUserId(normalizedUserId);
  const adminName = registeredNameFromRecord(adminByUserId?.record);
  if (adminName) return adminName;

  if (normalizedEmail) {
    const databaseAccount = await registeredDatabaseAccount(normalizedEmail, audience).catch(
      () => null,
    );
    const databaseName = registeredNameFromRecord(databaseAccount?.record);
    if (databaseName) return databaseName;
  }

  const appInstance = firebaseAdminApp();
  if (appInstance) {
    const authUser = normalizedUserId
      ? await getAuth(appInstance).getUser(normalizedUserId).catch(() => null)
      : normalizedEmail
        ? await getAuth(appInstance).getUserByEmail(normalizedEmail).catch(() => null)
        : null;
    const authName = registeredNameFromRecord(authUser || {});
    if (authName) return authName;
  }

  return fallback;
}

async function createFirebaseAuthUser(email, password) {
  return firebaseRequest("accounts:signUp", {
    email: normalizeEmail(email),
    password: String(password || ""),
    returnSecureToken: true,
  });
}

async function createOrRecoverPatientAuthSession(email, password) {
  try {
    return await createFirebaseAuthUser(email, password);
  } catch (error) {
    if (!isFirebaseEmailExists(error)) throw error;

    const existingDatabaseAccount = await registeredDatabaseAccount(email, "patient", {
      includePatientRegistry: false,
    });
    if (existingDatabaseAccount) {
      throw duplicateEmailError();
    }

    const appInstance = firebaseAdminApp();
    if (appInstance) {
      const authUser = await getAuth(appInstance)
        .getUserByEmail(normalizeEmail(email))
        .catch((lookupError) => {
          if (!isFirebaseEmailNotFound(lookupError)) {
            console.warn("Unable to inspect existing Firebase Auth user.", lookupError.message);
          }
          return null;
        });

      if (authUser?.uid) {
        try {
          await getAuth(appInstance).deleteUser(authUser.uid);
          return createFirebaseAuthUser(email, password);
        } catch (deleteError) {
          console.warn("Unable to clear unfinished Firebase Auth signup.", deleteError.message);
        }
      }
    }

    try {
      return await firebaseSignInWithPassword(email, password);
    } catch (recoveryError) {
      if (!isFirebaseInvalidCredentials(recoveryError)) {
        console.warn("Unable to recover unfinished Firebase Auth signup.", recoveryError.message);
      }
      throw unfinishedSignupError();
    }
  }
}

async function sendPasswordReset(email, audience = "patient", req = null) {
  const normalizedEmail = normalizeEmail(email);
  const databaseAccount = await registeredDatabaseAccount(normalizedEmail, audience);
  if (!databaseAccount) {
    throw passwordResetEmailNotRegisteredError(audience);
  }

  const appInstance = firebaseAdminApp();
  if (!appInstance) {
    throw customPasswordResetEmailUnavailableError();
  }

  let authUser = null;
  try {
    authUser = await getAuth(appInstance).getUserByEmail(normalizedEmail);
  } catch (error) {
    if (isFirebaseEmailNotFound(error)) {
      throw passwordResetEmailNotRegisteredError(audience);
    }
    console.warn("Unable to confirm Firebase Auth user before reset email.", error.message);
  }

  const firebaseLink = await getAuth(appInstance).generatePasswordResetLink(normalizedEmail);
  const oobCode = queryParamFromUrl(firebaseLink, "oobCode");
  if (oobCode) {
    rememberPasswordResetLink({
      audience,
      email: normalizedEmail,
      oobCode,
    });
  }
  const link = customPasswordResetLink(firebaseLink, normalizedEmail, audience, req);
  const accountRecord = databaseAccount.record || {};
  const recipientName = registeredNameFromRecord(accountRecord) || registeredNameFromRecord(authUser || {});
  await sendMail({
    fromEmail: alphastarSenderEmail,
    fromName: "Alphastar Laboratory",
    html: passwordResetEmailHtml({
      accountLabel: audience === "staff" ? "desktop staff account" : "mobile patient account",
      email: normalizedEmail,
      link,
      recipientName,
      title:
        audience === "staff"
          ? "Reset your desktop password"
          : "Reset your patient password",
    }),
    subject: `Alphastar password reset - ${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    text: `${recipientName ? `Hi, ${recipientName}!` : "Hello!"}\n\nUse this secure Alphastar password reset link: ${link}\n\nThis link is valid for ${passwordResetDurationLabel}. If you did not request this, ignore this email.`,
    to: normalizedEmail,
  });
  return { delivery: emailProvider(), ok: true };
}

async function createFirebaseCustomToken(uid, claims = {}) {
  const appInstance = firebaseAdminApp();
  if (!appInstance || !uid) return "";

  return getAuth(appInstance).createCustomToken(String(uid), claims).catch((error) => {
    console.warn("Unable to create Firebase custom token.", error.message);
    return "";
  });
}

function firebaseAdminRequiredError(action = "complete this secure action") {
  const error = new Error(
    `Firebase Admin credentials are required to ${action}. Add them to alphastar-desktop/backend/.env, then restart the desktop backend.`,
  );
  error.status = 503;
  error.code = "FIREBASE_ADMIN_REQUIRED";
  return error;
}

function sendError(res, error) {
  const payload = {
    code: error.code,
    error: error.message || "Request failed.",
    ok: false,
  };
  if (Number.isFinite(Number(error.resendAfterSeconds))) {
    payload.resendAfterSeconds = Math.max(0, Math.ceil(Number(error.resendAfterSeconds)));
  }
  res.status(error.status || 500).json(payload);
}

function requestBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function decodeJwt(token = "") {
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function actorFromRequest(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (req.staffAccess) {
    return { ...req.staffAccess.actor, email: req.staffAccess.decoded.email || "", token };
  }
  const decoded = decodeJwt(token);
  const uid = decoded.user_id || decoded.sub || "local-staff";
  const email = decoded.email || "staff@alphastar.ph";
  return { email, token, uid };
}

function upsert(collection, value, prefix) {
  const store = readStore();
  const row = {
    id: value.id || id(prefix),
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...value,
  };
  store[collection] ||= {};
  store[collection][row.id] = row;
  writeStore(store);
  return row;
}

function patchById(collection, rowId, patch) {
  const store = readStore();
  store[collection] ||= {};
  const previous = store[collection][rowId] || { id: rowId, createdAt: new Date().toISOString() };
  const next = { ...previous, ...patch, id: rowId, updatedAt: new Date().toISOString() };
  store[collection][rowId] = next;
  writeStore(store);
  return next;
}

function removeCollection(collection) {
  const store = readStore();
  store[collection] = {};
  writeStore(store);
}

function addAudit(actor, action, targetType, targetId, details = {}) {
  return upsert(
    "auditLogs",
    {
      action,
      actorEmail: actor.email,
      actorId: actor.uid,
      details,
      targetId,
      targetType,
      timestamp: new Date().toISOString(),
    },
    "audit",
  );
}

app.use(["/api/staff", "/api/staff-auth"], createStaffAccessGuard({ getFirebaseApp: firebaseAdminApp }));

app.use(["/api/staff/accounts", "/api/staff-auth/account-verification", "/api/staff/clinic-settings"], (req, res, next) => {
  try { requireAdministrator(req.staffAccess); next(); }
  catch (error) { sendError(res, error); }
});

app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, service: "alphastar-desktop-backend", capabilities: { staffAccountPin: 1, staffPinRecovery: 1 } });
});

app.post("/api/auth/account-status", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const audience = String(req.body.audience || "staff").toLowerCase();
  const account = await registeredDatabaseAccount(email, audience);
  const role = String(account?.role || "").toLowerCase();

  if (!account) {
    return res.status(404).json({
      active: false,
      error:
        audience === "patient"
          ? "This email is not registered in the Alphastar mobile app."
          : "This email is not registered in the Alphastar desktop system.",
      exists: false,
      role: null,
    });
  }

  if (audience === "staff" && !isStaffRole(role)) {
    return res.status(403).json({
      active: false,
      error: "This account is not authorized for the Alphastar desktop system.",
      exists: true,
      role,
    });
  }

  res.json({ active: true, exists: true, role: role || null });
});

app.post("/api/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  const audience = sanitizePlainText(req.body.audience || "patient", 24).toLowerCase();

  if (!isValidEmail(email) || !password) {
    return res.status(401).json({ error: "Invalid credentials", ok: false });
  }

  try {
    const store = readStore();
    cleanupChallenges(store);
    assertLoginAllowed(store, email, audience);

    const result = await firebaseSignInWithPassword(email, password);
    clearLoginFailures(email, audience);
    if (audience === "patient") {
      saveLocalPatientAccount({
        email: result.email || email,
        uid: result.localId,
      });
    }

    const account = audience !== "patient" ? await adminAccountRecordByUserId(result.localId) : null;
    const record = account?.record;
    const accountProfile = record ? {
      role: record.role || "",
      fullName: record.fullName || record.displayName || record.name || "",
      accountStatus: record.accountStatus || record.status || "active",
      email: result.email,
    } : null;
    res.json({
      accountProfile,
      email: result.email,
      expiresIn: result.expiresIn,
      idToken: result.idToken,
      localId: result.localId,
      ok: true,
      refreshToken: result.refreshToken,
    });
  } catch (error) {
    if (isFirebaseInvalidCredentials(error)) {
      const locked = recordLoginFailure(email, audience);
      return res.status(locked ? 429 : 401).json({
        error: locked
          ? "Too many failed login attempts. Please try again in 15 minutes."
          : "Invalid credentials",
        ok: false,
      });
    }
    sendError(res, error);
  }
});


const desktopResetPurpose = "desktop_password_reset_otp";
app.post("/api/password-reset/otp/send", async (req, res) => {
  let challenge;
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
    if (!await registeredDatabaseAccount(email, "staff")) throw passwordResetEmailNotRegisteredError("staff");
    const user = await getAuth(firebaseAdminApp()).getUserByEmail(email);
    if (user.disabled) throw new Error("This account is inactive. Contact your administrator.");
    challenge = createChallenge({ email, userId: user.uid, purpose: desktopResetPurpose });
    await sendMail({
      to: email,
      subject: "Alphastar password reset verification code",
      text: `Your Alphastar password reset verification code is ${challenge.code}. It expires in ${challengeDurationLabel}. Enter this code in the desktop app to reset your password. Never share this code with anyone.`,
      html: securityCodeEmailHtml({
        code: challenge.code, codeType: "verification", title: "Reset your password",
        description: "Use this one-time verification code to reset your Alphastar password.",
        expiresLabel: challengeDurationLabel, recipientName: user.displayName || "",
        appLabel: "Alphastar desktop app",
      }),
    });
    res.json({ ok: true, challengeToken: challenge.challengeToken, expiresAt: challenge.expiresAt });
  } catch (error) { if (challenge) forgetChallenge(challenge.challengeToken); sendError(res, error); }
});
app.post("/api/password-reset/otp/verify", (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const challenge = verifyChallenge({ email, challengeToken: req.body.challengeToken, code: String(req.body.code || ""), purpose: desktopResetPurpose });
    const session = createRegistrationToken({ email, purpose: desktopResetPurpose, metadata: { uid: challenge.userId } });
    res.json({ ok: true, resetToken: session.token });
  } catch (error) { sendError(res, error); }
});
app.post("/api/password-reset/otp/confirm", async (req, res) => {
  try {
    const password = req.body.password;
    if (typeof password !== "string" || password.length > 128 || !isStrongPassword(password)) throw new Error(passwordRulesMessage());
    if (password !== req.body.confirmPassword) throw new Error("Passwords do not match.");
    const email = normalizeEmail(req.body.email);
    const session = consumeRegistrationToken({ email, purpose: desktopResetPurpose, token: req.body.resetToken });
    const auth = getAuth(firebaseAdminApp());
    const user = await auth.getUser(session.metadata.uid);
    if (normalizeEmail(user.email) !== email || user.disabled || !await registeredDatabaseAccount(email, "staff")) throw new Error("This account cannot reset its password. Contact your administrator.");
    await auth.updateUser(user.uid, { password });
    clearLoginFailures(email, "staff");
    clearLoginFailures(email, "admin");
    res.json({ ok: true });
  } catch (error) { sendError(res, error); }
});

app.post("/api/password-reset/send", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const audience = String(req.body.audience || "patient").toLowerCase();

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Please enter a valid email address.", ok: false });
  }

  try {
    const result = await sendPasswordReset(email, audience, req);
    res.json({
      ...result,
      message:
        ["smtp", "brevo"].includes(result.delivery)
          ? `Password reset link sent from ${emailSender()}.`
          : "Password reset link sent to your email.",
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/reset-password", (req, res) => {
  res.type("html").send(resetPasswordPageHtml());
});

app.post("/api/password-reset/verify", async (req, res) => {
  const oobCode = String(req.body.oobCode || "").trim();
  if (!oobCode) {
    return res.status(400).json({ error: "This reset link is missing its security code.", ok: false });
  }

  try {
    const trackedLink = requireUsablePasswordResetLink(oobCode);
    const result = await firebaseRequest("accounts:resetPassword", { oobCode });
    if (result.requestType && result.requestType !== "PASSWORD_RESET") {
      return res.status(400).json({
        error: "This reset link is not for a password reset.",
        ok: false,
      });
    }
    const expiresAtMs = new Date(trackedLink.expiresAt).getTime();
    res.json({
      email: normalizeEmail(result.email || trackedLink.email),
      expiresAt: trackedLink.expiresAt,
      expiresInSeconds: Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000)),
      expiresLabel: passwordResetDurationLabel,
      ok: true,
    });
  } catch (error) {
    sendError(res, passwordResetCodeError(error) || error);
  }
});

app.post("/api/password-reset/confirm", async (req, res) => {
  const oobCode = String(req.body.oobCode || "").trim();
  const password = String(req.body.password || "");

  if (!oobCode) {
    return res.status(400).json({ error: "This reset link is missing its security code.", ok: false });
  }

  try {
    requireUsablePasswordResetLink(oobCode);

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: passwordRulesMessage(),
        ok: false,
      });
    }

    const result = await firebaseRequest("accounts:resetPassword", {
      newPassword: password,
      oobCode,
    });
    markPasswordResetLinkUsed(oobCode, result.email);
    res.json({
      email: normalizeEmail(result.email),
      message: "Password reset successfully.",
      ok: true,
    });
  } catch (error) {
    sendError(res, passwordResetCodeError(error) || error);
  }
});

app.post("/api/patient-auth/signup-code/start", async (req, res) => {
  const body = requestBody(req);
  const email = normalizeEmail(body.email);
  const fullName = sanitizePlainText(body.fullName || "Alphastar Patient", 120);

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Please enter a valid email address.", ok: false });
  }

  try {
    if (!emailReady()) {
      return res.status(503).json({
        error:
          emailUnavailableError().message,
        ok: false,
      });
    }

    const existingAccount = await registeredDatabaseAccount(email, "patient", {
      includePatientRegistry: false,
    });
    if (existingAccount) {
      if (existingAccount.uid) {
        claimLocalEmailRegistry(email, existingAccount.uid);
      }
      return res.status(409).json({
        error: "Email is already registered. Please use a different email or login instead.",
        ok: false,
      });
    }

    const challenge = createChallenge({
      email,
      metadata: { fullName },
      purpose: "patient_signup",
    });
    await sendMail({
      html: securityCodeEmailHtml({
        appLabel: "Alphastar mobile app",
        code: challenge.code,
        expiresLabel: challengeDurationLabel,
        greeting: `Hello ${fullName || "Alphastar Patient"},`,
        intro: "Use this OTP to finish creating your Alphastar patient account.",
        recipientName: fullName || "Alphastar Patient",
        title: "Create your patient account",
      }),
      subject: "Alphastar account OTP",
      text: `Your Alphastar OTP is ${challenge.code}. It expires in ${challengeDurationLabel}. Do not share it with anyone.`,
      to: email,
    });

    res.json({
      challengeToken: challenge.challengeToken,
      delivery: "email",
      senderEmail: emailSender(),
      expiresAt: challenge.expiresAt,
      maskedEmail: maskEmail(email),
      message: `OTP sent from ${emailSender()}.`,
      ok: true,
      resendAfterSeconds: resendDelaySeconds,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/patient-auth/signup-code/verify", (req, res) => {
  const body = requestBody(req);
  try {
    const challenge = verifyChallenge({
      challengeToken: String(body.challengeToken || ""),
      code: String(body.code || ""),
      email: normalizeEmail(body.email),
      purpose: "patient_signup",
    });
    const registration = createRegistrationToken({
      email: challenge.email,
      metadata: challenge.metadata || {},
      purpose: "patient_signup",
    });
    res.json({
      ok: true,
      registrationToken: registration.token,
      registrationTokenExpiresAt: registration.expiresAt,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/patient-auth/signup", async (req, res) => {
  const body = requestBody(req);
  const email = normalizeEmail(body.email);
  const fullName = sanitizePlainText(body.fullName || "Alphastar Patient", 120);
  const phone = sanitizePlainText(body.phone || "", 40);
  const password = String(body.password || "");
  const registrationToken = String(body.registrationToken || "");

  if (!fullName || !phone || !isValidEmail(email) || !password) {
    return res.status(400).json({ error: "Enter your full name, phone number, email, and password.", ok: false });
  }

  if (!isStrongPassword(password)) {
    return res.status(400).json({
      error: passwordRulesMessage(),
      ok: false,
    });
  }

  try {
    consumeRegistrationToken({
      email,
      purpose: "patient_signup",
      token: registrationToken,
    });

    const existingAccount = await registeredDatabaseAccount(email, "patient", {
      includePatientRegistry: false,
    });
    if (existingAccount) {
      if (existingAccount.uid) {
        claimLocalEmailRegistry(email, existingAccount.uid);
      }
      return res.status(409).json({
        error: "Email is already registered. Please use a different email or login instead.",
        ok: false,
      });
    }

    const result = await createOrRecoverPatientAuthSession(email, password);

    try {
      const existingDatabaseUid = await databaseEmailOwner(email, result.idToken, result.localId);
      if (existingDatabaseUid) {
        claimLocalEmailRegistry(email, existingDatabaseUid);
        throw duplicateEmailError();
      }
      await claimDatabaseEmailRegistry(email, result.localId, result.idToken, {
        allowReplace: true,
      });
      claimLocalEmailRegistry(email, result.localId, { allowReplace: true });
    } catch (registryError) {
      if (registryError?.status === 409) {
        await deleteFirebaseAuthSessionUser(result.idToken);
      }
      throw registryError;
    }

    const localPatientAccount = saveLocalPatientAccount({
      email: result.email || email,
      fullName,
      phone,
      uid: result.localId,
    });
    if (localPatientAccount) {
      await Promise.all([
        realtimeSet(`users/${result.localId}`, localPatientAccount.user, result.idToken).catch(
          (error) => {
            console.warn("Unable to mirror signup user to Firebase.", error.message);
          },
        ),
        realtimeSet(
          `patientProfiles/${result.localId}`,
          localPatientAccount.profile,
          result.idToken,
        ).catch((error) => {
          console.warn("Unable to mirror signup patient profile to Firebase.", error.message);
        }),
      ]);
    }

    const appInstance = firebaseAdminApp();
    if (appInstance && result.localId) {
      await getAuth(appInstance)
        .updateUser(result.localId, { emailVerified: true })
        .catch((error) => {
          console.warn("Unable to mark Firebase Auth email verified.", error.message);
        });
    }

    res.status(201).json({
      email: result.email,
      emailVerified: true,
      idToken: result.idToken,
      localId: result.localId,
      ok: true,
      refreshToken: result.refreshToken,
    });
  } catch (error) {
    if (isFirebaseEmailExists(error)) {
      return res.status(409).json({
        error: "Email is already registered. Please use a different email or login instead.",
        ok: false,
      });
    }
    sendError(res, error);
  }
});

function desktopPins() {
  const appInstance = firebaseAdminApp();
  if (!appInstance) throw firebaseAdminRequiredError("use an account PIN");
  desktopPins.service ||= createStaffAccountPin({
    getDatabase: () => getDatabase(appInstance),
    enabled: process.env.STAFF_ACCOUNT_PIN_ENABLED === "true",
    pepper: process.env.STAFF_PIN_PEPPER,
  });
  return desktopPins.service;
}
function pinAccount(req) {
  if (!req.staffAccess?.actor?.uid || !staffRoles.has(req.staffAccess.actor.role)) throw Object.assign(new Error("Please sign in again."), { status: 401 });
  return { uid: req.staffAccess.actor.uid, authProviderId: "password", authTime: req.staffAccess.decoded.auth_time };
}
function requireFreshPinLogin(account) {
  const time = Date.now() / 1000;
  if (!Number.isFinite(account.authTime) || time - account.authTime > 300 || account.authTime > time + 30) {
    throw Object.assign(new Error("Sign in with your password again before creating your PIN."), { status: 401, code: "STAFF_PIN_FRESH_LOGIN_REQUIRED" });
  }
}
app.post("/api/staff-auth/start", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const result = await desktopPins().status(pinAccount(req));
    res.json({ ok: true, ...result, delivery: "none" });
  } catch (error) { sendError(res, error); }
});
app.post("/api/staff-auth/pin/create", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const account = pinAccount(req);
    requireFreshPinLogin(account);
    if (req.body.pin !== req.body.confirmPin) throw Object.assign(new Error("PINs do not match."), { status: 400 });
    await desktopPins().create(account, req.body.pin);
    res.json({ ok: true, configured: true });
  } catch (error) { sendError(res, error); }
});
app.post("/api/staff-auth/verify", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const actor = actorFromRequest(req);
    await desktopPins().verify(pinAccount(req), req.body.pin);
    const customToken = await createFirebaseCustomToken(actor.uid, { source: "desktop" });
    res.json({ customToken: customToken || undefined, deviceId: req.body.deviceId || id("device"), ok: true, sessionId: id("session") });
  } catch (error) { sendError(res, error); }
});
app.post("/api/staff-auth/pin/change", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const account = pinAccount(req);
    if (req.body.pin !== req.body.confirmPin) throw Object.assign(new Error("PINs do not match."), { status: 400 });
    const proof = await desktopPins().beginChange(account, req.body.currentPin);
    await desktopPins().change(account, req.body.pin, proof.changeToken);
    res.json({ ok: true, configured: true });
  } catch (error) { sendError(res, error); }
});

const staffPinRecoveryPurpose = "staff_pin_recovery_otp";
async function staffPinRecoveryAccount(req) {
  // Recovery is available only after password sign-in. Never select another
  // account or recipient from a client-supplied UID/email or stale token email.
  const account = pinAccount(req);
  for (const key of ["uid", "userId", "targetUserId"]) {
    if (req.body[key] !== undefined && req.body[key] !== account.uid) {
      throw Object.assign(new Error("This PIN recovery does not match your signed-in account."), {
        status: 403, code: "STAFF_PIN_RECOVERY_ACCOUNT_MISMATCH",
      });
    }
  }
  const appInstance = firebaseAdminApp();
  if (!appInstance) throw firebaseAdminRequiredError("recover your account PIN");
  const user = await getAuth(appInstance).getUser(account.uid);
  if (user.uid !== account.uid || user.disabled) {
    throw Object.assign(new Error("This account is inactive. Please contact the clinic."), {
      status: 403, code: "STAFF_PIN_RECOVERY_ACCOUNT_INACTIVE",
    });
  }
  const email = normalizeEmail(user.email);
  if (!isValidEmail(email)) {
    throw Object.assign(new Error("This account has no valid registered email. Please contact the clinic."), {
      status: 409, code: "STAFF_PIN_RECOVERY_EMAIL_MISSING",
    });
  }
  if (req.body.email !== undefined &&
      (typeof req.body.email !== "string" || normalizeEmail(req.body.email) !== email)) {
    throw Object.assign(new Error("Use the registered email for your signed-in account."), {
      status: 403, code: "STAFF_PIN_RECOVERY_EMAIL_MISMATCH",
    });
  }
  return { account, email, user };
}
app.post("/api/staff-auth/pin/recovery/send", async (req, res) => {
  res.set("Cache-Control", "no-store");
  let challenge;
  try {
    const { account, email, user } = await staffPinRecoveryAccount(req);
    desktopPins().ready();
    if (!emailReady()) throw emailUnavailableError();
    challenge = createChallenge({ email, userId: account.uid,
      metadata: { uid: account.uid }, purpose: staffPinRecoveryPurpose });
    try {
      await sendMail({
        to: email,
        subject: "Alphastar PIN reset verification code",
        text: `Your Alphastar PIN reset OTP is ${challenge.code}. It expires in ${challengeDurationLabel}. Use this one-time code to create a new account PIN. Do not share it with anyone. Your existing PIN is never emailed.`,
        html: securityCodeEmailHtml({
          code: challenge.code, codeType: "verification", title: "Reset your PIN",
          description: "Enter this one-time verification code (OTP) in the desktop app to create a new account PIN. Do not share it. Your existing PIN is never emailed.",
          expiresLabel: challengeDurationLabel, recipientName: user.displayName || "",
          appLabel: "Alphastar desktop app",
        }),
      });
    } catch {
      // Provider errors may contain mail content; expose only a safe message.
      forgetChallenge(challenge.challengeToken, "expired");
      throw emailUnavailableError();
    }
    const at = email.indexOf("@");
    res.json({ ok: true, challengeToken: challenge.challengeToken,
      expiresAt: challenge.expiresAt, resendAfterSeconds: resendDelaySeconds,
      maskedEmail: `${email[0]}***${email.slice(at)}` });
  } catch (error) { sendError(res, error); }
});
app.post("/api/staff-auth/pin/recovery/verify", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { account, email } = await staffPinRecoveryAccount(req);
    if (typeof req.body.code !== "string" || !/^\d{6}$/.test(req.body.code) ||
        typeof req.body.challengeToken !== "string" || !req.body.challengeToken) {
      throw Object.assign(new Error("Enter the 6-digit OTP from the latest email."), {
        status: 400, code: "STAFF_PIN_RECOVERY_CODE_INVALID",
      });
    }
    const pins = desktopPins();
    pins.ready();
    verifyChallenge({ email, challengeToken: req.body.challengeToken, code: req.body.code,
      purpose: staffPinRecoveryPurpose, userId: account.uid, requireUserId: true });
    const resetToken = await pins.issueResetGrant(account);
    res.json({ ok: true, resetToken, expiresAt: new Date(Date.now() + 300_000).toISOString() });
  } catch (error) { sendError(res, error); }
});
app.post("/api/staff-auth/pin/recovery/confirm", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { account } = await staffPinRecoveryAccount(req);
    if (typeof req.body.pin !== "string" || !/^\d{6}$/.test(req.body.pin) ||
        typeof req.body.confirmPin !== "string" || !/^\d{6}$/.test(req.body.confirmPin)) {
      throw Object.assign(new Error("Enter all 6 digits of your new PIN."), {
        status: 400, code: "STAFF_PIN_INVALID",
      });
    }
    if (req.body.pin !== req.body.confirmPin) {
      throw Object.assign(new Error("PINs do not match."), { status: 400, code: "STAFF_PIN_MISMATCH" });
    }
    await desktopPins().reset(account, req.body.pin, req.body.resetToken);
    // Resetting does not unlock the workspace or issue a custom sign-in token.
    res.json({ ok: true, configured: true });
  } catch (error) { sendError(res, error); }
});

app.post("/api/staff-auth/session/renew", (req, res) => {
  const actor = actorFromRequest(req);
  createFirebaseCustomToken(actor.uid, { source: "desktop" })
    .then((customToken) => {
      res.json({
        customToken: customToken || undefined,
        deviceId: req.body.deviceId || id("device"),
        ok: true,
        sessionId: req.body.sessionId || id("session"),
      });
    })
    .catch((error) => sendError(res, error));
});

app.post("/api/staff-auth/session/logout", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/staff-auth/email-change/start", async (req, res) => {
  const actor = actorFromRequest(req);
  const newEmail = normalizeEmail(req.body.newEmail);
  const targetUserId = normalizeUserId(req.body.targetUserId || actor.uid);
  if (!isValidEmail(newEmail)) {
    return res.status(400).json({ error: "Please enter a valid new email address.", ok: false });
  }

  try {
    const recipientName = await recipientNameForAccount({
      audience: "staff",
      email: actor.email,
      userId: targetUserId,
    });
    const challenge = createChallenge({
      email: newEmail,
      metadata: {
        oldEmail: normalizeEmail(actor.email),
        targetUserId,
      },
      purpose: securityPurposes.staffEmailChange,
      userId: targetUserId,
    });
    try {
      await sendMail({
        html: securityCodeEmailHtml({
          appLabel: "Alphastar desktop app",
          code: challenge.code,
          description:
            "Use this one-time PIN code to confirm the new email address for the Alphastar desktop account. It can be used only once.",
          expiresLabel: challengeDurationLabel,
          recipientName,
          title: "Verify email change",
        }),
        subject: "Alphastar email-change PIN code",
        text: `Your Alphastar email-change PIN code is ${challenge.code}. It expires in ${challengeDurationLabel}. Do not share it with anyone.`,
        to: newEmail,
      });
    } catch (error) {
      forgetChallenge(challenge.challengeToken, "replaced");
      throw error;
    }
    res.json({
      challengeToken: challenge.challengeToken,
      delivery: "email",
      senderEmail: emailSender(),
      expiresAt: challenge.expiresAt,
      expiresIn: challengeDurationSeconds,
      maskedEmail: maskEmail(newEmail),
      message: `PIN code sent from ${emailSender()}.`,
      ok: true,
      resendAfterSeconds: resendDelaySeconds,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/staff-auth/email-change/verify", (req, res) => {
  const actor = actorFromRequest(req);
  const newEmail = normalizeEmail(req.body.newEmail);
  const targetUserId = normalizeUserId(req.body.targetUserId || actor.uid);
  if (!isValidEmail(newEmail)) {
    return res.status(400).json({ error: "Please enter a valid new email address.", ok: false });
  }

  try {
    verifyChallenge({
      challengeToken: String(req.body.challengeToken || ""),
      code: String(req.body.code || ""),
      email: newEmail,
      purpose: securityPurposes.staffEmailChange,
      requireUserId: true,
      userId: targetUserId,
    });
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

// Older clients must not send emailed codes for new staff/admin accounts.
for (const action of ["start", "verify"]) {
  app.post("/api/staff-auth/account-verification/" + action, (_req, res) => {
    res.status(410).json({ ok: false, error: "Account creation now uses Create PIN and Confirm PIN. Update the desktop app." });
  });
}

function desktopAccounts() {
  const appInstance = firebaseAdminApp();
  if (!appInstance) throw firebaseAdminRequiredError("save clinic accounts");
  return createAccountService({
    pins: desktopPins(),
    auth: getAuth(appInstance),
    database: getDatabase(appInstance),
    cache: ({ user, staff, audit, deletedUser, deletedStaff }) => {
      const store = readStore();
      if (deletedUser || deletedStaff) {
        const deletedId = deletedUser?.userId || deletedStaff?.userId || "";
        const deletedEmail = normalizeEmail(deletedUser?.email || deletedStaff?.email);
        if (deletedId) {
          delete store.users[deletedId];
          delete store.staff[deletedId];
        }
        if (deletedEmail) {
          const registryKey = emailRegistryKey(deletedEmail);
          if (store.emailRegistry?.[registryKey]?.uid === deletedId) {
            delete store.emailRegistry[registryKey];
          }
        }
      } else {
        store.users[user.userId] = user;
        store.staff[staff.userId] = staff;
      }
      store.auditLogs[audit.id] = audit;
      writeStore(store);
    },
  });
}

app.post("/api/staff/accounts/:userId/deletion-code", async (req, res) => {
  const actor = actorFromRequest(req);
  const targetUserId = normalizeUserId(req.params.userId);
  try {
    if (!targetUserId) throw new Error("Invalid account reference.");
    if (targetUserId === actor.uid) {
      return res.status(403).json({ ok: false, error: "You cannot delete the account currently signed in." });
    }
    if (!emailReady()) {
      return res.status(503).json({
        ok: false,
        error: emailUnavailableError().message,
      });
    }
    const target = await getDatabase(firebaseAdminApp()).ref(`users/${targetUserId}`).get();
    const targetRecord = target.val();
    const targetRole = String(targetRecord?.role || targetRecord?.accountRole || "").toLowerCase();
    if (!targetRecord || !staffRoles.has(targetRole)) {
      return res.status(404).json({ ok: false, error: "Account not found. Refresh the account list." });
    }
    if (targetRole === "admin") {
      return res.status(403).json({ ok: false, error: "Administrator accounts cannot be deleted." });
    }
    const recipientName = await recipientNameForAccount({
      audience: "staff",
      email: actor.email,
      userId: actor.uid,
    });
    const challenge = createChallenge({
      email: actor.email,
      metadata: { targetUserId },
      purpose: securityPurposes.accountDeletion,
      userId: actor.uid,
    });
    try {
      await sendMail({
        html: securityCodeEmailHtml({
          appLabel: "Alphastar desktop app",
          code: challenge.code,
          description: "Use this one-time PIN code to confirm deletion of a Staff Portal account. This action permanently removes that account's sign-in access.",
          expiresLabel: challengeDurationLabel,
          recipientName,
          title: "Confirm Staff Portal account deletion",
        }),
        subject: "Alphastar account deletion PIN code",
        text: `Your Alphastar account deletion PIN code is ${challenge.code}. It expires in ${challengeDurationLabel}. Do not share it with anyone.`,
        to: actor.email,
      });
    } catch (error) {
      forgetChallenge(challenge.challengeToken, "replaced");
      throw error;
    }
    res.json({
      ok: true,
      challengeToken: challenge.challengeToken,
      expiresAt: challenge.expiresAt,
      maskedEmail: maskEmail(actor.email),
      message: `Deletion PIN code sent to ${maskEmail(actor.email)}.`,
    });
  } catch (error) { sendError(res, error); }
});

app.post("/api/staff/accounts", async (req, res) => {
  const actor = actorFromRequest(req);
  const email = normalizeEmail(req.body.email);
  try {
    const service = desktopAccounts();
    const type = desktopAccountType(req.body.accountType || req.body.role || "staff");
    if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: "Enter a valid email address." });
    // Administrator-authenticated account creation sets a saved PIN, not an emailed code.
    const existingAccount = await registeredDatabaseAccount(email, "staff");
    if (existingAccount) return res.status(409).json({ ok: false, error: "Email is already registered in the Alpha Star desktop system." });
    const result = await service.create({ ...req.body, email, accountType: type }, actor);
    let confirmationEmailSent = false;
    if (emailReady()) {
      try {
        await sendStaffAccountCreatedEmail({
          email,
          recipientName: result.user.fullName,
        });
        confirmationEmailSent = true;
      } catch (error) {
        console.warn("Account saved, but its Staff Portal confirmation email could not be sent.", error.message);
      }
    }
    res.status(201).json({
      ...result,
      ok: true,
      account: {
        email: result.user.email,
        fullName: result.user.fullName,
        confirmationEmailSent,
        publicId: result.user.publicId,
        role: result.user.role,
        accountType: result.user.accountType,
        staff: result.staff,
        userId: result.user.userId,
      },
    });
  } catch (error) { sendError(res, error); }
});

app.patch("/api/staff/accounts/:userId", async (req, res) => {
  try {
    const result = await desktopAccounts().update(req.params.userId, requestBody(req), actorFromRequest(req));
    res.json({ ok: true, ...result });
  } catch (error) { sendError(res, error); }
});

app.post("/api/staff/accounts/:userId/pin", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    requireAdministrator(req.staffAccess);
    const targetUid = normalizeUserId(req.params.userId);
    if (!targetUid || !/^[A-Za-z0-9_-]{1,128}$/.test(targetUid)) throw Object.assign(new Error("Invalid account reference."), { status: 400 });
    const target = (await getDatabase(firebaseAdminApp()).ref(`users/${targetUid}`).get()).val();
    if (!target || !staffRoles.has(String(target.role || target.accountRole || "").toLowerCase())) throw Object.assign(new Error("Clinic account not found."), { status: 404 });
    if (req.body.pin !== req.body.confirmPin) throw Object.assign(new Error("PINs do not match."), { status: 400 });
    const pins = desktopPins();
    await pins.verify(pinAccount(req), req.body.currentPin);
    const account = { uid: targetUid, authProviderId: "password" };
    const grant = await pins.issueResetGrant(account);
    await pins.reset(account, req.body.pin, grant);
    addAudit(actorFromRequest(req), "staff_pin_reset", "staff", targetUid);
    res.json({ ok: true });
  } catch (error) { sendError(res, error); }
});

app.delete("/api/staff/accounts/:userId", async (req, res) => {
  const actor = actorFromRequest(req);
  const targetUserId = normalizeUserId(req.params.userId);
  try {
    if (!targetUserId) throw new Error("Invalid account reference.");
    const challenge = verifyChallenge({
      challengeToken: String(req.body.challengeToken || ""),
      code: String(req.body.code || ""),
      email: actor.email,
      purpose: securityPurposes.accountDeletion,
      requireUserId: true,
      userId: actor.uid,
    });
    if (normalizeUserId(challenge.metadata?.targetUserId) !== targetUserId) {
      return res.status(401).json({ ok: false, error: "This verification code is not valid for the selected account." });
    }
    const result = await desktopAccounts().remove(targetUserId, actor);
    res.json({ ok: true, ...result });
  } catch (error) { sendError(res, error); }
});

app.patch("/api/staff/profile", async (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const result = await desktopAccounts().update(actor.uid, requestBody(req), actor, { ownProfile: true });
    res.json({ ok: true, ...result });
  } catch (error) { sendError(res, error); }
});

registerBookingRoutes(app, { getFirebaseApp: firebaseAdminApp });
registerQueueRoutes(app, { getFirebaseApp: firebaseAdminApp });
registerSmpeRoutes(app);
registerSyncRoutes(app, { getFirebaseApp: firebaseAdminApp, assertAuthenticatorAccess: patientAuthenticatorAccess.assertAccess });

app.post("/api/staff/appointments", async (req, res) => {
  const actor = actorFromRequest(req);
  const appointment = upsert(
    "appointments",
    {
      ...req.body,
      appointmentNumber: req.body.appointmentNumber || `APT-${Date.now()}`,
      status: req.body.status || "pending",
    },
    "appt",
  );
  const audit = addAudit(actor, "appointment_created", "appointments", appointment.id);
  await Promise.all([
    mirrorRealtimeRow("appointments", appointment, actor.token),
    mirrorRealtimeRow("auditLogs", audit, actor.token),
  ]);
  res.status(201).json({ ok: true, appointment });
});

app.patch("/api/staff/appointments/:appointmentId/decision", async (req, res) => {
  const actor = actorFromRequest(req);
  const appointment = patchById("appointments", req.params.appointmentId, {
    decisionReason: req.body.reason || null,
    status: req.body.status || "scheduled",
  });
  const audit = addAudit(actor, "appointment_decision", "appointments", appointment.id);
  await Promise.all([
    mirrorRealtimeRow("appointments", appointment, actor.token),
    mirrorRealtimeRow("auditLogs", audit, actor.token),
  ]);
  res.json({ ok: true, appointment });
});

app.patch("/api/staff/appointments/:appointmentId/schedule", async (req, res) => {
  const actor = actorFromRequest(req);
  const appointment = patchById("appointments", req.params.appointmentId, {
    decisionReason: req.body.reason || null,
    scheduledAt: req.body.scheduledAt,
    status: "scheduled",
  });
  const audit = addAudit(actor, "appointment_rescheduled", "appointments", appointment.id);
  await Promise.all([
    mirrorRealtimeRow("appointments", appointment, actor.token),
    mirrorRealtimeRow("auditLogs", audit, actor.token),
  ]);
  res.json({ ok: true, appointment });
});

app.post("/api/staff/queue", async (req, res) => {
  const actor = actorFromRequest(req);
  const entry = upsert(
    "queueEntries",
    {
      ...req.body,
      queueNo: req.body.queueNo || `A-${String(Date.now()).slice(-3)}`,
      status: req.body.status || "waiting",
    },
    "queue",
  );
  const audit = addAudit(actor, "queue_created", "queueEntries", entry.id);
  await Promise.all([
    mirrorRealtimeRow("queueEntries", entry, actor.token),
    mirrorRealtimeRow("auditLogs", audit, actor.token),
  ]);
  res.status(201).json({ ok: true, entry });
});

app.patch("/api/staff/queue/:queueId", async (req, res) => {
  const actor = actorFromRequest(req);
  const entry = patchById("queueEntries", req.params.queueId, req.body);
  const audit = addAudit(actor, "queue_updated", "queueEntries", entry.id);
  await Promise.all([
    mirrorRealtimeRow("queueEntries", entry, actor.token),
    mirrorRealtimeRow("auditLogs", audit, actor.token),
  ]);
  res.json({ ok: true, entry });
});

app.post("/api/staff/medical-records", async (req, res) => {
  const actor = actorFromRequest(req);
  const record = upsert("medicalRecords", req.body, "record");
  const audit = addAudit(actor, "medical_record_created", "medicalRecords", record.id);
  await Promise.all([
    mirrorRealtimeRow("medicalRecords", record, actor.token),
    mirrorRealtimeRow("auditLogs", audit, actor.token),
  ]);
  res.status(201).json({ ok: true, record });
});

app.post("/api/staff/notifications", async (req, res) => {
  const actor = actorFromRequest(req);
  const notification = upsert(
    "notifications",
    { ...req.body, isRead: false, timestamp: new Date().toISOString() },
    "notice",
  );
  await mirrorRealtimeRow("notifications", notification, actor.token);
  res.status(201).json({ ok: true, notification });
});

app.patch("/api/staff/notifications/read-all", async (req, res) => {
  const actor = actorFromRequest(req);
  const store = readStore();
  Object.keys(store.notifications || {}).forEach((key) => {
    store.notifications[key].isRead = true;
    store.notifications[key].read = true;
  });
  writeStore(store);
  await mirrorRealtimeCollection("notifications", store.notifications, actor.token);
  res.json({ ok: true });
});

app.delete("/api/staff/notifications", async (req, res) => {
  const actor = actorFromRequest(req);
  removeCollection("notifications");
  await mirrorRealtimeCollection("notifications", null, actor.token);
  res.json({ ok: true });
});

app.post("/api/staff/stock-transactions", async (req, res) => {
  const actor = actorFromRequest(req);
  const transaction = upsert("stockTransactions", req.body, "stock");
  const audit = addAudit(actor, "stock_transaction_created", "stockTransactions", transaction.id);
  await Promise.all([
    mirrorRealtimeRow("stockTransactions", transaction, actor.token),
    mirrorRealtimeRow("auditLogs", audit, actor.token),
  ]);
  res.status(201).json({ ok: true, transaction });
});

app.put("/api/staff/clinic-settings", async (req, res) => {
  const actor = actorFromRequest(req);
  const store = readStore();
  store.clinicSettings = { ...store.clinicSettings, availability: req.body };
  writeStore(store);
  await mirrorRealtimeCollection("clinicSettings", store.clinicSettings, actor.token);
  res.json({ ok: true, clinicSettings: store.clinicSettings });
});

app.use((req, res) => {
  res.status(404).json({ message: `No Alphastar endpoint for ${req.method} ${req.path}` });
});

if (require.main === module) {
  app.listen(port, "0.0.0.0", () => {
    console.log(`Alpha Star desktop backend listening on http://127.0.0.1:${port}/api`);
  });
}

module.exports = {
  app,
  __test: {
    accountVerificationOtpEmailHtml,
    accountVerificationPurpose,
    cleanupChallenges,
    createChallenge,
    forgetChallenge,
    emailAttachmentsForHtml,
    emailReady,
    emailSender,
    passwordResetEmailHtml,
    readActiveChallenge,
    readStore,
    securityCodeEmailHtml,
    securityPurposes,
    staffAccountCreatedEmailHtml,
    verifyChallenge,
    writeStore,
  },
};
