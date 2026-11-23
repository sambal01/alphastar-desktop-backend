"use strict";

// Kept identical in the desktop and mobile backends. Firebase is canonical.
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const { buildPatientAudit } = require("./patient-audit");
const { TYPES, examinationType, validateExaminationType } = require("./examination-types");
const STAFF_ROLES = new Set(["admin", "staff", "doctor", "nurse", "receptionist"]);
const FINISHED = new Set(["approved", "completed", "reviewed", "rejected"]);
const SECTIONS = ["personalBackground", "medicalHistory", "medicalHistoryDetails", "physicalAssessment"];
const PHYSICAL_FIELDS = ["height", "weight", "bloodPressure", "pulseRate", "respiratoryRate", "temperature", "remarks"];
const EDIT_FIELDS = { physicalAssessment: PHYSICAL_FIELDS };

class SmpeError extends Error {
  constructor(message, status = 400, code = "SMPE_INVALID") {
    super(message); this.status = status; this.code = code;
  }
}
function safeKey(value) {
  const key = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
    throw new SmpeError("Invalid medical record reference.");
  }
  return key;
}
function revision(record) {
  return Number.isSafeInteger(record?.revision) && record.revision > 0 ? record.revision : 1;
}
function submittedAt(record) {
  return String(record?.submittedAt || record?.recordedAt || record?.createdAt || "");
}
function isSmpe(record, includeClinicEntered = false) {
  return (record?.patientSubmitted === true || includeClinicEntered && record?.clinicEntered === true) && record.recordType === "patient_medical_record" && Boolean(examinationType(record)) && !record.deleted && !record.deletedAt;
}
function values(history) {
  return Array.isArray(history) ? history.filter(Boolean) : Object.values(history || {});
}
function finished(record) {
  return FINISHED.has(String(record?.status || "").toLowerCase());
}
function snapshot(record) {
  const copy = {};
  for (const key of ["id", "userId", "clinicRecordId", "clinicEntered", "createdBy", "firstApprovedAt", "medicalRecordId", "title", "recordType", "patientSubmitted", "source", "createdAt", "updatedAt", "status", "staffRemarks", "reviewedAt", "reviewedBy", "reviewerName", "lastEditedAt", "lastEditedBy", "lastEditorName", "lastEditReason"]) {
    if (record[key] !== undefined) copy[key] = record[key];
  }
  for (const key of SECTIONS) copy[key] = JSON.parse(JSON.stringify(record[key] || {}));
  copy.examinationType = examinationType(record);
  if (record.patientPhoto) copy.patientPhoto = record.patientPhoto;
  if (record.schoolIdPhoto) copy.schoolIdPhoto = record.schoolIdPhoto;
  copy.revision = revision(record);
  copy.submittedAt = submittedAt(record);
  return copy;
}
function active(account) {
  return account && account.active !== false && !account.disabled && !account.deleted && !account.deletedAt &&
    ![account.status, account.accountStatus].some(value => ["inactive", "disabled", "deleted", "suspended", "blocked"].includes(String(value || "").toLowerCase()));
}
function savedActor(root, actor, patient = false) {
  const user = root.users?.[actor?.uid];
  const staff = root.staff?.[actor?.uid];
  const role = String(user?.role || user?.accountRole || staff?.accountRole || staff?.role || "").trim().toLowerCase();
  if (!active(user) || (!patient && staff && !active(staff)) || (patient ? role !== "patient" : !STAFF_ROLES.has(role))) {
    throw new SmpeError("Your account is not allowed to perform this action.", 403, "SMPE_FORBIDDEN");
  }
  return { uid: actor.uid, role, name: String(user.name || user.fullName || user.displayName || staff?.name || staff?.fullName || "Clinic staff").slice(0, 160) };
}
function notice(key, uid, recordKey, record, now, title, message, type) {
  return { id: key, userId: uid, referenceId: recordKey, referenceType: "medicalRecords", examinationType: examinationType(record), revision: revision(record),
    createdAt: now, updatedAt: now, timestamp: now, source: "mobile", title, message, type, read: false, isRead: false };
}
function keepCompleted(history, record) {
  if (finished(record) && !history.some(item => revision(item) === revision(record) && submittedAt(item) === submittedAt(record))) {
    history.push(snapshot(record));
  }
}
const plainObject = value => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
const cleanEditText = value => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
function correctionPatch(record, input) {
  const allowed = new Set(["expectedRevision", "expectedSubmittedAt", "reason", "physicalAssessment"]);
  if (!plainObject(input) || Object.keys(input).some(key => !allowed.has(key))) throw new SmpeError("Only vital signs and assessment remarks can be updated. Patient answers are read-only.");
  if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 500)) throw new SmpeError("The optional update reason must be text with no more than 500 characters.");
  const reason = input.reason === undefined ? "" : cleanEditText(input.reason);
  const sections = Object.keys(EDIT_FIELDS).filter(section => Object.hasOwn(input, section));
  if (!sections.length) throw new SmpeError("Choose the form fields to update.");
  const patch = {};
  for (const section of sections) {
    if (!plainObject(input[section])) throw new SmpeError("Form sections must contain named text fields.");
    patch[section] = {};
    for (const [key, raw] of Object.entries(input[section])) {
      const limit = 120;
      if (!EDIT_FIELDS[section].includes(key) || typeof raw !== "string" || raw.length > limit) throw new SmpeError("A form field is unknown, too long, or not text.");
      const value = cleanEditText(raw);
      const previous = String(record[section]?.[key] ?? "").trim();
      if (value === previous) continue;
      patch[section][key] = value;
    }
  }
  return { patch, reason };
}
function updateSmpe(root, recordKey, input, actor, now) {
  recordKey = safeKey(recordKey);
  const editor = savedActor(root, actor);
  const record = root.medicalRecords?.[recordKey];
  if (!isSmpe(record) || !record.userId) throw new SmpeError("This patient medical form is no longer available.", 404, "SMPE_NOT_FOUND");
  if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 1 || typeof input?.expectedSubmittedAt !== "string") throw new SmpeError("Open the current form before editing it.");
  if (revision(record) !== input.expectedRevision || submittedAt(record) !== input.expectedSubmittedAt) throw new SmpeError("This form has changed. Open the latest version before saving corrections.", 409, "SMPE_STALE");
  if (!["admin", "staff"].includes(editor.role)) throw new SmpeError("Only admin and staff can correct saved vital signs.", 403, "SMPE_FORBIDDEN");
  const { patch, reason } = correctionPatch(record, input);
  const changedFields = Object.entries(patch).flatMap(([section, fields]) => Object.keys(fields).map(key => section + "." + key));
  if (!changedFields.length) return { record: { ...record, recordKey }, unchanged: true };
  if (revision(record) >= Number.MAX_SAFE_INTEGER) throw new SmpeError("The form revision cannot be updated.", 409, "SMPE_STALE");
  const timestamp = new Date(now).toISOString();
  const reviewed = finished(record);
  const next = { ...record, status: reviewed ? record.status : "Pending Review", revision: revision(record) + 1, updatedAt: timestamp,
    lastEditedAt: timestamp, lastEditedBy: editor.uid, lastEditorName: editor.name,
    revisionHistory: [...values(record.revisionHistory), snapshot(record)] };
  if (reason) next.lastEditReason = reason; else delete next.lastEditReason;
  for (const [section, fields] of Object.entries(patch)) next[section] = { ...(record[section] || {}), ...fields };
  if (reviewed) {
    const history = values(record.reviewHistory);
    keepCompleted(history, record);
    keepCompleted(history, next);
    next.reviewHistory = history;
  } else for (const field of ["staffRemarks", "reviewedAt", "reviewedBy", "reviewerName"]) delete next[field];
  root.medicalRecords[recordKey] = next;
  const noticeId = "smpe-edit-" + recordKey + "-r" + next.revision;
  const form = TYPES[examinationType(record)];
  const notification = notice(noticeId, record.userId, recordKey, next, timestamp, form.label + " record updated",
    "The clinic updated your " + form.title + " record. Open your record to review the changes.", "medical_record_updated");
  notification.source = "desktop";
  (root.notifications ||= {})[noticeId] = notification;
  (root.auditLogs ||= {})[noticeId] = { id: noticeId, action: "smpe_updated", actorId: editor.uid, actorRole: editor.role,
    targetType: "medicalRecords", targetId: recordKey, timestamp, details: { revision: next.revision, changedFields, source: "desktop" } };
  return { record: { ...next, recordKey }, unchanged: false, notification };
}
function approveSmpe(root, recordKey, input, actor, now) {
  recordKey = safeKey(recordKey);
  const reviewer = savedActor(root, actor);
  const record = root.medicalRecords?.[recordKey];
  if (!isSmpe(record) || !record.userId) throw new SmpeError("This patient medical form is no longer available.", 404, "SMPE_NOT_FOUND");
  if (!Number.isSafeInteger(input?.expectedRevision) || typeof input?.expectedSubmittedAt !== "string") {
    throw new SmpeError("Open the patient's form before approving it.");
  }
  if (revision(record) !== input.expectedRevision || submittedAt(record) !== input.expectedSubmittedAt) {
    throw new SmpeError("The patient updated this form. Open the latest version and review it again.", 409, "SMPE_STALE");
  }
  if (finished(record)) return { record: { ...record, recordKey }, duplicate: true };
  if (input.remarks !== undefined && (typeof input.remarks !== "string" || input.remarks.length > 2000)) {
    throw new SmpeError("Review remarks must be text with at most 2,000 characters.");
  }
  const timestamp = new Date(now).toISOString();
  const remarks = String(input.remarks || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  const next = { ...record, status: "Approved", staffRemarks: remarks, reviewedAt: timestamp,
    reviewedBy: reviewer.uid, reviewerName: reviewer.name, updatedAt: timestamp };
  const history = values(record.reviewHistory);
  keepCompleted(history, next);
  next.reviewHistory = history;
  root.medicalRecords[recordKey] = next;
  root.notifications ||= {};
  const noticeId = "smpe-review-" + recordKey + "-r" + revision(record);
  const form = TYPES[examinationType(record)];
  const notification = notice(noticeId, record.userId, recordKey, record, timestamp, form.label + " approved",
    "Your " + form.title + " form has been reviewed and approved by the clinic.", "medical_record_approved");
  notification.source = "desktop";
  root.notifications[noticeId] = notification;
  root.auditLogs ||= {};
  root.auditLogs[noticeId] = { id: noticeId, action: "smpe_approved", actorId: reviewer.uid, actorRole: reviewer.role,
    targetType: "medicalRecords", targetId: recordKey, timestamp, details: { revision: revision(record), source: "desktop" } };
  return { record: { ...next, recordKey }, notification, duplicate: false };
}

// Call only with the validated patientMedicalRecordPayload(), not req.body.
// Read/build inside the transaction so approval and resubmission cannot erase
// each other's completed history, answers, or revision counter.
function submitSmpe(root, payload, actor, ids, now) {
  const type = validateExaminationType(payload.examinationType);
  const form = TYPES[type];
  const patient = savedActor(root, actor, true);
  const key = safeKey(ids.recordKey);
  const existing = root.medicalRecords?.[key];
  if (ids.editing && (!isSmpe(existing) || existing.userId !== actor.uid)) {
    throw new SmpeError("This medical record is not available for editing.", 403, "MEDICAL_RECORD_FORBIDDEN");
  }
  if (!ids.editing && existing) throw new SmpeError("Please submit the form again.", 409, "SMPE_CONFLICT");
  if (existing && examinationType(existing) !== type) throw new SmpeError("A saved form cannot be changed to a different examination type.", 409, "EXAMINATION_TYPE_MISMATCH");
  if (existing && PHYSICAL_FIELDS.filter(field => field !== "remarks").some(field =>
    String(payload.physicalAssessment?.[field] ?? "").trim() !== String(existing.physicalAssessment?.[field] ?? "").trim())) {
    throw new SmpeError("Saved vital signs can only be updated by clinic staff. Reopen the latest form before submitting.", 409, "SMPE_VITALS_LOCKED");
  }
  const timestamp = new Date(now).toISOString();
  const reviewHistory = values(existing?.reviewHistory);
  if (existing) keepCompleted(reviewHistory, existing);
  const revisionHistory = values(existing?.revisionHistory);
  if (existing) revisionHistory.push(snapshot(existing));
  const record = { ...(existing || {}), id: key, userId: actor.uid, medicalRecordId: existing?.medicalRecordId || ids.medicalRecordId,
    title: form.title, examinationType: type, recordType: "patient_medical_record", patientSubmitted: true, source: "mobile",
    status: "Pending Review", revision: existing ? revision(existing) + 1 : 1, createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp, submittedAt: timestamp, recordedAt: timestamp };
  for (const field of SECTIONS) record[field] = JSON.parse(JSON.stringify(payload[field] || {}));
  for (const field of ["staffRemarks", "reviewedAt", "reviewedBy", "reviewerName", "lastEditedAt", "lastEditedBy", "lastEditorName", "lastEditReason"]) delete record[field];
  if (reviewHistory.length) record.reviewHistory = reviewHistory;
  if (revisionHistory.length) record.revisionHistory = revisionHistory;
  root.medicalRecords ||= {};
  root.medicalRecords[key] = record;
  root.notifications ||= {};
  const baseId = "smpe-" + key + "-r" + record.revision;
  const notification = notice(baseId + "-patient", actor.uid, key, record, timestamp,
    existing ? "Medical record updated" : "Medical record submitted",
    "Your " + form.title + " was submitted for review.", existing ? "medical_record_updated" : "medical_record_submitted");
  const patientName = [record.personalBackground.firstName, record.personalBackground.lastName].filter(Boolean).join(" ") || "A patient";
  const staffNotification = notice(baseId, "desktop-staff", key, record, timestamp, existing ? form.label + " updated" : "New " + form.label + " submission",
    patientName + (existing ? " updated a " : " submitted a ") + form.label + " form. Open " + form.label + " Approval to review it.", existing ? "smpe_updated" : "smpe_submitted");
  root.notifications[notification.id] = notification;
  root.notifications[staffNotification.id] = staffNotification;
  const audit = buildPatientAudit({ uid: actor.uid, email: root.users[actor.uid].email || actor.email,
    name: patient.name === "Clinic staff" ? "Patient" : patient.name, authProviderId: root.users[actor.uid].authProviderId },
    existing ? "patient_medical_record_updated" : "patient_medical_record_submitted",
    { eventKey: baseId, recordId: key, medicalRecordId: record.medicalRecordId, revision: record.revision }, now);
  (root.auditLogs ||= {})[audit.id] = audit;
  return { record: { ...record, recordKey: key }, notification, staffNotification, audit, updated: Boolean(existing) };
}
async function mutateSmpe(database, apply) {
  let rejection, result;
  const transaction = await transactionWithLiveSnapshot(database.ref(), current => {
    rejection = undefined; result = undefined;
    const root = JSON.parse(JSON.stringify(current || {}));
    try { result = apply(root); return root; }
    catch (error) { rejection = error; return undefined; }
  });
  if (rejection) throw rejection;
  if (!transaction.committed || !result) throw new SmpeError("The form changed. Please try again.", 409, "SMPE_CONFLICT");
  return result;
}
function registerSmpeRoutes(app, options = {}) {
  require("./staff-medical-forms").register(app, options);
  app.patch("/api/staff/medical-records/:recordId/assessment", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.staffAccess?.database || !req.staffAccess?.actor?.uid) throw new SmpeError("Staff sign-in is required.", 401, "SMPE_UNAUTHORIZED");
      const now = (options.now || Date.now)();
      const result = await mutateSmpe(req.staffAccess.database, root => updateSmpe(root, req.params.recordId, req.body, req.staffAccess.actor, now));
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error instanceof SmpeError ? error.status : 503).json({ ok: false, code: error instanceof SmpeError ? error.code : "SMPE_UNAVAILABLE",
        error: error instanceof SmpeError ? error.message : "Medical form updates are temporarily unavailable. Please try again." });
    }
  });
  app.patch("/api/staff/medical-records/:recordId/review", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      // The verified staff middleware is mandatory. Never trust body/claims.
      if (!req.staffAccess?.database || !req.staffAccess?.actor?.uid) throw new SmpeError("Staff sign-in is required.", 401, "SMPE_UNAUTHORIZED");
      const now = (options.now || Date.now)();
      const result = await mutateSmpe(req.staffAccess.database, root =>
        approveSmpe(root, req.params.recordId, req.body, req.staffAccess.actor, now));
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error instanceof SmpeError ? error.status : 503).json({ ok: false,
        code: error instanceof SmpeError ? error.code : "SMPE_UNAVAILABLE",
        error: error instanceof SmpeError ? error.message : "Medical form review is temporarily unavailable. Please try again." });
    }
  });
}
module.exports = { registerSmpeRoutes, submitSmpe, mutateSmpe, staffFormSupport: {
  revision, submittedAt, snapshot, SmpeError, savedActor, keepCompleted, finished,
  isSmpe: record => isSmpe(record, true) && Boolean(record.userId) !== Boolean(record.clinicRecordId),
}, __test: { approveSmpe, updateSmpe, submitSmpe, revision, submittedAt, snapshot, SmpeError, EDIT_FIELDS } };
