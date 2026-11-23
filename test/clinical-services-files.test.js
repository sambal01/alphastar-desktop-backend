"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const {__test:c,registerClinicalRoutes}=require("../src/clinical-records");
const {checkedFile,ClinicalFileError}=require("../src/clinical-files");
const NOW=Date.parse("2026-11-18T01:00:00Z");
test("upload route stores private bytes before metadata, preserves the draft on storage failure, and rechecks permissions at commit",async()=>{
 const root=visit(),handlers=new Map();let puts=0,fail=true,revoke=false;
 const db={ref(path=""){return {
  async get(){return{val:()=>structuredClone(path?path.split("/").reduce((value,key)=>value?.[key],root):root)}},
  on(_event,listener){listener({val:()=>structuredClone(root)})},off(){},
  async transaction(update){const next=update(structuredClone(root));if(next===undefined)return{committed:false};for(const key of Object.keys(root))delete root[key];Object.assign(root,next);return{committed:true};}
 }}};
 registerClinicalRoutes(Object.fromEntries(["get","post","put"].map(method=>[method,(path,handler)=>handlers.set(method+" "+path,handler)])),{getFirebaseApp:()=>({}),fileStore:{async put(file){puts++;assert.equal(file.objectPath,"clinical-results/visit/file");assert.equal(file.base64,image);if(fail)throw Error("Synthetic private storage failure");if(revoke)root.users.staff.disabled=true;}}});
 async function request(actor="staff",body=upload()){let status=200,response;const res={set(){return res},status(value){status=value;return res},json(value){response=value}};
  await handlers.get("post /api/staff/clinical-records/:id/attachments")({params:{id:"visit"},body,staffAccess:{database:db,actor:{uid:actor}}},res);return{status,body:response};}
 const before=structuredClone(root);
 assert.equal((await request("patient")).status,403);assert.equal(puts,0);
 assert.equal((await request()).status,503);assert.deepEqual(root,before);assert.equal(root.clinicalVisitFiles,undefined);
 fail=false;assert.equal((await request()).status,200);assert.equal(root.clinicalVisits.visit.revision,2);
 assert.equal(root.clinicalVisitFiles.visit.file.base64,undefined);assert.equal(puts,2);
 assert.equal((await request()).body.duplicate,true);assert.equal(puts,2);
 const second=visit();for(const key of Object.keys(root))delete root[key];Object.assign(root,second);revoke=true;
 assert.equal((await request()).status,403);assert.equal(root.clinicalVisits.visit.revision,1);assert.equal(root.clinicalVisitFiles,undefined);
});
const image="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD3sAAAAASUVORK5CYII=";
const pdf=Buffer.from("%PDF-1.7\nSynthetic test document only.\n%%EOF\n").toString("base64");
test("a local vital-sign preview cannot silently acquire a different form-source reference on first save or retry",()=>{
 const root=fixture(),form={userId:"patient",patientSubmitted:true,recordType:"patient_medical_record",examinationType:"mape",status:"Approved",revision:1,reviewedAt:"2026-11-01T00:00:00Z",physicalAssessment:{weight:"60"}};
 root.medicalRecords={original:form};
 const source=c.savedFormVitals(root,{userId:"patient"},NOW).vitalsSource;
 const input={id:"preview",userId:"patient",serviceIds:["check"],expectedVitalsSource:{recordedAt:source.recordedAt,revision:source.revision,recordKey:source.recordKey}};
 form.revision=2;form.updatedAt="2026-11-02T00:00:00Z";form.physicalAssessment.weight="65";
 assert.throws(()=>c.createVisit(root,input,{uid:"staff"},NOW),e=>e.code==="CLINICAL_VITALS_CHANGED");assert.equal(root.clinicalVisits,undefined);
 const latest=c.savedFormVitals(root,{userId:"patient"},NOW).vitalsSource;input.expectedVitalsSource={recordKey:latest.recordKey,revision:latest.revision,recordedAt:latest.recordedAt};
 const created=c.createVisit(root,input,{uid:"staff"},NOW).record;assert.equal(created.vitals.weight,"65");
 form.revision=3;form.updatedAt="2026-11-03T00:00:00Z";form.physicalAssessment.weight="70";
 assert.equal(c.createVisit(root,input,{uid:"staff"},NOW).duplicate,true);
 assert.throws(()=>c.createVisit(root,{...input,expectedVitalsSource:null},{uid:"staff"},NOW),e=>e.code==="CLINICAL_VITALS_CHANGED");
});
function fixture() {
  return {users:{patient:{role:"patient"},other:{role:"patient"},staff:{role:"staff"},doctor:{role:"doctor",name:"Synthetic Doctor"}},
    patientAdmissions:{patient:{firstApprovedAt:"2026-11-01T00:00:00Z"},other:{firstApprovedAt:"2026-11-01T00:00:00Z"}},
    services:{check:{status:"active",service_name:"Consultation"},xray:{status:"active",service_name:"Digital X-Ray"},ecg:{status:"active",service_name:"ECG"},off:{status:"inactive",service_name:"Unavailable"}}};
}
function visit() { const root=fixture(); c.createVisit(root,{id:"visit",userId:"patient",serviceIds:["check","xray"]},{uid:"staff"},NOW);return root; }
const upload=(id="file",serviceId="xray",revision=1)=>({id,expectedRevision:revision,serviceId,name:"Result.png",mime:"image/png",base64:image});
const patch=(revision,extra={})=>({expectedRevision:revision,status:"draft",notes:{},vitals:{},...extra});
test("multiple server-named services create one private visit; retries do not duplicate it",()=>{
 const root=visit(),record=root.clinicalVisits.visit,before=structuredClone(root);
 assert.deepEqual(record.services.map(s=>s.id),["check","xray"]);assert.equal(record.serviceName,"Consultation + Digital X-Ray");
 assert.equal(record.documentationMode,"clinical_notes");assert.equal(record.status,"draft");
 assert.equal(c.createVisit(root,{id:"visit",userId:"patient",serviceIds:["xray","check"]},{uid:"staff"},NOW).duplicate,true);assert.deepEqual(root,before);
 for(const serviceIds of [[],["check","check"],["off"],["missing"],["check",{}]])assert.throws(()=>c.createVisit(root,{id:"bad",userId:"patient",serviceIds},{uid:"staff"},NOW));
 assert.throws(()=>c.createVisit(root,{id:"bad",userId:"patient",serviceIds:["check"]},{uid:"patient"},NOW),e=>e.status===403);
 c.updateVisit(root,"visit",patch(1,{serviceIds:["check","xray","ecg"]}),{uid:"staff"},NOW);
 root.services.xray.status="inactive";
 const saved=c.updateVisit(root,"visit",patch(2,{serviceIds:["xray","ecg"]}),{uid:"staff"},NOW).record;
 assert.equal(saved.documentationMode,"vitals_only");assert.equal(saved.services[0].name,"Digital X-Ray");
 assert.deepEqual(c.releasedHistory(root.clinicalVisits,"patient"),[]);
});
test("result files are service-linked metadata only; approved release exposes only own files and no private storage paths",()=>{
 const root=visit();const result=c.attachFile(root,"visit",upload(),{uid:"staff"},NOW);
 assert.equal(result.record.revision,2);assert.equal(result.record.status,"draft");
 assert.equal(result.record.attachments[0].serviceId,"xray");
 assert.equal(root.clinicalVisitFiles.visit.file.base64,undefined);assert.equal(root.clinicalVisitFiles.visit.file.objectPath,"clinical-results/visit/file");
 const before=structuredClone(root);assert.equal(c.attachFile(root,"visit",upload(),{uid:"staff"},NOW).duplicate,true);assert.deepEqual(root,before);
 assert.throws(()=>c.readFile(root,"visit","file",{uid:"patient"},true),e=>e.status===404);
 assert.throws(()=>c.attachFile(root,"visit",{...upload(),name:"Changed.png"},{uid:"staff"},NOW),e=>e.status===409);
 c.updateVisit(root,"visit",patch(2,{status:"awaiting_review"}),{uid:"staff"},NOW);
 assert.throws(()=>c.updateVisit(root,"visit",{expectedRevision:3},{uid:"staff"},NOW,true),e=>e.status===403);
 c.updateVisit(root,"visit",{expectedRevision:3},{uid:"doctor"},NOW,true);
 const released=c.releasedHistory(root.clinicalVisits,"patient");assert.equal(released.length,1);assert.equal(released[0].attachments[0].name,"Result.png");assert.equal(released[0].services.length,2);
 assert.doesNotMatch(JSON.stringify(released),/base64|objectPath|uploadedBy|hash/);
 assert.equal(c.readFile(root,"visit","file",{uid:"patient"},true).attachment.name,"Result.png");
 assert.throws(()=>c.readFile(root,"visit","file",{uid:"other"},true),e=>e.status===404);
 assert.throws(()=>c.attachFile(root,"visit",upload("later","xray",4),{uid:"staff"},NOW),e=>e.code==="CLINICAL_RELEASED");
 assert.throws(()=>c.deleteVisit(root,"visit",{expectedRevision:4},{uid:"doctor"},NOW),e=>e.code==="CLINICAL_RELEASED");
});
test("removing services/files is revision-checked, retains private history, and soft-deleting a draft never resurrects it",()=>{
 const root=visit();c.attachFile(root,"visit",upload(),{uid:"staff"},NOW);
 const before=structuredClone(root);
 assert.throws(()=>c.updateVisit(root,"visit",patch(2,{serviceIds:["check"]}),{uid:"staff"},NOW));assert.deepEqual(root,before);
 c.updateVisit(root,"visit",patch(2,{serviceIds:["check"],attachmentIds:[]}),{uid:"staff"},NOW);
 assert.equal(root.clinicalVisits.visit.attachments.length,0);assert.ok(root.clinicalVisitFiles.visit.file);
 assert.ok(root.clinicalVisitRevisions.visit_r2.attachments.length);
 assert.throws(()=>c.readFile(root,"visit","file",{uid:"staff"}),e=>e.status===404);
 assert.throws(()=>c.attachFile(root,"visit",upload(),{uid:"staff"},NOW),e=>e.status===409);
 assert.throws(()=>c.deleteVisit(root,"visit",{expectedRevision:1},{uid:"staff"},NOW),e=>e.code==="CLINICAL_STALE");
 c.deleteVisit(root,"visit",{expectedRevision:3},{uid:"staff"},NOW);assert.ok(root.clinicalVisits.visit.deletedAt);
 assert.equal(c.deleteVisit(root,"visit",{expectedRevision:3},{uid:"staff"},NOW).deleted,true);
 assert.throws(()=>c.updateVisit(root,"visit",patch(4),{uid:"staff"},NOW),e=>e.status===404);
 assert.throws(()=>c.createVisit(root,{id:"visit",userId:"patient",serviceIds:["check"]},{uid:"staff"},NOW),e=>e.status===409);
 assert.deepEqual(c.releasedHistory(root.clinicalVisits,"patient"),[]);
});
test("file validation rejects spoofed types, oversized payloads, unsafe names and excessive image dimensions",()=>{
 assert.equal(checkedFile(upload()).mime,"image/png");assert.equal(checkedFile({...upload(),name:"Result.pdf",mime:"application/pdf",base64:pdf}).mime,"application/pdf");
 for(const changed of [{mime:"text/html"},{name:"../patient.png"},{base64:"a".repeat(2800000)},{base64:"AAAA"},{base64:pdf},{mime:"image/jpeg"},{base64:image+"="}]){
  assert.throws(()=>checkedFile({...upload(),...changed}),e=>e instanceof ClinicalFileError);
 }
 const bytes=Buffer.from(image,"base64");bytes.writeUInt32BE(6001,16);
 assert.throws(()=>checkedFile({...upload(),base64:bytes.toString("base64")}));
 const root=visit();
 for(let n=1;n<=8;n++)c.attachFile(root,"visit",upload("file"+n,"xray",n),{uid:"staff"},NOW);
 assert.throws(()=>c.attachFile(root,"visit",upload("file9","xray",9),{uid:"staff"},NOW));
});
test("patient attachment routes authenticate, verify MFA and ownership before reading private bytes",async()=>{
 const root=visit();c.attachFile(root,"visit",upload(),{uid:"staff"},NOW);c.updateVisit(root,"visit",patch(2,{status:"awaiting_review"}),{uid:"staff"},NOW);c.updateVisit(root,"visit",{expectedRevision:3},{uid:"doctor"},NOW,true);
 const handlers=new Map(),reads=[],storedReads=[];
 const db={ref(path=""){return {async get(){reads.push(path);return{val:()=>structuredClone(path?path.split("/").reduce((value,key)=>value?.[key],root):root)}}}}};
 registerClinicalRoutes({get:(p,h)=>handlers.set(p,h),post(){},put(){}},{getFirebaseApp:()=>({}),getDatabase:()=>db,getAuth:()=>({verifyIdToken:async token=>{if(token==="bad")throw Error("Rejected");return{uid:token}}}),assertAuthenticatorAccess:async decoded=>{if(decoded.uid==="mfa")throw Object.assign(Error("Required"),{status:401})},fileStore:{read:async file=>{storedReads.push(file.objectPath);return image}}});
 async function request(token,params={id:"visit",fileId:"file"}){let status=200,body;const res={set:(k,v)=>{assert.equal(v,"no-store");return res},status:s=>{status=s;return res},json:value=>{body=value}};await handlers.get("/api/patient/clinical-records/:id/attachments/:fileId")({headers:token?{authorization:"Bearer "+token}:{},params},res);return{status,body};}
 for(const [token,status]of [["",401],["bad",401],["mfa",401],["other",404],["staff",403]])assert.equal((await request(token)).status,status);
 assert.equal(storedReads.length,0);
 assert.equal((await request("patient",{id:"visit",fileId:"missing"})).status,404);assert.equal(storedReads.length,0);
 const own=await request("patient");assert.equal(own.status,200);assert.equal(own.body.attachment.base64,image);assert.equal(storedReads.length,1);
 assert.doesNotMatch(JSON.stringify(own),/objectPath|uploadedBy|hash/);
 root.users.patient.disabled=true;assert.equal((await request("patient")).status,403);assert.equal(storedReads.length,1);
});
test("private Storage uses create-only generations and hash verification, never public URLs or RTDB file bytes",async()=>{
 const module={exports:{}},objects=new Map(),calls=[];
 vm.runInNewContext(fs.readFileSync(require.resolve("../src/clinical-files"),"utf8"),{module,exports:module.exports,Buffer,process:{env:{}},require(name){
  if(name==="node:crypto")return require(name);
  if(name==="firebase-admin/storage")return{getStorage:()=>({bucket:()=>({file:path=>({
   async save(bytes,options){calls.push(options);if(objects.has(path))throw Object.assign(Error("Exists"),{code:412});objects.set(path,{bytes,metadata:options.metadata});},
   async getMetadata(){return[objects.get(path).metadata]},async download(){return[objects.get(path).bytes]},
  })})})};
  throw Error(name);
 }});
 const store=module.exports.firebaseFileStore({options:{projectId:"synthetic"}}),file={...checkedFile(upload()),objectPath:"clinical-results/visit/file",uploadedBy:"staff",serviceId:"xray"};
 await store.put(file);await store.put(file);assert.equal(calls[0].preconditionOpts.ifGenerationMatch,0);assert.equal(calls[0].metadata.cacheControl,"private, no-store");assert.equal(calls[0].public,undefined);assert.equal(await store.read(file),image);
 await assert.rejects(store.put({...file,name:"Different.png"}));await assert.rejects(store.read({...file,hash:"invalid"}));
});
