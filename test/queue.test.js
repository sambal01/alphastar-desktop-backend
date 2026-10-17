"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { registerQueueRoutes, createStaffAccessGuard, __test: queue } = require("../src/queue-routes");
const { __test: booking } = require("../src/scheduling-routes");
const DAY = "2026-09-09";
const NOW = Date.parse(`${DAY}T08:00:00+08:00`);
const staff = { uid: "staff_auth", role: "staff" };

function seed() {
  return {
    users: { patient_auth: { role: "patient" }, staff_auth: { role: "staff" }, second_auth: { role: "patient" } },
    appointments: {
      apt_one: { id: "apt_one", userId: "patient_auth", patientName: "Juan Dela Cruz", serviceName: "Complete Laboratory", status: "approved", scheduledAt: `${DAY}T09:00:00+08:00`, contactNumber: "private-phone", email: "private@example.invalid", notes: "private notes" },
      apt_two: { id: "apt_two", userId: "second_auth", patientName: "Maria Santos", serviceName: "Digital X-Ray", status: "approved", scheduledAt: `${DAY}T09:00:00+08:00` },
    },
    queueEntries: {},
  };
}

function fixture(initial = seed(), customOptions = {}) {
  let state = structuredClone(initial);
  let now = NOW;
  let chain = Promise.resolve();
  const listeners = new Map();
  const routes = new Map();
  const snapshot = (path) => ({ val: () => structuredClone(path ? path.split("/").reduce((part, key) => part?.[key], state) ?? null : state) });
  const emit = () => { for (const [path, callbacks] of listeners) for (const callback of callbacks) callback(snapshot(path)); };
  const database = { ref(path = "") { return {
    get: async () => snapshot(path),
    transaction: (update) => {
      const run = chain.then(() => {
        // Root transactions see an empty cache unless a root value listener
        // survives until the transaction starts. A prior get() is insufficient.
        let result = update(structuredClone(listeners.get("")?.size ? state : null));
        if (result !== undefined && !listeners.get("")?.size) result = update(structuredClone(state));
        if (result === undefined) return { committed: false };
        state = result;
        emit();
        return { committed: true };
      });
      chain = run.catch(() => {});
      return run;
    },
    on: (_, callback) => { if (!listeners.has(path)) listeners.set(path, new Set()); listeners.get(path).add(callback); callback(snapshot(path)); },
    off: (_, callback) => listeners.get(path)?.delete(callback),
  }; } };
  const app = Object.fromEntries(["get", "post", "patch", "delete"].map((method) => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  registerQueueRoutes(app, {
    getFirebaseApp: () => ({}), getDatabase: () => database,
    getAuth: () => ({ verifyIdToken: async (token) => {
      if (!state.users[token]) throw new Error("invalid");
      return { uid: token, exp: Math.floor((NOW + 3600000) / 1000), source: "desktop" };
    } }),
    now: () => now, ...customOptions,
  });
  return {
    read: () => structuredClone(state),
    listenerCount: () => [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0),
    replace: (next) => { state = structuredClone(next); emit(); },
    setNow: (next) => { now = next; },
    mount: (app) => { for (const [key, handler] of routes) { const space = key.indexOf(' '); app[key.slice(0, space)](key.slice(space + 1), handler); } },
    async request(method, path, body = {}, token = "patient_auth", params = {}) {
      const req = Object.assign(new EventEmitter(), { body, params, headers: token ? { authorization: `Bearer ${token}` } : {} });
      const response = { status: 200, body: undefined, chunks: [] };
      const res = new EventEmitter();
      Object.assign(res, {
        set: () => res,
        status: (code) => { response.status = code; return res; },
        json: (value) => { response.body = value; return res; },
        flushHeaders: () => { res.headersSent = true; },
        write: (value) => { response.chunks.push(value); return true; },
        end: () => res.emit("close"),
      });
      assert.ok(routes.has(`${method} ${path}`));
      await routes.get(`${method} ${path}`)(req, res);
      await Promise.resolve();
      return { ...response, close: () => res.emit("close") };
    },
  };
}

test("safe names show only first name and last initial, with generic and single names masked", () => {
  assert.equal(queue.maskedName("Juan Dela Cruz"), "Juan C.");
  assert.equal(queue.maskedName("María Santos"), "María S.");
  for (const name of ["Patient", "Juan", "Walk-in Patient", "test@example.invalid", "12345", ""]) assert.equal(queue.maskedName(name), "Patient");
});

test("staff-assigned walk-in destinations persist and stream to the patient's live queue", async () => {
  const f = fixture();
  const stream = await f.request("get", "/api/queue/stream");
  try {
    const added = await f.request("post", "/api/staff/queue", {
      id: "walkin_location", userId: "patient_auth", patientName: "Juan Dela Cruz",
      serviceName: "ECG", floor: "2nd Floor", room: " Room 101 ",
    }, "staff_auth");
    assert.equal(added.status, 201);
    assert.equal(added.body.entry.floor, "2nd Floor");
    assert.equal(added.body.entry.room, "Room 101");
    const live = await f.request("get", "/api/queue/live");
    assert.equal(live.body.ownEntry.floor, "2nd Floor");
    assert.equal(live.body.ownEntry.room, "Room 101");
    assert.ok(stream.chunks.some((chunk) => chunk.includes('"room":"Room 101"')));
    for (const status of ["called", "in_service", "done"]) {
      const changed = await f.request("patch", "/api/staff/queue/:queueId", { status }, "staff_auth", { queueId: "walkin_location" });
      assert.equal(changed.status, 200);
      assert.equal(changed.body.entry.room, "Room 101");
    }
    assert.equal((await f.request("get", "/api/queue/live")).body.ownEntry.status, "completed");
  } finally { stream.close(); }
});

test("invalid or incomplete explicit queue destinations do not write records", async () => {
  for (const destination of [{ floor: "4th Floor", room: "101" }, { floor: "2nd Floor", room: "   " }, { room: "101" }]) {
    const f = fixture();
    const before = f.read();
    const result = await f.request("post", "/api/staff/queue", { id: "invalid_location", patientName: "Walk-in", ...destination }, "staff_auth");
    assert.equal(result.status, 400);
    assert.deepEqual(f.read(), before);
  }
});

test("confirmed appointment destination stays consistent after queue decoration", () => {
  const root = seed();
  require("../src/service-journey").ensureDefaults(root, NOW);
  const added = queue.addQueueEntry(root, { appointmentId: "apt_one", floor: "3rd Floor", room: "Room 301" }, staff, NOW, "assigned_location");
  assert.equal(added.entry.floor, "3rd Floor");
  assert.equal(root.appointments.apt_one.destinationRoom, "Room 301");
  assert.equal(queue.liveSnapshot(root, "patient_auth", NOW).ownEntry.room, "Room 301");
});

test("new walk-ins in an occupied room wait until it is released; different floors serve together", () => {
  const root = seed();
  for (const [id, floor] of [["first", "2nd Floor"], ["waiting", "2nd Floor"], ["other_floor", "3rd Floor"]]) {
    queue.addQueueEntry(root, { patientName: "Walk-in", serviceName: "ECG", floor, room: "Room 101" }, staff, NOW, id);
  }
  queue.changeQueueEntry(root, "first", { status: "in_service" }, staff, NOW);
  for (const status of ["called", "in_service"]) {
    assert.throws(() => queue.changeQueueEntry(root, "waiting", { status }, staff, NOW), (error) => error.code === "QUEUE_DESTINATION_OCCUPIED");
  }
  queue.changeQueueEntry(root, "other_floor", { status: "in_service" }, staff, NOW);
  assert.equal(queue.liveSnapshot(root, "", NOW).nowServing.length, 2);
  queue.changeQueueEntry(root, "first", { status: "done" }, staff, NOW);
  queue.changeQueueEntry(root, "waiting", { status: "called" }, staff, NOW);
  assert.equal(root.queueEntries.waiting.status, "called");
});

test("legacy appointments without embedded IDs keep the staff-assigned destination", () => {
  const root = seed();
  delete root.appointments.apt_one.id;
  queue.addQueueEntry(root, { appointmentId: "apt_one", floor: "1st Floor", room: "Room 102" }, staff, NOW, "legacy_destination");
  assert.equal(root.appointments.apt_one.destinationFloor, "1st Floor");
  assert.equal(root.appointments.apt_one.destinationRoom, "Room 102");
});

test("queue destination assignment cannot bypass pending appointment approval", async () => {
  const root = seed();
  root.appointments.apt_one.status = "pending";
  const f = fixture(root);
  const result = await f.request("post", "/api/staff/queue", { appointmentId: "apt_one", floor: "1st Floor", room: "Room 102" }, "staff_auth");
  assert.equal(result.status, 409);
  assert.deepEqual(f.read(), root);
});

test("queue number and estimated wait are automatic using active patients at the destination", () => {
  const root = seed();
  root.services = { ecg: { service_name: "ECG", estimated_duration: 20, status: "active" } };
  const input = { patientName: "Walk-in", serviceName: "ECG", floor: "2nd Floor", room: "Room 101" };
  const first = queue.addQueueEntry(root, input, staff, NOW, "auto_first").entry;
  const second = queue.addQueueEntry(root, input, staff, NOW + 1, "auto_second").entry;
  const otherRoom = queue.addQueueEntry(root, { ...input, room: "Room 102" }, staff, NOW + 2, "auto_other").entry;
  assert.equal(first.queueNo, "A-001");
  assert.equal(first.estimatedWaitMinutes, 0);
  assert.equal(second.queueNo, "A-002");
  assert.equal(second.estimatedWaitMinutes, 20);
  assert.equal(otherRoom.estimatedWaitMinutes, 0);
  queue.changeQueueEntry(root, "auto_first", { status: "done" }, staff, NOW + 3);
  const third = queue.addQueueEntry(root, input, staff, NOW + 4, "auto_third").entry;
  assert.equal(third.queueNo, "A-004");
  assert.equal(third.estimatedWaitMinutes, 20, "Completed patients and other rooms do not add waiting time");
});

test("queue numbers stay unique when a new clinic day starts", () => {
  const root = seed();
  const input = { patientName: "Walk-in", serviceName: "ECG", floor: "2nd Floor", room: "Room 101" };
  const first = queue.addQueueEntry(root, input, staff, NOW, "day_one").entry;
  const second = queue.addQueueEntry(root, input, staff, NOW + 24 * 60 * 60 * 1000, "day_two").entry;

  assert.equal(first.queueNo, "A-001");
  assert.equal(second.queueNo, "A-002");
});

test("Add Patient without an appointment selector reuses an already-active linked queue", () => {
  const root = seed();
  const first = queue.addQueueEntry(root, { appointmentId: "apt_one" }, staff, NOW, "already_queued");
  const result = queue.addQueueEntry(root, {
    userId: "patient_auth", serviceName: "Complete Laboratory", floor: "2nd Floor", room: "Room 101",
  }, staff, NOW + 1, "manual_retry");
  assert.equal(result.duplicate, true);
  assert.equal(result.entry.id, first.entry.id);
  assert.equal(Object.keys(root.queueEntries).length, 1);
});

test("live payload exposes only safe fields and identifies own queue using verified owner", () => {
  const root = seed();
  queue.addQueueEntry(root, { appointmentId: "apt_one", patientName: "Spoofed Name" }, staff, NOW, "q_one");
  queue.addQueueEntry(root, { appointmentId: "apt_two" }, staff, NOW + 100, "q_two");
  const result = queue.liveSnapshot(root, "patient_auth", NOW);
  assert.equal(result.ownEntry.patientName, "Juan C.");
  assert.equal(result.ownPosition, 1);
  assert.equal(result.next.id, "q_one");
  assert.equal(result.waiting[0].id, "q_two");
  assert.deepEqual(Object.keys(result.entries[0]).sort(), ["department", "floor", "id", "isOwn", "journeyStatus", "nextFloor", "nextService", "patientName", "position", "previousService", "queueNo", "room", "serviceName", "status"].sort());
  for (const secret of ["Juan Dela Cruz", "Maria Santos", "patient_auth", "second_auth", "apt_one", "private-phone", "private@example.invalid", "private notes"]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(queue.liveSnapshot(root, "stranger", NOW).ownPosition, null);
});

test("queue order follows check-in order, prioritizes serving and called, supports multiple serving", () => {
  const root = seed();
  for (let index = 0; index < 4; index += 1) queue.addQueueEntry(root, { patientName: `Guest ${index}`, queueNo: `A-${90 - index}` }, staff, NOW + index, `q_${index}`);
  queue.changeQueueEntry(root, "q_3", { status: "called" }, staff, NOW + 10);
  queue.changeQueueEntry(root, "q_2", { status: "in_service" }, staff, NOW + 11);
  queue.changeQueueEntry(root, "q_1", { status: "in_consultation" }, staff, NOW + 12);
  const result = queue.liveSnapshot(root, "patient_auth", NOW + 20);
  assert.deepEqual(result.nowServing.map((item) => item.id), ["q_1", "q_2"]);
  assert.equal(result.next.id, "q_3");
  assert.equal(result.waiting[0].id, "q_0");
  assert.deepEqual(result.entries.map((item) => item.position), [1, 2, 3, 4]);
});

test("multiple rooms can serve at once, but an occupied destination cannot be called or started", () => {
  const root = seed();
  root.queueEntries = {
    serving_room_101: { id: "serving_room_101", queueNo: "A-001", queueDate: DAY, status: "in_service", floor: "2nd Floor", room: "Room 101" },
    waiting_room_101: { id: "waiting_room_101", queueNo: "A-002", queueDate: DAY, status: "waiting", floor: "2nd Floor", room: "Room 101" },
    waiting_room_102: { id: "waiting_room_102", queueNo: "A-003", queueDate: DAY, status: "waiting", floor: "2nd Floor", room: "Room 102" },
  };

  for (const status of ["called", "in_service"]) {
    assert.throws(
      () => queue.changeQueueEntry(root, "waiting_room_101", { status }, staff, NOW),
      (error) => error.code === "QUEUE_DESTINATION_OCCUPIED",
    );
  }
  queue.changeQueueEntry(root, "waiting_room_102", { status: "in_service" }, staff, NOW);
  assert.deepEqual(queue.liveSnapshot(root, "patient_auth", NOW).nowServing.map((entry) => entry.queueNo), ["A-001", "A-003"]);
});

test("skip, completion and removal immediately update position without leaking removed entries", () => {
  const root = seed();
  queue.addQueueEntry(root, { appointmentId: "apt_one" }, staff, NOW, "q_one");
  queue.addQueueEntry(root, { appointmentId: "apt_two" }, staff, NOW + 1, "q_two");
  queue.changeQueueEntry(root, "q_one", { status: "skipped" }, staff, NOW + 2);
  assert.equal(queue.liveSnapshot(root, "second_auth", NOW).ownPosition, 1);
  assert.equal(queue.liveSnapshot(root, "patient_auth", NOW).ownEntry.status, "skipped");
  queue.changeQueueEntry(root, "q_one", { status: "waiting" }, staff, NOW + 3);
  assert.equal(queue.liveSnapshot(root, "patient_auth", NOW).ownPosition, 1);
  queue.changeQueueEntry(root, "q_one", { status: "done" }, staff, NOW + 4);
  assert.equal(queue.liveSnapshot(root, "patient_auth", NOW).ownEntry.status, "completed");
  queue.changeQueueEntry(root, "q_one", {}, staff, NOW + 5, true);
  assert.equal(queue.liveSnapshot(root, "patient_auth", NOW).ownEntry, null);
});

test("legacy embedded queue IDs can still update their canonical realtime entry", () => {
  const root = seed();
  root.queueEntries = {
    realtime_queue_key: {
      id: "legacy_queue_id",
      queueNo: "A-001",
      queueDate: DAY,
      status: "waiting",
    },
  };
  queue.changeQueueEntry(root, "legacy_queue_id", { status: "called" }, staff, NOW);
  assert.equal(root.queueEntries.realtime_queue_key.status, "called");
});

test("only the Manila calendar day is visible, including UTC date rollover", () => {
  const root = seed();
  queue.addQueueEntry(root, { appointmentId: "apt_one" }, staff, NOW, "q_one");
  assert.equal(queue.clinicDate("2026-09-08T16:00:00Z"), DAY);
  assert.equal(queue.liveSnapshot(root, "patient_auth", Date.parse("2026-09-09T15:59:59Z")).entries.length, 1);
  assert.equal(queue.liveSnapshot(root, "patient_auth", Date.parse("2026-09-09T16:00:00Z")).entries.length, 0);
});

test("today approval creates one queue entry transactionally and repeated approval never duplicates", () => {
  const root = seed();
  booking.updateBooking(root, "apt_one", { status: "approved" }, { ...staff, isStaff: true }, NOW, "decision");
  booking.updateBooking(root, "apt_one", { status: "checked_in" }, { ...staff, isStaff: true }, NOW + 100, "decision");
  assert.equal(Object.keys(root.queueEntries).length, 1);
  assert.equal(queue.liveSnapshot(root, "patient_auth", NOW).ownPosition, 1);
  booking.updateBooking(root, "apt_one", { status: "completed" }, { ...staff, isStaff: true }, NOW + 200, "decision");
  assert.equal(Object.values(root.queueEntries)[0].status, "done");
});

test("future approval waits until appointment day and linked cancellation removes the live entry", () => {
  const root = seed();
  root.appointments.apt_two.scheduledAt = "2026-09-10T09:00:00+08:00";
  queue.syncAppointmentQueue(root, root.appointments.apt_two, staff, NOW);
  assert.equal(Object.keys(root.queueEntries).length, 0);
  queue.syncAppointmentQueue(root, root.appointments.apt_one, staff, NOW);
  booking.updateBooking(root, "apt_one", {}, { uid: "patient_auth", role: "patient", isStaff: false }, NOW + 1, "cancel");
  assert.equal(Object.values(root.queueEntries)[0].status, "cancelled");
  assert.equal(queue.liveSnapshot(root, "patient_auth", NOW).entries.length, 0);
});

test("manual unlinked queue for the same owner and service is linked during approval", () => {
  const root = seed();
  queue.addQueueEntry(root, { userId: "patient_auth", serviceName: "Complete Laboratory", patientName: "Juan Dela Cruz" }, staff, NOW, "q_manual");
  queue.syncAppointmentQueue(root, root.appointments.apt_one, staff, NOW + 100);
  assert.equal(Object.keys(root.queueEntries).length, 1);
  assert.equal(root.queueEntries.q_manual.appointmentId, "apt_one");
});

test("patients and source-only desktop tokens cannot mutate queue via any staff route", async () => {
  const f = fixture();
  const before = f.read();
  for (const [method, path] of [["post", "/api/staff/queue"], ["patch", "/api/staff/queue/:queueId"], ["delete", "/api/staff/queue/:queueId"]]) {
    const response = await f.request(method, path, { patientName: "Patient", status: "done", role: "admin" }, "patient_auth", { queueId: "missing" });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(f.read(), before);
  assert.equal((await f.request("get", "/api/queue/live", {}, "")).status, 401);
  assert.equal((await f.request("get", "/api/queue/stream", {}, "invalid")).status, 401);
});

test("inactive canonical account status and flags deny queue and legacy staff access", async () => {
  const cases = [
    ["user accountStatus", "users", { accountStatus: "inactive" }],
    ["user active flag", "users", { active: false }],
    ["staff active flag", "staff", { active: false }],
  ];
  for (const [label, collection, patch] of cases) {
    const initial = seed();
    initial[collection] ||= {};
    initial[collection].staff_auth = { ...initial[collection].staff_auth, ...patch };
    const f = fixture(initial);
    const before = f.read();
    const response = await f.request("post", "/api/staff/queue", { appointmentId: "apt_one" }, "staff_auth");
    assert.equal(response.status, 403, label);
    assert.equal(response.body.code, "QUEUE_FORBIDDEN", label);
    assert.deepEqual(f.read(), before, `${label} must reject before mutation`);
    assert.equal((await f.request("get", "/api/queue/live", {}, "staff_auth")).status, 403, label);
    assert.equal((await f.request("get", "/api/queue/stream", {}, "staff_auth")).status, 403, label);
    assert.equal(f.listenerCount(), 0, `${label} must not open a realtime stream`);

    const guard = createStaffAccessGuard({
      getFirebaseApp: () => ({}),
      getDatabase: () => ({ ref: (path) => ({ get: async () => ({ val: () => path.split("/").reduce((record, key) => record?.[key], f.read()) ?? null }) }) }),
      getAuth: () => ({ verifyIdToken: async () => ({ uid: "staff_auth", role: "staff", admin: true }) }),
    });
    let guardStatus = 200;
    let continued = false;
    const res = { status: (value) => { guardStatus = value; return res; }, json: () => res };
    await guard({ headers: { authorization: "Bearer staff_auth" } }, res, () => { continued = true; });
    assert.equal(guardStatus, 403, `${label} must deny legacy staff access even with an admin claim`);
    assert.equal(continued, false, `${label} must not continue to the legacy handler`);
  }
});

test("concurrent staff additions allocate distinct numbers and same appointment retries deduplicate", async () => {
  const f = fixture();
  const responses = await Promise.all([
    f.request("post", "/api/staff/queue", { appointmentId: "apt_one" }, "staff_auth"),
    f.request("post", "/api/staff/queue", { appointmentId: "apt_two" }, "staff_auth"),
    f.request("post", "/api/staff/queue", { appointmentId: "apt_one" }, "staff_auth"),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [201, 201, 200]);
  assert.equal(Object.keys(f.read().queueEntries).length, 2);
  assert.notEqual(responses[0].body.entry.queueNo, responses[1].body.entry.queueNo);
});

test("SSE receives staff changes immediately and detaches database listeners on close", async () => {
  const f = fixture();
  const stream = await f.request("get", "/api/queue/stream");
  assert.equal(f.listenerCount(), 2);
  assert.match(stream.chunks.join(""), /event: queue/);
  await f.request("post", "/api/staff/queue", { appointmentId: "apt_one", id: "q_live" }, "staff_auth");
  assert.match(stream.chunks.at(-1), /Juan C\./);
  assert.doesNotMatch(stream.chunks.join(""), /Juan Dela Cruz|patient_auth/);
  await f.request("patch", "/api/staff/queue/:queueId", { status: "in_service" }, "staff_auth", { queueId: "q_live" });
  assert.match(stream.chunks.at(-1), /"status":"serving"/);
  stream.close();
  assert.equal(f.listenerCount(), 0);
});

test("SSE revalidates active accounts and ends revoked or disabled sessions", async () => {
  const f = fixture(seed(), { revalidateMs: 10 });
  const stream = await f.request("get", "/api/queue/stream");
  const changed = f.read();
  changed.users.patient_auth.disabled = true;
  f.replace(changed);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(stream.chunks.join(""), /event: error/);
  assert.equal(f.listenerCount(), 0);
  stream.close();
});

test("legacy staff and session routes reject forged tokens and patient role escalation", async () => {
  const guard = createStaffAccessGuard({
    getFirebaseApp: () => ({}),
    getDatabase: () => ({ref: path => ({get: async () => ({val: () => path === 'users/verified_staff' ? {role:'staff', status:'active'} : null})})}),
    getAuth: () => ({ verifyIdToken: async token => {
      if (token === 'forged') throw new Error('invalid signature');
      return {uid:token,role:token === 'verified_staff' ? 'staff' : 'patient',source:'desktop'};
    }}),
  });
  for (const [token,expected] of [['',401],['forged',401],['patient',403],['verified_staff',200]]) {
    let status = 200, continued = false;
    const res = {status: value => {status=value; return res;},json: () => res};
    await guard({headers:token ? {authorization:'Bearer '+token} : {},body:{role:'admin'}},res,()=>{continued=true;});
    assert.equal(status, expected);
    assert.equal(continued, expected === 200);
  }
});

test("marking an appointment in progress and completed pushes its linked queue status", () => {
  const root = seed();
  booking.updateBooking(root, 'apt_one', {status:'in_progress'}, {...staff,isStaff:true}, NOW,'decision');
  assert.equal(queue.liveSnapshot(root,'patient_auth',NOW).nowServing[0].status,'serving');
  booking.updateBooking(root, 'apt_one', {status:'completed'}, {...staff,isStaff:true}, NOW+100,'decision');
  assert.equal(queue.liveSnapshot(root,'patient_auth',NOW).nowServing.length,0);
  assert.equal(queue.liveSnapshot(root,'patient_auth',NOW).ownEntry.status,'completed');
});

test("legacy RTDB appointments without an embedded id retain patient linkage", () => {
  const root = seed();
  delete root.appointments.apt_one.id;
  queue.addQueueEntry(root,{appointmentId:'apt_one'},staff,NOW,'legacy_queue');
  assert.equal(root.queueEntries.legacy_queue.appointmentId,'apt_one');
  assert.equal(queue.liveSnapshot(root,'patient_auth',NOW).ownEntry.patientName,'Juan C.');
});

test("real HTTP stream receives add, serving and removal events without reconnecting", async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  const f = fixture();
  f.mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  let reader;
  try {
    const response = await fetch(base + '/api/queue/stream', {headers:{Authorization:'Bearer patient_auth'},signal:controller.signal});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    reader = response.body.getReader();
    let buffer = '';
    const decoder = new TextDecoder();
    async function nextSnapshot() {
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary >= 0) {
            const frame = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2);
            if (frame.includes('event: queue')) return JSON.parse(frame.split('\n').find(line=>line.startsWith('data:')).slice(5));
            continue;
          }
          const chunk = await reader.read();
          assert.equal(chunk.done,false,'stream remains open');
          buffer += decoder.decode(chunk.value,{stream:true});
        }
      } finally { clearTimeout(timeout); }
    }
    assert.equal((await nextSnapshot()).entries.length,0);
    const staffHeaders = {Authorization:'Bearer staff_auth','Content-Type':'application/json'};
    assert.equal((await fetch(base + '/api/staff/queue',{method:'POST',headers:staffHeaders,body:JSON.stringify({id:'http_queue',appointmentId:'apt_one'})})).status,201);
    assert.equal((await nextSnapshot()).ownEntry.patientName,'Juan C.');
    await fetch(base+'/api/staff/queue/http_queue',{method:'PATCH',headers:staffHeaders,body:JSON.stringify({status:'in_service'})});
    assert.equal((await nextSnapshot()).nowServing[0].id,'http_queue');
    await fetch(base+'/api/staff/queue/http_queue',{method:'DELETE',headers:staffHeaders});
    assert.equal((await nextSnapshot()).ownEntry,null);
  } finally {
    controller.abort();
    await reader?.cancel().catch(()=>{});
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});

const journey = require("../src/service-journey");
function visitSeed() {
  const root=seed();
  root.users.admin_auth={role:"admin"};
  root.services={lab:{service_name:"Complete Laboratory",floor:"2nd Floor",room:"Lab",department:"Laboratory",status:"active",estimated_duration:30},xray:{service_name:"Digital X-Ray",floor:"3rd Floor",room:"X-Ray Room",department:"Radiology",status:"active",estimated_duration:20}};
  journey.plan(root,root.appointments.apt_one,["lab","xray"]);
  return root;
}
test("multi-service completion transfers once and completes visit only after the final service", async()=>{
  const f=fixture(visitSeed());
  await f.request("post","/api/staff/queue",{id:"visit_queue",appointmentId:"apt_one"},"staff_auth");
  let entry=f.read().queueEntries.visit_queue;
  assert.equal(entry.floor,"2nd Floor");assert.equal(entry.nextFloor,"3rd Floor");
  const first=entry.appointmentServiceId;
  const patch=(body)=>f.request("patch","/api/staff/queue/:queueId",body,"staff_auth",{queueId:"visit_queue"});
  assert.equal((await patch({status:"done",appointmentServiceId:first})).status,409);
  await patch({status:"in_service",appointmentServiceId:first});
  const transfer={status:"done",appointmentServiceId:first};
  const results=await Promise.all([patch(transfer),patch(transfer)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  entry=f.read().queueEntries.visit_queue;
  assert.equal(entry.floor,"3rd Floor");assert.equal(entry.serviceName,"Digital X-Ray");
  assert.equal(f.read().appointments.apt_one.status,"in_progress");
  assert.equal(Object.keys(f.read().notifications).length,1);
  assert.equal((await f.request("get","/api/queue/live")).body.ownEntry.floor,"3rd Floor");
  await patch({status:"in_service",appointmentServiceId:entry.appointmentServiceId});
  assert.equal((await patch({status:"done",appointmentServiceId:entry.appointmentServiceId})).status,200);
  assert.equal(f.read().appointments.apt_one.status,"completed");
  assert.ok(Object.values(f.read().appointmentServices).every(step=>step.completed_at && step.started_at));
});

test("Complete Visit repairs a stale serving queue row after its appointment was already completed", () => {
  const root = visitSeed();
  const added = queue.addQueueEntry(root, { appointmentId: "apt_one" }, staff, NOW, "stale_completed_queue");
  const entry = added.entry;
  queue.changeQueueEntry(root, entry.id, { status: "in_service", appointmentServiceId: entry.appointmentServiceId }, staff, NOW + 1);
  for (const step of Object.values(root.appointmentServices)) {
    if (step.appointment_id === "apt_one") {
      step.queue_status = "completed";
      step.completed_at = new Date(NOW + 2).toISOString();
    }
  }
  root.appointments.apt_one.status = "completed";
  root.appointments.apt_one.appointmentStatus = "completed";
  queue.changeQueueEntry(root, entry.id, { status: "done", appointmentServiceId: entry.appointmentServiceId }, staff, NOW + 3);
  assert.equal(root.queueEntries[entry.id].status, "done");
  assert.equal(root.queueEntries[entry.id].journeyStatus, "completed");
  assert.equal(root.appointments.apt_one.status, "completed");
  assert.equal(queue.liveSnapshot(root, "patient_auth", NOW + 4).ownEntry.status, "completed");
});
test("service locations are Admin-only and edits update the active destination",async()=>{
  const f=fixture(visitSeed());
  const input={service_name:"Complete Laboratory",floor:"4th Floor",room:"New Lab",department:"Laboratory",status:"active",estimated_duration:30};
  for(const token of ["patient_auth","staff_auth",""]) assert.ok((await f.request("patch","/api/staff/services/:serviceId",input,token,{serviceId:"lab"})).status>=400);
  await f.request("post","/api/staff/queue",{id:"visit_queue",appointmentId:"apt_one"},"staff_auth");
  assert.equal((await f.request("patch","/api/staff/services/:serviceId",input,"admin_auth",{serviceId:"lab"})).status,200);
  assert.equal(f.read().queueEntries.visit_queue.floor,"4th Floor");
  assert.throws(()=>journey.plan(visitSeed(),seed().appointments.apt_one,["lab","missing"]));
  assert.throws(()=>journey.plan(visitSeed(),seed().appointments.apt_one,["lab","lab"]));
});
