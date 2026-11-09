"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {readNativeChat}=require("../src/native-chat");
const {registerHumanChatRoutes}=require("../src/human-chat");
function fixture(){
  let now=Date.parse("2026-11-02T02:00:00Z");
  const root={users:{"patient-a":{role:"patient",fullName:"Synthetic Patient A",email:"a@example.test"},"patient-b":{role:"patient",fullName:"Synthetic Patient B",email:"b@example.test"}}},handlers=new Map(),queries=[];
  const value=path=>path?path.split("/").reduce((row,key)=>row?.[key],root):root;
  const set=(path,row)=>{const keys=path.split("/"),last=keys.pop();let target=root;for(const key of keys)target=target[key]||= {};target[last]=structuredClone(row);};
  const snap=row=>({val:()=>row==null?null:structuredClone(row)});
  function ref(path=""){
    let order="",limit,before;
    return {on(_event,callback){callback(snap(value(path)));},off(){},
      async transaction(fn){const next=fn(value(path)==null?null:structuredClone(value(path)));if(next!==undefined)set(path,next);return {committed:next!==undefined,snapshot:snap(value(path))};},
      async update(patch){for(const [key,row]of Object.entries(patch))set(path?path+"/"+key:key,row);},
      orderByChild(key){order=key;return this;},limitToLast(count){limit=count;return this;},endBefore(time,key){before=[time,key];return this;},
      async get(){let row=value(path);if(order){queries.push({path,order,limit});let rows=Object.values(row||{}).sort((a,b)=>a[order].localeCompare(b[order])||a.id.localeCompare(b.id));if(before)rows=rows.filter(r=>r[order]<before[0]||r[order]===before[0]&&r.id<before[1]);if(limit)rows=rows.slice(-limit);row=Object.fromEntries(rows.map(r=>[r.id,r]));}return snap(row);}
    };
  }
  const db={ref};
  registerHumanChatRoutes({post(path,handler){handlers.set("POST "+path,handler);},get(path,handler){handlers.set("GET "+path,handler);}},{
    now:()=>now,getFirebaseApp:()=>({}),getDatabase:()=>db,getAuth:()=>({async verifyIdToken(token,revoked){assert.equal(revoked,true);if(!root.users[token])throw Error("expired");return {uid:token,email:root.users[token].email};}}),
  });
  async function invoke(method,path,req={}){const res={code:200,set(){return this;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handlers.get(method+" "+path)({headers:{},params:{},query:{},ip:"synthetic-ip",...req},res);return res;}
  const openGuest=()=>invoke("POST","/api/support/chats",{body:{name:"Synthetic Visitor",email:"guest@example.test",consent:true}});
  const guest=(id,token,body)=>({params:{id},headers:{"x-alphastar-chat-token":token},...(body?{body}:{})});
  const patient=(uid,extra={})=>({headers:{authorization:"Bearer "+uid},...extra});
  return {root,db,queries,handlers,invoke,openGuest,guest,patient,advance:ms=>{now+=ms;}};
}

const staff = (id, uid = "staff-a", body = {}, role = "staff") => ({ params: { id }, staffAccess: { actor: { uid, role } }, body });
async function requestGuest(f, opened) { return f.invoke("POST", "/api/support/chats/:id/request", f.guest(opened.id, opened.token, { cycle: 1 })); }
async function connect(f, id, identity = "anonymous", uid = "staff-a") { return f.invoke("POST", "/api/staff/human-chats/:id/connect", staff(id, uid, { cycle: 1, identity })); }

test("guest consent, welcome, capability ownership and private metadata", async () => {
 const f=fixture();
 assert.equal((await f.invoke("POST","/api/support/chats",{body:{name:"Synthetic",email:"guest@example.test",consent:false}})).code,400);
 const first=(await f.openGuest()).body,second=(await f.openGuest()).body;
 assert.notEqual(first.id,second.id); assert.notEqual(first.token,second.token);
 assert.equal(first.conversation.status,"welcome");
 assert.equal(first.conversation.messages[0].sender,"system");
 assert.match(first.conversation.messages[0].text,/Welcome to AlphaStar/);
 assert.equal(Object.keys(f.root.notifications||{}).length,0);
 assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest(first.id,second.token))).code,401);
 assert.doesNotMatch(JSON.stringify(first.conversation),/_outbox|_accepted|_readBy|tokenHash|_connection|_patientUid/);
 f.advance(25*3600000);assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest(first.id,first.token))).code,401);
});

test("request is idempotent, notifies staff and records the named visitor and System acknowledgement",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body;
 const [a,b]=await Promise.all([requestGuest(f,opened),requestGuest(f,opened)]);
 assert.equal(a.code,200);assert.equal(b.code,200);
 assert.equal(a.body.conversation.status,"waiting");
 const messages=a.body.conversation.messages;
 assert.deepEqual(messages.map(row=>row.sender),["system","visitor","system"]);
 assert.equal(messages[1].name,"Synthetic Visitor");
 assert.match(messages[2].text,/24 hours or longer/);
 assert.equal(Object.keys(f.root.notifications).length,1);
 const notice=Object.values(f.root.notifications)[0];
 assert.deepEqual(notice.targetRoles,["admin","staff"]);assert.equal(notice.referenceId,opened.id);
});

test("connection requires a choice, claims atomically, uses verified first name, and hides real anonymous identity",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body,{id,token}=opened;
 f.root.users["staff-a"]={role:"staff",name:"Saved Real Name"};
 f.root.staff={"staff-a":{name:"Synthetic Assistant"}};
 assert.equal((await connect(f,id)).code,409);
 await requestGuest(f,opened);
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/connect",staff(id))).code,400);
 const [a,b]=await Promise.all([connect(f,id,"first_name"),connect(f,id,"anonymous","staff-b")]);
 assert.deepEqual([a.code,b.code].sort(),[200,409]);
 assert.equal(a.body.conversation.connectedName,"Synthetic"); assert.equal(a.body.conversation.canReply,true);
 const reply=await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-a",{cycle:1,text:"Synthetic answer",clientId:"a".repeat(32),name:"Forged",staffRole:"admin"}));
 assert.equal(reply.code,200);assert.equal(reply.body.message.name,"Synthetic");assert.equal(reply.body.message.staffRole,"staff");
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-b",{cycle:1,text:"Other staff",clientId:"b".repeat(32)}))).code,403);
 const data=(await f.invoke("GET","/api/support/chats/:id",f.guest(id,token))).body.conversation;
 assert.doesNotMatch(JSON.stringify(data),/Saved Real|Synthetic Assistant|staff-a|staff-b|Forged|_connection|_outbox/);
 const anon=(await f.openGuest()).body;await requestGuest(f,anon);await connect(f,anon.id);
 const anonymous=(await f.invoke("GET","/api/support/chats/:id",f.guest(anon.id,anon.token))).body.conversation;
 assert.equal(anonymous.connectedName,"Support assistant");assert.doesNotMatch(JSON.stringify(anonymous),/Synthetic Assistant|Saved Real|staff-a/);
});

test("messages are idempotent, new messages alone increase unread, and reads are per staff",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body,{id,token}=opened;await requestGuest(f,opened);await connect(f,id);
 const body={cycle:1,text:"Synthetic question",clientId:"a".repeat(32)},req=f.guest(id,token,body);
 const [a,b]=await Promise.all([f.invoke("POST","/api/support/chats/:id/messages",req),f.invoke("POST","/api/support/chats/:id/messages",req)]);
 assert.equal(a.code,200);assert.equal(a.body.message.id,b.body.message.id);
 assert.equal(f.root.humanChats[id].visitorSequence,2);
 const lifecycle=require("../src/native-chat-lifecycle");
 assert.equal(lifecycle.publicSummary(f.root.humanChats[id],{uid:"staff-a"}).unread,true);
 await f.invoke("POST","/api/staff/human-chats/:id/read",staff(id,"staff-a",{sequence:2}));
 assert.equal(lifecycle.publicSummary(f.root.humanChats[id],{uid:"staff-a"}).unread,false);
 assert.equal(lifecycle.publicSummary(f.root.humanChats[id],{uid:"staff-b"}).unread,true);
 await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-a",{cycle:1,text:"Synthetic answer",clientId:"c".repeat(32)}));
 assert.equal(f.root.humanChats[id].visitorSequence,2);
 assert.equal(lifecycle.publicSummary(f.root.humanChats[id],{uid:"staff-a"}).unread,false);
 await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,{cycle:1,text:"Changed",clientId:"a".repeat(32)})).then(r=>assert.equal(r.code,409));
 await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,{cycle:1,text:"Another question",clientId:"b".repeat(32)}));
 await f.invoke("POST","/api/staff/human-chats/:id/read",staff(id,"staff-a",{sequence:2}));
 assert.equal(lifecycle.publicSummary(f.root.humanChats[id],{uid:"staff-a"}).unread,true);
});

test("end saves feedback, history is read-only, new website visits never recover someone else's thread",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body,{id,token}=opened;await requestGuest(f,opened);await connect(f,id);
 assert.equal((await f.invoke("POST","/api/support/chats/:id/end",f.guest(id,token,{cycle:1,rating:"invalid"}))).code,400);
 const endBody={cycle:1,rating:"up",comment:"Synthetic helpful reply"};
 const ended=await f.invoke("POST","/api/support/chats/:id/end",f.guest(id,token,endBody));assert.equal(ended.code,200);assert.equal(ended.body.conversation.status,"ended");
 assert.equal((await f.invoke("POST","/api/support/chats/:id/end",f.guest(id,token,endBody))).code,200);
 assert.equal((await requestGuest(f,opened)).code,409);
 assert.equal((await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,{cycle:1,text:"Too late",clientId:"d".repeat(32)}))).code,409);
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-a",{cycle:1,text:"Too late",clientId:"e".repeat(32)}))).code,403);
 assert.doesNotMatch(JSON.stringify(ended.body.conversation),/Synthetic helpful reply/);
 const authorized=require("../src/native-chat-lifecycle").publicSummary(f.root.humanChats[id],{uid:"staff-a"});
 assert.equal(authorized.feedback.rating,"up");assert.equal(authorized.feedback.comment,endBody.comment);
 assert.notEqual((await f.openGuest()).body.id,id);
});

test("website exit and lost heartbeats end the chat; a delayed heartbeat cannot resurrect it",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body;await requestGuest(f,opened);
 f.advance(60000);assert.equal((await f.invoke("POST","/api/support/chats/:id/heartbeat",f.guest(opened.id,opened.token,{cycle:1}))).code,200);
 f.advance(60000);assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest(opened.id,opened.token))).body.conversation.status,"waiting");
 f.advance(91000);assert.equal((await f.invoke("POST","/api/support/chats/:id/heartbeat",f.guest(opened.id,opened.token,{cycle:1}))).code,200);
 assert.equal(f.root.humanChats[opened.id].status,"ended");
 const next=(await f.openGuest()).body;await requestGuest(f,next);
 assert.equal((await f.invoke("POST","/api/support/chats/:id/exit",{params:{id:next.id},body:JSON.stringify({cycle:1,token:next.token})})).code,200);
 assert.equal(f.root.humanChats[next.id].status,"ended");
 assert.equal((await f.invoke("POST","/api/support/chats/:id/exit",{params:{id:next.id},body:{cycle:1,token:opened.token}})).code,401);
});

test("mobile persists on exit, enforces its owner and MFA, and can continue an ended conversation in a new cycle",async()=>{
 const f=fixture(),opened=await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-a")),id=opened.body.id;
 assert.equal((await f.invoke("GET","/api/patient-support/chats/:id",f.patient("patient-b",{params:{id}}))).code,404);
 await f.invoke("POST","/api/patient-support/chats/:id/request",f.patient("patient-a",{params:{id},body:{cycle:1}}));
 await connect(f,id);
 await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-a",{cycle:1,text:"Patient update",clientId:"a".repeat(32)}));
 assert.ok(Object.values(f.root.notifications).some(n=>n.userId==="patient-a"&&n.referenceId===id));
 f.advance(24*3600000);
 const saved=await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-a"));assert.equal(saved.body.id,id);assert.equal(saved.body.conversation.status,"connected");
 await f.invoke("POST","/api/patient-support/chats/:id/end",f.patient("patient-a",{params:{id},body:{cycle:1,rating:"down",comment:"Synthetic"}}));
 const resumed=await f.invoke("POST","/api/patient-support/chats/:id/request",f.patient("patient-a",{params:{id},body:{cycle:1}}));assert.equal(resumed.code,200);assert.equal(resumed.body.conversation.cycle,2);assert.equal(resumed.body.conversation.status,"waiting");
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-a",{cycle:1,text:"Stale reply",clientId:"b".repeat(32)}))).code,409);
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-a",{cycle:2,text:"Not connected",clientId:"b".repeat(32)}))).code,403);
 const newConnection=await f.invoke("POST","/api/staff/human-chats/:id/connect",staff(id,"staff-a",{cycle:2,identity:"account"}));assert.equal(newConnection.code,200);assert.equal(newConnection.body.conversation.connectedIdentity,"account");
 f.root.patientAuthenticator={"patient-a":{version:1,enabled:true,revision:"a".repeat(64),provider:"password"}};
 assert.equal((await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-a"))).code,401);
 f.root.users["patient-b"].active=false;assert.equal((await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-b"))).code,403);
});

test("message/end races cannot accept a new event after the end; idempotent earlier sends remain recoverable",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body,{id,token}=opened;await requestGuest(f,opened);await connect(f,id);
 const body={cycle:1,text:"Accepted before end",clientId:"a".repeat(32)};
 const accepted=await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,body));
 await f.invoke("POST","/api/support/chats/:id/end",f.guest(id,token,{cycle:1,rating:"up"}));
 assert.equal((await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,body))).body.message.id,accepted.body.message.id);
 const results=await Promise.all(Array.from({length:5},(_,i)=>f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,{cycle:1,text:"Late "+i,clientId:String(i).repeat(32)}))));
 assert.ok(results.every(r=>r.code===409));
 assert.equal(f.root.humanChats[id].status,"ended");
});

test("failed outbox delivery is retried without duplicate transcript entries or notifications",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body,id=opened.id,original=f.db.ref;
 let failed=false;
 f.db.ref=path=>{const ref=original(path);if(path?.startsWith("notifications/")&&!failed){ref.transaction=async()=>{failed=true;throw Error("Synthetic interruption");};}return ref;};
 const first=await requestGuest(f,opened);assert.equal(first.code,503);
 const retried=await requestGuest(f,opened);assert.equal(retried.code,200);
 assert.equal(retried.body.conversation.messages.filter(m=>m.sender==="visitor").length,1);
 assert.equal(Object.keys(f.root.notifications).length,1);
 assert.equal(Object.keys(f.root.humanChats[id]._outbox||{}).length,0);
});

test("all transcript pages are retained with bounded indexed queries",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body,id=opened.id;
 f.root.nativeChatMessages[id]={};
 for(let i=0;i<205;i++){const key=i.toString(16).padStart(64,"0");f.root.nativeChatMessages[id][key]={id:key,time:new Date(Date.parse("2026-11-01T00:00:00Z")+i*1000).toISOString(),text:"Synthetic "+i,sender:"visitor",name:""};}
 const latest=await readNativeChat(f.db,id),earlier=await readNativeChat(f.db,id,latest.before),first=await readNativeChat(f.db,id,earlier.before);
 assert.equal(latest.messages.length,100);assert.equal(earlier.messages.length,100);assert.equal(first.messages.length,5);assert.equal(first.before,"");
 assert.equal(new Set([...latest.messages,...earlier.messages,...first.messages].map(row=>row.id)).size,205);
 assert.ok(f.queries.every(q=>q.limit===101&&q.order==="time"));
});

test("invalid ids, missing auth, oversized text, and unauthenticated staff are rejected",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body,{id,token}=opened;
 assert.equal((await f.invoke("POST","/api/patient-support/chats/open")).code,401);
 assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest("../users",token))).code,400);
 for(const text of ["","x".repeat(2001)])assert.equal((await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,{cycle:1,text,clientId:"a".repeat(32)}))).code,400);
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/connect",{params:{id},body:{identity:"anonymous",cycle:1}})).code,403);
});


test("staff inbox pages preserve all ended chats, keep private fields server-only and reject malformed cursors", async()=>{
 const f=fixture(),actor={actor:{uid:"staff-a",role:"staff"}};
 for(let i=0;i<125;i++){
   const id=i.toString(16).padStart(64,"0"),at=new Date(Date.parse("2026-11-01T00:00:00Z")+i*1000).toISOString();
   f.root.humanChats||={};f.root.humanChats[id]={id,provider:"alphastar",lifecycleVersion:2,status:"ended",cycle:1,visitorName:"Synthetic "+i,requestedAt:at,updatedAt:at,_connection:{uid:"private-staff-uid"},_readBy:{"staff-a":2},visitorSequence:2,_feedback:{1:{rating:"up",comment:"Synthetic feedback"}}};
 }
 const page=before=>f.invoke("GET","/api/staff/human-chats",{staffAccess:actor,query:before?{before}:{}});
 const one=await page(),two=await page(one.body.before),three=await page(two.body.before);
 assert.equal(one.code,200);assert.equal(one.body.conversations.length,50);assert.equal(two.body.conversations.length,50);assert.equal(three.body.conversations.length,25);
 assert.equal(new Set([...one.body.conversations,...two.body.conversations,...three.body.conversations].map(row=>row.id)).size,125);
 assert.doesNotMatch(JSON.stringify(one.body),/private-staff-uid|_connection|_readBy|_feedback|_accepted/);
 assert.equal((await page("bad")).code,400);
 assert.equal((await f.invoke("GET","/api/staff/human-chats")).code,403);
 assert.ok(f.queries.every(q=>q.order==="updatedAt"&&q.limit===50));
});

test("a real text/plain exit POST is parsed without JSON middleware and ends the authenticated guest only",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body;await requestGuest(f,opened);
 const express=require("express"),app=express();app.use(express.json());
 app.post("/api/support/chats/:id/exit",f.handlers.get("POST /api/support/chats/:id/exit"));
 const server=await new Promise(resolve=>{const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));});
 try{
   const response=await fetch("http://127.0.0.1:"+server.address().port+"/api/support/chats/"+opened.id+"/exit",{method:"POST",headers:{"Content-Type":"text/plain;charset=UTF-8"},body:JSON.stringify({token:opened.token,cycle:1})});
   assert.equal(response.status,200);assert.equal(f.root.humanChats[opened.id].status,"ended");
 }finally{await new Promise(resolve=>server.close(resolve));}
});


test("earlier no-cycle clients keep first-session messaging without fabricated visitor consent or double retries",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body,{id,token}=opened;
 const body={text:"Earlier client question",clientId:"a".repeat(32)};
 const sent=await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,body));
 assert.equal(sent.code,200);assert.equal(f.root.humanChats[id].status,"waiting");
 const rows=Object.values(f.root.nativeChatMessages[id]);
 assert.equal(rows.filter(m=>m.sender==="visitor").length,1);
 assert.equal(rows.find(m=>m.sender==="visitor").text,body.text);
 assert.equal(f.root.humanChats[id].visitorSequence,1);
 assert.equal(Object.keys(f.root.notifications).length,1);
 const reply=await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-a",{text:"Earlier staff reply",clientId:"b".repeat(32)}));
 assert.equal(reply.code,200);assert.equal(reply.body.message.name,"Support assistant");
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-b",{text:"Wrong owner",clientId:"c".repeat(32)}))).code,403);
 assert.equal((await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,body))).body.message.id,sent.body.message.id);
 await f.invoke("POST","/api/support/chats/:id/end",f.guest(id,token,{cycle:1,rating:"up"}));
 assert.equal((await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,{text:"Too late",clientId:"d".repeat(32)}))).code,409);
});

test("pre-lifecycle retry ids remain idempotent and missing-cycle callers cannot send into a continued thread",async()=>{
 const f=fixture(),opened=await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-a")),id=opened.body.id;
 const clientId="a".repeat(32),key=require("node:crypto").createHash("sha256").update(id+":patient-a:"+clientId).digest("hex");
 f.root.nativeChatMessages[id][key]={id:key,sender:"visitor",name:"Patient",text:"Already saved",time:"2026-11-02T00:00:00Z"};
 const result=await f.invoke("POST","/api/patient-support/chats/:id/messages",f.patient("patient-a",{params:{id},body:{text:"Already saved",clientId}}));
 assert.equal(result.code,200);assert.equal(result.body.message.id,key);
 assert.equal(Object.values(f.root.nativeChatMessages[id]).filter(m=>m.text==="Already saved").length,1);
 await f.invoke("POST","/api/patient-support/chats/:id/request",f.patient("patient-a",{params:{id},body:{cycle:1}}));
 await f.invoke("POST","/api/patient-support/chats/:id/end",f.patient("patient-a",{params:{id},body:{cycle:1,rating:"up"}}));
 await f.invoke("POST","/api/patient-support/chats/:id/request",f.patient("patient-a",{params:{id},body:{cycle:1}}));
 assert.equal((await f.invoke("POST","/api/patient-support/chats/:id/messages",f.patient("patient-a",{params:{id},body:{text:"Outdated draft",clientId:"b".repeat(32)}}))).code,426);
 assert.equal(f.root.humanChats[id].cycle,2);
});

test("desktop receives one notice per conversation, read notices stay read and subsequent patient messages only increase unread sequence", async () => {
 const f=fixture(),opened=(await f.openGuest()).body,{id,token}=opened;await requestGuest(f,opened);
 const noticeId=`native_chat_${id}`;assert.ok(f.root.notifications[noticeId]);
 f.root.notifications[noticeId].read=true;f.root.notifications[noticeId].isRead=true;
 for(let i=0;i<4;i++)assert.equal((await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,{cycle:1,text:`Synthetic ${i}`,clientId:String(i).repeat(32)}))).code,200);
 assert.equal(Object.keys(f.root.notifications).length,1);assert.equal(f.root.notifications[noticeId].read,true);
 assert.equal(f.root.humanChats[id].visitorSequence,5);
});

test("typing is owner-authorized, expires, does not save drafts, create notices, change sorting or mark messages read", async () => {
 const f=fixture(),opened=(await f.openGuest()).body,{id,token}=opened;await requestGuest(f,opened);await connect(f,id,"clinic");
 const at=f.root.humanChats[id].updatedAt,count=Object.keys(f.root.notifications).length,sequence=f.root.humanChats[id].visitorSequence;
 const marker={cycle:1,isTyping:true,clientId:"e".repeat(32),sequence:1,text:"Never persist this draft"};
 assert.equal((await f.invoke("POST","/api/support/chats/:id/typing",f.guest(id,token,marker))).code,200);
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/typing",staff(id,"staff-b",marker))).code,403);
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/typing",staff(id,"staff-a",marker))).code,200);
 let row=(await f.invoke("GET","/api/support/chats/:id",f.guest(id,token))).body.conversation;
 assert.ok(row.typing.visitor.expiresAt);assert.ok(row.typing.staff.expiresAt);
 assert.doesNotMatch(JSON.stringify(row),/staff-a|_typing|clientId|Never persist/);
 assert.doesNotMatch(JSON.stringify(f.root),/Never persist this draft/);
 assert.equal(f.root.humanChats[id].updatedAt,at);assert.equal(f.root.humanChats[id].visitorSequence,sequence);assert.equal(Object.keys(f.root.notifications).length,count);
 f.advance(8001);row=(await f.invoke("GET","/api/support/chats/:id",f.guest(id,token))).body.conversation;assert.deepEqual(row.typing,{});
 assert.equal((await f.invoke("POST","/api/support/chats/:id/typing",f.guest(id,token,{...marker,isTyping:"true"}))).code,400);
 assert.equal((await f.invoke("POST","/api/support/chats/:id/typing",f.guest(id,token,{...marker,cycle:2}))).code,409);
});

test("renewed draft presence survives multiple leases without creating messages, notices or unread changes",async()=>{
 const f=fixture(),opened=(await f.openGuest()).body,{id,token}=opened;await requestGuest(f,opened);await connect(f,id,"clinic");
 const before=JSON.stringify({messages:f.root.nativeChatMessages,notices:f.root.notifications,sequence:f.root.humanChats[id].visitorSequence,updatedAt:f.root.humanChats[id].updatedAt});
 const marker={cycle:1,isTyping:true,clientId:"f".repeat(32)};
 for(let sequence=1;sequence<=7;sequence++){
  f.advance(3000);assert.equal((await f.invoke("POST","/api/support/chats/:id/typing",f.guest(id,token,{...marker,sequence}))).code,200);
  assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/typing",staff(id,"staff-a",{...marker,sequence}))).code,200);
  const row=(await f.invoke("GET","/api/support/chats/:id",f.guest(id,token))).body.conversation;assert.ok(row.typing.visitor);assert.ok(row.typing.staff);
 }
 assert.equal(JSON.stringify({messages:f.root.nativeChatMessages,notices:f.root.notifications,sequence:f.root.humanChats[id].visitorSequence,updatedAt:f.root.humanChats[id].updatedAt}),before);
 await f.invoke("POST","/api/support/chats/:id/typing",f.guest(id,token,{...marker,isTyping:false,sequence:8}));
 assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest(id,token))).body.conversation.typing.visitor,undefined);
 f.advance(8001);assert.deepEqual((await f.invoke("GET","/api/support/chats/:id",f.guest(id,token))).body.conversation.typing,{});
});

test("out-of-order typing cannot resurrect a stopped indicator; send and end clear it and resumed cycles reject old markers", async () => {
 const f=fixture(),opened=await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-a")),id=opened.body.id;
 await f.invoke("POST","/api/patient-support/chats/:id/request",f.patient("patient-a",{params:{id},body:{cycle:1}}));
 const type=body=>f.invoke("POST","/api/patient-support/chats/:id/typing",f.patient("patient-a",{params:{id},body}));
 const marker={cycle:1,isTyping:true,clientId:"e".repeat(32),sequence:1};
 assert.equal((await type(marker)).code,200);
 await type({...marker,isTyping:false,sequence:3});await type({...marker,sequence:2});
 assert.deepEqual((await f.invoke("GET","/api/patient-support/chats/:id",f.patient("patient-a",{params:{id}}))).body.conversation.typing,{});
 await type({...marker,sequence:4});
 await f.invoke("POST","/api/patient-support/chats/:id/messages",f.patient("patient-a",{params:{id},body:{cycle:1,text:"Sent",clientId:"a".repeat(32)}}));
 assert.equal(f.root.humanChats[id]._typing.visitor.until,0);
 await f.invoke("POST","/api/patient-support/chats/:id/end",f.patient("patient-a",{params:{id},body:{cycle:1,rating:"up"}}));
 assert.equal((await type({...marker,sequence:5})).code,409);
 await f.invoke("POST","/api/patient-support/chats/:id/request",f.patient("patient-a",{params:{id},body:{cycle:1}}));
 assert.equal((await type({...marker,sequence:6})).code,409);
 assert.equal((await f.invoke("POST","/api/patient-support/chats/:id/typing",f.patient("patient-b",{params:{id},body:{...marker,cycle:2}}))).code,404);
});

test("connection identity is fixed for the cycle, retries are idempotent and account initials stay verified", async () => {
 const f=fixture(),opened=(await f.openGuest()).body,{id}=opened;await requestGuest(f,opened);
 f.root.staff={"staff-a":{fullName:"Fredilito Sambal"}};
 const first=await connect(f,id,"account");assert.equal(first.body.conversation.connectedName,"Fredilito");assert.equal(first.body.conversation.connectedInitials,"FS");assert.equal(first.body.conversation.connectedAvatar,"initials");assert.equal(first.body.conversation.connectedIdentity,"account");
 const reply=await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-a",{cycle:1,text:"Account reply",clientId:"a".repeat(32)}));
 assert.equal(reply.body.message.name,"Fredilito");assert.equal(reply.body.message.initials,"FS");
 assert.equal((await connect(f,id,"clinic","staff-b")).code,409);
 assert.equal((await connect(f,id,"clinic")).code,409);
 const retry=await connect(f,id,"first_name");assert.equal(retry.code,200);assert.equal(retry.body.conversation.connectedIdentity,"account");
 assert.equal(retry.body.conversation.messages.filter(m=>m.text.includes("has connected")).length,1);
 assert.equal(retry.body.conversation.messages.find(m=>m.id===reply.body.message.id).name,"Fredilito");
 const next=await f.invoke("POST","/api/staff/human-chats/:id/messages",staff(id,"staff-a",{cycle:1,text:"Still account reply",clientId:"b".repeat(32)}));assert.equal(next.body.message.avatar,"initials");assert.equal(next.body.message.name,"Fredilito");
 const clinic=(await f.openGuest()).body;await requestGuest(f,clinic);await connect(f,clinic.id,"clinic");assert.equal((await connect(f,clinic.id,"account")).code,409);
 const branded=(await connect(f,clinic.id,"anonymous")).body.conversation;assert.equal(branded.connectedName,"Alphastar Staff");assert.equal(branded.connectedAvatar,"clinic");
 const patient=(await f.invoke("GET","/api/support/chats/:id",f.guest(id,opened.token))).body.conversation;
 assert.doesNotMatch(JSON.stringify(patient),/Fredilito Sambal|staff-a|connectedIdentity|_typing/);
});

test("the staff navigation unread index covers older history with bounded queries and never exposes visitor details", async()=>{
 const f=fixture();f.root.humanChats={};
 for(let i=0;i<205;i++){
  const id=i.toString(16).padStart(64,"0"),at=new Date(Date.parse("2026-11-01T00:00:00Z")+i*1000).toISOString();
  f.root.humanChats[id]={id,provider:"alphastar",lifecycleVersion:2,status:i%2?"ended":"connected",source:i===0?"website":"mobile",_guestLeaseUntil:0,cycle:1,visitorName:"Private Synthetic Person",visitorEmail:"private@example.test",visitorSequence:1,requestedAt:at,updatedAt:at,_readBy:{"staff-a":i>=200?1:0},_connection:{uid:"private-assistant"}};
 }
 const response=await f.invoke("GET","/api/staff/human-chats/unread",staff("", "staff-a"));assert.equal(response.code,200);assert.equal(response.body.unread.length,200);
 assert.equal(response.body.unread.filter(row=>row.history).length,101);
 assert.doesNotMatch(JSON.stringify(response.body),/Private Synthetic|private@example|private-assistant|_readBy|_connection/);
 assert.ok(f.queries.every(query=>query.limit===100&&query.order==="updatedAt"));assert.equal(f.queries.length,3);
 assert.equal((await f.invoke("GET","/api/staff/human-chats/unread",staff("", "staff-b"))).body.unread.length,205);
 assert.equal((await f.invoke("GET","/api/staff/human-chats/unread",staff("", "patient-a",{},"patient"))).code,403);
 assert.equal((await f.invoke("GET","/api/staff/human-chats/unread")).code,403);
});
