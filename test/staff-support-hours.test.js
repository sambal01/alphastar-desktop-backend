const test = require("node:test"), assert = require("node:assert/strict");
const { staffSupportHours } = require("../src/staff-support-hours");
const fixture = require("./helpers/native-feedback-fixture.cjs");
test("the public hours endpoint exposes only the current support window without touching patient records", async () => {
  const f = fixture({ now: () => Date.parse("2026-11-10T09:00:00Z") }), before = JSON.stringify(f.root);
  const result = await f.invoke("GET", "/api/support/hours");
  assert.equal(result.code, 200); assert.equal(result.body.supportHours.open, false);
  assert.equal(result.body.supportHours.timeZone, "Asia/Manila");
  assert.equal(JSON.stringify(f.root), before);
});
test("Staff Support uses Manila time, opens at 7 AM, includes lunch and closes exactly at 5 PM", () => {
  for (const [instant, open] of [["2026-11-09T22:59:59.999Z", false], ["2026-11-09T23:00:00Z", true], ["2026-11-10T04:00:00Z", true], ["2026-11-10T08:59:59.999Z", true], ["2026-11-10T09:00:00Z", false], ["2026-11-10T22:59:59Z", false], ["2026-11-10T23:00:00Z", true]]) {
    const hours = staffSupportHours(Date.parse(instant));
    assert.equal(hours.open, open, instant); assert.equal(hours.timeZone, "Asia/Manila");
  }
});
for (const source of ["website", "mobile"]) test(source + " blocks requests, messages, staff connections and typing outside hours without blocking reading or ending", async () => {
  let now = Date.parse("2026-11-10T08:59:58Z");
  const f = fixture({ now: () => now }), chat = await f.open(source);
  const staff = body => ({ params: { id: chat.id }, staffAccess: { actor: { uid: "staff", role: "staff" } }, body });
  assert.equal((await f.invoke("POST", "/api/staff/human-chats/:id/connect", staff({ cycle: 1, identity: "anonymous" }))).code, 200);
  now = Date.parse("2026-11-10T09:00:00Z");
  const before = JSON.stringify(f.root.nativeChatMessages);
  for (const response of [
    await chat.call("/request", { cycle: 1 }),
    await chat.call("/messages", { cycle: 1, text: "Outside hours", clientId: "a".repeat(32) }),
    await chat.call("/typing", { cycle: 1, isTyping: true, clientId: "b".repeat(32), sequence: 1 }),
    await f.invoke("POST", "/api/staff/human-chats/:id/messages", staff({ cycle: 1, text: "Outside hours", clientId: "c".repeat(32) })),
    await f.invoke("POST", "/api/staff/human-chats/:id/connect", staff({ cycle: 1, identity: "anonymous" })),
  ]) { assert.equal(response.code, 403); assert.match(response.body.error, /7:00 AM to 5:00 PM/); }
  assert.equal(JSON.stringify(f.root.nativeChatMessages), before);
  const read = await chat.call("", null, "GET");
  assert.equal(read.code, 200); assert.equal(read.body.conversation.supportHours.open, false); assert.ok(read.body.conversation.messages.length);
  assert.equal((await chat.call("/typing", { cycle: 1, isTyping: false, clientId: "b".repeat(32), sequence: 2 })).code, 200);
  assert.equal((await chat.call("/end", { cycle: 1, rating: null, comment: "" })).code, 200);
  if (source === "mobile") {
    assert.equal((await chat.call("/request", { cycle: 1 })).code, 403);
    now = Date.parse("2026-11-10T23:00:00Z");
    const continued = await chat.call("/request", { cycle: 1 });
    assert.equal(continued.code, 200); assert.equal(continued.body.conversation.cycle, 2);
    assert.ok(continued.body.conversation.messages.length > read.body.conversation.messages.length);
  }
});
