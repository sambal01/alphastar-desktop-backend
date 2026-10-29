"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { registerBookingRoutes, __test: booking } = require("../src/scheduling-routes");
const DAY = "2027-02-10", NOW = Date.parse(DAY + "T06:00:00+08:00"), SERVICE = "Anti-Rabies Vaccine";
const admin = { uid: "admin", role: "admin", isStaff: true };
const actor = uid => ({ uid, role: "patient", isStaff: false });
const input = (id, serviceName = SERVICE, date = DAY, time = "07:00") => ({ id, serviceName, scheduledAt: date + "T" + time + ":00+08:00" });
const morningHour = index => String([7, 9, 13][index]).padStart(2, "0") + ":00";
function seed() { return { users: Object.fromEntries(["admin", "staff", ...Array.from({length: 10}, (_, i) => "p" + i)].map(uid => [uid, { role: uid === "admin" ? "admin" : uid === "staff" ? "staff" : "patient" }])), appointments: {} }; }
const availability = (root, service = SERVICE, date = DAY, exclude = "") => booking.listSlots(root, service, date, NOW, true, exclude);
const save = (root, slots, revision = 0) => booking.saveSchedule(root, { serviceName: SERVICE, date: DAY, mode: "home_service", slots, revision }, admin, NOW);
test("the shared Vaccination Services catalog name is recognized by both backends", () => {
  const root = seed(); root.services = { vaccination_services: { service_name: "Vaccination Services", status: "active" } };
  const saved = booking.createBooking(root, input("vaccination-request", "Vaccination Services"), actor("p0"), NOW);
  assert.equal(saved.endTime, "09:00"); assert.equal(saved.visitType, "home_service");
});
test("home default is three one-patient two-hour slots with 3 shared daily places; clinic schedule stays unchanged", () => {
  const root = seed(), info = availability(root);
  assert.equal(info.slots.length, 3); assert.equal(info.slots[0].startTime, "07:00"); assert.equal(info.slots[2].endTime, "15:00");
  assert.deepEqual(info.slots.map(slot => [slot.startTime, slot.endTime, slot.capacity]), [["07:00", "09:00", 1], ["09:00", "11:00", 1], ["13:00", "15:00", 1]]);
  assert.equal(info.slotCapacity, 1);
  assert.equal(info.dailyCapacity, 3); assert.equal(info.dailyRemaining, 3);
  assert.equal(booking.listSlots(root, SERVICE, DAY, NOW).slots.length > 1, true);
});
test("three patients across different home services fill every service for that day; retry stays idempotent", () => {
  const root = seed(), services = [SERVICE, "Check-Up Bata-Matanda", "Anti-Tetanus Toxoid"];
  services.forEach((service, i) => booking.createBooking(root, input("a" + i, service, DAY, morningHour(i)), actor("p" + i), NOW));
  const before = JSON.stringify(root);
  assert.equal(availability(root, "ECG").dailyBookedCount, 3); assert.equal(availability(root, "ECG").slots[0].status, "full");
  assert.throws(() => booking.createBooking(root, input("fourth", "ECG"), actor("p4"), NOW), { code: "HOME_SERVICE_DAY_FULL" });
  assert.equal(JSON.stringify(root), before);
  booking.createBooking(root, input("a0"), actor("p0"), NOW);
  assert.equal(Object.keys(root.appointments).length, 3);
  assert.equal(availability(root, SERVICE, "2027-02-11").dailyRemaining, 3);
});
test("cancellation and expiry release seats; completed visits still count, clinic tickets do not", () => {
  const root = seed();
  const one = booking.createBooking(root, input("a0"), actor("p0"), NOW);
  booking.createBooking(root, input("a1", "ECG", DAY, "09:00"), actor("p1"), NOW);
  booking.createBooking(root, input("a2", "2D Echo", DAY, "13:00"), actor("p2"), NOW);
  booking.updateBooking(root, one.id, {}, actor("p0"), NOW, "cancel");
  assert.equal(availability(root).dailyRemaining, 1);
  root.appointments.a1.status = "expired"; root.appointments.a1.appointmentStatus = "expired";
  root.appointments.a2.status = "completed";
  root.appointments.clinic = { source: "desktop", visitType: "clinic", serviceName: SERVICE, scheduledAt: DAY + "T07:00:00+08:00", status: "approved" };
  root.appointments.deleted = { ...root.appointments.a2, deleted: true };
  assert.equal(availability(root).dailyBookedCount, 1); assert.equal(availability(root).dailyRemaining, 2);
});
test("extra time slots cannot multiply the daily limit, and saved reservations are retained when closed", () => {
  const root = seed();
  const rows = [7, 8, 9, 10].map(hour => ({ startTime: String(hour).padStart(2, "0") + ":00", endTime: String(hour + 1).padStart(2, "0") + ":00", capacity: 3, isBreak: false, closed: false }));
  assert.throws(() => save(root, rows), /7–9 AM/);
  save(root, availability(root).slots);
  for (let i = 0; i < 3; i++) booking.createBooking(root, input("a" + i, SERVICE, DAY, morningHour(i)), actor("p" + i), NOW);
  assert.equal(availability(root).slots.every(slot => slot.status === "full"), true);
  assert.throws(() => booking.createBooking(root, { ...input("fourth"), scheduledAt: DAY + "T09:00:00+08:00" }, actor("p4"), NOW), { code: "HOME_SERVICE_DAY_FULL" });
  const result = save(root, [], 1); assert.equal(result.slots.length, 3); assert.equal(result.slots.every(slot => slot.closed && slot.bookedCount === 1), true);
  assert.equal(Object.keys(root.appointments).length, 3);
  assert.throws(() => save(root, rows, 0), { code: "SCHEDULE_CONFLICT" });
  assert.throws(() => save(seed(), [{ ...rows[0], capacity: 4 }]), /one patient per slot/);
});
test("home reschedules recheck daily capacity and exclude only the moved canonical record", () => {
  const root = seed();
  for (let i = 0; i < 3; i++) booking.createBooking(root, input("a" + i, SERVICE, DAY, morningHour(i)), actor("p" + i), NOW);
  assert.equal(availability(root, SERVICE, DAY, "a0").dailyRemaining, 1);
  booking.updateBooking(root, "a0", { scheduledAt: DAY + "T07:00:00+08:00" }, admin, NOW, "schedule");
  const other = booking.createBooking(root, input("other", SERVICE, "2027-02-11"), actor("p4"), NOW);
  assert.throws(() => booking.updateBooking(root, other.id, { scheduledAt: DAY + "T07:00:00+08:00" }, admin, NOW, "schedule"), { code: "HOME_SERVICE_DAY_FULL" });
  assert.equal(other.appointmentDate, "2027-02-11");
});
function fixture() {
  let root = seed(), pending = Promise.resolve(); const handlers = new Map(), listeners = new Set();
  const snap = value => ({ val: () => structuredClone(value) });
  const database = { ref(path = "") { return {
    get: async () => snap(path ? path.split("/").reduce((value, key) => value?.[key], root) ?? null : root),
    on(_event, cb) { listeners.add(cb); queueMicrotask(() => cb(snap(root))); }, off(_event, cb) { listeners.delete(cb); },
    transaction(update) { const run = pending.then(() => { const value = update(structuredClone(root)); if (value === undefined) return { committed: false }; root = value; return { committed: true }; }); pending = run.catch(() => {}); return run; }
  }; } };
  const app = Object.fromEntries(["get","post","patch"].map(method => [method, (path, fn) => handlers.set(method + " " + path, fn)]));
  registerBookingRoutes(app, { dispatchPush: false, getFirebaseApp: () => ({}), getDatabase: () => database, now: () => NOW,
    getAuth: () => ({ verifyIdToken: async uid => { if (!root.users[uid]) throw Error("invalid"); return { uid, role: root.users[uid].role }; } }) });
  return { read: () => root, async request(method, path, token = "p0", body = {}, query = {}) {
    const result = { status: 200 }; const res = { set() { return res; }, status(value) { result.status = value; return res; }, json(body) { result.body = body; return res; } };
    await handlers.get(method + " " + path)({ body, query, params: {}, headers: token ? { authorization: "Bearer " + token } : {} }, res); return result;
  } };
}
test("concurrent patients using different services get only three committed bookings", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({length: 10}, (_, i) => f.request("post", "/api/booking/appointments", "p" + i, input("a" + i, i % 2 ? SERVICE : "ECG", DAY, morningHour(i % 3)))));
  assert.equal(results.filter(row => row.status === 201).length, 3);
  assert.equal(results.filter(row => row.body.code === "HOME_SERVICE_DAY_FULL").length, 7);
  assert.equal(Object.keys(f.read().appointments).length, 3);
});
test("monthly calendar is aggregate-only, authenticated, gray/full after 3, and uses Philippine dates", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await f.request("post", "/api/booking/appointments", "p" + i, input("a" + i, SERVICE, DAY, morningHour(i)));
  const query = { service: SERVICE, month: "2027-02" };
  const result = await f.request("get", "/api/booking/calendar", "p0", {}, query);
  assert.equal(result.status, 200); assert.equal(result.body.days.length, 28);
  assert.equal(result.body.days.find(row => row.date === DAY).status, "full");
  assert.equal(result.body.days.find(row => row.date === "2027-02-11").remaining, 3);
  assert.doesNotMatch(JSON.stringify(result.body), /patientName|userId|scheduledAt|a0|p0/);
  assert.equal((await f.request("get", "/api/booking/calendar", "", {}, query)).status, 401);
  assert.equal((await f.request("get", "/api/booking/calendar", "p0", {}, { ...query, exclude: "a1" })).status, 403);
  const own = await f.request("get", "/api/booking/calendar", "p0", {}, { ...query, exclude: "a0" });
  assert.equal(own.body.days.find(row => row.date === DAY).remaining, 1);
  assert.equal((await f.request("get", "/api/booking/calendar", "p0", {}, { ...query, month: "2027-13" })).status, 400);
});
test("only Admin saves home slots, and custom home configuration leaves clinic schedules untouched", async () => {
  const f = fixture(), body = { mode: "home_service", serviceName: SERVICE, date: DAY, revision: 0, slots: [] };
  assert.equal((await f.request("post", "/api/booking/schedule", "staff", body)).status, 403);
  assert.equal((await f.request("post", "/api/booking/schedule", "admin", body)).status, 200);
  assert.equal(f.read().serviceSlotSchedules, undefined);
  const result = await f.request("get", "/api/booking/slots", "p0", {}, { mode: "home_service", service: SERVICE, date: DAY });
  assert.equal(result.body.slots.length, 3);
  assert.equal(result.body.slots.every(slot => slot.closed), true);
});

test("one patient blocks an overlapping hour across every home service but not the next hour", () => {
  const root = seed();
  booking.createBooking(root, input("first", SERVICE), actor("p0"), NOW);
  const info = availability(root, "ECG");
  assert.equal(info.dailyRemaining, 2);
  assert.deepEqual(info.slots.map(slot => [slot.status, slot.remaining]), [["full", 0], ["available", 1], ["available", 1]]);
  const before = JSON.stringify(root);
  assert.throws(() => booking.createBooking(root, input("conflict", "ECG"), actor("p1"), NOW), { code: "SLOT_FULL" });
  assert.equal(JSON.stringify(root), before, "A conflict cannot write an appointment, notice or audit");
  booking.createBooking(root, input("next-hour", "ECG", DAY, "09:00"), actor("p1"), NOW);
  assert.equal(Object.keys(root.appointments).length, 2);
});

test("legacy long visits block every overlapping hour without rewriting existing records", () => {
  const root = seed();
  root.appointments.legacy = { id: "legacy", userId: "p0", source: "mobile", serviceName: SERVICE,
    scheduledAt: DAY + "T07:00:00+08:00", endTime: "10:00", status: "approved" };
  const before = JSON.stringify(root), info = availability(root, "ECG");
  assert.equal(info.dailyBookedCount, 1);
  assert.equal(info.slots.slice(0, 2).every(slot => slot.status === "full" && slot.remaining === 0), true);
  assert.equal(info.slots[2].status, "available");
  assert.equal(JSON.stringify(root), before);
  assert.throws(() => booking.createBooking(root, input("overlap", "ECG", DAY, "09:00"), actor("p1"), NOW), { code: "SLOT_FULL" });
  root.appointments.legacy.status = "cancelled";
  assert.equal(availability(root).slots.every(slot => slot.status === "available"), true);
});

test("legacy missing durations occupy an hour, adjacent boundaries do not overlap, and unknown times fail closed", () => {
  const root = seed();
  root.appointments.legacy = { id: "legacy", source: "mobile", serviceName: SERVICE,
    scheduledAt: DAY + "T07:30:00+08:00", status: "pending" };
  assert.deepEqual(availability(root, "ECG").slots.map(slot => slot.status), ["full", "available", "available"]);
  root.appointments.legacy.endTime = "8:00 AM";
  assert.deepEqual(availability(root, "ECG").slots.map(slot => slot.status), ["full", "available", "available"]);
  delete root.appointments.legacy.scheduledAt; root.appointments.legacy.appointmentDate = DAY;
  assert.equal(availability(root, "ECG").slots.every(slot => slot.status === "full"), true);
});

test("ten concurrent requests for the same hour across services commit exactly one appointment", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    f.request("post", "/api/booking/appointments", "p" + i, input("same-hour-" + i, i % 2 ? SERVICE : "ECG"))));
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.equal(results.filter(result => result.status === 409 && result.body.code === "SLOT_FULL").length, 9);
  assert.equal(Object.keys(f.read().appointments).length, 1);
});

test("reschedule conflicts retain the original hour and acceptance rechecks a newly occupied target", () => {
  const root = seed();
  const own = booking.createBooking(root, input("own"), actor("p0"), NOW);
  booking.createBooking(root, input("other", "ECG", DAY, "09:00"), actor("p1"), NOW);
  assert.throws(() => booking.requestBookingReschedule(root, "own", { requestedScheduledAt: DAY + "T09:00:00+08:00" }, actor("p0"), NOW), { code: "SLOT_FULL" });
  assert.equal(own.startTime, "07:00");
  booking.updateBooking(root, "other", {}, actor("p1"), NOW, "cancel");
  booking.requestBookingReschedule(root, "own", { requestedScheduledAt: DAY + "T09:00:00+08:00" }, actor("p0"), NOW);
  booking.createBooking(root, input("new-occupant", "ECG", DAY, "09:00"), actor("p2"), NOW);
  assert.deepEqual(booking.autoApproveExpiredRescheduleRequests(root, NOW + 15 * 60 * 1000), []);
  assert.equal(own.startTime, "07:00");
  assert.equal(availability(root).slots[0].status, "full");
});

test("a saved copy of the previous default becomes two-hour windows without data migration or shortening legacy visits", () => {
  const root = seed();
  root.homeServiceSlotSchedules = { [DAY]: { [booking.serviceKey(SERVICE)]: { configured: true, revision: 2,
    slots: [{ id: "0700-1000", startTime: "07:00", endTime: "10:00", capacity: 3, closed: false, isBreak: false }] } } };
  const before = JSON.stringify(root);
  assert.equal(availability(root).slots.length, 3); assert.equal(availability(root).revision, 2);
  assert.equal(JSON.stringify(root), before);
  root.appointments.legacy = { source: "mobile", serviceName: SERVICE, scheduledAt: DAY + "T07:00:00+08:00", endTime: "10:00", status: "pending" };
  assert.equal(availability(root).slots.slice(0, 2).every(slot => slot.status === "full"), true);
  assert.equal(root.appointments.legacy.endTime, "10:00");
});
