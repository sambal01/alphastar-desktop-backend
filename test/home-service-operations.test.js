"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), { once } = require("node:events");
const { startBookingHttpFixture, DAY } = require("./helpers/booking-http-fixture.cjs");
const { __test: b } = require("../src/scheduling-routes");
const { createPushDispatcher, registerDevice, currentJob, queuePush } = require("../src/appointment-push");
const NOW = Date.parse(DAY + "T06:00:00+08:00"), slots = ["07:00", "09:00", "13:00"];
const patient = uid => ({ uid, role: "patient", isStaff: false }), staff = { uid: "staff", role: "staff", isStaff: true };
const body = (id, time = "07:00", serviceName = "ECG") => ({ id, serviceName, scheduledAt: `${DAY}T${time}:00+08:00` });
const seed = () => ({ appointments: {}, users: { p0: { role: "patient" } }, patientProfiles: { p0: { fullName: "Synthetic Patient", address: "Synthetic address", phone: "09000000000" } } });
async function send(f, uid, method, path, input) {
  const response = await f.fetch(f.base + path, { method, headers: { Authorization: "Bearer " + uid, "Content-Type": "application/json" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  return { status: response.status, value: await response.json() };
}
test("home policy has only three two-hour windows, Manila clinic hours and protected buffers", () => {
  const root = seed(), info = b.listSlots(root, "ECG", DAY, NOW, true);
  assert.deepEqual(info.slots.map(slot => [slot.startTime, slot.endTime, slot.capacity]), [["07:00", "09:00", 1], ["09:00", "11:00", 1], ["13:00", "15:00", 1]]);
  assert.equal(info.homeServicePolicy, "two-hour-v1"); assert.equal(info.timeZone, "Asia/Manila");
  for (const time of ["08:00", "11:00", "12:00", "15:00", "16:00"]) assert.throws(() => b.createBooking(seed(), body("invalid", time), patient("p0"), NOW), { code: "SLOT_UNAVAILABLE" });
  assert.throws(() => b.saveSchedule(root, { mode: "home_service", serviceName: "ECG", date: DAY, revision: 0, slots: [{ startTime: "12:00", endTime: "13:00", capacity: 1, closed: false, isBreak: false }] }, { ...staff, role: "admin" }, NOW), /7–9 AM/);
  const atStart = b.listSlots(root, "ECG", DAY, Date.parse(DAY + "T07:00:00+08:00"), true);
  assert.equal(atStart.slots[0].status, "unavailable"); assert.equal(atStart.slots[1].status, "available");
});
test("real HTTP concurrent bookings share three daily places and one place per slot across services; cancellation releases the slot", async t => {
  const f = await startBookingHttpFixture(); t.after(() => f.close());
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => send(f, "p" + i, "POST", "/booking/appointments", body("race" + i, slots[i % 3], i % 2 ? "ECG" : "Anti-Rabies Vaccine"))));
  assert.equal(results.filter(r => r.status === 201).length, 3); assert.equal(Object.keys(f.read().appointments).length, 3);
  assert.ok(results.filter(r => r.status === 409).every(r => ["SLOT_FULL", "HOME_SERVICE_DAY_FULL"].includes(r.value.code)));
  const full = await send(f, "p9", "GET", `/booking/slots?mode=home_service&service=ECG&date=${DAY}`);
  assert.equal(full.value.dailyRemaining, 0); assert.ok(full.value.slots.every(slot => slot.status === "full"));
  const row = Object.values(f.read().appointments).find(a => a.startTime === "07:00");
  await send(f, "staff", "PATCH", `/staff/appointments/${row.id}/decision`, { status: "approved" });
  assert.equal((await send(f, "p9", "GET", `/booking/slots?mode=home_service&service=ECG&date=${DAY}`)).value.slots[0].remaining, 0);
  assert.equal((await send(f, row.userId, "POST", `/booking/appointments/${row.id}/cancel`, {})).status, 200);
  assert.equal((await send(f, "p9", "GET", `/booking/slots?mode=home_service&service=ECG&date=${DAY}`)).value.slots[0].status, "available");
  const freePatient = Array.from({ length: 10 }, (_, i) => "p" + i).find(uid => !Object.values(f.read().appointments).some(a => a.userId === uid));
  assert.equal((await send(f, freePatient, "POST", "/booking/appointments", body("replacement"))).status, 201);
});
test("only authorized staff record departure after confirmation and save an idempotent update for the correct patient", async t => {
  const f = await startBookingHttpFixture(); t.after(() => f.close());
  await send(f, "p0", "POST", "/booking/appointments", body("visit"));
  assert.equal((await send(f, "p1", "PATCH", "/staff/appointments/visit/decision", { status: "on_the_way" })).status, 403);
  assert.equal((await send(f, "staff", "PATCH", "/staff/appointments/visit/decision", { status: "on_the_way" })).status, 409);
  await send(f, "staff", "PATCH", "/staff/appointments/visit/decision", { status: "confirmed" });
  const departed = await send(f, "staff", "PATCH", "/staff/appointments/visit/decision", { status: "on_the_way", userId: "p1" });
  assert.equal(departed.value.appointment.status, "on_the_way"); assert.ok(departed.value.appointment.onTheWayAt);
  await send(f, "staff", "PATCH", "/staff/appointments/visit/decision", { status: "on_the_way" });
  const input = { requestId: "delay-1", message: "We are delayed by traffic. Please keep your phone available.", userId: "p1" };
  assert.equal((await send(f, "p1", "POST", "/staff/appointments/visit/update", input)).status, 403);
  assert.equal((await send(f, "staff", "POST", "/staff/appointments/visit/update", input)).status, 200);
  assert.equal((await send(f, "staff", "POST", "/staff/appointments/visit/update", input)).status, 200);
  assert.equal((await send(f, "staff", "POST", "/staff/appointments/visit/update", { ...input, message: "Different" })).status, 409);
  const notices = Object.values(f.read().notifications), departures = notices.filter(n => n.title === "Staff on the way"), updates = notices.filter(n => n.title === "Home-service appointment update");
  assert.equal(departures.length, 1); assert.equal(updates.length, 1);
  assert.equal(departures[0].message, "Our staff is on the way to your address. Please keep your phone available.");
  assert.ok([...departures, ...updates].every(n => n.userId === "p0" && n.referenceId === "visit"));
  assert.equal(f.read().appointments.visit.staffUpdate, input.message);
  assert.equal(f.read().appointments.visit.startTime, "07:00", "A delay message never moves the saved slot");
});
test("reminders follow the latest saved schedule, are deduplicated across workers, and stop on cancellation", async t => {
  let clock = NOW - 1;
  const f = await startBookingHttpFixture({ now: () => clock }); t.after(() => f.close());
  await send(f, "p0", "POST", "/booking/appointments", body("visit"));
  await send(f, "staff", "PATCH", "/staff/appointments/visit/decision", { status: "approved" });
  assert.deepEqual(await f.workers.processDueAppointments(), { reminded: [], expired: [] });
  clock = NOW;
  await Promise.all([f.workers.processDueAppointments(), f.workers.processDueAppointments()]);
  let reminders = Object.values(f.read().notifications).filter(n => n.title === "Appointment starts soon");
  assert.equal(reminders.length, 1); assert.equal(reminders[0].message, "Your Alphastar home-service appointment is today at 7:00 AM. Please prepare and keep your phone available.");
  const state = f.read(); delete state.notifications[reminders[0].id];
  assert.deepEqual(b.processDueAppointmentEvents(state, clock), { reminded: [], expired: [] }, "Clearing the patient's notification list does not send another reminder");
  await send(f, "staff", "PATCH", "/staff/appointments/visit/schedule", { scheduledAt: DAY + "T09:00:00+08:00" });
  assert.equal(currentJob(f.read(), Object.values(f.read().pushOutbox).find(j => j.kind === "reminder"), clock), false);
  clock = Date.parse(DAY + "T08:00:00+08:00"); await f.workers.processDueAppointments(); await f.workers.processDueAppointments();
  reminders = Object.values(f.read().notifications).filter(n => n.title === "Appointment starts soon");
  assert.equal(reminders.length, 2); assert.match(reminders.at(-1).message, /9:00 AM/);
  await send(f, "p0", "POST", "/booking/appointments/visit/cancel", {});
  assert.ok(Object.values(f.read().pushOutbox).filter(j => j.kind === "reminder").every(j => !currentJob(f.read(), j, clock)));
  assert.deepEqual(await f.workers.processDueAppointments(), { reminded: [], expired: [] });
});
test("real HTTP push dispatch targets only the patient's enabled device, claims once across workers, retries safely, and checks receipts", async t => {
  let clock = NOW;
  const f = await startBookingHttpFixture({ now: () => clock }); t.after(() => f.close());
  const token = "ExponentPushToken[synthetic-patient-device]", other = "ExponentPushToken[synthetic-other-device]";
  await send(f, "p0", "POST", "/patient/push-device", { token, enabled: true, userId: "p1" });
  await send(f, "p1", "POST", "/patient/push-device", { token: other, enabled: true });
  await send(f, "p0", "POST", "/booking/appointments", body("visit"));
  await send(f, "staff", "PATCH", "/staff/appointments/visit/decision", { status: "approved" });
  await f.workers.processDueAppointments();
  const traffic = []; let fail = true;
  const provider = http.createServer(async (req, res) => {
    let bytes = ""; for await (const chunk of req) bytes += chunk;
    const data = JSON.parse(bytes); traffic.push({ path: req.url, data });
    res.setHeader("Content-Type", "application/json");
    if (fail) { res.writeHead(503); return res.end('{"errors":[{"code":"UNAVAILABLE"}]}'); }
    res.end(JSON.stringify(req.url === "/send" ? { data: { status: "ok", id: "ticket-" + traffic.length } } : { data: Object.fromEntries(data.ids.map(id => [id, { status: "error", details: { error: "DeviceNotRegistered" } }])) }));
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening"); t.after(() => new Promise(resolve => provider.close(resolve)));
  const opts = { database: f.database, now: () => clock, baseUrl: "http://127.0.0.1:" + provider.address().port, accessToken: "", fetchImpl: fetch };
  await createPushDispatcher(opts).dispatch(); assert.ok(traffic.length > 0);
  assert.ok(traffic.every(r => r.data.to === token));
  const before = traffic.length; await createPushDispatcher(opts).dispatch(); assert.equal(traffic.length, before, "Retries back off after provider failure");
  clock += 120000; fail = false;
  await Promise.all([createPushDispatcher(opts).dispatch(), createPushDispatcher(opts).dispatch()]);
  const sentCount = traffic.filter(r => r.path === "/send").length;
  await createPushDispatcher(opts).dispatch(); assert.equal(traffic.filter(r => r.path === "/send").length, sentCount);
  assert.ok(traffic.filter(r => r.path === "/send").every(r => r.data.data.userId === "p0"));
  clock += 900001; await createPushDispatcher(opts).dispatch(); assert.ok(traffic.some(r => r.path === "/getReceipts"));
  assert.equal(Object.values(f.read().patientPushDevices).find(d => d.token === token).enabled, false);
  assert.equal(Object.values(f.read().patientPushDevices).find(d => d.token === other).enabled, true);
});
test("device registration cannot spoof recipients or let stale cleanup remove a newer binding", () => {
  const root = {}, token = "ExpoPushToken[synthetic-shared-device]";
  registerDevice(root, "p0", { token, bindingId: "old", enabled: true, userId: "p1" }, NOW);
  assert.equal(Object.values(root.patientPushDevices)[0].userId, "p0");
  registerDevice(root, "p1", { token, bindingId: "new", enabled: true }, NOW);
  registerDevice(root, "p0", { token, bindingId: "old", enabled: false }, NOW);
  assert.equal(Object.values(root.patientPushDevices)[0].userId, "p1");
  registerDevice(root, "p1", { token, bindingId: "newer", enabled: true }, NOW);
  registerDevice(root, "p1", { token, bindingId: "new", enabled: false }, NOW);
  assert.equal(Object.values(root.patientPushDevices)[0].enabled, true);
});

test("completed push history cannot hide a ready update, and transport retries use the same display tag", async t => {
  const f = await startBookingHttpFixture(); t.after(() => f.close());
  await send(f, "p0", "POST", "/booking/appointments", body("visit"));
  await send(f, "staff", "PATCH", "/staff/appointments/visit/decision", { status: "confirmed" });
  await send(f, "p0", "POST", "/patient/push-device", { token: "ExpoPushToken[synthetic-history-device]", enabled: true });
  await f.database.ref().transaction(root => {
    const key = Object.keys(root.patientPushDevices)[0], notice = { id: "a_ready", userId: "p0", title: "Update", message: "Synthetic update" };
    root.notifications = { [notice.id]: notice }; root.pushOutbox = {};
    queuePush(root, notice, "visit", "update", NOW);
    for (let i = 0; i < 205; i++) {
      const id = "z_completed_" + i;
      root.notifications[id] = { ...notice, id };
      root.pushOutbox[id] = { ...root.pushOutbox.a_ready, id, deliveries: { [key]: { state: "sent" } } };
    }
    return root;
  });
  const calls = [];
  await createPushDispatcher({ database: f.database, now: () => NOW, accessToken: "", fetchImpl: async (_url, options) => {
    calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ data: { status: "ok", id: "synthetic-ticket" } }) };
  } }).dispatch();
  assert.equal(calls.length, 1); assert.equal(calls[0].data.notificationId, "a_ready");
  const tag = require("node:crypto").createHash("sha256").update("a_ready").digest("hex");
  assert.equal(calls[0].tag, tag); assert.equal(calls[0].collapseId, tag); assert.equal(calls[0].priority, "high");
});

test("departure does not cancel a valid confirmed reminder, but cancellation does", () => {
  const root = seed();
  b.createBooking(root, body("visit"), patient("p0"), NOW - 1000);
  b.updateBooking(root, "visit", { status: "confirmed" }, staff, NOW - 999, "decision");
  b.updateBooking(root, "visit", { status: "on_the_way" }, staff, NOW - 998, "decision");
  assert.deepEqual(b.processDueAppointmentEvents(root, NOW).reminded, ["visit"]);
  const job = Object.values(root.pushOutbox).find(job => job.kind === "reminder");
  assert.equal(currentJob(root, job, NOW), true);
  b.updateBooking(root, "visit", { status: "cancelled" }, staff, NOW + 1, "decision");
  assert.equal(currentJob(root, job, NOW + 1), false);
});
