"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isHomeServiceAppointment } = require("../src/appointment-mode");
const { __test: queue } = require("../src/queue-routes");
const now = Date.parse("2026-10-13T08:00:00+08:00");
const staff = { uid: "synthetic_staff", role: "staff" };
function seed(patch = {}) {
  return { appointments: { home: { id: "home", userId: "synthetic_patient", status: "approved",
    scheduledAt: "2026-10-13T09:00:00+08:00", serviceName: "ECG", bookingSource: "mobile", ...patch } },
    queueEntries: { historical: { id: "historical", status: "done", queueNo: "A-001", createdAt: "2026-10-12T01:00:00Z" } } };
}
test("mobile home visits and explicit home services are distinct from clinic bookings", () => {
  for (const row of [{ source: "mobile" }, { booking_source: "mobile" }, { id: "mobile_legacy" },
    { recordKey: "mobile_legacy", id: "embedded" }, { visitType: "home_service", source: "desktop" },
    { serviceMode: "home-visit" }, { serviceName: "Home Service Available" }]) assert.equal(isHomeServiceAppointment(row), true);
  for (const row of [{ source: "desktop", serviceName: "ECG" }, { source: "walk_in" }, { serviceName: "Digital X-Ray" }]) assert.equal(isHomeServiceAppointment(row), false);
});
test("home approval, check-in, service start and completion never create or change a clinic queue", () => {
  const root = seed();
  const prior = structuredClone(root.queueEntries);
  for (const status of ["approved", "scheduled", "checked_in", "in_progress", "completed", "cancelled"]) {
    root.appointments.home.status = status;
    queue.syncAppointmentQueue(root, root.appointments.home, staff, now);
    assert.deepEqual(root.queueEntries, prior);
  }
  assert.equal(root.appointments.home.completedAt, new Date(now).toISOString());
});
test("a direct staff queue request cannot bypass the home-service restriction", () => {
  for (const patch of [{}, { bookingSource: "desktop", visitType: "home_service" }, { bookingSource: "", serviceName: "Home Service Available" }]) {
    const root = seed(patch), prior = structuredClone(root);
    assert.throws(() => queue.addQueueEntry(root, { appointmentId: "home" }, staff, now, "not_allowed"),
      error => error.code === "HOME_SERVICE_NO_QUEUE" && error.status === 409);
    assert.deepEqual(root, prior);
  }
});
test("in-clinic bookings and walk-in additions still receive a queue number", () => {
  const root = seed({ bookingSource: "desktop", visitType: "clinic" });
  queue.syncAppointmentQueue(root, root.appointments.home, staff, now);
  assert.equal(Object.keys(root.queueEntries).length, 2);
  const added = queue.addQueueEntry(root, { patientName: "Synthetic Walk-in", serviceName: "ECG", floor: "1st Floor", room: "Room 101" }, staff, now, "walk_in");
  assert.ok(added.entry.queueNo);
  assert.equal(Object.keys(root.queueEntries).length, 3);
});
