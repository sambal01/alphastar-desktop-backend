"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {submitSmpe,__test:{approveSmpe,updateSmpe}}=require("../src/smpe-routes");
const {examinationType,validateExaminationType,personalFields}=require("../src/examination-types");
const now=Date.parse("2026-11-03T03:00:00Z");
const root=()=>({users:{patient:{role:"patient"},other:{role:"patient"},staff:{role:"staff",name:"Synthetic Reviewer"}}});
const payload=type=>({examinationType:type,personalBackground:type==="mape"?{firstName:"Synthetic",companyOccupation:"Synthetic company",emergencyContactName:"Synthetic contact",relationship:"Sibling",emergencyContactNumber:"09123456789"}:{firstName:"Synthetic",school:"Synthetic school",guardianName:"Synthetic guardian"},medicalHistory:{tuberculosis:"no"},medicalHistoryDetails:{},physicalAssessment:{height:"170"}});
const submit=(db,type,key=type)=>submitSmpe(db,payload(type),{uid:"patient"},{recordKey:key,medicalRecordId:type.toUpperCase()+"-SYNTHETIC"},now);
const expected=record=>({expectedRevision:record.revision,expectedSubmittedAt:record.submittedAt});
test("legacy records remain SMAPE; supported type validation does not silently coerce unknown kinds",()=>{
 assert.equal(examinationType({}),"smape");assert.equal(validateExaminationType("smpe"),"smape");assert.equal(validateExaminationType("mape"),"mape");
 for(const value of ["unknown",{},[],42,"MAPE","__proto__"])assert.throws(()=>validateExaminationType(value));
 assert.ok(personalFields("mape").includes("companyOccupation"));assert.ok(!personalFields("mape").includes("school"));
 assert.ok(personalFields("mape").includes("emergencyContactName"));assert.ok(!personalFields("mape").includes("guardianName"));
});
test("both form types save independent IDs, fields and owner/staff notices without medical answers",()=>{
 const db=root();const student=submit(db,"smape"),general=submit(db,"mape");
 assert.equal(student.record.examinationType,"smape");assert.equal(general.record.examinationType,"mape");
 assert.equal(general.record.title,"Medical & Physical Examination");assert.equal(student.record.personalBackground.school,"Synthetic school");
 assert.equal(general.record.personalBackground.companyOccupation,"Synthetic company");assert.equal(general.record.status,"Pending Review");
 for(const saved of [student,general]){
  assert.equal(saved.notification.userId,"patient");assert.equal(saved.staffNotification.userId,"desktop-staff");
  assert.ok(saved.staffNotification.title.includes(saved.record.examinationType.toUpperCase()));
  assert.ok(saved.staffNotification.message.includes(saved.record.examinationType.toUpperCase()+" Approval"));
  assert.ok(!JSON.stringify(saved.staffNotification).includes("Synthetic company"));
 }
});
test("approval, clinic corrections and resubmission preserve MAPE type, full history and owning patient",()=>{
 const db=root();submit(db,"mape");
 const edited=updateSmpe(db,"mape",{...expected(db.medicalRecords.mape),physicalAssessment:{height:"171"}},{uid:"staff"},now+1000);
 assert.equal(edited.record.examinationType,"mape");assert.equal(edited.record.revisionHistory[0].examinationType,"mape");
 const approved=approveSmpe(db,"mape",expected(edited.record),{uid:"staff"},now+2000);
 assert.equal(approved.record.status,"Approved");assert.equal(approved.record.reviewHistory[0].examinationType,"mape");
 assert.equal(approved.notification.title,"MAPE approved");assert.equal(approved.notification.userId,"patient");
 const revised=submitSmpe(db,payload("mape"),{uid:"patient"},{recordKey:"mape",editing:true},now+3000);
 assert.equal(revised.record.status,"Pending Review");assert.equal(revised.record.reviewHistory.length,1);
 assert.equal(revised.record.reviewHistory[0].personalBackground.companyOccupation,"Synthetic company");
 assert.equal(revised.record.reviewHistory[0].physicalAssessment.height,"171");
});
test("changing type or ownership on edit fails before a new version or notification can be stored",()=>{
 const db=root();submit(db,"smape");submit(db,"mape");
 const before=JSON.stringify(db);
 assert.throws(()=>submitSmpe(db,payload("mape"),{uid:"patient"},{recordKey:"smape",editing:true},now+1),error=>error.code==="EXAMINATION_TYPE_MISMATCH");
 assert.throws(()=>submitSmpe(db,payload("smape"),{uid:"patient"},{recordKey:"mape",editing:true},now+1),error=>error.code==="EXAMINATION_TYPE_MISMATCH");
 assert.throws(()=>submitSmpe(db,payload("mape"),{uid:"other"},{recordKey:"mape",editing:true},now+1));
 assert.throws(()=>approveSmpe(db,"mape",expected(db.medicalRecords.mape),{uid:"patient"},now+1));
 assert.equal(JSON.stringify(db),before);
});
test("editing a legacy SMPE record retains its identifier and completed history while adopting the SMAPE label",()=>{
 const db=root();submit(db,"smape","legacy");delete db.medicalRecords.legacy.examinationType;db.medicalRecords.legacy.medicalRecordId="SMPE-LEGACY";
 approveSmpe(db,"legacy",expected(db.medicalRecords.legacy),{uid:"staff"},now+1);
 const revised=submitSmpe(db,payload("smape"),{uid:"patient"},{recordKey:"legacy",editing:true},now+2);
 assert.equal(revised.record.medicalRecordId,"SMPE-LEGACY");assert.equal(revised.record.examinationType,"smape");
 assert.equal(examinationType(revised.record.reviewHistory[0]),"smape");assert.equal(revised.record.reviewHistory.length,1);
});
