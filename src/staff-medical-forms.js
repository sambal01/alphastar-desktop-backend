"use strict";

// Staff-only form authoring. Mobile submissions and the legacy vital-sign
// correction endpoint retain their existing, narrower permissions.
const { TYPES, personalFields, examinationType } = require("./examination-types");
const { examinationPhoto } = require("./examination-photo");
const { admitApprovedPatient, patientIdentity, firstApproval, ClinicalError } = require("./clinical-records");
const clinical = { identity: patientIdentity, firstApproval, ClinicalError };
const smpe = () => require("./smpe-routes").staffFormSupport;
const HISTORY = ["frequentSevereHeadache", "dizzinessFaintingSpell", "eyeVisionTrouble", "noseEarThroatProblem", "allergySkinDisease", "tuberculosis", "asthmaLungDisease", "heartDiseaseHeartAttack", "highLowBloodPressure", "stomachLiverIntestinalDisease", "kidneyBladderDisease", "hernia", "diabetesMellitus", "otherEndocrineDisease", "typhoidParatyphoidFever", "hepatitisInfectiousDisease", "sexuallyTransmittedDisease", "cancerTumor", "neurologicDisorders", "mentalDisorderDepressionAnxiety", "arthritisRheumatismFracture", "previousInjuries", "previousOperations", "previousHospitalization", "delayedMenstruation", "otherMedicalCondition"];
const VITALS = ["height", "weight", "bloodPressure", "pulseRate", "respiratoryRate", "temperature", "remarks"];
const object = value => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function invalid(message, status = 400, code = "SMPE_INVALID") { throw new (smpe().SmpeError)(message, status, code); }
function exact(input, fields) { if (!object(input) || Object.keys(input).some(key => !fields.includes(key))) invalid("The form contains unsupported fields."); }
function text(value, limit) {
  if (typeof value !== "string" || value.length > limit) invalid("A form field is invalid or too long.");
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}
function actor(root, user) {
  const editor = smpe().savedActor(root, user);
  if (!["admin", "staff", "doctor"].includes(editor.role)) invalid("Only authorized clinic personnel can manage patient forms.", 403, "SMPE_FORBIDDEN");
  return editor;
}
function sections(input, type, now) {
  const fields = { personalBackground: [...personalFields(type), "presentAddress"], medicalHistory: HISTORY, medicalHistoryDetails: HISTORY, physicalAssessment: VITALS };
  const result = {};
  for (const [section, allowed] of Object.entries(fields)) {
    exact(input[section], allowed); result[section] = {};
    for (const [key, value] of Object.entries(input[section])) {
      result[section][key] = text(value, section === "medicalHistoryDetails" ? 2000 : section === "physicalAssessment" ? 120 : 500);
      if (section === "medicalHistory" && !["", "yes", "no"].includes(result[section][key])) invalid("Choose Yes or No for medical history answers.");
    }
  }
  const p = result.personalBackground;
  if (!p.firstName || !p.lastName) invalid("Enter the patient's first and last name.");
  if (p.age && (!/^\d{1,3}$/.test(p.age) || +p.age < 1 || +p.age > 120)) invalid("Enter an age from 1 to 120.");
  if (p.dateOfBirth) {
    const date = new Date(p.dateOfBirth + "T00:00:00Z");
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== p.dateOfBirth || p.dateOfBirth > `${parts.year}-${parts.month}-${parts.day}`) invalid("Enter a valid date of birth that is not in the future.");
  }
  if (p.sex && !["Female", "Male", "Intersex", "Other", "Prefer not to say"].includes(p.sex)) invalid("Choose a valid sex.");
  if (p.emailAddress && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(p.emailAddress)) invalid("Enter a valid email address or leave it blank.");
  for (const key of VITALS.filter(key => !["remarks", "bloodPressure"].includes(key))) {
    const value = result.physicalAssessment[key];
    if (value && (!/^\d+(\.\d+)?$/.test(value) || +value <= 0 || +value > 1000)) invalid("Check the measurement for " + key + ".");
  }
  if (result.physicalAssessment.bloodPressure && !/^\d{1,3}\s*\/\s*\d{1,3}$/.test(result.physicalAssessment.bloodPressure)) invalid("Enter blood pressure as two numbers, for example 120/80.");
  try { if (input.patientPhoto !== undefined) result.patientPhoto = examinationPhoto(input.patientPhoto); }
  catch (error) { invalid(error.message); }
  return result;
}
function recordKey(key) { if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,180}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) invalid("Invalid form reference."); return key; }
function current(root, key, input) {
  recordKey(key); const record = root.medicalRecords?.[key];
  if (!smpe().isSmpe(record)) invalid("This medical form is no longer available.", 404, "SMPE_NOT_FOUND");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || typeof input.expectedSubmittedAt !== "string") invalid("Open the current form before saving.");
  if (smpe().revision(record) !== input.expectedRevision || smpe().submittedAt(record) !== input.expectedSubmittedAt || smpe().revision(record) >= Number.MAX_SAFE_INTEGER) invalid("This form changed. Open the latest form and try again.", 409, "SMPE_STALE");
  return record;
}
function updateProfile(root, record, editor, now) {
  const p = record.personalBackground, id = record.userId || record.clinicRecordId;
  if (record.userId) record.firstApprovedAt = admitApprovedPatient(root, record.userId, record.id, now).firstApprovedAt;
  const profile = root.patientProfiles?.[id];
  if (!profile) return;
  Object.assign(profile, { fullName: [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ").slice(0, 160), updatedAt: new Date(now).toISOString(), updatedBy: editor.uid });
  for (const [field, source] of [["birthDate", "dateOfBirth"], ["gender", "sex"], ["address", "presentAddress"]]) if (Object.hasOwn(p, source)) profile[field] = p[source];
  if (Object.hasOwn(p, "contactNumber")) Object.assign(profile, { phone: p.contactNumber, contactNumber: p.contactNumber, contactPhone: p.contactNumber, mobileNumber: p.contactNumber });
  if (record.clinicRecordId && Object.hasOwn(p, "emailAddress")) profile.email = p.emailAddress;
}
function log(root, record, editor, action, now) {
  const id = "staff-form-" + record.id + "-r" + record.revision;
  (root.auditLogs ||= {})[id] = { id, action, actorId: editor.uid, actorRole: editor.role, targetId: record.id, targetType: "medicalRecords", source: "desktop", timestamp: now, details: { revision: record.revision } };
  if (record.userId) {
    const deleted = action === "medical_form_deleted";
    (root.notifications ||= {})[id] = { id, userId: record.userId, referenceId: record.id, referenceType: "medicalRecords", examinationType: examinationType(record), source: "desktop", type: deleted ? "medical_record_deleted" : "medical_record_updated", title: deleted ? "Medical form removed" : "Medical form updated", message: deleted ? "The clinic removed your previous form. You can submit a new Medical Form from the Form tab." : "The clinic updated your medical form. Open Medical Form History or contact clinic staff for details.", createdAt: now, timestamp: now, read: false, isRead: false };
  }
}
function create(root, key, input, user, now) {
  const editor = actor(root, user); recordKey(key);
  if (!/^form_[a-f0-9]{32}$/.test(key)) invalid("Invalid new form reference.");
  const followUp = Object.hasOwn(input || {}, 'sourceFormKey');
  exact(input, followUp ? ["userId", "clinicRecordId", "sourceFormKey", "expectedSourceRevision", "expectedSourceSubmittedAt", "physicalAssessment"] : ["userId", "clinicRecordId", "examinationType", "personalBackground", "medicalHistory", "medicalHistoryDetails", "physicalAssessment", "patientPhoto", "reason"]);
  const patient = clinical.identity(root, input), existing = root.medicalRecords?.[key];
  const source = followUp ? current(root, input.sourceFormKey, { expectedRevision: input.expectedSourceRevision, expectedSubmittedAt: input.expectedSourceSubmittedAt }) : null;
  if (source && (patient.userId ? source.userId !== patient.userId || source.clinicRecordId : source.clinicRecordId !== patient.clinicRecordId || source.userId)) invalid("Choose a saved form belonging to this patient.", 403, "SMPE_FORBIDDEN");
  const type = source ? examinationType(source) : input.examinationType;
  if (!["smape", "mape"].includes(type)) invalid("Choose Student or Non-student.");
  const values = sections(source ? { personalBackground: source.personalBackground || {}, medicalHistory: source.medicalHistory || {}, medicalHistoryDetails: source.medicalHistoryDetails || {}, physicalAssessment: input.physicalAssessment, ...(source.patientPhoto ? { patientPhoto: source.patientPhoto } : {}) } : input, type, now);
  if (source?.schoolIdPhoto && type === "smape") values.schoolIdPhoto = source.schoolIdPhoto;
  if (followUp && !VITALS.some(field => field !== 'remarks' && values.physicalAssessment[field])) invalid("Enter at least one vital sign for the new form.");
  if (input.reason !== undefined) text(input.reason, 500);
  if (existing) {
    if (existing.createdBy === editor.uid && !existing.deleted && !existing.deletedAt && existing.examinationType === type && existing.userId === patient.userId && existing.clinicRecordId === patient.clinicRecordId && Object.entries(values).every(([field, value]) => JSON.stringify(existing[field]) === JSON.stringify(value))) return { record: { ...existing, recordKey: key }, unchanged: true };
    invalid("This save reference is already in use. Open the saved form before changing it.", 409, "SMPE_CONFLICT");
  }
  const timestamp = new Date(now).toISOString();
  const record = { id: key, ...patient, ...values, examinationType: type, title: TYPES[type].title, medicalRecordId: TYPES[type].label + "-" + key.slice(5, 17).toUpperCase(), recordType: "patient_medical_record", clinicEntered: true, patientSubmitted: Boolean(patient.userId), source: "desktop", status: "Approved", revision: 1, createdBy: editor.uid, createdAt: timestamp, submittedAt: timestamp, updatedAt: timestamp, reviewedAt: timestamp, reviewedBy: editor.uid, reviewerName: editor.name,
    ...(source ? { copiedFrom: { recordKey: input.sourceFormKey, revision: smpe().revision(source), submittedAt: smpe().submittedAt(source) } } : {}) };
  record.reviewHistory = [smpe().snapshot(record)];
  (root.medicalRecords ||= {})[key] = record;
  updateProfile(root, record, editor, now); log(root, record, editor, "medical_form_created", timestamp);
  return { record: { ...record, recordKey: key }, unchanged: false };
}
function update(root, key, input, user, now) {
  const editor = actor(root, user);
  exact(input, ["expectedRevision", "expectedSubmittedAt", "reason", "personalBackground", "medicalHistory", "medicalHistoryDetails", "physicalAssessment", "patientPhoto"]);
  const record = current(root, key, input), values = sections(input, examinationType(record), now), reason = input.reason === undefined ? '' : text(input.reason, 500);
  // Validate the saved target, never a caller-supplied patient identity.
  if (record.clinicRecordId) clinical.identity(root, record);
  else if (!root.users?.[record.userId] || root.users[record.userId].deleted || root.users[record.userId].deletedAt || String(root.users[record.userId].role).toLowerCase() !== 'patient') invalid('The patient account is unavailable.', 404, 'SMPE_NOT_FOUND');
  if (Object.entries(values).every(([field, value]) => JSON.stringify(record[field]) === JSON.stringify(value))) return { record: { ...record, recordKey: key }, unchanged: true };
  const timestamp = new Date(now).toISOString();
  const next = { ...record, ...values, revision: smpe().revision(record) + 1, updatedAt: timestamp, lastEditedAt: timestamp, lastEditedBy: editor.uid, lastEditorName: editor.name, lastEditReason: reason, revisionHistory: [...Object.values(record.revisionHistory || {}), smpe().snapshot(record)] };
  if (smpe().finished(record)) {
    const history = [...Object.values(record.reviewHistory || {})]; smpe().keepCompleted(history, record); smpe().keepCompleted(history, next); next.reviewHistory = history;
    if (/^(approved|completed|reviewed)$/i.test(String(record.status))) updateProfile(root, next, editor, now);
  }
  root.medicalRecords[key] = next; log(root, next, editor, "medical_form_updated", timestamp);
  return { record: { ...next, recordKey: key }, unchanged: false };
}
function remove(root, key, input, user, now) {
  const editor = actor(root, user); exact(input, ["expectedRevision", "expectedSubmittedAt", "confirm"]);
  if (input.confirm !== true) invalid("Confirm deletion before removing this form.");
  const record = current(root, key, input), timestamp = new Date(now).toISOString();
  if (record.userId && /^(approved|completed|reviewed)$/i.test(String(record.status))) {
    const at = clinical.firstApproval(root, record.userId);
    if (at) {
      record.firstApprovedAt = at;
      if (root.patientProfiles?.[record.userId]) root.patientProfiles[record.userId].firstApprovedAt = at;
      (root.patientAdmissions ||= {})[record.userId] ||= { userId: record.userId, firstApprovedAt: at };
    }
  }
  const next = { ...record, revision: smpe().revision(record) + 1, deleted: true, deletedAt: timestamp, deletedBy: editor.uid, updatedAt: timestamp, revisionHistory: [...Object.values(record.revisionHistory || {}), smpe().snapshot(record)] };
  root.medicalRecords[key] = next; log(root, next, editor, "medical_form_deleted", timestamp);
  return { record: { ...next, recordKey: key } };
}
function register(app, options = {}) {
  for (const [method, suffix, apply] of [["put", "", create], ["patch", "/form", update], ["delete", "/form", remove]]) app[method]?.("/api/staff/medical-records/:recordId" + suffix, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.staffAccess?.database || !req.staffAccess.actor?.uid) invalid("Staff sign-in is required.", 401, "SMPE_UNAUTHORIZED");
      const now = (options.now || Date.now)();
      const result = await require("./smpe-routes").mutateSmpe(req.staffAccess.database, root => apply(root, req.params.recordId, req.body, req.staffAccess.actor, now));
      res.json({ ok: true, ...result });
    } catch (error) {
      const known = error instanceof smpe().SmpeError || error instanceof clinical.ClinicalError;
      res.status(known ? error.status : 503).json({ ok: false, code: known ? error.code : "SMPE_UNAVAILABLE", error: known ? error.message : "The form could not be saved. Keep it open and try again." });
    }
  });
}
module.exports = { register, create, update, remove, sections };
