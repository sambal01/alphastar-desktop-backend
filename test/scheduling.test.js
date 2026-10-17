"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerBookingRoutes, __test: booking } = require("../src/scheduling-routes");

const DAY = "2026-09-09";
const NOW = Date.parse(`${DAY}T06:00:00+08:00`);
const SERVICE = "Complete Laboratory";
const patient = { uid: "patient_a", email: "patient-a@example.invalid", isStaff: false, role: "patient" };
const admin = { uid: "admin_a", email: "admin@example.invalid", isStaff: true, role: "admin" };

test("successful booking creates patient and staff notifications; retries preserve read state", () => {
  const root = seed();
  const appointment = booking.createBooking(root, input(), patient, NOW);
  const notifications = Object.values(root.notifications);
  assert.equal(notifications.length, 2);
  const notification = notifications.find((item) => item.userId === patient.uid);
  const staffNotice = notifications.find((item) => item.userId === "desktop-staff");
  assert.equal(staffNotice.referenceId, appointment.id);
  assert.equal(staffNotice.isRead, false);
  assert.equal(staffNotice.source, "mobile");
  staffNotice.isRead = true;
  assert.equal(notification.userId, patient.uid);
  assert.equal(notification.referenceId, appointment.id);
  assert.equal(notification.isRead, false);
  assert.match(notification.message, /pending clinic approval/);
  assert.match(notification.message, /My schedule on Home/);
  notification.isRead = true;
  booking.createBooking(root, input(), patient, NOW + 1000);
  assert.equal(Object.keys(root.notifications).length, 2);
  assert.equal(root.notifications[staffNotice.id].isRead, true);
  assert.equal(root.notifications[notification.id].isRead, true);
});

test("rejected bookings do not create a success notification", () => {
  const root = seed();
  save(root, oneSlot(1, { closed: true }));
  assert.throws(() => booking.createBooking(root, input(), patient, NOW), { code: "SLOT_UNAVAILABLE" });
  assert.equal(Object.keys(root.notifications || {}).length, 0);
});

test("a staff-created appointment notifies the selected patient, not the staff member", () => {
  const root = seed();
  booking.createBooking(root, { ...input(), userId: patient.uid }, admin, NOW);
  assert.equal(Object.values(root.notifications)[0].userId, patient.uid);
});

test("staff approval saves an editable destination and notifies the patient", () => {
  const root = seed();
  const appointment = booking.createBooking(root, input(), patient, NOW);
  Object.assign(appointment, { bookingSource: "desktop", booking_source: "desktop", source: "desktop", visitType: "clinic" });
  booking.updateBooking(root, appointment.id, {
    status: "approved", destinationFloor: "3rd Floor", destinationRoom: "X-Ray Room",
  }, admin, NOW + 1000, "decision");
  assert.equal(appointment.destinationFloor, "3rd Floor");
  assert.equal(appointment.destinationRoom, "X-Ray Room");
  const notification = root.notifications[`appointment_destination_${appointment.id}`];
  assert.equal(notification.userId, patient.uid);
  assert.match(notification.message, /3rd Floor – X-Ray Room/);
});

test("staff can complete an appointment using its legacy embedded id", () => {
  const root = seed();
  const appointment = booking.createBooking(root, input(), patient, NOW);
  const recordId = appointment.id;
  appointment.id = "legacy_embedded_appointment";

  booking.updateBooking(root, appointment.id, { status: "completed" }, admin, NOW + 1000, "decision");

  assert.equal(root.appointments[recordId].status, "completed");
});

test("staff can complete an appointment using its legacy appointment number", () => {
  const root = seed();
  const appointment = booking.createBooking(root, input(), patient, NOW);
  const recordId = appointment.id;
  appointment.id = "internal_appointment_id";
  appointment.appointmentNumber = "APT-LEGACY-1001";
  appointment.ref = appointment.appointmentNumber;

  booking.updateBooking(root, appointment.appointmentNumber, { status: "completed" }, admin, NOW + 1000, "decision");

  assert.equal(root.appointments[recordId].status, "completed");
});

test("staff cannot approve a pending appointment without an allowed floor and room", () => {
  const root = seed();
  const appointment = booking.createBooking(root, input(), patient, NOW);
  Object.assign(appointment, { bookingSource: "desktop", booking_source: "desktop", source: "desktop", visitType: "clinic" });
  assert.throws(() => booking.updateBooking(root, appointment.id, { status: "approved" }, admin, NOW + 1000, "decision"), /destination floor and enter the destination room/);
  assert.throws(() => booking.destinationForAppointment(root, appointment, { destinationFloor: "4th Floor", destinationRoom: "Room 401" }), /1st Floor, 2nd Floor, or 3rd Floor/);
  assert.equal(appointment.destinationFloor, undefined);
});

test("staff approval applies an open patient reschedule request and notifies the destination", () => {
  const root = seed();
  const appointment = booking.createBooking(root, input(), patient, NOW);
  Object.assign(appointment, { bookingSource: "desktop", booking_source: "desktop", source: "desktop", visitType: "clinic" });
  Object.assign(appointment, {
    status: "reschedule_requested",
    appointmentStatus: "reschedule_requested",
    requestedScheduledAt: `${DAY}T08:00:00+08:00`,
  });

  booking.updateBooking(root, appointment.id, {
    scheduledAt: appointment.requestedScheduledAt,
    destinationFloor: "2nd Floor",
    destinationRoom: "Room 201",
  }, admin, NOW + 1000, "schedule");

  assert.equal(appointment.status, "scheduled");
  assert.equal(appointment.appointmentDate, DAY);
  assert.equal(appointment.startTime, "08:00");
  assert.equal(appointment.requestedScheduledAt, undefined);
  assert.equal(appointment.destinationFloor, "2nd Floor");
  assert.equal(appointment.destinationRoom, "Room 201");
  assert.match(root.notifications[`appointment_destination_${appointment.id}`].message, /2nd Floor.*Room 201/);
});

test("home-service approval needs no clinic destination and never creates a queue", () => {
  const root = seed();
  const appointment = booking.createBooking(root, input(), patient, NOW);
  assert.equal(appointment.visitType, "home_service");
  booking.updateBooking(root, appointment.id, { status: "approved" }, admin, NOW + 1000, "decision");
  assert.equal(appointment.status, "approved");
  assert.equal(appointment.destinationFloor, "");
  assert.equal(appointment.destinationRoom, "");
  assert.equal(Object.keys(root.queueEntries || {}).length, 0);
  const notice = root.notifications[`appointment_destination_${appointment.id}`];
  assert.match(notice.message, /home-service.*approved/);
  assert.doesNotMatch(notice.message, /when your queue number is called|Destination:/);
  booking.updateBooking(root, appointment.id, { status: "in_progress" }, admin, NOW + 2000, "decision");
  booking.updateBooking(root, appointment.id, { status: "completed" }, admin, NOW + 3000, "decision");
  assert.equal(Object.keys(root.queueEntries || {}).length, 0);
  assert.equal(appointment.completedAt, new Date(NOW + 3000).toISOString());
});

function seed() {
  return {
    users: {
      patient_a: { fullName: "Registered Patient", role: "patient", email: "patient-a@example.invalid" },
      patient_b: { fullName: "Another Patient", role: "patient", email: "patient-b@example.invalid" },
      admin_a: { role: "admin", fullName: "Clinic Admin" },
    },
    patientProfiles: { patient_a: { fullName: "Saved Profile Name" } },
    appointments: {},
  };
}

function input(id = "appointment_1", time = "07:00", serviceName = SERVICE) {
  return { id, serviceName, scheduledAt: `${DAY}T${time}:00+08:00`, patientName: "Spoofed Name", email: "other@example.invalid", notes: "Clinic visit" };
}

function oneSlot(capacity = 2, extra = {}) {
  return [{ startTime: "07:00", endTime: "08:00", capacity, isBreak: false, closed: false, ...extra }];
}

function save(root, slots, revision = 0, serviceName = SERVICE) {
  return booking.saveSchedule(root, { serviceName, date: DAY, slots, revision }, admin, NOW);
}

test("service schedules remain isolated, using a stable normalized service key", () => {
  const root = seed();
  save(root, oneSlot(1));
  booking.createBooking(root, input(), patient, NOW);
  const lab = booking.listSlots(root, SERVICE, DAY, NOW);
  const ecg = booking.listSlots(root, "ECG", DAY, NOW);
  assert.equal(lab.slots[0].remaining, 0);
  assert.equal(lab.slots[0].status, "full");
  assert.equal(ecg.slots[0].remaining, 2);
  assert.equal(booking.serviceKey(" Complete  Laboratory "), booking.serviceKey("complete laboratory"));
});

test("Philippine opening and START time boundaries mark past slots unavailable", () => {
  const root = seed();
  const before = booking.listSlots(root, SERVICE, DAY, Date.parse(`${DAY}T06:59:59+08:00`));
  const atStart = booking.listSlots(root, SERVICE, DAY, Date.parse(`${DAY}T07:00:00+08:00`));
  assert.equal(before.slots[0].status, "available");
  assert.equal(atStart.slots[0].status, "unavailable");
  assert.throws(() => booking.createBooking(root, input(), patient, Date.parse(`${DAY}T07:00:00+08:00`)), { code: "SLOT_EXPIRED" });
  assert.equal(booking.defaultSlots("2026-09-13").at(-1).endTime, "16:00");
  assert.equal(booking.defaultSlots(DAY).at(-1).endTime, "17:00");
});

test("breaks remain identifiable for patients to hide and cannot accept bookings", () => {
  const root = seed();
  const lunch = booking.listSlots(root, SERVICE, DAY, NOW).slots.find((slot) => slot.startTime === "12:00");
  assert.equal(lunch.isBreak, true);
  assert.equal(lunch.status, "unavailable");
  assert.throws(() => booking.createBooking(root, input("lunch", "12:00"), patient, NOW), { code: "SLOT_UNAVAILABLE" });
  save(root, oneSlot(2, { closed: true }));
  assert.throws(() => booking.createBooking(root, input(), patient, NOW), { code: "SLOT_UNAVAILABLE" });
});

test("saved profile and verified owner override request-supplied patient identity", () => {
  const root = seed();
  const appointment = booking.createBooking(root, { ...input(), userId: "patient_b" }, patient, NOW);
  assert.equal(appointment.userId, patient.uid);
  assert.equal(appointment.patientName, "Saved Profile Name");
  assert.equal(appointment.email, patient.email);
});

test("idempotent retry succeeds after capacity fills without creating a second reservation", () => {
  const root = seed();
  save(root, oneSlot(1));
  const first = booking.createBooking(root, input(), patient, NOW);
  const retry = booking.createBooking(root, input(), patient, NOW);
  assert.deepEqual(retry, first);
  assert.equal(Object.keys(root.appointments).length, 1);
  assert.equal(booking.listSlots(root, SERVICE, DAY, NOW).slots[0].bookedCount, 1);
  assert.throws(() => booking.createBooking(root, input("appointment_2"), patient, NOW), { code: "SLOT_FULL" });
});

test("patient cancellation verifies owner and releases exactly one reservation", () => {
  const root = seed();
  save(root, oneSlot(1));
  booking.createBooking(root, input(), patient, NOW);
  assert.throws(() => booking.updateBooking(root, "appointment_1", { reason: "Not mine" }, { ...patient, uid: "patient_b" }, NOW, "cancel"), { code: "BOOKING_FORBIDDEN" });
  booking.updateBooking(root, "appointment_1", { reason: "Changed plan" }, patient, NOW, "cancel");
  assert.equal(booking.listSlots(root, SERVICE, DAY, NOW).slots[0].remaining, 1);
  booking.updateBooking(root, "appointment_1", { reason: "Retry" }, patient, NOW, "cancel");
  assert.equal(booking.listSlots(root, SERVICE, DAY, NOW).slots[0].remaining, 1);
});

test("legacy RTDB appointments count once; cancellation frees capacity; other services do not count", () => {
  const root = seed();
  root.appointments.legacy = { id: "legacy", userId: "patient_a", reason: SERVICE, scheduledAt: `${DAY}T07:00:00+08:00`, status: "confirmed" };
  root.appointments.other = { ...root.appointments.legacy, id: "other", reason: "ECG" };
  save(root, oneSlot(2));
  booking.createBooking(root, input(), patient, NOW);
  assert.equal(booking.listSlots(root, SERVICE, DAY, NOW).slots[0].bookedCount, 2);
  root.appointments.legacy.status = "cancelled";
  assert.equal(booking.listSlots(root, SERVICE, DAY, NOW).slots[0].bookedCount, 1);
});

test("admin changes use optimistic revision, reject overlap and capacity below booked count", () => {
  const root = seed();
  assert.equal(save(root, oneSlot(2)).revision, 1);
  booking.createBooking(root, input(), patient, NOW);
  booking.createBooking(root, input("appointment_2"), patient, NOW);
  assert.throws(() => save(root, oneSlot(3), 0), { code: "SCHEDULE_CONFLICT" });
  assert.throws(() => save(root, oneSlot(1), 1), { code: "SLOT_HAS_BOOKINGS" });
  assert.throws(() => save(root, oneSlot(2, { isBreak: true }), 1), { code: "SLOT_HAS_BOOKINGS" });
  assert.throws(() => booking.validateSlots([...oneSlot(2), { ...oneSlot(2)[0], startTime: "07:30", endTime: "08:30" }]), /overlap/);
  assert.equal(save(root, oneSlot(3), 1).slots[0].remaining, 1);
});

test("removing booked intervals preserves them as closed; removing empty ones works", () => {
  const root = seed();
  save(root, oneSlot(2));
  booking.createBooking(root, input(), patient, NOW);
  const retained = save(root, [], 1);
  assert.equal(retained.slots.length, 1);
  assert.equal(retained.slots[0].closed, true);
  assert.equal(retained.slots[0].bookedCount, 1);
  booking.updateBooking(root, "appointment_1", {}, patient, NOW, "cancel");
  const empty = save(root, [], 2);
  assert.deepEqual(empty.slots, []);
});

test("admin rescheduling enforces target capacity and atomically moves availability", () => {
  const root = seed();
  booking.createBooking(root, input(), patient, NOW);
  booking.createBooking(root, input("appointment_2", "08:00"), patient, NOW);
  booking.createBooking(root, input("appointment_3", "08:00"), patient, NOW);
  assert.throws(() => booking.updateBooking(root, "appointment_1", { scheduledAt: `${DAY}T08:00:00+08:00` }, admin, NOW, "schedule"), { code: "SLOT_FULL" });
  booking.updateBooking(root, "appointment_1", { scheduledAt: `${DAY}T09:00:00+08:00`, destinationFloor: "2nd Floor", destinationRoom: "Room 101" }, admin, NOW, "schedule");
  const slots = booking.listSlots(root, SERVICE, DAY, NOW).slots;
  assert.equal(slots.find((slot) => slot.startTime === "07:00").bookedCount, 0);
  assert.equal(slots.find((slot) => slot.startTime === "09:00").bookedCount, 1);
});

// Request-level fixture: no Firebase SDK, credentials, sockets, network, or clinic data.
// The fake database serializes transactions just as the RTDB commit contract requires.
function requestFixture(initial = seed(), legacy = {}, coldCache = null) {
  let state = structuredClone(initial);
  let pending = Promise.resolve();
  const listeners = new Set();
  const snapshot = (value) => ({ val: () => structuredClone(value) });
  const database = {
    ref(path = "") {
      return {
        get: async () => snapshot(path ? path.split("/").reduce((value, key) => value?.[key], state) ?? null : state),
        on(event, callback) {
          assert.equal(path, "");
          assert.equal(event, "value");
          listeners.add(callback);
          queueMicrotask(() => { if (listeners.has(callback)) callback(snapshot(state)); });
        },
        off(event, callback) {
          assert.equal(event, "value");
          listeners.delete(callback);
        },
        transaction(update) {
          const run = pending.then(() => {
            // get() does not retain a root cache in the real Firebase SDK.
            // Aborting this first callback prevents its server-data retry.
            let next = update(structuredClone(listeners.size ? state : coldCache));
            if (next !== undefined && !listeners.size) next = update(structuredClone(state));
            if (next === undefined) return { committed: false, snapshot: snapshot(state) };
            state = structuredClone(next);
            return { committed: true, snapshot: snapshot(state) };
          });
          pending = run.then(() => undefined, () => undefined);
          return run;
        },
      };
    },
  };
  const routes = new Map();
  const app = Object.fromEntries(["get", "post", "patch"].map((method) => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  registerBookingRoutes(app, {
    getFirebaseApp: () => ({}), getDatabase: () => database,
    loadLegacyAppointments: async () => typeof legacy === "function" ? legacy() : structuredClone(legacy),
    getAuth: () => ({ verifyIdToken: async (token) => {
      if (!state.users[token]) throw new Error("invalid token");
      return { uid: token, email: state.users[token].email || "", role: state.users[token].role };
    } }),
    now: () => NOW,
  });
  return {
    read: () => structuredClone(state),
    listenerCount: () => listeners.size,
    async request(method, path, body = {}, token = patient.uid, extras = {}) {
      const req = { body, params: {}, query: {}, headers: token ? { authorization: `Bearer ${token}` } : {}, ...extras };
      const response = { status: 200, body: undefined };
      const res = { set: () => res, status: (status) => { response.status = status; return res; }, json: (value) => { response.body = value; return res; } };
      const handler = routes.get(`${method} ${path}`);
      assert.ok(handler, `${method} ${path} is registered`);
      await handler(req, res);
      return response;
    },
  };
}

test("cancel and complete succeed with an initially empty or partial transaction cache", async () => {
  for (const coldCache of [null, { users: { admin_a: { role: "admin" } } }]) {
    for (const action of [
      { method: "post", path: "/api/booking/appointments/:appointmentId/cancel", status: "cancelled", token: patient.uid },
      { method: "patch", path: "/api/staff/appointments/:appointmentId/decision", status: "cancelled", token: admin.uid },
      { method: "patch", path: "/api/staff/appointments/:appointmentId/decision", status: "completed", token: admin.uid },
    ]) {
      const root = seed();
      const appointment = booking.createBooking(root, input(), patient, NOW);
      const fixture = requestFixture(root, {}, coldCache);
      const response = await fixture.request(action.method, action.path, { status: action.status }, action.token, {
        params: { appointmentId: appointment.appointmentNumber },
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(fixture.read().appointments[appointment.id].status, action.status);
      assert.equal(Object.keys(fixture.read().appointments).length, 1);
      assert.equal(fixture.listenerCount(), 0, "finished requests must release the root listener");
    }
  }
});

test("a genuinely missing appointment is rejected without writes or leaked listeners", async () => {
  const fixture = requestFixture();
  const before = fixture.read();
  const response = await fixture.request("patch", "/api/staff/appointments/:appointmentId/decision", { status: "completed" }, admin.uid, {
    params: { appointmentId: "missing_appointment" },
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "APPOINTMENT_NOT_FOUND");
  assert.deepEqual(fixture.read(), before);
  assert.equal(fixture.listenerCount(), 0);
});

test("concurrent last-seat requests produce one success and one conflict", async () => {
  const root = seed();
  save(root, oneSlot(1));
  const fixture = requestFixture(root);
  const results = await Promise.all([
    fixture.request("post", "/api/booking/appointments", input("first")),
    fixture.request("post", "/api/booking/appointments", input("second"), "patient_b"),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(results.find((result) => result.status === 409).body.code, "SLOT_FULL");
  assert.equal(Object.keys(fixture.read().appointments).length, 1);
});

test("concurrent identical retries keep one appointment and return matching success", async () => {
  const root = seed();
  save(root, oneSlot(1));
  const fixture = requestFixture(root);
  const results = await Promise.all([
    fixture.request("post", "/api/booking/appointments", input()),
    fixture.request("post", "/api/booking/appointments", input()),
  ]);
  assert.deepEqual(results.map((result) => result.status), [201, 201]);
  assert.equal(Object.keys(fixture.read().appointments).length, 1);
});

test("request auth blocks anonymous access and patient schedule edits without database changes", async () => {
  const fixture = requestFixture();
  const before = fixture.read();
  const anonymous = await fixture.request("get", "/api/booking/slots", {}, "", { query: { service: SERVICE, date: DAY } });
  assert.equal(anonymous.status, 401);
  const denied = await fixture.request("post", "/api/booking/schedule", { serviceName: SERVICE, date: DAY, revision: 0, slots: oneSlot(4) });
  assert.equal(denied.status, 403);
  assert.deepEqual(fixture.read(), before);
  const allowed = await fixture.request("post", "/api/booking/schedule", { serviceName: SERVICE, date: DAY, revision: 0, slots: oneSlot(4) }, "admin_a");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.revision, 1);
});

test("request availability exposes only aggregate counts, never patient identities", async () => {
  const root = seed();
  booking.createBooking(root, input(), patient, NOW);
  const fixture = requestFixture(root);
  const response = await fixture.request("get", "/api/booking/slots", {}, patient.uid, { query: { service: SERVICE, date: DAY } });
  assert.equal(response.status, 200);
  assert.equal(response.body.slots[0].bookedCount, 1);
  assert.equal(JSON.stringify(response.body).includes("Saved Profile Name"), false);
  assert.equal(JSON.stringify(response.body).includes(patient.email), false);
  assert.equal(JSON.stringify(response.body).includes("patient_a"), false);
});

test("staff create uses the same capacity enforcement as patient booking", async () => {
  const root = seed();
  save(root, oneSlot(1));
  booking.createBooking(root, input(), patient, NOW);
  const fixture = requestFixture(root);
  const response = await fixture.request("post", "/api/staff/appointments", { ...input("staff_new"), userId: "patient_b" }, "admin_a");
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "SLOT_FULL");
});

test("legacy Firestore-only bookings count and import on a confirmed write without replacing RTDB", async () => {
  const root = seed();
  save(root, oneSlot(2));
  const legacy = {
    legacy_only: { id: "legacy_only", userId: patient.uid, patientName: "Legacy Patient", serviceName: SERVICE, scheduledAt: `${DAY}T07:00:00+08:00`, status: "confirmed" },
    stale_copy: { id: "stale_copy", userId: patient.uid, serviceName: SERVICE, scheduledAt: `${DAY}T07:00:00+08:00`, status: "confirmed" },
  };
  root.appointments.stale_copy = { ...legacy.stale_copy, status: "cancelled" };
  const fixture = requestFixture(root, legacy);
  const read = await fixture.request("get", "/api/booking/slots", {}, patient.uid, { query: { service: SERVICE, date: DAY } });
  assert.equal(read.body.slots[0].bookedCount, 1);
  assert.equal(fixture.read().appointments.legacy_only, undefined, "Availability reads do not migrate data");
  const created = await fixture.request("post", "/api/booking/appointments", input());
  assert.equal(created.status, 201);
  assert.equal(fixture.read().appointments.legacy_only.id, "legacy_only");
  assert.equal(fixture.read().appointments.stale_copy.status, "cancelled");
  const full = await fixture.request("post", "/api/booking/appointments", input("too_many"));
  assert.equal(full.status, 409);
  assert.equal(full.body.code, "SLOT_FULL");
});

test("availability remains available when the optional legacy Firestore read fails", async () => {
  const fixture = requestFixture(seed(), async () => {
    throw Object.assign(new Error("Firestore permission denied"), { code: 7 });
  });
  const response = await fixture.request(
    "get",
    "/api/booking/slots",
    {},
    patient.uid,
    { query: { service: SERVICE, date: DAY } },
  );
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.slots));
});

test("staff can process bookings but cannot edit service slot configuration", async () => {
  const root = seed(); root.users.staff_a = { role: "staff", status: "active" };
  const f = requestFixture(root);
  const before = f.read();
  const denied = await f.request("post", "/api/booking/schedule", { serviceName: SERVICE, date: DAY, revision: 0, slots: oneSlot(4) }, "staff_a");
  assert.equal(denied.status, 403);
  assert.deepEqual(f.read(), before);
});

test("booking persists the ordered services and rejects retries with a different plan",()=>{
  const root=seed();
  root.services={lab:{service_name:SERVICE,name:SERVICE,status:"active",floor:"2nd Floor",room:"Lab"},ecg:{service_name:"ECG",name:"ECG",status:"active",floor:"2nd Floor",room:"ECG Room"}};
  const request={...input(),serviceIds:["lab","ecg"]};
  const created=booking.createBooking(root,request,patient,NOW);
  assert.deepEqual(created.serviceIds,["lab","ecg"]);
  assert.deepEqual(Object.values(root.appointmentServices).map(s=>s.sequence_number),[1,2]);
  booking.createBooking(root,request,patient,NOW);
  assert.equal(Object.keys(root.appointmentServices).length,2);
  assert.throws(()=>booking.createBooking(root,{...request,serviceIds:["lab"]},patient,NOW),{code:"APPOINTMENT_CONFLICT"});
  booking.updateBooking(root, created.id, { status: "completed" }, admin, NOW, "status");
  assert.equal(created.status, "completed");
  assert.ok(Object.values(root.appointmentServices).every((step) => step.completed_at));
});
