"use strict";

const fs = require("node:fs");
const path = require("node:path");

function emailProvider(env = process.env) {
  return String(env.EMAIL_PROVIDER || (env.BREVO_API_KEY ? "brevo" : "smtp")).trim().toLowerCase();
}

function brevoConfig(env = process.env) {
  return {
    apiKey: String(env.BREVO_API_KEY || "").trim(),
    fromEmail: String(env.EMAIL_FROM_ADDRESS || "").trim(),
    fromName: String(env.EMAIL_FROM_NAME || "Alphastar Laboratory").trim(),
  };
}

function brevoReady(env = process.env) {
  const config = brevoConfig(env);
  return Boolean(config.apiKey && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.fromEmail));
}

function emailUnavailableError() {
  return Object.assign(new Error(
    "Email verification is temporarily unavailable. Please try again later or contact the clinic.",
  ), { status: 503, code: "EMAIL_DELIVERY_UNAVAILABLE" });
}

async function sendMailViaBrevo(message, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!brevoReady(env)) throw emailUnavailableError();
  const config = brevoConfig(env);
  try {
    const attachment = (message.attachments || []).map((item) => ({
      name: item.filename || path.basename(item.path || "attachment.txt"),
      content: (item.path ? fs.readFileSync(item.path) : Buffer.from(item.content || "", item.encoding || "utf8"))
        .toString("base64"),
    }));
    const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": config.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      // Never retry an uncertain delivery automatically: it could send duplicate OTPs.
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        sender: { email: config.fromEmail, name: config.fromName },
        to: (Array.isArray(message.to) ? message.to : [message.to]).map((email) => ({ email })),
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
        ...(attachment.length ? { attachment } : {}),
      }),
    });
    if (!response.ok) {
      // Provider responses can contain addresses or message content. Do not log them.
      console.warn(`Brevo email delivery rejected (HTTP ${response.status}). Check the API key, verified sender, and quota in Brevo.`);
      throw emailUnavailableError();
    }
    const result = await response.json();
    if (!result.messageId) throw emailUnavailableError();
    return result.messageId;
  } catch {
    // Never expose the API key, OTP, recipient, or provider response to patients.
    throw emailUnavailableError();
  }
}

module.exports = { emailProvider, brevoConfig, brevoReady, emailUnavailableError, sendMailViaBrevo };
