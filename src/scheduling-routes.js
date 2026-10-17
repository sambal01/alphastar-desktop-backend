"use strict";

const crypto = require("node:crypto");
const journey = require("./service-journey");
const { syncAppointmentQueue } = require("./queue-routes");
const { isHomeServiceAppointment } = require("./appointment-mode");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");

const DEFAULT_SERVICES = [
  "Check-Up Bata-Matanda", "Complete Laboratory", "Digital X-Ray", "ECG", "2D Echo",
  "Drug Test", "Ultrasound with Transvaginal", "Pap Smear", "Circumcision (Tuli)",
  "School Package", "Buntis Package", "Anti-Rabies Vaccine", "Anti-Tetanus Toxoid",
  "Employment Package", "Blood Chemistry Promo Package (8 Tests)", "Home Service Available",
];
const STAFF_ROLES = new Set(["admin", "staff", "doctor", "nurse", "receptionist"]);
const RELEASED_STATUSES = new Set(["cancelled", "canceled", "rejected", "declined", "deleted", "no_show", "no-show"]);

class BookingError extends Error {
  constructor(message, status = 400, code = "BOOKING_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function clean(value, max = 160) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeService(value) {
  return clean(value).toLowerCase();
}

function serviceKey(value) {
  return crypto.createHash("sha256").update(normalizeService(value)).digest("hex");
}

function requireService(value) {
  const name = clean(value);
  if (!name) throw new BookingError("Select a clinic service.");
  return name;
}

function requireDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new BookingError("Choose a valid appointment date.");
  }
  return date;
}

function requireTime(value) {
  const time = String(value || "");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BookingError("Use a valid time in HH:mm format.");
  return time;
}

function slotId(startTime, endTime) {
  return `${startTime.replace(":", "")}-${endTime.replace(":", "")}`;
}

function slotStart(date, time) {
  return Date.parse(`${date}T${time}:00+08:00`);
}

function philippineParts(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new BookingError("Choose a valid appointment time.");
  const local = new Date(parsed.getTime() + 8 * 60 * 60 * 1000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

function defaultSlots(date) {
  const closingHour = new Date(`${requireDate(date)}T00:00:00Z`).getUTCDay() === 0 ? 16 : 17;
  return Array.from({ length: closingHour - 7 }, (_, offset) => {
    const hour = 7 + offset;
    const startTime = `${String(hour).padStart(2, "0")}:00`;
    const endTime = `${String(hour + 1).padStart(2, "0")}:00`;
    return { id: slotId(startTime, endTime), startTime, endTime, capacity: hour === 9 ? 3 : 2, isBreak: hour === 12, closed: false };
  });
}

function validateSlots(input) {
  if (!Array.isArray(input) || input.length > 96) throw new BookingError("Provide at most 96 time slots.");
  const slots = input.map((item) => {
    const startTime = requireTime(item?.startTime);
    const endTime = requireTime(item?.endTime);
    if (endTime <= startTime) throw new BookingError("Each slot must end after it starts.");
    const capacity = Number(item?.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new BookingError("Slot capacity must be a whole number between 1 and 1000.");
    if (typeof item.isBreak !== "boolean" || typeof item.closed !== "boolean") throw new BookingError("Set break and closed values for each slot.");
    return { id: slotId(startTime, endTime), startTime, endTime, capacity, isBreak: item.isBreak, closed: item.closed };
  }).sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (let i = 1; i < slots.length; i += 1) {
    if (slots[i].startTime < slots[i - 1].endTime) throw new BookingError("Time slots and breaks must not overlap.");
  }
  return slots;
}

function getSchedule(root, serviceName, date) {
  return root.serviceSlotSchedules?.[date]?.[serviceKey(serviceName)] || null;
}

function configSlots(root, serviceName, date) {
  const config = getSchedule(root, serviceName, date);
  // RTDB omits empty arrays. The configured flag keeps an intentionally empty day closed.
  return config?.configured ? Object.values(config.slots || {}) : defaultSlots(date);
}

function assertKnownService(root, serviceName, date) {
  const normalized = normalizeService(serviceName);
  const known = DEFAULT_SERVICES.some((name) => normalizeService(name) === normalized)
    || Object.values(root.services || {}).some((service) => normalizeService(typeof service === "string" ? service : service.name || service.serviceName || service.title) === normalized)
    || Object.values(root.appointments || {}).some((item) => normalizeService(item.serviceName || item.reason) === normalized)
    || Boolean(getSchedule(root, serviceName, date));
  if (!known) throw new BookingError("This clinic service is not available. Refresh the service list.");
}

function appointmentLocation(item) {
  // scheduledAt is authoritative when the desktop has rescheduled an older appointment.
  if (item.scheduledAt && Number.isFinite(Date.parse(item.scheduledAt))) return philippineParts(item.scheduledAt);
  const date = item.appointmentDate || item.date;
  let time = String(item.startTime || item.time || "");
  const displayTime = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (displayTime) time = `${String(Number(displayTime[1]) % 12 + (displayTime[3].toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0")}:${displayTime[2]}`;
  return { date, time: time.slice(0, 5) };
}

function consumesCapacity(item) {
  return item && !RELEASED_STATUSES.has(String(item.status || item.appointmentStatus || "pending").toLowerCase()) && !item.deletedAt;
}

function matchingBookings(root, serviceName, date, excludedId = "") {
  const result = {};
  const normalized = normalizeService(serviceName);
  for (const [id, appointment] of Object.entries(root.appointments || {})) {
    if (id === excludedId || !consumesCapacity(appointment) || normalizeService(appointment.serviceName || appointment.reason) !== normalized) continue;
    const location = appointmentLocation(appointment);
    if (location.date !== date || !location.time) continue;
    result[id] = { startTime: location.time, userId: String(appointment.userId || appointment.patientUserId || appointment.patientId || ""), status: appointment.status || "pending" };
  }
  return result;
}

function countSlot(bookings, slot) {
  return Object.values(bookings).filter((booking) => booking.startTime >= slot.startTime && booking.startTime < slot.endTime).length;
}

function listSlots(root, serviceName, date, now = Date.now()) {
  const bookings = matchingBookings(root, serviceName, date);
  const config = getSchedule(root, serviceName, date);
  return {
    serviceName,
    date,
    revision: Number(config?.revision || 0),
    serverNow: new Date(now).toISOString(),
    slots: configSlots(root, serviceName, date).map((slot) => {
      const bookedCount = countSlot(bookings, slot);
      const remaining = Math.max(0, slot.capacity - bookedCount);
      const unavailable = slot.closed || slot.isBreak || slotStart(date, slot.startTime) <= now;
      return { ...slot, bookedCount, remaining, status: unavailable ? "unavailable" : remaining === 0 ? "full" : "available" };
    }),
  };
}

function writeSchedule(root, serviceName, date, slots, revision, actorId, now) {
  root.serviceSlotSchedules ||= {};
  root.serviceSlotSchedules[date] ||= {};
  root.serviceSlotSchedules[date][serviceKey(serviceName)] = {
    configured: true,
    serviceName,
    date,
    slots,
    revision,
    bookings: matchingBookings(root, serviceName, date),
    updatedAt: new Date(now).toISOString(),
    updatedBy: actorId,
  };
}

function refreshBookings(root, serviceName, date, actorId, now) {
  const existing = getSchedule(root, serviceName, date);
  writeSchedule(root, serviceName, date, configSlots(root, serviceName, date), Number(existing?.revision || 0), actorId, now);
}

function saveSchedule(root, input, actor, now) {
  const serviceName = requireService(input.serviceName);
  const date = requireDate(input.date);
  assertKnownService(root, serviceName, date);
  const revision = Number(input.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new BookingError("Refresh the schedule before saving.");
  const current = getSchedule(root, serviceName, date);
  if (revision !== Number(current?.revision || 0)) throw new BookingError("This schedule was changed by another staff member. Reload it before saving.", 409, "SCHEDULE_CONFLICT");
  const bookings = matchingBookings(root, serviceName, date);
  const slots = validateSlots(input.slots);
  for (const slot of slots) {
    const booked = countSlot(bookings, slot);
    if (booked > slot.capacity) throw new BookingError(`Capacity for ${slot.startTime} cannot be lower than its ${booked} existing appointment(s).`, 409, "SLOT_HAS_BOOKINGS");
    if (slot.isBreak && booked) throw new BookingError(`Move or cancel the appointments at ${slot.startTime} before making it a break.`, 409, "SLOT_HAS_BOOKINGS");
  }
  // Keep a removed booked interval visible but closed; never delete a patient's reservation.
  for (const oldSlot of configSlots(root, serviceName, date)) {
    const booked = countSlot(bookings, oldSlot);
    if (booked && !slots.some((slot) => slot.id === oldSlot.id)) {
      slots.push({ ...oldSlot, capacity: Math.max(oldSlot.capacity, booked), closed: true, isBreak: false });
    }
  }
  const validated = validateSlots(slots);
  writeSchedule(root, serviceName, date, validated, revision + 1, actor.uid, now);
  return listSlots(root, serviceName, date, now);
}

function patientName(root, uid, fallback) {
  const profile = root.patientProfiles?.[uid] || root.profiles?.[uid] || {};
  const user = root.users?.[uid] || {};
  return clean(profile.fullName || profile.name || user.fullName || user.name || fallback || "Patient");
}

function assertBookable(root, serviceName, scheduledAt, now, excludedId = "") {
  if (typeof scheduledAt !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledAt)) throw new BookingError("Appointment time must include its timezone.");
  const location = philippineParts(scheduledAt);
  requireDate(location.date);
  assertKnownService(root, serviceName, location.date);
  const slot = configSlots(root, serviceName, location.date).find((candidate) => candidate.startTime === location.time);
  if (!slot || slot.closed || slot.isBreak) throw new BookingError("This time is unavailable. Choose another time.", 409, "SLOT_UNAVAILABLE");
  if (Date.parse(scheduledAt) !== slotStart(location.date, slot.startTime)) throw new BookingError("Choose the exact start time of an available slot.");
  if (slotStart(location.date, slot.startTime) <= now) throw new BookingError("This time has already passed. Choose a later time.", 409, "SLOT_EXPIRED");
  if (countSlot(matchingBookings(root, serviceName, location.date, excludedId), slot) >= slot.capacity) throw new BookingError("This time was just filled. Choose another time.", 409, "SLOT_FULL");
  return { slot, ...location };
}

function validateId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new BookingError("Invalid appointment reference.");
  return id;
}

function resolveAppointment(root, value) {
  const reference = validateId(value);
  const direct = root.appointments?.[reference];
  if (direct && typeof direct === "object") {
    return { appointment: direct, recordId: reference };
  }

  // Older records may be addressed by their embedded id, appointment number,
  // or legacy reference instead of their Realtime Database record key.
  const match = Object.entries(root.appointments || {}).find(([, candidate]) =>
    candidate &&
    typeof candidate === "object" &&
    [
      candidate.id,
      candidate.appointmentId,
      candidate.appointmentNumber,
      candidate.ref,
      candidate.referenceId,
    ].some((candidateReference) => String(candidateReference || "") === reference),
  );

  return match
    ? { appointment: match[1], recordId: match[0] }
    : { appointment: null, recordId: reference };
}

function addAudit(root, id, actor, action, appointment, now) {
  root.auditLogs ||= {};
  root.auditLogs[id] = {
    id, actorId: actor.uid, actorEmail: actor.email || "", actorRole: actor.role || "patient",
    action, appointmentId: appointment.id, targetId: appointment.id, targetType: "appointments",
    summary: `${appointment.patientName} ${action.replaceAll("_", " ")}.`,
    status: "success", source: actor.isStaff ? "desktop" : "mobile", createdAt: new Date(now).toISOString(),
  };
}

function destinationForAppointment(root, appointment, input = {}) {
  if (isHomeServiceAppointment(appointment)) return { floor: "", room: "", department: "", serviceId: "" };
  const serviceIds = [appointment.serviceId, ...(appointment.serviceIds || [])].filter(Boolean);
  const suppliedFloor = clean(input.destinationFloor ?? input.floor ?? appointment.destinationFloor, 160);
  const suppliedRoom = clean(input.destinationRoom ?? input.room ?? appointment.destinationRoom, 160);
  if (!suppliedFloor || !suppliedRoom) throw new BookingError("Choose the destination floor and enter the destination room before approving this appointment.");
  if (!["1st Floor", "2nd Floor", "3rd Floor"].includes(suppliedFloor)) throw new BookingError("Choose 1st Floor, 2nd Floor, or 3rd Floor for the destination.");
  return {
    floor: suppliedFloor,
    room: suppliedRoom,
    department: clean(input.destinationDepartment ?? input.department ?? appointment.destinationDepartment, 160),
    serviceId: appointment.destinationServiceId || serviceIds[0] || "",
  };
}

function notifyApprovedDestination(root, appointment, destination, now) {
  root.notifications ||= {};
  const timestamp = new Date(now).toISOString();
  const location = destination.floor && destination.room ? `${destination.floor} – ${destination.room}` : "";
  const id = `appointment_destination_${appointment.id}`;
  root.notifications[id] = {
    id, userId: appointment.userId || appointment.patientUserId || appointment.patientId,
    type: "appointment", referenceType: "appointment", referenceId: appointment.id,
    title: "Appointment approved",
    message: isHomeServiceAppointment(appointment)
      ? `Your ${appointment.serviceName || appointment.reason || "home-service"} home-service appointment is approved. Clinic staff will coordinate the visit with you. No clinic queue number is needed.`
      : location
      ? `Your ${appointment.serviceName || appointment.reason || "clinic"} appointment is approved. Destination: ${location}. Please proceed there when your queue number is called.`
      : `Your ${appointment.serviceName || appointment.reason || "clinic"} appointment is approved. The clinic will send your destination before your visit.`,
    isRead: false, read: false, createdAt: timestamp, updatedAt: timestamp,
  };
}

function createBooking(root, input, actor, now) {
  const id = validateId(input.id);
  const serviceName = requireService(input.serviceName);
  const uid = actor.isStaff ? clean(input.userId || input.patientUserId, 128) : actor.uid;
  if (!uid) throw new BookingError("Select the patient account for this appointment.");
  const existing = root.appointments?.[id];
  if (existing) {
    if (input.serviceIds !== undefined && JSON.stringify(input.serviceIds) !== JSON.stringify(existing.serviceIds)) throw new BookingError("This appointment already has a different service sequence.",409,"APPOINTMENT_CONFLICT");
    const owner = existing.userId || existing.patientUserId || existing.patientId;
    if (owner === uid && normalizeService(existing.serviceName) === normalizeService(serviceName) && Date.parse(existing.scheduledAt) === Date.parse(input.scheduledAt)) return existing;
    throw new BookingError("This appointment reference already exists. Refresh your appointments.", 409, "APPOINTMENT_CONFLICT");
  }
  const { slot, date, time } = assertBookable(root, serviceName, input.scheduledAt, now);
  const name = patientName(root, uid, input.patientName);
  const email = clean(root.users?.[uid]?.email || (actor.isStaff ? input.email : actor.email), 254);
  const contact = clean(input.contactNumber || root.patientProfiles?.[uid]?.phone || "", 40);
  const timestamp = new Date(now).toISOString();
  const ref = `APT-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 12).toUpperCase()}`;
  const appointment = {
    id, userId: uid, patientId: uid, patientUserId: uid,
    patientName: name, guestName: name, patientEmail: email, contactEmail: email, guestEmail: email, email,
    contactNumber: contact, contactPhone: contact, guestPhone: contact, phone: contact,
    serviceName, reason: serviceName, scheduledAt: new Date(slotStart(date, time)).toISOString(),
    appointmentDate: date, startTime: slot.startTime, endTime: slot.endTime, time: slot.startTime,
    timeSlotId: slot.id, serviceSlotKey: serviceKey(serviceName), slotReservation: true,
    appointmentNumber: ref, ref, status: "pending", appointmentStatus: "pending", paymentStatus: "unpaid",
    notes: clean(input.notes, 2000), doctor: clean(input.doctor || "Clinic team"),
    bookingSource: actor.isStaff ? "desktop" : "mobile", booking_source: actor.isStaff ? "desktop" : "mobile",
    source: actor.isStaff ? "desktop" : "mobile", createdAt: timestamp, updatedAt: timestamp,
    visitType: actor.isStaff ? "clinic" : "home_service",
    createdBy: actor.uid, updatedBy: actor.uid,
  };
  if (input.serviceId) appointment.serviceId = clean(input.serviceId);
  if (actor.isStaff && input.doctorId) appointment.doctorId = clean(input.doctorId);
  root.appointments ||= {};
  if (input.serviceIds !== undefined) journey.plan(root, appointment, input.serviceIds);
  root.appointments[id] = appointment;
  refreshBookings(root, serviceName, date, actor.uid, now);
  addAudit(root, `booking_created_${id}`, actor, "appointment_created", appointment, now);
  const notificationId = `booking_received_${id}`;
  root.notifications ||= {};
  root.notifications[notificationId] = {
    id: notificationId, userId: uid, type: "appointment", referenceType: "appointment", referenceId: id,
    title: "Appointment request received",
    message: `Your ${serviceName} appointment request for ${date} at ${slot.startTime} was submitted successfully. It is pending clinic approval. View it in My schedule on Home.`,
    isRead: false, read: false, createdAt: timestamp, updatedAt: timestamp,
  };
  if (!actor.isStaff) {
    const staffNoticeId = "appointment-" + id;
    root.notifications[staffNoticeId] = {
      id: staffNoticeId, userId: "desktop-staff", type: "appointment", source: "mobile",
      referenceType: "appointment", referenceId: id,
      title: "New Mobile Appointment",
      message: name + " booked " + serviceName + " for " + date + " at " + slot.startTime + ".",
      isRead: false, read: false, createdAt: timestamp, updatedAt: timestamp,
    };
  }
  return appointment;
}

function updateBooking(root, id, input, actor, now, action) {
  const { appointment, recordId } = resolveAppointment(root, id);
  if (!appointment) throw new BookingError("Appointment not found.", 404, "APPOINTMENT_NOT_FOUND");
  const owner = appointment.userId || appointment.patientUserId || appointment.patientId;
  if (!actor.isStaff && owner !== actor.uid) throw new BookingError("You cannot change this appointment.", 403, "BOOKING_FORBIDDEN");
  const oldLocation = appointmentLocation(appointment);
  const serviceName = requireService(appointment.serviceName || appointment.reason);
  const previousActive = consumesCapacity(appointment);
  const wasApproved = ["approved", "confirmed", "scheduled"].includes(String(appointment.status || appointment.appointmentStatus || "").toLowerCase());
  const wasRescheduleRequested = String(appointment.status || appointment.appointmentStatus || "").toLowerCase() === "reschedule_requested";
  if (action === "schedule") {
    if (!actor.isStaff) throw new BookingError("Only clinic staff can reschedule appointments.", 403, "BOOKING_FORBIDDEN");
    const next = assertBookable(root, serviceName, input.scheduledAt, now, recordId);
    Object.assign(appointment, {
      scheduledAt: new Date(slotStart(next.date, next.time)).toISOString(), appointmentDate: next.date,
      startTime: next.slot.startTime, endTime: next.slot.endTime, time: next.slot.startTime,
      timeSlotId: next.slot.id, status: "scheduled", appointmentStatus: "scheduled",
    });
    if (wasRescheduleRequested) {
      delete appointment.requestedScheduledAt;
    }
  } else {
    const status = action === "cancel" ? "cancelled" : String(input.status || "").toLowerCase();
    if (!["pending", "confirmed", "scheduled", "approved", "checked_in", "in_progress", "in_service", "in_consultation", "serving", "completed", ...RELEASED_STATUSES].includes(status)) throw new BookingError("Choose a valid appointment status.");
    if (!actor.isStaff && ["completed", "checked_in", "in_progress", "in_service", "in_consultation", "serving"].includes(appointment.status)) throw new BookingError("Please contact clinic staff to change this appointment.", 409, "APPOINTMENT_LOCKED");
    if (!previousActive && !RELEASED_STATUSES.has(status)) assertBookable(root, serviceName, appointment.scheduledAt, now, recordId);
    appointment.status = status;
    appointment.appointmentStatus = status;
  }
  appointment.decisionReason = clean(input.reason, 1000);
  if (actor.isStaff && !wasApproved && ["approved", "confirmed", "scheduled"].includes(appointment.status)) {
    const destination = destinationForAppointment(root, appointment, input);
    appointment.destinationFloor = destination.floor;
    appointment.destinationRoom = destination.room;
    appointment.destinationDepartment = destination.department;
    appointment.destinationServiceId = destination.serviceId;
    notifyApprovedDestination(root, appointment, destination, now);
  }
  appointment.updatedAt = new Date(now).toISOString();
  appointment.updatedBy = actor.uid;
  if (oldLocation.date) refreshBookings(root, serviceName, oldLocation.date, actor.uid, now);
  const newLocation = appointmentLocation(appointment);
  if (newLocation.date && newLocation.date !== oldLocation.date) refreshBookings(root, serviceName, newLocation.date, actor.uid, now);
  addAudit(root, `booking_${action}_${recordId}_${now}`, actor, `appointment_${action === "cancel" ? "cancelled" : action === "schedule" ? "rescheduled" : "decision"}`, appointment, now);
  syncAppointmentQueue(root, appointment, actor, now);
  return appointment;
}

function registerBookingRoutes(app, options) {
  const clock = options.now || Date.now;
  const getDatabase = options.getDatabase || require("firebase-admin/database").getDatabase;
  const getAuth = options.getAuth || require("firebase-admin/auth").getAuth;
  async function legacyAppointments() {
    if (options.loadLegacyAppointments) {
      try {
        return await options.loadLegacyAppointments();
      } catch (error) {
        // Firestore is only a legacy appointment source. A disabled, missing,
        // or permission-restricted Firestore database must not stop RTDB
        // availability from loading or saving.
        console.warn("Legacy Firestore appointments are unavailable; using Realtime Database schedules.", error.message);
        return {};
      }
    }
    // The clinic's canonical appointment store is Realtime Database. Do not
    // query Firestore as a fallback: this project intentionally does not
    // require the Firestore API for booking, staff decisions, or queue flow.
    return {};
  }

  function mergeLegacy(root, legacy) {
    // Keep original Firestore documents; canonical RTDB updates always take precedence.
    root.appointments = { ...legacy, ...(root.appointments || {}) };
    return root;
  }

  async function context(req, requireStaff = false) {
    const firebaseApp = options.getFirebaseApp();
    if (!firebaseApp) throw new BookingError("Clinic booking server is not configured. Please contact the clinic.", 503, "BOOKING_NOT_CONFIGURED");
    const token = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new BookingError("Sign in to continue.", 401, "BOOKING_UNAUTHENTICATED");
    let decoded;
    try { decoded = await getAuth(firebaseApp).verifyIdToken(token, true); }
    catch { throw new BookingError("Your session expired. Sign in again.", 401, "BOOKING_UNAUTHENTICATED"); }
    const database = getDatabase(firebaseApp);
    const [userSnap, staffSnap] = await Promise.all([database.ref(`users/${decoded.uid}`).get(), database.ref(`staff/${decoded.uid}`).get()]);
    const user = userSnap.val() || {};
    const staff = staffSnap.val() || {};
    if (!Boolean(userSnap.val()) || user.disabled || user.deletedAt || staff.disabled || staff.deletedAt || user.active === false || staff.active === false || [user.status, user.accountStatus, staff.status, staff.accountStatus].some((value) => ["disabled", "blocked", "inactive", "suspended"].includes(String(value || "").toLowerCase()))) throw new BookingError("This account is inactive.", 403, "BOOKING_FORBIDDEN");
    const roles = [user.role || user.accountRole || staff.accountRole || staff.role].map((value) => String(value || "").trim().toLowerCase());
    const isStaff = Boolean(userSnap.val()) && roles.some((role) => STAFF_ROLES.has(role));
    if (requireStaff && !isStaff) throw new BookingError("Only clinic staff can change the schedule.", 403, "BOOKING_FORBIDDEN");
    return { database, actor: { uid: decoded.uid, email: decoded.email || user.email || "", isStaff, role: isStaff ? roles.find((role) => STAFF_ROLES.has(role)) || "admin" : "patient" } };
  }

  function route(handler) {
    return async (req, res) => {
      res.set("Cache-Control", "no-store");
      try { await handler(req, res); }
      catch (error) {
        if (!(error instanceof BookingError)) console.error("Booking request failed:", error.code || error.message);
        res.status(error.status || 503).json({ ok: false, code: error.code || "BOOKING_UNAVAILABLE", error: error instanceof BookingError ? error.message : "Unable to load or save clinic availability. Please try again." });
      }
    };
  }

  async function mutate(database, apply) {
    let rejection;
    let result;
    const legacy = await legacyAppointments();
    // Appointments and service schedules share one transaction so legacy staff changes,
    // cancellations, and concurrent patients cannot race the capacity check. This is a
    // deliberate compatibility choice for this clinic; shard before very large datasets.
    const ref = database.ref();
    const transaction = await transactionWithLiveSnapshot(ref, (current) => {
      result = undefined;
      rejection = undefined;
      const root = mergeLegacy(JSON.parse(JSON.stringify(current || {})), legacy);
      try { result = apply(root, clock()); rejection = undefined; return root; }
      catch (error) { rejection = error; return undefined; }
    });
    if (rejection) throw rejection;
    if (!transaction.committed || result === undefined) throw new BookingError("The schedule changed. Refresh and try again.", 409, "SCHEDULE_CONFLICT");
    return result;
  }

  app.get("/api/booking/slots", route(async (req, res) => {
    const { database } = await context(req);
    const serviceName = requireService(req.query.service);
    const date = requireDate(req.query.date);
    const [snapshot, legacy] = await Promise.all([database.ref().get(), legacyAppointments()]);
    const root = mergeLegacy(snapshot.val() || {}, legacy);
    assertKnownService(root, serviceName, date);
    res.json(listSlots(root, serviceName, date, clock()));
  }));

  app.post("/api/booking/schedule", route(async (req, res) => {
    const { database, actor } = await context(req, true);
    if (actor.role !== "admin") throw new BookingError("Only administrators can manage booking schedules.", 403, "BOOKING_FORBIDDEN");
    const result = await mutate(database, (root, now) => saveSchedule(root, req.body, actor, now));
    res.json({ ok: true, ...result });
  }));

  app.post("/api/booking/appointments", route(async (req, res) => {
    const { database, actor } = await context(req);
    const appointment = await mutate(database, (root, now) => createBooking(root, req.body, { ...actor, isStaff: false }, now));
    res.status(201).json({ ok: true, name: appointment.id, appointment });
  }));

  app.post("/api/booking/appointments/:appointmentId/cancel", route(async (req, res) => {
    const { database, actor } = await context(req);
    const appointment = await mutate(database, (root, now) => updateBooking(root, req.params.appointmentId, req.body, { ...actor, isStaff: false }, now, "cancel"));
    res.json({ ok: true, appointment });
  }));

  // Register before existing legacy staff handlers to enforce the same capacity rules.
  app.post("/api/staff/appointments", route(async (req, res) => {
    const { database, actor } = await context(req, true);
    const id = req.body.id || req.body.requestId || req.headers["idempotency-key"] || `appt_${crypto.randomUUID()}`;
    const appointment = await mutate(database, (root, now) => createBooking(root, { ...req.body, id }, actor, now));
    res.status(201).json({ ok: true, appointment });
  }));

  for (const action of ["decision", "schedule"]) {
    app.patch(`/api/staff/appointments/:appointmentId/${action}`, route(async (req, res) => {
      const { database, actor } = await context(req, true);
      const appointment = await mutate(database, (root, now) => updateBooking(root, req.params.appointmentId, req.body, actor, now, action));
      res.json({ ok: true, appointment });
    }));
  }
}

module.exports = {
  registerBookingRoutes,
  __test: { BookingError, serviceKey, defaultSlots, validateSlots, listSlots, saveSchedule, createBooking, updateBooking, appointmentLocation, matchingBookings, destinationForAppointment },
};
