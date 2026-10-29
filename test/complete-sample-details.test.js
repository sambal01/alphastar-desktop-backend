"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const { SAMPLE_MEDICINES } = require('../scripts/seed-sample-medicines');
const { VERSION, SAMPLE_DETAILS, fillMissingSampleDetails, completeSamples } = require('../scripts/complete-sample-medicine-details');
const NOW=Date.parse('2026-10-25T08:00:00Z');
const samples=()=>Object.fromEntries(SAMPLE_MEDICINES.map(row=>[row.id,{...row}]));
test('sample completion fills all five missing prices and dates but never changes stock or demo labels',()=>{
  const original=samples(); original['MED-REAL']={name:'Existing medicine',stock:23}; const snapshot=structuredClone(original);
  const plan=fillMissingSampleDetails(original,NOW); assert.equal(plan.updated.length,5); assert.deepEqual(original,snapshot);
  assert.deepEqual(plan.inventory['MED-REAL'],snapshot['MED-REAL']);
  for(const sample of SAMPLE_MEDICINES){
    const row=plan.inventory[sample.id]; assert.equal(row.stock,sample.stock);assert.equal(row.name,sample.name);assert.equal(row.sampleData,true);
    assert.equal(row.expiry,'2027-12-31');assert.ok(row.cost>0&&row.price>row.cost);assert.equal(row.sampleDetailsVersion,VERSION);
    assert.match(row.sampleDetailsNote,/Fictional/);assert.match(row.location,/not for patient use/);
    assert.deepEqual(plan.updated.find(p=>p.id===sample.id).fields,['cost','price','expiry']);
  }
});
test('completion preserves custom values, zero reorder and dispensed stock; reruns never reset later edits',()=>{
  const original=samples(); Object.assign(original['SAMPLE-MED-001'],{stock:0,reorder:0,cost:7.5,price:10,expiry:'2029-01-15',location:'Edited demo shelf'});
  const first=fillMissingSampleDetails(original,NOW);assert.equal(first.updated.length,4);assert.deepEqual(first.inventory['SAMPLE-MED-001'],original['SAMPLE-MED-001']);
  Object.assign(first.inventory['SAMPLE-MED-002'],{price:0,stock:73,expiry:''});
  const retry=fillMissingSampleDetails(first.inventory,NOW+1000);assert.equal(retry.updated.length,0);assert.deepEqual(retry.inventory,first.inventory);
});
test('unsafe or missing sample identities and invalid stock abort the whole completion without writes',()=>{
  for(const patch of [rows=>delete rows['SAMPLE-MED-003'], rows=>rows['SAMPLE-MED-003'].sampleData=false, rows=>rows['SAMPLE-MED-003'].sampleSeed='other', rows=>rows['SAMPLE-MED-003'].id='real',rows=>rows['SAMPLE-MED-003'].stock=-1]){
    const rows=samples();patch(rows);const snapshot=structuredClone(rows);assert.throws(()=>fillMissingSampleDetails(rows,NOW));assert.deepEqual(rows,snapshot);
  }
  for(const value of [null,[],4,'invalid'])assert.throws(()=>fillMissingSampleDetails(value,NOW));
});
function fixture(){
  const state={root:{inventory:{...samples(),'MED-REAL':{name:'Real existing record',stock:25}},users:{private:{role:'patient'}}},writes:[],listeners:0};
  const database={ref:path=>{
    const get=()=>path.split('/').reduce((value,key)=>value?.[key],state.root)??null;
    return{get:async()=>({val:()=>structuredClone(get())}),on(_event,listener){state.listeners++;listener();},off(){state.listeners--;},async transaction(update){
      const next=update(structuredClone(get()));if(next===undefined)return{committed:false};const parts=path.split('/'),key=parts.pop();let target=state.root;for(const part of parts)target=target[part]||={};target[key]=structuredClone(next);state.writes.push(path);return{committed:true};
    }};
  }};return{state,database};
}
test('completion dry run never writes; apply is inventory-scoped, audited once and idempotent',async()=>{
  const {state,database}=fixture(),users=structuredClone(state.root.users),other=structuredClone(state.root.inventory['MED-REAL']);
  const dry=await completeSamples(database,{now:NOW});assert.equal(dry.updated.length,5);assert.deepEqual(state.writes,[]);
  const result=await completeSamples(database,{apply:true,now:NOW});assert.equal(result.sampleRecordsVerified,5);assert.deepEqual(state.writes,['inventory','auditLogs/'+VERSION]);
  assert.deepEqual(state.root.users,users);assert.deepEqual(state.root.inventory['MED-REAL'],other);
  const audit=structuredClone(state.root.auditLogs);state.root.inventory['SAMPLE-MED-001'].stock=93;state.root.inventory['SAMPLE-MED-001'].price=0;
  const retry=await completeSamples(database,{apply:true,now:NOW+1000});assert.equal(retry.updated.length,0);assert.equal(state.root.inventory['SAMPLE-MED-001'].price,0);assert.equal(state.root.inventory['SAMPLE-MED-001'].stock,93);
  assert.deepEqual(state.root.auditLogs,audit);assert.equal(state.writes.length,2);assert.equal(state.listeners,0);
});
test('completed sample definitions prefill every existing medicine form field without inventing new records',()=>{
  const plan=fillMissingSampleDetails(samples(),NOW);
  for(const row of Object.values(plan.inventory))for(const field of ['name','generic','category','stock','unit','reorder','cost','price','supplier','expiry','location'])assert.ok(row[field]!==undefined&&row[field]!==null&&String(row[field])!=='',field);
  assert.equal(Object.keys(SAMPLE_DETAILS).length,5);
});
