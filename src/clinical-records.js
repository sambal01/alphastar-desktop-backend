"use strict";

// Private clinical work is deliberately separate from patient-readable medical forms.
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const { catalog } = require("./service-journey");
const { checkedFile, fileMetadata, ClinicalFileError, MAX_FILES, MAX_TOTAL_BYTES } = require("./clinical-files");
const { privateFileStore } = require("./private-clinical-files");
const ROLES = new Set(["admin", "staff", "doctor"]);
const VITALS = Object.freeze({ height: "Height (cm)", weight: "Weight (kg)", bloodPressure: "Blood pressure (mmHg)", pulseRate: "Pulse (bpm)", respiratoryRate: "Respiratory rate (/min)", temperature: "Temperature (°C)" });
const NOTES = Object.freeze({ concern: "Presenting concern", findings: "Findings / results", assessment: "Clinical assessment", treatment: "Treatment / instructions", followUp: "Follow-up instructions" });
const VITALS_ONLY_SERVICES = new Set(["completelaboratory", "digitalxray", "ecg", "2decho", "twodecho", "drugtest", "ultrasoundtransvaginal", "ultrasoundwithtransvaginal", "bloodchemistrypromo8tests", "bloodchemistrypromopackage8tests"]);
function documentationMode(value = {}) {
  // Never hide or discard clinical notes already saved on a legacy visit.
  if (Object.values(value.notes || {}).some(note => typeof note === "string" && note.trim())) return "clinical_notes";
  if (["clinical_notes", "vitals_only"].includes(value.documentationMode)) return value.documentationMode;
  const service = String(value.serviceName || value.service_name || value.name || value.serviceId || value.service_id || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return VITALS_ONLY_SERVICES.has(service) ? "vitals_only" : "clinical_notes";
}
class ClinicalError extends Error {
  constructor(message, status = 400, code = "CLINICAL_INVALID") { super(message); Object.assign(this, { status, code }); }
}
const values = value => Object.values(value || {}).filter(Boolean);
// Legacy rows can lack a visit date. Sorting must not turn one such row into
// a 503 for the patient's entire history (or the staff draft list).
function newestVisit(a, b) {
  const timestamp = row => [row.visitAt, row.createdAt, row.updatedAt].map(validTime).filter(Boolean)[0] || "";
  return timestamp(b).localeCompare(timestamp(a)) || String(a.id || "").localeCompare(String(b.id || ""));
}
const active = row => Boolean(row && row.active !== false && !row.disabled && !row.deleted && !row.deletedAt && ![row.status, row.accountStatus].some(value => /^(inactive|disabled|suspended|blocked|deleted)$/i.test(String(value || ""))));
function key(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,180}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw new ClinicalError("Invalid record reference.");
  return value;
}
function actorFor(root, actor, patient = false) {
  const user = root.users?.[actor?.uid], staff = root.staff?.[actor?.uid];
  const role = String(user?.role || user?.accountRole || staff?.accountRole || staff?.role || "").toLowerCase();
  if (!active(user) || (staff && !active(staff)) || !(patient ? role === "patient" : ROLES.has(role))) throw new ClinicalError("Your account cannot access these records.", 403, "CLINICAL_FORBIDDEN");
  // Only the server-managed staff record (not a self-editable user profile)
  // or a private reviewer designation may confer clinical-release authority.
  const canRelease = !patient && (role === "doctor" || String(staff?.accountType || "").toLowerCase() === "doctor" || root.clinicalReviewers?.[actor.uid]?.active === true);
  return { uid: actor.uid, role, name: String(staff?.name || staff?.fullName || user.fullName || user.name || "Clinic staff").slice(0, 160), canRelease };
}
function validTime(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : ""; }
function firstApproval(root, uid) {
  const dates = [root.patientAdmissions?.[uid]?.firstApprovedAt];
  for (const form of values(root.medicalRecords)) {
    if (form.userId !== uid || form.patientSubmitted !== true || form.recordType !== "patient_medical_record" || form.deleted || form.deletedAt) continue;
    dates.push(form.firstApprovedAt);
    for (const version of [form, ...values(form.reviewHistory), ...values(form.revisionHistory)]) {
      if (/^(approved|completed|reviewed)$/i.test(String(version.status || ""))) dates.push(version.reviewedAt);
    }
  }
  return dates.map(validTime).filter(Boolean).sort()[0] || "";
}
function admitApprovedPatient(root, uid, recordKey, now) {
  key(uid); key(recordKey);
  const previous = root.patientAdmissions?.[uid];
  const firstApprovedAt = firstApproval(root, uid) || new Date(now).toISOString();
  const admission = { ...(previous || {}), userId: uid, firstApprovedAt, updatedAt: new Date(now).toISOString(), forms: { ...(previous?.forms || {}), [recordKey]: true } };
  (root.patientAdmissions ||= {})[uid] = admission;
  // Approval links the reviewed demographics to the existing account; it does
  // not create a second user or replace verified email/security fields.
  const personal = root.medicalRecords?.[recordKey]?.personalBackground || {};
  const profile = { ...(root.patientProfiles?.[uid] || {}), userId: uid, firstApprovedAt, updatedAt: admission.updatedAt };
  const fullName = [personal.firstName, personal.middleName, personal.lastName].filter(value => typeof value === "string" && value.trim()).join(" ").trim().slice(0, 160);
  if (fullName) profile.fullName = fullName;
  if (typeof personal.dateOfBirth === "string" && /^\d{4}-\d{2}-\d{2}$/.test(personal.dateOfBirth)) profile.birthDate = personal.dateOfBirth;
  if (typeof personal.sex === "string" && personal.sex.trim()) profile.gender = personal.sex.trim().slice(0, 24);
  if (typeof personal.contactNumber === "string" && personal.contactNumber.trim()) {
    const phone = personal.contactNumber.trim().slice(0, 40);
    Object.assign(profile, { phone, contactNumber: phone, contactPhone: phone, mobileNumber: phone });
  }
  (root.patientProfiles ||= {})[uid] = profile;
  return admission;
}
function identity(root, input) {
  if (Boolean(input?.userId) === Boolean(input?.clinicRecordId)) throw new ClinicalError("Select one patient from Patient Records.");
  if (input.userId) {
    const userId = key(input.userId), user = root.users?.[userId];
    if (!active(user) || String(user.role).toLowerCase() !== "patient") throw new ClinicalError("This patient account is unavailable.", 404);
    const hasLegacyApproval = values(root.medicalRecords).some(row => row.userId === userId && row.patientSubmitted === true && /^(approved|completed|reviewed)$/i.test(String(row.status || "")));
    if (!firstApproval(root, userId) && !hasLegacyApproval) throw new ClinicalError("Approve the patient's SMAPE or MAPE application first.", 409, "CLINICAL_APPROVAL_REQUIRED");
    return { userId };
  }
  const clinicRecordId = key(input.clinicRecordId), profile = root.patientProfiles?.[clinicRecordId];
  if (!profile || profile.recordKind !== "clinic_only" || profile.deleted || profile.deletedAt) throw new ClinicalError("This clinic patient is unavailable.", 404);
  return { clinicRecordId };
}
function serviceCatalog(root) {
  return catalog(root).filter(row => row.status === "active" && row.active !== false && !row.deleted && !row.deletedAt && !/home[ _-]*service/i.test([row.service_id, row.service_name, row.department].join(" ")))
    .map(row => ({ id: row.service_id, name: row.service_name, department: String(row.department || ""), documentationMode: documentationMode(row) })).filter(row => row.name).sort((a,b) => a.name.localeCompare(b.name));
}
function visitServices(record) {
  return Array.isArray(record.services) && record.services.length ? record.services : [{ id: record.serviceId, name: record.serviceName, department: record.department || "", documentationMode: documentationMode(record) }];
}
function reportMonth(value) {
  const month = String(value || "");
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ClinicalError("Choose a valid report month.");
  return month;
}
const manilaMonthFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit" });
function manilaMonth(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const parts = Object.fromEntries(manilaMonthFormatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  return parts.year && parts.month ? parts.year + "-" + parts.month : "";
}
function reportText(value, fallback, limit) {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, limit) : "";
  return text || fallback;
}
function reportPatientName(root, record) {
  const profile = record.userId ? root.patientProfiles?.[record.userId] : root.patientProfiles?.[record.clinicRecordId];
  const user = record.userId ? root.users?.[record.userId] : null;
  for (const source of [profile, user]) {
    if (!source) continue;
    const name = [source.fullName, source.name, source.displayName].find(value => typeof value === "string" && value.trim()) ||
      [source.firstName, source.middleName, source.lastName].filter(value => typeof value === "string" && value.trim()).join(" ");
    const cleaned = reportText(name, "", 200);
    if (cleaned) return cleaned;
  }
  return "Patient name not recorded";
}
function visitHistoryReport(root, requestedMonth) {
  const month = reportMonth(requestedMonth), groups = new Map();
  for (const record of values(root.clinicalVisits)) {
    if (record.deletedAt || record.deleted === true) continue;
    const visitAt = [record.visitAt, record.createdAt].find(value => validTime(value));
    if (!visitAt || manilaMonth(visitAt) !== month) continue;
    const patientName = reportPatientName(root, record), added = new Set();
    for (const service of visitServices(record)) {
      const serviceName = reportText(service?.name, "Clinic service not recorded", 250);
      const key = serviceName.toLocaleLowerCase();
      if (added.has(key)) continue;
      added.add(key);
      if (!groups.has(key)) groups.set(key, { serviceName, entries: [] });
      groups.get(key).entries.push({ patientName, visitAt: validTime(visitAt) });
    }
  }
  const sorted = [...groups.values()].sort((left, right) => left.serviceName.localeCompare(right.serviceName, "en", { sensitivity: "base" }));
  for (const group of sorted) group.entries.sort((left, right) => left.visitAt.localeCompare(right.visitAt) || left.patientName.localeCompare(right.patientName, "en", { sensitivity: "base" }));
  return { month, groups: sorted, totalEntries: sorted.reduce((count, group) => count + group.entries.length, 0) };
}
function selectServices(root, ids, previous) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 30 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) throw new ClinicalError("Choose one or more different clinic services (up to 30).");
  const available = new Map(serviceCatalog(root).map(row => [row.id, row]));
  // Retain saved service snapshots if a service was later deactivated.
  const saved = new Map(previous ? visitServices(previous).map(row => [row.id, row]) : []);
  const services = ids.map(id => {
    const service = saved.get(id) || available.get(id);
    if (!service) throw new ClinicalError("A selected clinic service is no longer available. Refresh the service list.");
    return { ...service };
  });
  return { services, serviceId: services[0].id, serviceName: services.map(row => row.name).join(" + "),
    department: [...new Set(services.map(row => row.department).filter(Boolean))].join(", "),
    documentationMode: services.some(row => row.documentationMode !== "vitals_only") || Object.values(previous?.notes || {}).some(Boolean) ? "clinical_notes" : "vitals_only" };
}
function text(raw, limit, label) {
  if (typeof raw !== "string" || raw.length > limit) throw new ClinicalError(label + " must be text with no more than " + limit + " characters.");
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}
function exactObject(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(field => !allowed.includes(field))) throw new ClinicalError("The record contains an unsupported field.");
}
function clinicalPatch(input, mode) {
  const notes = {}, vitals = {};
  exactObject(input.notes, Object.keys(NOTES)); exactObject(input.vitals, Object.keys(VITALS));
  for (const field of Object.keys(NOTES)) notes[field] = text(input.notes[field] ?? "", 6000, NOTES[field]);
  if (mode === "vitals_only" && Object.values(notes).some(Boolean)) throw new ClinicalError("This service uses a vital-sign record. Clinical notes cannot be added to this visit.", 400, "CLINICAL_NOTES_NOT_ALLOWED");
  for (const field of Object.keys(VITALS)) vitals[field] = text(input.vitals[field] ?? "", 120, VITALS[field]);
  for (const field of ["height", "weight", "pulseRate", "respiratoryRate", "temperature"]) {
    if (vitals[field] && (!/^\d+(\.\d+)?$/.test(vitals[field]) || Number(vitals[field]) <= 0 || Number(vitals[field]) > 1000)) throw new ClinicalError("Check the measurement for " + VITALS[field] + ".");
  }
  if (vitals.bloodPressure && !/^\d{1,3}\s*\/\s*\d{1,3}$/.test(vitals.bloodPressure)) throw new ClinicalError("Enter blood pressure as two numbers, for example 120/80.");
  return { notes, vitals };
}
function audit(root, record, actor, action, now) {
  const id = "clinical-" + record.id + "-r" + record.revision;
  (root.auditLogs ||= {})[id] = { id, action, actorId: actor.uid, actorRole: actor.role, targetType: "clinicalVisits", targetId: record.id, timestamp: now, details: { revision: record.revision } };
}
function savedFormVitals(root, patient, now) {
  const matches = row => Boolean(row && (patient.userId ? row.userId === patient.userId && !row.clinicRecordId : patient.clinicRecordId && row.clinicRecordId === patient.clinicRecordId && !row.userId));
  const candidates = [];
  for (const [recordKey, form] of Object.entries(root.medicalRecords || {})) {
    if (!matches(form) || !(form.patientSubmitted === true || form.clinicEntered === true) || form.recordType !== "patient_medical_record" || form.deleted || form.deletedAt || !["smpe", "smape", "mape"].includes(form.examinationType || "smape")) continue;
    for (const version of [form, ...values(form.reviewHistory), ...values(form.revisionHistory)]) {
      if (!matches(version) || !(version.patientSubmitted === true || version.clinicEntered === true) || version.recordType !== "patient_medical_record" || version.deleted || version.deletedAt || !/^(approved|completed|reviewed)$/i.test(String(version.status || ""))) continue;
      const examinationType = version.examinationType || form.examinationType || "smape";
      if (!["smpe", "smape", "mape"].includes(examinationType)) continue;
      const dates = [version.lastEditedAt, version.reviewedAt, version.updatedAt].map(validTime).filter(Boolean).sort();
      if (!dates.length || Date.parse(dates.at(-1)) > now) continue; // Never invent dates or copy future measurements.
      candidates.push({ recordKey, version, examinationType: examinationType === "mape" ? "mape" : "smape", recordedAt: dates.at(-1) });
    }
  }
  candidates.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || (Number(b.version.revision) || 1) - (Number(a.version.revision) || 1) || a.recordKey.localeCompare(b.recordKey));
  const latest = candidates[0];
  if (!latest) return { vitals: {} };
  const vitals = {};
  for (const field of Object.keys(VITALS)) {
    const value = latest.version.physicalAssessment?.[field];
    if (typeof value !== "string" || !value.trim()) continue;
    try { vitals[field] = clinicalPatch({ notes: {}, vitals: { [field]: value } }).vitals[field]; }
    catch (error) { if (!(error instanceof ClinicalError)) throw error; }
  }
  // Do not fill missing/cleared values with measurements from a different form.
  if (!Object.keys(vitals).length) return { vitals: {} };
  return { vitals, vitalsSource: { recordKey: latest.recordKey, recordId: String(latest.version.medicalRecordId || latest.recordKey),
    examinationType: latest.examinationType, revision: Number.isSafeInteger(latest.version.revision) && latest.version.revision > 0 ? latest.version.revision : 1, recordedAt: latest.recordedAt } };
}
function checkExpectedVitalsSource(expected, source) {
  if (expected === undefined) return;
  if (expected !== null) exactObject(expected, ["recordKey", "revision", "recordedAt"]);
  const reference = value => value ? { recordKey: value.recordKey, revision: value.revision, recordedAt: value.recordedAt } : null;
  if (JSON.stringify(reference(expected)) !== JSON.stringify(reference(source))) throw new ClinicalError("The saved medical form changed. Reload and verify the vital signs before saving this visit.", 409, "CLINICAL_VITALS_CHANGED");
}
function createVisit(root, input, actor, now) {
  const staff = actorFor(root, actor);
  exactObject(input, ["id", "userId", "clinicRecordId", "serviceId", "serviceIds", "expectedVitalsSource"]);
  if (input.serviceId && input.serviceIds) throw new ClinicalError("Choose services using one selection list.");
  const id = key(input.id), patient = identity(root, input), selected = selectServices(root, input.serviceIds || [input.serviceId]);
  const existing = root.clinicalVisits?.[id];
  if (existing) {
    if (existing.deletedAt || existing.userId !== patient.userId || existing.clinicRecordId !== patient.clinicRecordId || JSON.stringify(visitServices(existing).map(row => row.id).sort()) !== JSON.stringify(selected.services.map(row => row.id).sort()) || existing.createdBy !== staff.uid) throw new ClinicalError("This request reference has already been used.", 409, "CLINICAL_CONFLICT");
    checkExpectedVitalsSource(input.expectedVitalsSource, existing.vitalsSource);
    return { record: existing, duplicate: true };
  }
  const copied = savedFormVitals(root, patient, now);
  checkExpectedVitalsSource(input.expectedVitalsSource, copied.vitalsSource);
  const timestamp = new Date(now).toISOString();
  const record = { id, ...patient, ...selected, attachments: [], status: "draft", revision: 1, visitAt: timestamp, createdAt: timestamp, createdBy: staff.uid, updatedAt: timestamp, updatedBy: staff.uid, ...copied, notes: {} };
  (root.clinicalVisits ||= {})[id] = record;
  audit(root, record, staff, "clinical_visit_created", timestamp);
  return { record, duplicate: false };
}
function visitForEditor(root, record, patient, now) {
  // Only suggest values for an untouched, empty draft. GET never changes the
  // stored visit, explicit saved blanks, manual measurements or released results.
  if (record.status !== 'draft' || (Number(record.revision) || 1) !== 1 || record.vitalsSource ||
      Object.values(record.vitals || {}).some(value => value !== null && value !== undefined && String(value).trim()) ||
      Object.values(record.notes || {}).some(value => value !== null && value !== undefined && String(value).trim())) return record;
  const saved = savedFormVitals(root, patient, now);
  return Object.keys(saved.vitals).length ? { ...record, ...saved } : record;
}
function updateVisit(root, id, input, actor, now, release = false) {
  id = key(id); const staff = actorFor(root, actor);
  exactObject(input, release ? ["expectedRevision"] : ["expectedRevision", "status", "notes", "vitals", "serviceIds", "attachmentIds"]);
  const record = root.clinicalVisits?.[id];
  if (!record || record.deletedAt) throw new ClinicalError("This visit is unavailable.", 404);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision >= Number.MAX_SAFE_INTEGER) throw new ClinicalError("This record needs a clinic administrator's review before another revision can be saved.", 409, "CLINICAL_STALE");
  if (release && !staff.canRelease) throw new ClinicalError("A doctor or designated clinical reviewer must release the result.", 403, "CLINICAL_REVIEWER_REQUIRED");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new ClinicalError("Open the latest record before saving.");
  // A retried release of the same reviewed version is safe and sends no duplicate notice.
  if (release && record.status === "released" && input.expectedRevision === record.revision - 1) return { record, duplicate: true };
  if (record.status === "released") throw new ClinicalError("Released records are read-only. Create a new visit for a subsequent encounter.", 409, "CLINICAL_RELEASED");
  if (record.revision !== input.expectedRevision) throw new ClinicalError("This record changed. Reopen it before saving.", 409, "CLINICAL_STALE");
  if (release && record.status !== "awaiting_review") throw new ClinicalError("Save and submit the result for clinical review first.", 409);
  if (!release && !["draft", "awaiting_review"].includes(input.status)) throw new ClinicalError("Choose Draft or Ready for review.");
  const servicePatch = !release && input.serviceIds ? selectServices(root, input.serviceIds, record) : {};
  const mode = servicePatch.documentationMode || documentationMode(record);
  const patch = release ? {} : clinicalPatch(input, mode);
  const savedAttachments = values(record.attachments);
  let attachments = savedAttachments;
  if (!release && input.attachmentIds !== undefined) {
    if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > MAX_FILES || new Set(input.attachmentIds).size !== input.attachmentIds.length || input.attachmentIds.some(id => !savedAttachments.some(file => file.id === id))) throw new ClinicalError("Select only files already attached to this visit.");
    attachments = savedAttachments.filter(file => input.attachmentIds.includes(file.id));
  }
  const selectedIds = (servicePatch.services || visitServices(record)).map(service => service.id);
  if (attachments.some(file => !selectedIds.includes(file.serviceId))) throw new ClinicalError("Remove the attachments for a service before removing that service.");
  if (release && !attachments.length && ![...Object.values(record.vitals || {}), ...Object.values(record.notes || {})].some(value => typeof value === "string" && value.trim())) throw new ClinicalError("Add vital signs, a clinical note, or a result file before sending this record.", 400, "CLINICAL_EMPTY_RECORD");
  // All five note fields are optional; reviewer permissions and revision gates still apply.
  const timestamp = new Date(now).toISOString();
  const next = { ...record, ...servicePatch, ...patch, attachments, documentationMode: mode, revision: record.revision + 1, status: release ? "released" : input.status, updatedAt: timestamp, updatedBy: staff.uid };
  if (release) Object.assign(next, { releasedAt: timestamp, releasedBy: staff.uid, reviewerName: staff.name });
  root.clinicalVisits[id] = next;
  // Audit revisions are private; released content is never overwritten.
  (root.clinicalVisitRevisions ||= {})[id + "_r" + record.revision] = record;
  audit(root, next, staff, release ? "clinical_result_released" : "clinical_visit_updated", timestamp);
  if (release && record.userId) {
    const noticeId = "clinical-release-" + id;
    (root.notifications ||= {})[noticeId] = { id: noticeId, userId: record.userId, title: "Medical record available", message: "The clinic released a medical record. Open Medical Records to view it.", referenceType: "clinicalVisits", referenceId: id, type: "clinical_result_released", source: "desktop", createdAt: timestamp, updatedAt: timestamp, timestamp, read: false, isRead: false };
  }
  return { record: next, duplicate: false };
}
function releasedHistory(records, uid) {
  return values(records).filter(row => !row.deletedAt && row.userId === uid && !row.clinicRecordId && row.status === "released" && validTime(row.releasedAt)).map(row => ({
    id: row.id, serviceName: row.serviceName, department: row.department, documentationMode: documentationMode(row), visitAt: row.visitAt, releasedAt: row.releasedAt, reviewerName: row.reviewerName,
    services: visitServices(row), attachments: values(row.attachments).map(fileMetadata),
    vitals: Object.fromEntries(Object.keys(VITALS).map(field => [field, String(row.vitals?.[field] || "")])),
    notes: Object.fromEntries(Object.keys(NOTES).map(field => [field, String(row.notes?.[field] || "")])),
  })).sort(newestVisit);
}
function attachFile(root, id, input, actor, now, storageBackend) {
  const staff = actorFor(root, actor), record = root.clinicalVisits?.[key(id)];
  if (!record || record.deletedAt) throw new ClinicalError("This visit is unavailable.", 404);
  exactObject(input, ["id", "expectedRevision", "serviceId", "name", "mime", "base64"]);
  const file = checkedFile(input), attachmentId = key(input.id);
  if (record.status === "released") throw new ClinicalError("Released records are read-only.", 409, "CLINICAL_RELEASED");
  const existing = root.clinicalVisitFiles?.[id]?.[attachmentId];
  if (existing) {
    if (existing.hash !== file.hash || existing.serviceId !== input.serviceId || existing.name !== file.name || existing.uploadedBy !== staff.uid || !values(record.attachments).some(row => row.id === attachmentId)) throw new ClinicalError("This attachment request was already used.", 409, "CLINICAL_CONFLICT");
    return { record, duplicate: true };
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || record.revision !== input.expectedRevision || record.revision >= Number.MAX_SAFE_INTEGER) throw new ClinicalError("This record changed. Reopen it before attaching a file.", 409, "CLINICAL_STALE");
  if (!visitServices(record).some(service => service.id === input.serviceId)) throw new ClinicalError("Choose a service on this visit for the attachment.");
  const attachments = values(record.attachments);
  if (attachments.length >= MAX_FILES || attachments.reduce((sum, row) => sum + row.size, 0) + file.size > MAX_TOTAL_BYTES) throw new ClinicalError("A visit supports up to 8 files and 8 MB in total.");
  const { base64, ...metadata } = file;
  const timestamp = new Date(now).toISOString(), stored = { ...metadata, objectPath: "clinical-results/" + id + "/" + attachmentId, id: attachmentId, serviceId: input.serviceId, uploadedAt: timestamp, uploadedBy: staff.uid };
  if (storageBackend !== undefined) {
    if (!["firestore", "storage"].includes(storageBackend)) throw new ClinicalError("Invalid private file storage.");
    stored.storageBackend = storageBackend;
  }
  ((root.clinicalVisitFiles ||= {})[id] ||= {})[attachmentId] = stored;
  const next = { ...record, attachments: [...attachments, fileMetadata(stored)], status: "draft", revision: record.revision + 1, updatedAt: timestamp, updatedBy: staff.uid };
  (root.clinicalVisitRevisions ||= {})[id + "_r" + record.revision] = record;
  root.clinicalVisits[id] = next; audit(root, next, staff, "clinical_file_attached", timestamp);
  return { record: next, duplicate: false };
}
function deleteVisit(root, id, input, actor, now) {
  const staff = actorFor(root, actor), record = root.clinicalVisits?.[key(id)];
  exactObject(input, ["expectedRevision"]);
  if (!record) throw new ClinicalError("This visit is unavailable.", 404);
  if (record.deletedAt) return { id, deleted: true };
  if (record.status === "released") throw new ClinicalError("Released medical records cannot be deleted.", 409, "CLINICAL_RELEASED");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || record.revision !== input.expectedRevision || record.revision >= Number.MAX_SAFE_INTEGER) throw new ClinicalError("This record changed. Reopen it before deleting.", 409, "CLINICAL_STALE");
  const timestamp = new Date(now).toISOString();
  (root.clinicalVisitRevisions ||= {})[id + "_r" + record.revision] = record;
  root.clinicalVisits[id] = { ...record, revision: record.revision + 1, deletedAt: timestamp, deletedBy: staff.uid };
  audit(root, root.clinicalVisits[id], staff, "clinical_draft_deleted", timestamp);
  return { id, deleted: true };
}
function readFile(root, id, fileId, actor, patient = false) {
  actorFor(root, actor, patient);
  const record = root.clinicalVisits?.[key(id)], file = root.clinicalVisitFiles?.[id]?.[key(fileId)];
  if (!record || record.deletedAt || !file || !values(record.attachments).some(row => row.id === fileId) || (patient && (record.userId !== actor.uid || record.clinicRecordId || record.status !== "released"))) throw new ClinicalError("This attachment is unavailable.", 404);
  return { attachment: fileMetadata(file) };
}
async function mutate(database, apply) {
  let result, rejection;
  const transaction = await transactionWithLiveSnapshot(database.ref(), current => {
    result = rejection = undefined;
    const root = JSON.parse(JSON.stringify(current || {}));
    try { result = apply(root); return root; } catch (error) { rejection = error; return undefined; }
  });
  if (rejection) throw rejection;
  if (!transaction.committed || !result) throw new ClinicalError("The record changed. Try again.", 409, "CLINICAL_CONFLICT");
  return result;
}
function registerClinicalRoutes(app, options) {
  const privateFiles = () => options.fileStore || privateFileStore(options.getFirebaseApp(), options.getFirestore);
  const now = options.now || Date.now;
  const wrap = work => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...await work(req) }); }
    catch (error) { const known = error instanceof ClinicalError || error instanceof ClinicalFileError; res.status(known ? error.status : 503).json({ ok: false, code: known ? error.code : "CLINICAL_UNAVAILABLE", error: known ? error.message : "Medical records are temporarily unavailable. Please try again." }); }
  };
  const staffAccess = req => { if (!req.staffAccess?.database || !req.staffAccess?.actor?.uid) throw new ClinicalError("Staff sign-in is required.", 401); return req.staffAccess; };
  app.get("/api/staff/clinical-records", wrap(async req => {
    const { database, actor } = staffAccess(req), root = (await database.ref().get()).val() || {};
    const staff = actorFor(root, actor), patient = identity(root, req.query);
    const records = values(root.clinicalVisits).filter(row => !row.deletedAt && (patient.userId ? row.userId === patient.userId && !row.clinicRecordId : row.clinicRecordId === patient.clinicRecordId && !row.userId)).sort(newestVisit);
    return { records: records.map(record => ({ ...visitForEditor(root, record, patient, now()), documentationMode: documentationMode(record) })), formVitals: savedFormVitals(root, patient, now()), services: serviceCatalog(root), canRelease: staff.canRelease };
  }));
  app.get("/api/staff/clinical-records/report", wrap(async req => {
    const { database, actor } = staffAccess(req), root = (await database.ref().get()).val() || {};
    actorFor(root, actor);
    return visitHistoryReport(root, req.query.month);
  }));
  app.post("/api/staff/clinical-records", wrap(async req => { const { database, actor } = staffAccess(req); return mutate(database, root => createVisit(root, req.body, actor, now())); }));
  app.put("/api/staff/clinical-records/:id", wrap(async req => { const { database, actor } = staffAccess(req); return mutate(database, root => updateVisit(root, req.params.id, req.body, actor, now())); }));
  app.post("/api/staff/clinical-records/:id/release", wrap(async req => { const { database, actor } = staffAccess(req); return mutate(database, root => updateVisit(root, req.params.id, req.body, actor, now(), true)); }));
  app.post("/api/staff/clinical-records/:id/attachments", wrap(async req => {
    const { database, actor } = staffAccess(req), id = key(req.params.id);
    const root = (await database.ref().get()).val() || {};
    // Validate role, revision, selected service and limits before storing bytes.
    const prepared = attachFile(root, id, req.body, actor, now());
    if (prepared.duplicate) return prepared;
    const file = root.clinicalVisitFiles[id][req.body.id];
    const location = await privateFiles().put({ ...file, base64: req.body.base64 });
    // Create-only private files are immutable. A racing metadata change
    // cannot overwrite bytes already linked by a different request.
    return mutate(database, current => attachFile(current, id, req.body, actor, now(), location?.storageBackend));
  }));
  app.post("/api/staff/clinical-records/:id/delete", wrap(async req => { const { database, actor } = staffAccess(req); return mutate(database, root => deleteVisit(root, req.params.id, req.body, actor, now())); }));
  app.get("/api/staff/clinical-records/:id/attachments/:fileId", wrap(async req => {
    const { database, actor } = staffAccess(req), root = (await database.ref().get()).val() || {};
    const result = readFile(root, req.params.id, req.params.fileId, actor);
    result.attachment.base64 = await privateFiles().read(root.clinicalVisitFiles[req.params.id][req.params.fileId]);
    return result;
  }));
  async function patientAccess(req) {
    const token = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) throw new ClinicalError("Sign in to view your medical records.", 401);
    const firebaseApp = options.getFirebaseApp();
    if (!firebaseApp) throw new ClinicalError("Medical records are temporarily unavailable.", 503);
    const getAuth = options.getAuth || require("firebase-admin/auth").getAuth;
    const getDatabase = options.getDatabase || require("firebase-admin/database").getDatabase;
    let decoded;
    try { decoded = await getAuth(firebaseApp).verifyIdToken(token, true); }
    catch { throw new ClinicalError("Your session expired. Sign in again.", 401); }
    key(decoded.uid);
    if (options.assertAuthenticatorAccess) {
      try { await options.assertAuthenticatorAccess(decoded); }
      catch (error) { if (error.status === 401) throw new ClinicalError("Sign in and complete your account security verification.", 401, "PATIENT_AUTHENTICATOR_REQUIRED"); throw error; }
    }
    const database = getDatabase(firebaseApp), user = (await database.ref("users/" + decoded.uid).get()).val();
    actorFor({ users: { [decoded.uid]: user } }, { uid: decoded.uid }, true);
    return { database, uid: decoded.uid };
  }
  app.get("/api/patient/clinical-records", wrap(async req => {
    const { database, uid } = await patientAccess(req);
    const records = (await database.ref("clinicalVisits").orderByChild("userId").equalTo(uid).get()).val();
    return { records: releasedHistory(records, uid) };
  }));
  app.get("/api/patient/clinical-records/:id/attachments/:fileId", wrap(async req => {
    const { database, uid } = await patientAccess(req), id = key(req.params.id), fileId = key(req.params.fileId);
    // Authorize the exact released visit before reading any attachment bytes.
    const record = (await database.ref("clinicalVisits/" + id).get()).val();
    if (!record || record.deletedAt || record.userId !== uid || record.clinicRecordId || record.status !== "released" || !values(record.attachments).some(file => file.id === fileId)) throw new ClinicalError("This attachment is unavailable.", 404);
    const file = (await database.ref("clinicalVisitFiles/" + id + "/" + fileId).get()).val();
    const result = readFile({ users: { [uid]: { role: "patient" } }, clinicalVisits: { [id]: record }, clinicalVisitFiles: { [id]: { [fileId]: file } } }, id, fileId, { uid }, true);
    result.attachment.base64 = await privateFiles().read(file);
    return result;
  }));
}
module.exports = { registerClinicalRoutes, admitApprovedPatient, patientIdentity: identity, firstApproval, ClinicalError, __test: { actorFor, firstApproval, identity, serviceCatalog, visitServices, selectServices, documentationMode, savedFormVitals, visitForEditor, createVisit, updateVisit, attachFile, deleteVisit, readFile, releasedHistory, mutate, VITALS, NOTES, ClinicalError } };
