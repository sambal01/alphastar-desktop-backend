"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {registerNativeChatRoutes,readNativeChat}=require("../src/native-chat");
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
  registerNativeChatRoutes({post(path,handler){handlers.set("POST "+path,handler);},get(path,handler){handlers.set("GET "+path,handler);}},{
    now:()=>now,getFirebaseApp:()=>({}),getDatabase:()=>db,getAuth:()=>({async verifyIdToken(token,revoked){assert.equal(revoked,true);if(!root.users[token])throw Error("expired");return {uid:token,email:root.users[token].email};}}),
  });
  async function invoke(method,path,req={}){const res={code:200,set(){return this;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handlers.get(method+" "+path)({headers:{},params:{},query:{},ip:"synthetic-ip",...req},res);return res;}
  const openGuest=()=>invoke("POST","/api/support/chats",{body:{name:"Synthetic Visitor",email:"guest@example.test",consent:true}});
  const guest=(id,token,body)=>({params:{id},headers:{"x-alphastar-chat-token":token},...(body?{body}:{})});
  const patient=(uid,extra={})=>({headers:{authorization:"Bearer "+uid},...extra});
  return {root,db,queries,invoke,openGuest,guest,patient,advance:ms=>{now+=ms;}};
}
test("guest conversations require consent and random capabilities, never lookup by email",async()=>{
 const f=fixture();
 assert.equal((await f.invoke("POST","/api/support/chats",{body:{name:"Synthetic",email:"guest@example.test",consent:false}})).code,400);
 const first=await f.openGuest(),second=await f.openGuest();assert.equal(first.code,200);assert.notEqual(first.body.id,second.body.id);assert.notEqual(first.body.token,second.body.token);
 assert.match(first.body.token,/^[a-f0-9]{64}$/);assert.equal(Object.keys(f.root.notifications||{}).length,0);
 assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest(first.body.id,second.body.token))).code,401);
 assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest(first.body.id,first.body.token))).code,200);
 assert.doesNotMatch(JSON.stringify(first.body.conversation),/tokenHash|expiresAt|uid/);
 f.advance(25*3600000);assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest(first.body.id,first.body.token))).code,401);
});
test("guest messages and desktop replies persist, are idempotent and notify staff once per message",async()=>{
 const f=fixture(),opened=await f.openGuest(),{id,token}=opened.body;
 const req=f.guest(id,token,{text:"Synthetic question",clientId:"a".repeat(32)});
 const [one,two]=await Promise.all([f.invoke("POST","/api/support/chats/:id/messages",req),f.invoke("POST","/api/support/chats/:id/messages",req)]);
 assert.equal(one.code,200);assert.equal(two.code,200);assert.equal(one.body.message.id,two.body.message.id);
 assert.equal(Object.keys(f.root.nativeChatMessages[id]).length,1);assert.equal(Object.keys(f.root.notifications).length,1);
 const notice=Object.values(f.root.notifications)[0];notice.isRead=true;
 await f.invoke("POST","/api/support/chats/:id/messages",req);assert.equal(notice.isRead,true);
 assert.equal((await f.invoke("POST","/api/staff/human-chats/:id/messages",{params:{id},body:{text:"Unauthorized",clientId:"b".repeat(32)}})).code,403);
 f.advance(1000);const reply=await f.invoke("POST","/api/staff/human-chats/:id/messages",{params:{id},staffAccess:{actor:{uid:"staff-a"}},body:{text:"Synthetic answer",clientId:"b".repeat(32)}});assert.equal(reply.code,200);
 const result=await f.invoke("GET","/api/support/chats/:id",f.guest(id,token));assert.equal(result.body.conversation.messages.length,2);assert.equal(result.body.conversation.messages[1].sender,"staff");
 assert.equal((await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,{text:"Changed retry",clientId:"a".repeat(32)}))).code,409);
});
test("mobile chat resumes only for its authenticated owner, protects MFA, and saves patient reply notifications",async()=>{
 const f=fixture(),open=await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-a",{body:{userId:"patient-b"}}));assert.equal(open.code,200);const id=open.body.id;
 const again=await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-a"));assert.equal(again.body.id,id);
 assert.equal((await f.invoke("GET","/api/patient-support/chats/:id",f.patient("patient-b",{params:{id}}))).code,404);
 assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest(id,"a".repeat(64)))).code,401);
 const reply=await f.invoke("POST","/api/staff/human-chats/:id/messages",{params:{id},staffAccess:{actor:{uid:"staff-a"}},body:{text:"Synthetic patient update",clientId:"c".repeat(32)}});assert.equal(reply.code,200);
 const notice=Object.values(f.root.notifications)[0];assert.equal(notice.userId,"patient-a");assert.equal(notice.referenceId,id);assert.equal(notice.type,"human_chat");
 f.root.patientAuthenticator={"patient-a":{version:1,enabled:true,revision:"a".repeat(64),provider:"password"}};
 assert.equal((await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-a"))).code,401);
 f.root.users["patient-b"].active=false;assert.equal((await f.invoke("POST","/api/patient-support/chats/open",f.patient("patient-b"))).code,403);
});
test("all messages are retained and older pages use bounded indexed queries",async()=>{
 const f=fixture(),opened=await f.openGuest(),id=opened.body.id;
 f.root.nativeChatMessages||={};f.root.nativeChatMessages[id]={};
 for(let i=0;i<205;i++){const key=i.toString(16).padStart(64,"0");f.root.nativeChatMessages[id][key]={id:key,time:new Date(Date.parse("2026-11-01T00:00:00Z")+i*1000).toISOString(),text:"Synthetic "+i,sender:"visitor",name:""};}
 const latest=await readNativeChat(f.db,id);assert.equal(latest.messages.length,100);assert.ok(latest.before);
 const earlier=await readNativeChat(f.db,id,latest.before);assert.equal(earlier.messages.length,100);const first=await readNativeChat(f.db,id,earlier.before);assert.equal(first.messages.length,5);assert.equal(first.before,"");
 assert.equal(new Set([...latest.messages,...earlier.messages,...first.messages].map(row=>row.id)).size,205);
 assert.equal(Object.keys(f.root.nativeChatMessages[id]).length,205);assert.ok(f.queries.every(query=>query.limit===101&&query.order==="time"));
});
test("invalid ids, empty or oversized text and anonymous patient requests are rejected",async()=>{
 const f=fixture(),opened=await f.openGuest(),{id,token}=opened.body;
 assert.equal((await f.invoke("POST","/api/patient-support/chats/open")).code,401);
 assert.equal((await f.invoke("GET","/api/support/chats/:id",f.guest("../users",token))).code,400);
 for(const text of ["","x".repeat(2001)])assert.equal((await f.invoke("POST","/api/support/chats/:id/messages",f.guest(id,token,{text,clientId:"a".repeat(32)}))).code,400);
});
