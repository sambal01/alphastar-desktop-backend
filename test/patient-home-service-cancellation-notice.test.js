"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { __test: booking } = require("../src/scheduling-routes");

const NOW = Date.parse("2027-02-01T00:00:00Z");
const patient = { uid: "synthetic-patient", role: "patient", isStaff: false };
function seed(status = "pending") {
  return {
    appointments: {
      canonical: {
        id: "legacy-display-id", appointmentNumber: "APT-SYNTHETIC",
        userId: patient.uid, patientName: "Sample Patient",
        serviceName: "Anti-Rabies Vaccine", bookingSource: "mobile", visitType: "home_service",
        status, scheduledAt: "2027-02-10T01:00:00Z", endTime: "10:00",
      },
    },
    notifications: { unrelated: { id: "unrelated", userId: "another-patient", isRead: true } },
    queueEntries: {}, appointmentServices: {},
  };
}
const staffAlerts = root => Object.values(root.notifications).filter(notice => notice.userId === "desktop-staff" && notice.type === "appointment_cancelled");

test("patient home cancellation notifies staff with saved identity, canonical reference and Philippine schedule", () => {
  for (const status of ["pending", "scheduled", "reschedule_requested"]) {
    const root = seed(status);
    const unrelated = structuredClone(root.notifications.unrelated);
    booking.updateBooking(root, "APT-SYNTHETIC", {
      reason: "Changed plan", userId: "another-patient", patientName: "Forged name",
    }, patient, NOW, "cancel");
    const alerts = staffAlerts(root);
    assert.equal(alerts.length, 1);
    const notice = alerts[0];
    assert.equal(notice.referenceId, "canonical");
    assert.equal(notice.referenceType, "appointment");
    assert.equal(notice.source, "mobile");
    assert.equal(notice.isRead, false);
    assert.equal(notice.read, false);
    assert.equal(notice.createdAt, new Date(NOW).toISOString());
    assert.equal(notice.updatedAt, notice.createdAt);
    assert.match(notice.title, /Patient cancelled/);
    for (const text of ["Sample Patient", "APT-SYNTHETIC", "Anti-Rabies Vaccine", "Feb", "2027", "9:00", "AM", "Changed plan", "Home Service History"]) assert.ok(notice.message.includes(text), text);
    assert.ok(!notice.message.includes("Forged name"));
    assert.equal(root.appointments.canonical.status, "cancelled");
    assert.equal(root.appointments.canonical.cancelledAt, notice.createdAt);
    assert.equal(root.appointments.canonical.cancellationReason, "Changed plan");
    assert.deepEqual(root.notifications.unrelated, unrelated);
    assert.ok(!Object.values(root.notifications).some(row => row.userId === patient.uid));
    assert.equal(Object.keys(root.queueEntries).length, 0);
  }
});

test("retry through any appointment alias keeps one alert, its read state and original cancellation time", () => {
  const root = seed();
  booking.updateBooking(root, "canonical", { reason: "Original reason" }, patient, NOW, "cancel");
  const notice = staffAlerts(root)[0];
  notice.isRead = true;
  notice.read = true;
  notice.readAt = new Date(NOW + 1).toISOString();
  const saved = structuredClone(notice);
  for (const reference of ["APT-SYNTHETIC", "legacy-display-id", "canonical"]) {
    booking.updateBooking(root, reference, { reason: "Retried request" }, patient, NOW + 5000, "cancel");
  }
  assert.equal(staffAlerts(root).length, 1);
  assert.deepEqual(root.notifications[notice.id], saved);
  assert.equal(root.appointments.canonical.cancelledAt, new Date(NOW).toISOString());
  assert.equal(root.appointments.canonical.cancellationReason, "Original reason");
});

test("missing appointments, wrong owners and locked visits never emit cancellation alerts", () => {
  for (const scenario of ["missing", "wrong-owner", "completed", "in_progress"]) {
    const root = seed(["completed", "in_progress"].includes(scenario) ? scenario : "pending");
    const before = structuredClone(root);
    assert.throws(() => booking.updateBooking(root, scenario === "missing" ? "not-found" : "canonical", {},
      scenario === "wrong-owner" ? { ...patient, uid: "another-patient" } : patient, NOW, "cancel"));
    assert.deepEqual(root, before);
  }
});

test("staff cancellations and clinic bookings never claim a patient cancelled a home visit", () => {
  const staffRoot = seed();
  booking.updateBooking(staffRoot, "canonical", { status: "cancelled", reason: "Clinic change" },
    { uid: "synthetic-staff", role: "staff", isStaff: true }, NOW, "decision");
  assert.equal(staffAlerts(staffRoot).length, 0);
  const clinicRoot = seed();
  Object.assign(clinicRoot.appointments.canonical, { bookingSource: "website", visitType: "clinic" });
  booking.updateBooking(clinicRoot, "canonical", {}, patient, NOW, "cancel");
  assert.equal(staffAlerts(clinicRoot).length, 0);
});

test("legacy appointments without names or valid schedule use safe readable fallbacks", () => {
  const root = seed();
  const appointment = root.appointments.canonical;
  delete appointment.patientName;
  delete appointment.scheduledAt;
  delete appointment.appointmentNumber;
  booking.updateBooking(root, "canonical", {}, patient, NOW, "cancel");
  const notice = staffAlerts(root)[0];
  assert.match(notice.message, /A patient cancelled canonical/);
  assert.ok(!/undefined|Invalid Date|Reason:/.test(notice.message));
});
