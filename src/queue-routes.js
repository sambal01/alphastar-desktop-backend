"use strict";
const { isHomeServiceAppointment } = require("./appointment-mode");

const crypto = require("node:crypto");
const journey = require("./service-journey");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const STAFF_ROLES = new Set(["admin", "staff", "doctor", "nurse", "receptionist"]);
const ACTIVE = new Set(["waiting", "called", "serving"]);

class QueueError extends Error {
  constructor(message, status = 400, code = "QUEUE_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function clean(value, max = 160) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new QueueError("Invalid queue reference.");
  return id;
}

function clinicDate(value) {
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
}

function dateField(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
}

function normalizeStatus(value) {
  const status = clean(value).toLowerCase().replace(/[ -]+/g, "_");
  if (["in_service", "in_consultation", "in_progress", "serving", "being_served"].includes(status)) return "serving";
  if (["done", "completed", "complete"].includes(status)) return "completed";
  if (["skipped", "no_show"].includes(status)) return "skipped";
  if (["cancelled", "canceled", "removed", "deleted", "rejected", "declined"].includes(status)) return "removed";
  if (["proceed_to_floor", "transferred_to_next_service"].includes(status)) return "waiting";
  if (["called", "next"].includes(status)) return "called";
  if (["waiting", "queued", "pending", "checked_in", ""].includes(status)) return "waiting";
  return "removed";
}

function storedStatus(value) {
  const normalized = normalizeStatus(value);
  if (normalized === "removed" && !["cancelled", "canceled", "removed", "deleted"].includes(clean(value).toLowerCase())) throw new QueueError("Choose a valid queue status.");
  return { serving: "in_service", completed: "done", removed: "cancelled" }[normalized] || normalized;
}

function maskedName(value) {
  const name = clean(value);
  if (!name || /[@\d]/.test(name) || /^(patient|guest|walk[ -]?in)(\b|$)/i.test(name)) return "Patient";
  const words = name.split(" ").filter((part) => /\p{L}/u.test(part));
  if (words.length < 2) return "Patient";
  const first = words[0].replace(/[^\p{L}\p{M}'’-]/gu, "").slice(0, 40);
  const initial = words.at(-1).match(/\p{L}/u)?.[0];
  return first && initial ? `${first} ${initial.toUpperCase()}.` : "Patient";
}

function appointmentFor(root, entry) {
  const reference = entry.appointmentRecordId || entry.appointmentId || entry.appointmentInternalId;
  const appointment = journey.appointmentFor(root, reference);
  if (!appointment) return null;
  return appointment.id ? appointment : { ...appointment, id: journey.appointmentRecordId(root, appointment) || String(reference || "") };
}

function owner(entry, appointment) {
  return String(appointment?.userId || appointment?.patientUserId || appointment?.patientId || entry.userId || entry.patientUserId || entry.patientId || "");
}

function entryDate(entry, appointment) {
  return dateField(entry.queueDate) || clinicDate(entry.checkedInAt) || clinicDate(appointment?.scheduledAt) || dateField(appointment?.appointmentDate || appointment?.date) || clinicDate(entry.createdAt);
}

function liveSnapshot(root, uid, now = Date.now()) {
  const date = clinicDate(now);
  const rows = [];
  for (const [id, entry] of Object.entries(root.queueEntries || {})) {
    if (!entry || typeof entry !== "object" || entry.deletedAt) continue;
    journey.decorate(root, entry);
    const appointment = appointmentFor(root, entry);
    if (entryDate(entry, appointment) !== date) continue;
    let status = normalizeStatus(entry.status);
    if (appointment) {
      const appointmentStatus = clean(appointment.status || appointment.appointmentStatus).toLowerCase();
      if (["cancelled", "canceled", "rejected", "declined", "deleted"].includes(appointmentStatus) || appointment.deletedAt) continue;
      if (appointmentStatus === "completed") status = "completed";
      if (["no_show", "no-show"].includes(appointmentStatus)) status = "skipped";
    }
    if (status === "removed") continue;
    const queueNo = clean(entry.queueNo || (entry.queueNumber ? `A-${String(entry.queueNumber).padStart(3, "0")}` : ""), 20);
    const queuedAt = Date.parse(entry.checkedInAt || entry.createdAt || "") || 0;
    rows.push({
      id,
      queueNo: /^[A-Za-z0-9# -]{1,20}$/.test(queueNo) ? queueNo : "—",
      patientName: maskedName(appointment?.patientName || appointment?.guestName || appointment?.fullName || entry.patientName),
      serviceName: clean(entry.serviceName || appointment?.serviceName || appointment?.reason || entry.service || "Clinic visit"),
      floor: entry.floor || "", room: entry.room || "", department: entry.department || "", nextService: entry.nextService || "", nextFloor: entry.nextFloor || "", journeyStatus: entry.journeyStatus || status, previousService: entry.previousService || "",
      status,
      isOwn: Boolean(uid && owner(entry, appointment) === uid),
      position: null,
      _sequence: Number.isFinite(Number(entry.sequence)) ? Number(entry.sequence) : queuedAt,
      _queuedAt: queuedAt,
    });
  }
  rows.sort((a, b) => a._queuedAt - b._queuedAt || a._sequence - b._sequence || a.id.localeCompare(b.id));
  const priority = { serving: 0, called: 1, waiting: 2, skipped: 3, completed: 4 };
  rows.sort((a, b) => priority[a.status] - priority[b.status]);
  const positions = new Map();
  const entries = rows.map(({ _sequence, _queuedAt, ...entry }) => {
    if (ACTIVE.has(entry.status)) { const key=entry.serviceName; const position=(positions.get(key)||0)+1; positions.set(key,position); entry.position=position; }
    return entry;
  });
  const nowServing = entries.filter((entry) => entry.status === "serving");
  const upcoming = entries.filter((entry) => ["called", "waiting"].includes(entry.status));
  const ownEntry = entries.find((entry) => entry.isOwn && ACTIVE.has(entry.status)) || entries.find((entry) => entry.isOwn) || null;
  return {
    date, serverNow: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), entries,
    nowServing, next: upcoming[0] || null, waiting: upcoming.slice(1),
    ownEntry, ownPosition: ownEntry?.position ?? null, totalWaiting: upcoming.length,
  };
}

function audit(root, entry, actor, action, now) {
  root.auditLogs ||= {};
  const id = `queue_${action}_${entry.id}_${now}`;
  root.auditLogs[id] = { id, actorId: actor.uid, actorRole: actor.role, action: `queue_${action}`, targetId: entry.id, targetType: "queueEntries", source: "desktop", status: "success", createdAt: new Date(now).toISOString() };
}

function destinationKey(root, entry) {
  journey.decorate(root, entry);
  const floor = clean(entry.floor).toLowerCase();
  const room = clean(entry.room).toLowerCase();
  return floor && room ? `${floor}\u0000${room}` : "";
}

function assertDestinationAvailable(root, entry, requestedStatus) {
  const nextStatus = normalizeStatus(requestedStatus);
  const currentStatus = normalizeStatus(entry.status);
  // A patient can wait, but cannot be called into or start in a room that is
  // already serving another patient. Existing serving rows remain valid.
  if (!['called', 'serving'].includes(nextStatus) || currentStatus === 'serving') return;

  const key = destinationKey(root, entry);
  if (!key) return;
  const occupied = Object.entries(root.queueEntries || {}).find(([id, other]) => {
    if (id === entry.id || !other || other.deletedAt || normalizeStatus(other.status) !== 'serving') return false;
    return destinationKey(root, other) === key;
  });
  if (!occupied) return;

  const [floor, room] = key.split('\u0000');
  throw new QueueError(`Cannot ${nextStatus === 'called' ? 'call the next patient' : 'start service'}. ${floor} – ${room} is already in use.`, 409, 'QUEUE_DESTINATION_OCCUPIED');
}

function automaticWaitMinutes(root, input, appointment, now) {
  const floor = clean(input.floor || appointment?.destinationFloor).toLowerCase();
  const room = clean(input.room || appointment?.destinationRoom).toLowerCase();
  const serviceName = clean(appointment?.serviceName || input.serviceName).toLowerCase();
  const services = journey.catalog(root);
  let minutes = 0;
  for (const entry of Object.values(root.queueEntries || {})) {
    if (!entry || entry.deletedAt || !ACTIVE.has(normalizeStatus(entry.status)) || entryDate(entry, appointmentFor(root, entry)) !== clinicDate(now)) continue;
    const sameDestination = floor && room
      ? clean(entry.floor).toLowerCase() === floor && clean(entry.room).toLowerCase() === room
      : clean(entry.serviceName).toLowerCase() === serviceName;
    if (!sameDestination) continue;
    const configured = services.find((service) => clean(service.service_name).toLowerCase() === clean(entry.serviceName).toLowerCase());
    const duration = Number(configured?.estimated_duration);
    // A conservative fallback when the service has no configured duration.
    minutes += Number.isFinite(duration) && duration > 0 ? duration : 30;
  }
  return Math.min(1440, Math.ceil(minutes));
}

function addQueueEntry(root, input, actor, now, id) {
  const reference = clean(input.appointmentRecordId || input.appointmentId || input.appointmentInternalId);
  const appointment = reference ? appointmentFor(root, { appointmentId: reference }) : null;
  const appointmentRecordId = appointment ? journey.appointmentRecordId(root, appointment) : "";
  if (reference && !appointment) throw new QueueError("Appointment not found. Refresh the appointment list.", 404, "QUEUE_APPOINTMENT_NOT_FOUND");
  if (isHomeServiceAppointment(appointment || input)) throw new QueueError("Home-service appointments do not use the clinic queue.", 409, "HOME_SERVICE_NO_QUEUE");
  root.queueEntries ||= {};
  if (appointment && ["cancelled", "canceled", "rejected", "declined", "completed", "deleted"].includes(clean(appointment.status).toLowerCase())) throw new QueueError("This appointment cannot be added to the active queue.", 409);
  const timestamp = new Date(now).toISOString();
  const date = clinicDate(now);
  const uid = owner(input, appointment);
  const existing = Object.values(root.queueEntries).find((entry) => entry && !entry.deletedAt && entryDate(entry, appointmentFor(root, entry)) === date && ACTIVE.has(normalizeStatus(entry.status)) && (
    (appointment && appointmentFor(root, entry)?.id === appointment.id) ||
    ((!appointment || !entry.appointmentId) && uid && owner(entry, appointmentFor(root, entry)) === uid && clean(entry.serviceName).toLowerCase() === clean(appointment?.serviceName || input.serviceName).toLowerCase())
  ));
  if (existing) {
    if (appointment && !existing.appointmentId) {
      existing.appointmentId = appointment.id;
      existing.appointmentRecordId = appointmentRecordId;
      existing.appointmentNumber = appointment.appointmentNumber || appointment.ref || "";
      existing.updatedAt = timestamp;
      existing.updatedBy = actor.uid;
    }
    return { entry: existing, duplicate: true };
  }
  const entryId = safeId(id);
  if (root.queueEntries[entryId]) {
    const previous = root.queueEntries[entryId];
    if (String(previous.appointmentId || "") === String(appointment?.id || "") && String(previous.userId || "") === uid) return { entry: previous, duplicate: true };
    throw new QueueError("This queue reference is already in use.", 409);
  }
  const queueEntries = Object.values(root.queueEntries).filter((entry) => entry && !entry.deletedAt);
  const used = new Set(queueEntries.map((entry) => String(entry.queueNo || "")));
  let number = Math.max(0, ...queueEntries.map((entry) => Number(entry.queueNumber) || Number(String(entry.queueNo || "").match(/\d+$/)?.[0]) || 0)) + 1;
  let queueNo = clean(input.queueNo, 20);
  if (queueNo && !/^[A-Za-z0-9# -]{1,20}$/.test(queueNo)) throw new QueueError("Use a valid queue number.");
  if (queueNo && used.has(queueNo)) throw new QueueError("This queue number is already in use. Choose another number.", 409, "QUEUE_NUMBER_CONFLICT");
  if (!queueNo) {
    while (used.has(`A-${String(number).padStart(3, "0")}`)) number += 1;
    queueNo = `A-${String(number).padStart(3, "0")}`;
  }
  const profile = root.patientProfiles?.[uid] || root.users?.[uid] || {};
  const estimate = input.estimatedWaitMinutes == null
    ? automaticWaitMinutes(root, input, appointment, now)
    : Number(input.estimatedWaitMinutes);
  if (!Number.isFinite(estimate) || estimate < 0 || estimate > 1440) throw new QueueError("Estimated waiting time must be between 0 and 1440 minutes.");
  const hasDestination = input.floor !== undefined || input.room !== undefined;
  const floor = clean(hasDestination ? input.floor : appointment?.destinationFloor);
  const room = clean(hasDestination ? input.room : appointment?.destinationRoom);
  if (hasDestination && (!["1st Floor", "2nd Floor", "3rd Floor"].includes(floor) || !room)) {
    throw new QueueError("Choose 1st Floor, 2nd Floor or 3rd Floor and enter the destination room.", 400, "QUEUE_DESTINATION_REQUIRED");
  }
  if (hasDestination && appointment && !["approved", "confirmed", "scheduled", "checked_in", "in_progress", "in_service", "in_consultation", "serving"].includes(clean(appointment.status).toLowerCase())) {
    throw new QueueError("Approve the appointment before assigning its queue destination.", 409);
  }
  if (appointment && hasDestination) {
    // Keep the staff-assigned destination consistent with My Schedule and
    // journey decoration, which reads the appointment's first destination.
    appointment.destinationFloor = floor;
    appointment.destinationRoom = room;
    appointment.updatedAt = timestamp;
    appointment.updatedBy = actor.uid;
    Object.assign(root.appointments[appointmentRecordId], {
      destinationFloor: floor, destinationRoom: room,
      updatedAt: timestamp, updatedBy: actor.uid,
    });
  }
  const entry = {
    id: entryId, queueNo, queueNumber: Number(queueNo.match(/\d+$/)?.[0]) || number,
    sequence: Math.max(0, ...queueEntries.map((item) => Number(item.sequence || 0))) + 1,
    appointmentId: appointment?.id || appointmentRecordId || "", appointmentRecordId, appointmentNumber: appointment?.appointmentNumber || appointment?.ref || "",
    userId: uid, patientName: clean(appointment?.patientName || appointment?.guestName || profile.fullName || profile.name || input.patientName || "Patient"),
    serviceName: clean(appointment?.serviceName || appointment?.reason || input.serviceName || "Clinic visit"),
    doctor: clean(appointment?.doctor || input.doctor || "Clinic team"),
    floor, room,
    status: input.status ? storedStatus(input.status) : "waiting", estimatedWaitMinutes: estimate,
    queueDate: date, checkedInAt: timestamp, createdAt: timestamp, updatedAt: timestamp, createdBy: actor.uid, updatedBy: actor.uid,
  };
  if (appointment) journey.initialize(root, appointment, entry);
  root.queueEntries[entryId] = entry;
  audit(root, entry, actor, "created", now);
  return { entry, duplicate: false };
}

function changeQueueEntry(root, id, input, actor, now, remove = false) {
  const requestedId = safeId(id);
  const directEntry = root.queueEntries?.[requestedId];
  // Early desktop builds used an entry's embedded id instead of its RTDB
  // record key. Resolve that legacy reference so real queue actions remain
  // usable after a realtime refresh.
  const legacyMatch = directEntry
    ? null
    : Object.entries(root.queueEntries || {}).find(
        ([, candidate]) => candidate && String(candidate.id || "") === requestedId,
      );
  const entry = directEntry || legacyMatch?.[1];
  if (!entry || entry.deletedAt) throw new QueueError("Queue entry not found.", 404, "QUEUE_NOT_FOUND");
  if (remove) {
    entry.status = "cancelled";
    entry.deletedAt = new Date(now).toISOString();
  } else {
    if (input.status !== undefined) assertDestinationAvailable(root, entry, input.status);
    const transferred = journey.update(root, entry, input, actor, now);
    if (input.status !== undefined && !transferred) entry.status = storedStatus(input.status);
    if (input.estimatedWaitMinutes !== undefined) {
      const estimate = Number(input.estimatedWaitMinutes);
      if (!Number.isFinite(estimate) || estimate < 0 || estimate > 1440) throw new QueueError("Estimated waiting time must be between 0 and 1440 minutes.");
      entry.estimatedWaitMinutes = estimate;
    }
  }
  entry.updatedAt = new Date(now).toISOString();
  entry.updatedBy = actor.uid;
  audit(root, entry, actor, remove ? "removed" : "updated", now);
  return entry;
}

// Called inside the appointment transaction: approval and the queue become visible together.
function syncAppointmentQueue(root, appointment, actor, now) {
  if (isHomeServiceAppointment(appointment)) {
    if (String(appointment.status || appointment.appointmentStatus).toLowerCase() === "completed") {
      const completedAt = new Date(now).toISOString();
      appointment.completedAt ||= completedAt;
      for (const step of journey.steps(root, appointment.id)) step.completed_at ||= completedAt;
    }
    return;
  }
  const appointmentRecordId = journey.appointmentRecordId(root, appointment) || appointment.id;
  const appointmentReference = appointment.id || appointmentRecordId;
  const status = clean(appointment.status || appointment.appointmentStatus).toLowerCase();
  if (status === "completed") {
    const completedAt = new Date(now).toISOString();
    for (const step of journey.steps(root, appointment.id)) {
      if (!step.completed_at) {
        step.queue_status = "completed";
        step.completed_at = completedAt;
      }
    }
    appointment.completedAt ||= completedAt;
  }
  const linked = Object.values(root.queueEntries || {}).filter((entry) => {
    const linkedAppointment = appointmentFor(root, entry);
    return linkedAppointment === appointment || journey.appointmentRecordId(root, linkedAppointment) === appointmentRecordId;
  });
  if (["in_progress", "in_service", "in_consultation", "serving"].includes(status)) {
    const result = addQueueEntry(root, { appointmentId: appointmentReference, appointmentRecordId }, actor, now,
      `queue_${crypto.createHash("sha256").update(`${appointmentRecordId}:${clinicDate(now)}`).digest("hex").slice(0, 32)}`);
    changeQueueEntry(root, result.entry.id, { status: "in_service" }, actor, now);
    return;
  }
  const finished = { completed: "done", cancelled: "cancelled", canceled: "cancelled", rejected: "cancelled", declined: "cancelled", deleted: "cancelled", no_show: "skipped", "no-show": "skipped", pending: "cancelled" }[status];
  if (finished) {
    for (const entry of linked) {
      if (!entry.deletedAt && ACTIVE.has(normalizeStatus(entry.status))) changeQueueEntry(root, entry.id, { status: finished }, actor, now);
    }
    return;
  }
  const scheduledDate = clinicDate(appointment.scheduledAt) || dateField(appointment.appointmentDate || appointment.date);
  if (!["approved", "confirmed", "scheduled", "checked_in"].includes(status)) return;
  for (const entry of linked) {
    if (ACTIVE.has(normalizeStatus(entry.status)) && entryDate(entry, appointment) !== scheduledDate) changeQueueEntry(root, entry.id, { status: "cancelled" }, actor, now);
  }
  if (scheduledDate !== clinicDate(now)) return;
  const reusable = linked.find((entry) => !entry.deletedAt && entryDate(entry, appointment) === scheduledDate && normalizeStatus(entry.status) === "removed");
  if (reusable) {
    changeQueueEntry(root, reusable.id, { status: "waiting" }, actor, now);
    return;
  }
  addQueueEntry(root, { appointmentId: appointmentReference, appointmentRecordId }, actor, now, `queue_${crypto.createHash("sha256").update(`${appointmentRecordId}:${scheduledDate}`).digest("hex").slice(0, 32)}`);
}

function queueAccess(options) {
  const getDatabase = options.getDatabase || require("firebase-admin/database").getDatabase;
  const getAuth = options.getAuth || require("firebase-admin/auth").getAuth;

  async function context(req, staffOnly = false) {
    const token = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new QueueError("Sign in to view the live queue.", 401, "QUEUE_UNAUTHENTICATED");
    const firebaseApp = options.getFirebaseApp();
    if (!firebaseApp) throw new QueueError("The live queue is temporarily unavailable.", 503, "QUEUE_UNAVAILABLE");
    let decoded;
    try { decoded = await getAuth(firebaseApp).verifyIdToken(token, true); }
    catch { throw new QueueError("Your session expired. Sign in again.", 401, "QUEUE_UNAUTHENTICATED"); }
    const database = getDatabase(firebaseApp);
    const [userSnap, staffSnap] = await Promise.all([database.ref(`users/${decoded.uid}`).get(), database.ref(`staff/${decoded.uid}`).get()]);
    const user = userSnap.val() || {};
    const staff = staffSnap.val() || {};
    if (user.disabled || user.deletedAt || staff.disabled || staff.deletedAt || user.active === false || staff.active === false || [user.status, user.accountStatus, staff.status, staff.accountStatus].some((value) => ["disabled", "blocked", "inactive", "suspended"].includes(clean(value).toLowerCase()))) throw new QueueError("This account is inactive.", 403, "QUEUE_FORBIDDEN");
    const roles = [user.role || user.accountRole || staff.accountRole || staff.role].map((value) => String(value || "").trim().toLowerCase());
    const isStaff = Boolean(userSnap.val()) && roles.some((role) => STAFF_ROLES.has(role));
    if (staffOnly && !isStaff) throw new QueueError("Only clinic staff can perform this action.", 403, "QUEUE_FORBIDDEN");
    return { database, decoded, actor: { uid: decoded.uid, role: isStaff ? roles.find((role) => STAFF_ROLES.has(role)) || "admin" : "patient" } };
  }
  return context;
}

// Protect legacy staff/profile and session-renewal endpoints too, so a patient
// cannot obtain staff access through an older route and then modify the queue.
function createStaffAccessGuard(options) {
  const context = queueAccess(options);
  return async (req, res, next) => {
    try { req.staffAccess = await context(req, true); next(); }
    catch (error) {
      res.status(error instanceof QueueError ? error.status : 503).json({
        ok: false, error: error instanceof QueueError ? error.message : "Unable to verify staff access.",
      });
    }
  };
}

function registerQueueRoutes(app, options) {
  const clock = options.now || Date.now;
  const context = queueAccess(options);

  function route(handler) {
    return async (req, res) => {
      res.set("Cache-Control", "no-store");
      try { await handler(req, res); }
      catch (error) {
        if (res.headersSent) { res.end(); return; }
        res.status(error.status || 503).json({ ok: false, code: error instanceof QueueError ? error.code : "QUEUE_UNAVAILABLE", error: error instanceof QueueError || error.code === "JOURNEY_INVALID" ? error.message : "The live queue is temporarily unavailable. Reconnecting may help." });
      }
    };
  }

  async function mutate(database, apply) {
    const ref = database.ref();
    let rejection;
    let result;
    const transaction = await transactionWithLiveSnapshot(ref, (current) => {
      result = undefined;
      rejection = undefined;
      const root = JSON.parse(JSON.stringify(current || {}));
      try { result = apply(root, clock()); rejection = undefined; return root; }
      catch (error) { rejection = error; return undefined; }
    });
    if (rejection) throw rejection;
    if (!transaction.committed || result === undefined) throw new QueueError("The queue changed. Please try again.", 409, "QUEUE_CONFLICT");
    return result;
  }

  app.get("/api/services", route(async (req, res) => {
    const { database } = await context(req);
    const services = await mutate(database, (root, now) => {
      journey.ensureDefaults(root, now);
      return journey.catalog(root);
    });
    res.json({ services });
  }));
  app.patch("/api/staff/services/:serviceId", route(async (req, res) => {
    const { database, actor } = await context(req, true);
    if (actor.role !== "admin") throw new QueueError("Only administrators can change service locations.", 403);
    const record = journey.validateService(req.params.serviceId, req.body);
    const result = await mutate(database, (root, now) => {
      root.services ||= {};
      journey.ensureDefaults(root, now);
      const duplicate = journey.catalog(root).find(s => s.service_id !== record.service_id && s.service_name.toLowerCase() === record.service_name.toLowerCase());
      if (duplicate) throw new QueueError("A service with this name already exists.",409);
      root.services[record.service_id] = {...root.services[record.service_id], ...record, updatedAt:new Date(now).toISOString()};
      Object.values(root.queueEntries || {}).forEach(entry=>journey.decorate(root,entry));
      audit(root, {id:record.service_id}, actor, "service_location_updated", now);
      return root.services[record.service_id];
    });
    res.json({ok:true,service:result});
  }));
  app.get("/api/queue/live", route(async (req, res) => {
    const { database, actor } = await context(req);
    const [queue, appointments, services, appointmentServices] = await Promise.all([database.ref("queueEntries").get(), database.ref("appointments").get(), database.ref("services").get(), database.ref("appointmentServices").get()]);
    res.json(liveSnapshot({ queueEntries: queue.val(), appointments: appointments.val(), services: services.val(), appointmentServices: appointmentServices.val() }, actor.uid, clock()));
  }));

  app.get("/api/queue/stream", route(async (req, res) => {
    const { database, actor, decoded } = await context(req);
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    const refs = [database.ref("queueEntries"), database.ref("appointments")];
    const root = {};
    const ready = new Set();
    let ended = false;
    let scheduled = false;
    let lastPayload = "";
    let checking = false;
    let heartbeat;
    let revalidate;
    const listeners = [];
    const cleanup = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      clearInterval(revalidate);
      refs.forEach((ref, index) => { if (listeners[index]) ref.off("value", listeners[index]); });
    };
    res.on("close", cleanup);
    req.on("aborted", cleanup);
    const fail = (message) => {
      if (ended) return;
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      cleanup();
      res.end();
    };
    const publish = () => {
      if (ended || ready.size !== 2) return;
      const snapshot = liveSnapshot(root, actor.uid, clock());
      const payload = JSON.stringify({ ...snapshot, serverNow: undefined, updatedAt: undefined });
      if (payload === lastPayload) return;
      lastPayload = payload;
      res.write(`event: queue\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    ["queueEntries", "appointments"].forEach((key, index) => {
      const listener = (snapshot) => {
        root[key] = snapshot.val() || {};
        ready.add(key);
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; publish(); });
      };
      listeners.push(listener);
      refs[index].on("value", listener, () => fail("The live queue connection was interrupted."));
    });
    if (ended) return;
    heartbeat = setInterval(() => {
      if (decoded.exp && clock() >= decoded.exp * 1000) { fail("Your session expired. Reconnecting with your renewed session."); return; }
      if (!ended) { publish(); res.write(`: heartbeat\nevent: heartbeat\ndata: ${JSON.stringify({ serverNow: new Date(clock()).toISOString() })}\n\n`); }
    }, options.heartbeatMs || 15000);
    revalidate = setInterval(async () => {
      if (ended || checking) return;
      checking = true;
      try { await context(req); }
      catch { fail("Your session is no longer active. Sign in again."); }
      finally { checking = false; }
    }, options.revalidateMs || 60000);
    heartbeat.unref?.();
    revalidate.unref?.();
  }));

  app.post("/api/staff/queue", route(async (req, res) => {
    const { database, actor } = await context(req, true);
    const id = req.body.id || req.body.requestId || req.headers["idempotency-key"] || `queue_${crypto.randomUUID()}`;
    const result = await mutate(database, (root, now) => addQueueEntry(root, req.body, actor, now, id));
    res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result, queueEntry: result.entry });
  }));

  app.patch("/api/staff/queue/:queueId", route(async (req, res) => {
    const { database, actor } = await context(req, true);
    const entry = await mutate(database, (root, now) => changeQueueEntry(root, req.params.queueId, req.body, actor, now));
    res.json({ ok: true, entry, queueEntry: entry });
  }));

  app.delete("/api/staff/queue/:queueId", route(async (req, res) => {
    const { database, actor } = await context(req, true);
    const entry = await mutate(database, (root, now) => changeQueueEntry(root, req.params.queueId, {}, actor, now, true));
    res.json({ ok: true, entry, queueEntry: entry });
  }));
}

module.exports = { registerQueueRoutes, createStaffAccessGuard, syncAppointmentQueue, __test: { QueueError, clinicDate, maskedName, normalizeStatus, liveSnapshot, addQueueEntry, changeQueueEntry, syncAppointmentQueue, destinationKey } };
