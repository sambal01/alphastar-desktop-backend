"use strict";

// Kept identical in the desktop and mobile backends. Firebase is canonical.
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const STAFF_ROLES = new Set(["admin", "staff", "doctor", "nurse", "receptionist"]);
const FINISHED = new Set(["approved", "completed", "reviewed", "rejected"]);
const SECTIONS = ["personalBackground", "medicalHistory", "medicalHistoryDetails", "physicalAssessment"];

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
function isSmpe(record) {
  return record?.patientSubmitted === true && record.recordType === "patient_medical_record" && !record.deleted && !record.deletedAt;
}
function values(history) {
  return Array.isArray(history) ? history.filter(Boolean) : Object.values(history || {});
}
function finished(record) {
  return FINISHED.has(String(record?.status || "").toLowerCase());
}
function snapshot(record) {
  const copy = {};
  for (const key of ["id", "userId", "medicalRecordId", "title", "recordType", "patientSubmitted", "source", "createdAt", "status", "staffRemarks", "reviewedAt", "reviewedBy", "reviewerName"]) {
    if (record[key] !== undefined) copy[key] = record[key];
  }
  for (const key of SECTIONS) copy[key] = JSON.parse(JSON.stringify(record[key] || {}));
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
  return { id: key, userId: uid, referenceId: recordKey, referenceType: "medicalRecords", revision: revision(record),
    createdAt: now, updatedAt: now, timestamp: now, source: "mobile", title, message, type, read: false, isRead: false };
}
function keepCompleted(history, record) {
  if (finished(record) && !history.some(item => revision(item) === revision(record) && submittedAt(item) === submittedAt(record))) {
    history.push(snapshot(record));
  }
}
function approveSmpe(root, recordKey, input, actor, now) {
  recordKey = safeKey(recordKey);
  const reviewer = savedActor(root, actor);
  const record = root.medicalRecords?.[recordKey];
  if (!isSmpe(record) || !record.userId) throw new SmpeError("This patient SMPE form is no longer available.", 404, "SMPE_NOT_FOUND");
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
  const notification = notice(noticeId, record.userId, recordKey, record, timestamp, "SMPE approved",
    "Your Student Medical & Physical Examination form has been reviewed and approved by the clinic.", "medical_record_approved");
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
  savedActor(root, actor, true);
  const key = safeKey(ids.recordKey);
  const existing = root.medicalRecords?.[key];
  if (ids.editing && (!isSmpe(existing) || existing.userId !== actor.uid)) {
    throw new SmpeError("This medical record is not available for editing.", 403, "MEDICAL_RECORD_FORBIDDEN");
  }
  if (!ids.editing && existing) throw new SmpeError("Please submit the form again.", 409, "SMPE_CONFLICT");
  const timestamp = new Date(now).toISOString();
  const reviewHistory = values(existing?.reviewHistory);
  if (existing) keepCompleted(reviewHistory, existing);
  const revisionHistory = values(existing?.revisionHistory);
  if (existing) revisionHistory.push(snapshot(existing));
  const record = { ...(existing || {}), id: key, userId: actor.uid, medicalRecordId: existing?.medicalRecordId || ids.medicalRecordId,
    title: "Student Medical & Physical Examination", recordType: "patient_medical_record", patientSubmitted: true, source: "mobile",
    status: "Pending Review", revision: existing ? revision(existing) + 1 : 1, createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp, submittedAt: timestamp, recordedAt: timestamp };
  for (const field of SECTIONS) record[field] = JSON.parse(JSON.stringify(payload[field] || {}));
  for (const field of ["staffRemarks", "reviewedAt", "reviewedBy", "reviewerName"]) delete record[field];
  if (reviewHistory.length) record.reviewHistory = reviewHistory;
  if (revisionHistory.length) record.revisionHistory = revisionHistory;
  root.medicalRecords ||= {};
  root.medicalRecords[key] = record;
  root.notifications ||= {};
  const baseId = "smpe-" + key + "-r" + record.revision;
  const notification = notice(baseId + "-patient", actor.uid, key, record, timestamp,
    existing ? "Medical record updated" : "Medical record submitted",
    "Your Student Medical & Physical Examination was submitted for review.", existing ? "medical_record_updated" : "medical_record_submitted");
  const patientName = [record.personalBackground.firstName, record.personalBackground.lastName].filter(Boolean).join(" ") || "A patient";
  const staffNotification = notice(baseId, "desktop-staff", key, record, timestamp, existing ? "SMPE updated" : "New SMPE submission",
    patientName + (existing ? " updated an SMPE form." : " submitted an SMPE form.") + " Open SMPE Approval to review it.", existing ? "smpe_updated" : "smpe_submitted");
  root.notifications[notification.id] = notification;
  root.notifications[staffNotification.id] = staffNotification;
  return { record: { ...record, recordKey: key }, notification, staffNotification, updated: Boolean(existing) };
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
        error: error instanceof SmpeError ? error.message : "SMPE review is temporarily unavailable. Please try again." });
    }
  });
}
module.exports = { registerSmpeRoutes, submitSmpe, mutateSmpe, __test: { approveSmpe, submitSmpe, revision, submittedAt, snapshot, SmpeError } };
