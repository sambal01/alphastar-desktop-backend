"use strict";

const crypto = require("node:crypto");

// This is a server-side allowlist, not an endpoint accepting arbitrary events
// from a patient. Never pass a request body, credential or SMPE section here.
const EVENTS = Object.freeze({
  patient_account_created: ["Patient Account Created", "Completed patient account registration.", "accounts"],
  patient_login: ["Patient Sign-in Verified", "Verified patient sign-in credentials. Account PIN checks are recorded separately.", "authentication"],
  patient_logout: ["Patient Sign-out Requested", "Requested sign-out on this device.", "authentication"],
  patient_authenticator_enabled: ["Authenticator Enabled", "Enabled patient two-factor authentication.", "security"],
  patient_authenticator_disabled: ["Authenticator Disabled", "Disabled patient two-factor authentication.", "security"],
  patient_pin_created: ["Account PIN Created", "Created the patient account PIN.", "security"],
  patient_pin_verified: ["Account PIN Verified", "Successfully verified the patient account PIN.", "authentication"],
  patient_pin_changed: ["Account PIN Changed", "Changed the patient account PIN.", "security"],
  patient_pin_reset: ["Account PIN Reset", "Reset the patient account PIN after email verification.", "security"],
  patient_pin_failed: ["Account PIN Check Failed", "The patient account PIN check was not accepted.", "authentication"],
  patient_password_changed: ["Password Changed", "Changed the patient password after account and email verification.", "security"],
  patient_password_reset: ["Password Reset", "Reset the patient password after email verification.", "security"],
  patient_medical_record_submitted: ["SMPE Submitted", "Submitted an SMPE record for clinic review.", "medical_records"],
  patient_medical_record_updated: ["SMPE Updated", "Resubmitted an updated SMPE record for clinic review.", "medical_records"],
});
const text = (value, limit) => String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, limit);

function buildPatientAudit(account, action, options = {}, now = Date.now()) {
  if (!Object.hasOwn(EVENTS, action) || !account?.uid) throw new Error("Invalid patient audit event.");
  const [actionLabel, summary, category] = EVENTS[action];
  const uid = text(account.uid, 128);
  const provider = ["password", "google.com"].includes(account.authProviderId) ? account.authProviderId : "";
  const registrationKey = action === "patient_account_created" ? `${uid}:${provider}` : "";
  // Stable IDs preserve one registration and one event per committed SMPE
  // revision/security operation, including transaction retries and mirroring.
  const key = registrationKey || options.eventKey;
  const id = "patient-audit-" + (key ? crypto.createHash("sha256").update(JSON.stringify([uid, action, key])).digest("hex") : crypto.randomUUID());
  const createdAt = new Date(now).toISOString();
  const medical = category === "medical_records";
  const details = {};
  if (provider) details.authProvider = provider === "google.com" ? "Google" : "Email and password";
  if (["primary", "two_factor"].includes(options.verification)) details.verification = options.verification === "two_factor" ? "Two-factor verification" : "Primary sign-in";
  if (medical && Number.isSafeInteger(options.revision) && options.revision > 0) details.revision = options.revision;
  if (medical && options.medicalRecordId) details.medicalRecordId = text(options.medicalRecordId, 180);
  if (action === "patient_pin_failed" && ["PATIENT_PIN_INCORRECT", "PATIENT_PIN_LOCKED"].includes(options.reason)) details.reason = options.reason === "PATIENT_PIN_LOCKED" ? "Attempt limit or temporary lock" : "Incorrect PIN";
  const actorName = text(account.name || account.fullName || account.user?.displayName, 160) || "Patient";
  const targetCollection = medical ? "medicalRecords" : "users";
  return { id, action, type: action, actionLabel, category, actorId: uid, actorRole: "patient",
    actorEmail: text(account.email, 254), actorName, source: "mobile", status: action === "patient_pin_failed" ? "failed" : "success",
    createdAt, timestamp: createdAt, targetId: medical ? text(options.recordId, 180) : uid,
    targetType: targetCollection, targetCollection, summary, details, auditVersion: 1 };
}

function createPatientAuditWriter({ getDatabase, cache = () => {}, onError = () => {},
  // CAS retries preserve existing events even if the SDK cache starts empty;
  // this append-only operation does not require a value listener.
  transact = (ref, update) => ref.transaction(update, undefined, false), now = Date.now, timeoutMs = 2500 }) {
  return async (account, action, options = {}) => {
    // A failed audit mirror must not report that an already committed password,
    // PIN or registration failed and encourage repeating that mutation.
    let row, timer;
    const report = stage => { try { onError({ action: Object.hasOwn(EVENTS, action) ? action : "unknown", stage }); } catch { /* Diagnostics must not fail a completed mutation. */ } };
    try {
      row = buildPatientAudit(account, action, options, now());
      const result = await Promise.race([
        transact(getDatabase().ref(`auditLogs/${row.id}`), current => current || row),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Audit acknowledgement timed out.")), timeoutMs); }),
      ]);
      if (!result.committed) throw new Error("Audit transaction was not committed.");
      const saved = result.snapshot?.val?.() || row;
      try { cache(saved); } catch { report("local-cache"); }
      return true;
    } catch {
      if (row) { try { cache(row); } catch { /* Diagnostics below contain no patient or credential data. */ } }
      report("audit-storage");
      return false;
    } finally { clearTimeout(timer); }
  };
}

// Optional injection keeps route tests independent of a live database. This
// guard also prevents a logging outage from changing a completed action result.
async function recordPatientAudit(audit, account, action, options) {
  try { await audit(account, action, options); } catch { /* The configured writer reports sanitized diagnostics. */ }
}

module.exports = { EVENTS, buildPatientAudit, createPatientAuditWriter, recordPatientAudit };
