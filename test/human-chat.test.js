"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { verifySignature, normalizeEvent, applyEvent, registerHumanChatRoutes } = require("../src/human-chat");
const propertyId = "synthetic-property", secret = "synthetic-webhook-secret";
const payload = (event = "chat:start", extra = {}) => ({ event, chatId:"synthetic-chat", time:"2026-11-01T05:00:00Z", property:{id:propertyId}, visitor:{name:"Synthetic Visitor",email:"synthetic@example.test"}, message:{type:"msg",text:"I need clinic assistance",sender:{type:"visitor"}}, ...extra });
test("Tawk signatures cover exact raw bytes and reject unsigned, wrong-key and malformed requests", () => {
  const raw = Buffer.from(JSON.stringify(payload())), signature = crypto.createHmac("sha1", secret).update(raw).digest("hex");
  assert.equal(verifySignature(raw,signature,secret),true);
  for (const [body,sig,key] of [[Buffer.concat([raw,Buffer.from(' ')]),signature,secret],[raw,signature,'wrong'],[raw,'x'.repeat(40),secret],[raw,'',secret],[raw,signature,''],[{},signature,secret]]) assert.equal(verifySignature(body,sig,key),false);
});
test("duplicate starts and replay after marking read do not create or reset staff notifications", () => {
  const root = {}, event = normalizeEvent(payload(),propertyId);
  applyEvent(root,event); assert.equal(Object.keys(root.notifications).length,1);
  const notice = Object.values(root.notifications)[0]; notice.isRead = true;
  applyEvent(root,event); assert.equal(Object.keys(root.notifications).length,1); assert.equal(notice.isRead,true);
  assert.equal(root.humanChatMessages[event.id].length,1);
  assert.equal(notice.referenceId,event.id); assert.equal(notice.targetRole,'staff'); assert.equal(notice.userId,'desktop-staff');
});
test("completed transcripts merge safely and delayed start cannot reopen a completed conversation", () => {
  const root = {}, start = normalizeEvent(payload(),propertyId); applyEvent(root,start);
  const event = normalizeEvent(payload('chat:transcript_created',{time:'2026-11-01T05:05:00Z',chat:{id:'synthetic-chat',visitor:{name:'Synthetic Visitor',email:'synthetic@example.test'},messages:[{sender:{t:'v'},type:'msg',msg:'I need clinic assistance',time:'2026-11-01T05:00:00Z'},{sender:{t:'a',n:'Synthetic Staff'},type:'msg',msg:'We can help.',time:'2026-11-01T05:01:00Z'}]}}),propertyId);
  applyEvent(root,event); applyEvent(root,event); applyEvent(root,start);
  const row = root.humanChats[start.id]; assert.equal(row.status,'ended'); assert.equal(root.humanChatMessages[start.id].length,2); assert.equal(row.transcriptSaved,true); assert.equal(row.visitorEmail,'synthetic@example.test');
  applyEvent(root,{...start,at:event.at}); assert.equal(root.humanChats[start.id].status,'ended','An equal-time delayed start cannot reopen a terminal chat');
});
test("untrusted property and malformed events are rejected; transcripts redact secret values and omit attachments", () => {
  assert.throws(()=>normalizeEvent(payload(), 'other-property'));
  assert.throws(()=>normalizeEvent(payload('fake'),propertyId));
  const event = normalizeEvent(payload('chat:transcript_created',{chat:{id:'synthetic-chat',messages:[{type:'file',msg:'private file',attchs:[{url:'https://untrusted.test/file'}]},{type:'msg',msg:'My PIN: 123456',sender:{t:'v'}}]}}),propertyId);
  assert.equal(event.messages.length,1); assert.doesNotMatch(JSON.stringify(event),/123456|untrusted\.test|private file/);
});
function routes() {
  const handlers = new Map(); let root = {}, calls = 0;
  const ref = path => ({ on(_type, fn) { fn(); },off() {}, async transaction(fn) { root = fn(root); return {committed:true}; },orderByChild(){return this;},limitToLast(){return this;},async get(){calls++;return {val:()=>path === 'humanChats' ? root.humanChats : path ? root.humanChats?.[path.split('/')[1]] : root};} });
  registerHumanChatRoutes({post(path,fn){handlers.set('POST '+path,fn);},get(path,fn){handlers.set('GET '+path,fn);}}, {propertyId,webhookSecret:secret,identityKey:'synthetic-identity-key',getFirebaseApp:()=>({}),getDatabase:()=>({ref})});
  const invoke = async (path, req = {}) => { const res = {code:200,set(){return this;},status(value){this.code=value;return this;},json(value){this.body=value;return this;}}; await handlers.get(path)({headers:{},...req},res);return res; };
  return {invoke,root:()=>root,calls:()=>calls};
}
test("webhook persists signed events and staff endpoints reject patient/anonymous access", async () => {
  const f = routes(), body = payload(), rawBody = Buffer.from(JSON.stringify(body)), signature = crypto.createHmac('sha1',secret).update(rawBody).digest('hex');
  assert.equal((await f.invoke('POST /api/support/tawk/webhook',{body,rawBody,headers:{'x-tawk-signature':signature}})).code,200);
  assert.equal(Object.keys(f.root().humanChats).length,1);
  assert.equal((await f.invoke('GET /api/staff/human-chats')).code,403); assert.equal(f.calls(),0);
  const result = await f.invoke('GET /api/staff/human-chats',{staffAccess:{actor:{uid:'staff'}}});
  assert.equal(result.code,200); assert.equal(result.body.conversations.length,1); assert.equal(result.body.conversations[0].messages,undefined);
  assert.equal((await f.invoke('GET /api/staff/human-chats/:id',{staffAccess:{actor:{uid:'staff'}},params:{id:'../patient'}})).code,400);
});
test("website identity accepts explicit contact consent but never a caller-selected patient userId", async () => {
  const f = routes();
  assert.equal((await f.invoke('POST /api/support/guest-identity',{body:{name:'Synthetic',email:'synthetic@example.test',consent:false}})).code,400);
  const first = await f.invoke('POST /api/support/guest-identity',{body:{name:'Synthetic',email:'synthetic@example.test',consent:true,userId:'existing-patient'}});
  const second = await f.invoke('POST /api/support/guest-identity',{body:{name:'Synthetic',email:'synthetic@example.test',consent:true,userId:first.body.userId}});
  assert.match(first.body.userId,/^website_guest_[a-f0-9]{48}$/); assert.notEqual(first.body.userId,second.body.userId);
  assert.equal(first.body.hash,crypto.createHmac('sha256','synthetic-identity-key').update(first.body.userId).digest('hex'));
  assert.equal(first.body.email,'synthetic@example.test'); assert.equal(f.calls(),0);
});
