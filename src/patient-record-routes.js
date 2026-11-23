"use strict";

const crypto = require("node:crypto");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
class PatientRecordError extends Error {
  constructor(message, status = 400, code = "PATIENT_RECORD_INVALID") {
    super(message); this.status = status; this.code = code;
  }
}
function safeUid(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
    throw new PatientRecordError("Select a registered patient account.");
  }
  return value;
}
function active(value) {
  return value && value.active !== false && !value.disabled && !value.deleted && !value.deletedAt &&
    ![value.status, value.accountStatus].some(status => ["inactive", "disabled", "blocked", "suspended", "deleted"].includes(String(status || "").toLowerCase()));
}
function assertAdministrator(root, actor) {
  const administrator = root.users?.[actor.uid], staff = root.staff?.[actor.uid];
  if (!active(administrator) || (staff && !active(staff)) || String(administrator.role || administrator.accountRole || "").toLowerCase() !== "admin") {
    throw new PatientRecordError("Only an active administrator can manage patient records.", 403, "PATIENT_RECORD_FORBIDDEN");
  }
}
function clinicRecordId(value) {
  if (typeof value !== "string" || !/^clinic_[a-f0-9]{32}$/.test(value)) throw new PatientRecordError("The clinic record reference is invalid. Reopen the form and try again.");
  return value;
}
function patientPatch(input, now) {
  const limits = { fullName: 120, birthDate: 10, gender: 24, phone: 40, address: 500 };
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !Object.hasOwn(limits, key))) {
    throw new PatientRecordError("Only patient contact details can be updated here.");
  }
  const patch = {};
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw !== "string" || raw.length > limits[key]) throw new PatientRecordError("A patient field is invalid or too long.");
    patch[key] = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  }
  if (Object.hasOwn(patch, "fullName") && !patch.fullName) throw new PatientRecordError("Enter the patient's full name.");
  if (patch.birthDate) {
    const date = new Date(patch.birthDate + "T00:00:00Z");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.birthDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== patch.birthDate || patch.birthDate > today) {
      throw new PatientRecordError("Enter a valid date of birth that is not in the future.");
    }
  }
  if (Object.hasOwn(patch, "gender") && !["", "Female", "Male", "Intersex", "Other", "Prefer not to say"].includes(patch.gender)) throw new PatientRecordError("Choose a valid sex.");
  return patch;
}
function updatePatientRecord(root, uid, input, actor, now, eventId) {
  assertAdministrator(root, actor);
  const user = root.users?.[uid];
  if (!user || user.deleted || user.deletedAt || String(user.role || user.accountRole || "").toLowerCase() !== "patient") {
    throw new PatientRecordError("The registered patient account was not found. Refresh and select it again.", 404, "PATIENT_RECORD_NOT_FOUND");
  }
  if (root.desktopPatientRecordRemovals?.[uid]) throw new PatientRecordError("This patient record was removed from the directory.", 409, "PATIENT_RECORD_CONFLICT");
  const patch = patientPatch(input, now), timestamp = new Date(now).toISOString();
  const profile = { ...(root.patientProfiles?.[uid] || {}), ...patch, userId: uid, updatedAt: timestamp, updatedBy: actor.uid };
  // All aliases read by desktop/mobile must agree after a contact correction.
  if (Object.hasOwn(patch, "phone")) Object.assign(profile, { contactNumber: patch.phone, contactPhone: patch.phone, mobileNumber: patch.phone, phoneDigits: patch.phone.replace(/\D/g, "") });
  root.patientProfiles ||= {}; root.patientProfiles[uid] = profile;
  root.auditLogs ||= {};
  root.auditLogs[eventId] = { id: eventId, actorId: actor.uid, actorRole: "admin", action: "patient_profile_updated", targetType: "patientProfiles", targetId: uid,
    source: "desktop", timestamp, createdAt: timestamp, details: { fields: Object.keys(patch) } };
  // Return contact/profile fields only, never unrelated medical/security data.
  return Object.fromEntries(["userId", "patientNumber", "fullName", "birthDate", "gender", "phone", "address", "updatedAt"].filter(key => profile[key] !== undefined).map(key => [key, profile[key]]));
}
function clinicPatientPatch(input, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PatientRecordError("Enter the patient's contact details.");
  const { email = "", ...fields } = input;
  const patch = patientPatch(fields, now);
  for (const field of ["fullName", "birthDate", "phone", "address"]) {
    if (!patch[field]) throw new PatientRecordError("Enter the patient's name, date of birth, contact number and address.");
  }
  if (typeof email !== "string" || email.length > 254 || (email.trim() && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email.trim()))) {
    throw new PatientRecordError("Enter a valid email address or leave it blank.");
  }
  return { ...patch, gender: patch.gender || "", email: email.trim().toLowerCase() };
}
function saveClinicPatientRecord(root, id, input, actor, now, eventId) {
  assertAdministrator(root, actor);
  clinicRecordId(id);
  const prior = root.patientProfiles?.[id];
  if (root.users?.[id] || root.desktopPatientRecordRemovals?.[id] || (prior && (prior.recordKind !== "clinic_only" || prior.recordId !== id || prior.userId || prior.deleted || prior.deletedAt))) {
    throw new PatientRecordError("This is not an editable clinic-only patient record.", 409, "PATIENT_RECORD_CONFLICT");
  }
  const patch = clinicPatientPatch(input, now), timestamp = new Date(now).toISOString();
  // The form keeps this random ID across retries. A lost response must not
  // create another patient or audit entry, and names/emails never link accounts.
  if (prior && Object.entries(patch).every(([key, value]) => prior[key] === value)) return publicClinicProfile(prior);
  const patientNumber = prior?.patientNumber || `PAT-C-${id.slice(7, 19).toUpperCase()}`;
  if (!prior && Object.values(root.patientProfiles || {}).some(profile => profile?.patientNumber === patientNumber)) {
    throw new PatientRecordError("A patient reference already exists. Reopen the form and try again.", 409, "PATIENT_RECORD_CONFLICT");
  }
  const profile = { ...prior, ...patch, recordId: id, recordKind: "clinic_only", patientNumber,
    createdAt: prior?.createdAt || timestamp, createdBy: prior?.createdBy || actor.uid, updatedAt: timestamp, updatedBy: actor.uid };
  root.patientProfiles ||= {}; root.patientProfiles[id] = profile;
  root.auditLogs ||= {};
  root.auditLogs[eventId] = { id: eventId, actorId: actor.uid, actorRole: "admin", action: prior ? "patient_record_updated" : "patient_record_created",
    targetType: "patientProfiles", targetId: id, source: "desktop", timestamp, createdAt: timestamp, details: { fields: Object.keys(patch) } };
  return publicClinicProfile(profile);
}
function publicClinicProfile(profile) {
  return Object.fromEntries(["recordId", "recordKind", "patientNumber", "fullName", "birthDate", "gender", "phone", "email", "address", "createdAt", "updatedAt"]
    .filter(key => profile[key] !== undefined).map(key => [key, profile[key]]));
}
function removePatientRecord(root, id, kind, actor, now, eventId) {
  assertAdministrator(root, actor);
  const profile = root.patientProfiles?.[id];
  const user = root.users?.[id];
  const matchesClinic = !user && profile?.recordKind === "clinic_only" && profile.recordId === id && !profile.userId;
  const matchesRegistered = String(user?.role || user?.accountRole || "").toLowerCase() === "patient" && profile?.recordKind !== "clinic_only";
  if (!(kind === "clinic" ? matchesClinic : matchesRegistered)) {
    throw new PatientRecordError("Patient record not found. Reopen Patient Records and try again.", 404, "PATIENT_RECORD_NOT_FOUND");
  }
  if (root.desktopPatientRecordRemovals?.[id]?.removedAt) return root.desktopPatientRecordRemovals[id].removedAt;

  const timestamp = new Date(now).toISOString();
  root.desktopPatientRecordRemovals ||= {};
  root.desktopPatientRecordRemovals[id] = { removedAt: timestamp, removedBy: actor.uid };
  root.auditLogs ||= {};
  root.auditLogs[eventId] = { id: eventId, actorId: actor.uid, actorRole: "admin", action: "patient_record_removed",
    targetType: "patientProfiles", targetId: id, source: "desktop", timestamp, createdAt: timestamp };
  return timestamp;
}

function registerPatientRecordRoutes(app, options = {}) {
  app.get("/api/staff/patient-record-removals", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const access = req.staffAccess;
    if (!access?.database || !access.actor?.uid) return res.status(401).json({ ok: false, error: "Sign in to the desktop again." });
    try {
      const saved = (await access.database.ref("desktopPatientRecordRemovals").get()).val() || {};
      res.json({ ok: true, removals: Object.fromEntries(Object.entries(saved).map(([id, row]) => [id, row.removedAt])) });
    } catch {
      res.status(503).json({ ok: false, error: "Patient record removals could not be loaded. Please try again." });
    }
  });
  app.delete("/api/staff/patient-records/:recordId", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const access = req.staffAccess;
      if (!access?.database || !access.actor?.uid) throw new PatientRecordError("Sign in to the desktop again.", 401, "PATIENT_RECORD_UNAUTHORIZED");
      if (access.actor.role !== "admin") throw new PatientRecordError("Only an administrator can delete patient records.", 403, "PATIENT_RECORD_FORBIDDEN");
      const { kind, confirm } = req.body || {};
      if (confirm !== true || !["clinic", "registered"].includes(kind)) throw new PatientRecordError("Confirm the selected patient record before deleting it.");
      const id = kind === "clinic" ? clinicRecordId(req.params.recordId) : safeUid(req.params.recordId);
      const now = (options.now || Date.now)();
      const eventId = "patient_record_" + crypto.randomUUID();
      let failure, removedAt;
      const result = await transactionWithLiveSnapshot(access.database.ref(), current => {
        failure = undefined;
        removedAt = undefined;
        const root = structuredClone(current || {});
        try { removedAt = removePatientRecord(root, id, kind, access.actor, now, eventId); return root; }
        catch (error) { failure = error; return undefined; }
      });
      if (failure) throw failure;
      if (!result.committed || !removedAt) throw new PatientRecordError("The patient record changed. Try again.", 409, "PATIENT_RECORD_CONFLICT");
      res.json({ ok: true, recordId: id, removedAt });
    } catch (error) {
      res.status(error instanceof PatientRecordError ? error.status : 503).json({ ok: false,
        code: error instanceof PatientRecordError ? error.code : "PATIENT_RECORD_UNAVAILABLE",
        error: error instanceof PatientRecordError ? error.message : "The patient record could not be removed. Please try again." });
    }
  });
  app.put("/api/staff/clinic-patients/:recordId", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const access = req.staffAccess;
      if (!access?.database || !access.actor?.uid) throw new PatientRecordError("Sign in to the desktop again.", 401, "PATIENT_RECORD_UNAUTHORIZED");
      if (access.actor.role !== "admin") throw new PatientRecordError("Only an administrator can save patient contact details.", 403, "PATIENT_RECORD_FORBIDDEN");
      const id = clinicRecordId(req.params.recordId), now = (options.now || Date.now)();
      clinicPatientPatch(req.body, now);
      const eventId = "patient_record_" + crypto.randomUUID();
      let failure, profile;
      const result = await transactionWithLiveSnapshot(access.database.ref(), current => {
        failure = undefined; profile = undefined;
        const root = structuredClone(current || {});
        try { profile = saveClinicPatientRecord(root, id, req.body, access.actor, now, eventId); return root; }
        catch (error) { failure = error; return undefined; }
      });
      if (failure) throw failure;
      if (!result.committed || !profile) throw new PatientRecordError("The patient record changed. Try saving again.", 409, "PATIENT_RECORD_CONFLICT");
      res.json({ ok: true, profile });
    } catch (error) {
      res.status(error instanceof PatientRecordError ? error.status : 503).json({ ok: false,
        code: error instanceof PatientRecordError ? error.code : "PATIENT_RECORD_UNAVAILABLE",
        error: error instanceof PatientRecordError ? error.message : "The patient record could not be saved. Keep this form open and try again." });
    }
  });
  app.patch("/api/staff/patients/:userId", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const access = req.staffAccess;
      if (!access?.database || !access.actor?.uid) throw new PatientRecordError("Sign in to the desktop again.", 401, "PATIENT_RECORD_UNAUTHORIZED");
      if (access.actor.role !== "admin") throw new PatientRecordError("Only an administrator can update patient contact details.", 403, "PATIENT_RECORD_FORBIDDEN");
      const uid = safeUid(req.params.userId), now = (options.now || Date.now)();
      patientPatch(req.body, now);
      try { await options.verifyPatientUid(uid); }
      catch (error) {
        if (error.code === "auth/user-not-found") throw new PatientRecordError("This patient must finish registering in Alphastar Mobile first.", 404, "PATIENT_RECORD_NOT_FOUND");
        throw error;
      }
      const eventId = "patient_profile_" + crypto.randomUUID();
      let failure, profile;
      const result = await transactionWithLiveSnapshot(access.database.ref(), current => {
        failure = undefined; profile = undefined;
        const root = structuredClone(current || {});
        try { profile = updatePatientRecord(root, uid, req.body, access.actor, now, eventId); return root; }
        catch (error) { failure = error; return undefined; }
      });
      if (failure) throw failure;
      if (!result.committed || !profile) throw new PatientRecordError("The patient record changed. Try saving again.", 409, "PATIENT_RECORD_CONFLICT");
      res.json({ ok: true, profile });
    } catch (error) {
      res.status(error instanceof PatientRecordError ? error.status : 503).json({ ok: false,
        code: error instanceof PatientRecordError ? error.code : "PATIENT_RECORD_UNAVAILABLE",
        error: error instanceof PatientRecordError ? error.message : "The patient record could not be saved. Keep this form open and try again." });
    }
  });
}
module.exports = { registerPatientRecordRoutes, __test: { patientPatch, updatePatientRecord, clinicPatientPatch, saveClinicPatientRecord, PatientRecordError } };
