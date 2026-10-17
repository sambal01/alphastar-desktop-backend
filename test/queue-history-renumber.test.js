"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { __test: history } = require("../scripts/renumber-queue-history");

test("history queue numbers are unique, consecutive, and preserve linked service steps", () => {
  const root = {
    queueEntries: {
      later: { queueNo: "A-001", queueNumber: 1, status: "cancelled", createdAt: "2026-09-11T01:00:00.000Z", appointmentId: "appointment_2" },
      active: { queueNo: "A-001", queueNumber: 1, status: "waiting", createdAt: "2026-09-10T01:00:00.000Z", appointmentId: "appointment_3" },
      first: { queueNo: "A-001", queueNumber: 1, status: "done", createdAt: "2026-09-10T01:00:00.000Z", appointmentId: "appointment_1" },
    },
    appointmentServices: {
      firstStep: { appointment_id: "appointment_1", queue_number: "A-001" },
      laterStep: { appointment_id: "appointment_2", queue_number: "A-001" },
    },
  };

  assert.deepEqual(history.normalizeHistory(root), { changed: 1, count: 2 });
  assert.equal(root.queueEntries.first.queueNo, "A-001");
  assert.equal(root.queueEntries.later.queueNo, "A-002");
  assert.equal(root.queueEntries.active.queueNo, "A-001");
  assert.equal(root.appointmentServices.firstStep.queue_number, "A-001");
  assert.equal(root.appointmentServices.laterStep.queue_number, "A-002");
});
