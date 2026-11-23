"use strict";
const TYPES = Object.freeze({smape:{label:"SMAPE",title:"Student Medical & Physical Examination"},mape:{label:"MAPE",title:"Medical & Physical Examination"}});
function examinationType(record) {
  const raw = record?.examinationType;
  if (raw === undefined || raw === null || raw === "" || raw === "smpe") return "smape";
  return Object.hasOwn(TYPES, raw) ? raw : null;
}
function validateExaminationType(value) {
  const type = examinationType({examinationType:value});
  if (!type) { const error = new Error("Choose a valid medical examination form."); error.status=400; error.code="INVALID_EXAMINATION_TYPE"; throw error; }
  return type;
}
const commonPersonalFields=["lastName","firstName","middleName","sex","age","dateOfBirth","placeOfBirth","civilStatus","religion","emailAddress","contactNumber","relationship"];
function personalFields(type) {
  return commonPersonalFields.concat(type==="mape"?["presentAddress","requestedBy","lastMenstrualPeriod","companyOccupation","emergencyContactName","emergencyContactNumber"]:["school","guardianName","guardianContactNumber"]);
}
module.exports={TYPES,examinationType,validateExaminationType,personalFields};
