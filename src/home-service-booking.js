"use strict";
// Home visits share one daily allowance across all services. Clinic queues and
// clinic-only schedules are intentionally not part of this policy.
const { isHomeServiceAppointment } = require("./appointment-mode");
module.exports.create = function ({ BookingError, serviceKey, normalizeService, requireDate, validateSlots, appointmentLocation, consumesCapacity }) {
  const DAILY_CAPACITY = 3;
  const SLOT_CAPACITY = 1;
  const POLICY = "two-hour-v1";
  const defaultSlots = () => [7, 9, 13].map(hour => ({
    id: `${String(hour).padStart(2, "0")}00-${String(hour + 2).padStart(2, "0")}00`,
    startTime: `${String(hour).padStart(2, "0")}:00`, endTime: `${String(hour + 2).padStart(2, "0")}:00`,
    capacity: SLOT_CAPACITY, isBreak: false, closed: false,
  }));
  function minutes(value) {
    const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
    if (!match) return NaN;
    let hour = Number(match[1]), minute = Number(match[2]);
    if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return NaN;
    if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
    return hour * 60 + minute;
  }
  function overlaps(appointment, slot) {
    const start = minutes(appointmentLocation(appointment).time), savedEnd = minutes(appointment.endTime);
    // A legacy booking with no duration occupies its booked hour. Preserve
    // explicit longer visits, and fail closed for a same-day unknown time.
    if (!Number.isFinite(start)) return true;
    const end = Number.isFinite(savedEnd) && savedEnd > start ? savedEnd : Math.min(1440, start + 60);
    return start < minutes(slot.endTime) && end > minutes(slot.startTime);
  }
  function config(root, service, date) {
    const own = root.homeServiceSlotSchedules?.[date]?.[serviceKey(service)];
    if (own?.configured) return own;
    // Retain deliberately customized older schedules; revision zero was a
    // generated snapshot, not an administrator's configured booking window.
    const legacy = root.serviceSlotSchedules?.[date]?.[serviceKey(service)];
    return legacy?.configured && Number(legacy.revision) > 0 ? legacy : null;
  }
  function configuredSlots(saved) {
    if (!saved) return defaultSlots();
    const rows = Object.values(saved.slots || {});
    return defaultSlots().map(slot => {
      const matching = rows.find(row => row.startTime === slot.startTime && row.endTime === slot.endTime);
      const closed = !rows.length || (saved.homeServicePolicy === POLICY ? !matching || matching.closed || matching.isBreak
        : rows.some(row => (row.closed || row.isBreak) && minutes(row.startTime) < minutes(slot.endTime) && minutes(row.endTime) > minutes(slot.startTime)));
      return { ...slot, closed: Boolean(closed) };
    });
  }
  function bookings(root, date, excludedId = "") {
    return Object.entries(root.appointments || {}).filter(([id, item]) =>
      id !== excludedId && item && !item.deleted && !["expired","cancelled","canceled","rejected","declined","deleted","no_show","no-show"].includes(String(item.status || item.appointmentStatus || "").toLowerCase()) && consumesCapacity(item) &&
      isHomeServiceAppointment(item) && appointmentLocation(item).date === date);
  }
  function listSlots(root, serviceName, date, now, excludedId = "") {
    requireDate(date);
    const saved = config(root, serviceName, date), entries = bookings(root, date, excludedId);
    const dailyBookedCount = entries.length, dailyRemaining = Math.max(0, DAILY_CAPACITY - dailyBookedCount);
    const slots = configuredSlots(saved).map(slot => {
      const bookedCount = entries.filter(([, item]) => overlaps(item, slot)).length;
      const capacity = Math.min(SLOT_CAPACITY, Number(slot.capacity));
      const remaining = Math.min(dailyRemaining, Math.max(0, capacity - bookedCount));
      const expired = Date.parse(date + "T" + slot.startTime + ":00+08:00") <= now;
      return { ...slot, capacity, bookedCount, remaining, status: slot.closed || slot.isBreak || expired ? "unavailable" : remaining === 0 ? "full" : "available" };
    });
    return { serviceName, date, mode: "home_service", revision: Number(saved?.revision || 0), serverNow: new Date(now).toISOString(),
      homeServicePolicy: POLICY, timeZone: "Asia/Manila", clinicHours: [["07:00", "12:00"], ["13:00", "16:00"]],
      dailyCapacity: DAILY_CAPACITY, slotCapacity: SLOT_CAPACITY, patientActiveLimit: 1, singleService: true, dailyBookedCount, dailyRemaining, slots };
  }
  function calendar(root, serviceName, month, now, excludedId = "") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) throw new BookingError("Choose a valid calendar month.");
    requireDate(month + "-01");
    const count = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    const days = Array.from({ length: count }, (_, index) => {
      const date = month + "-" + String(index + 1).padStart(2, "0"), info = listSlots(root, serviceName, date, now, excludedId);
      const status = info.slots.some(slot => slot.status === "available") ? "available" : info.dailyRemaining === 0 || info.slots.some(slot => slot.status === "full") ? "full" : "unavailable";
      const remaining = Math.min(info.dailyRemaining, info.slots.filter(slot => slot.status === "available").length);
      return { date, status, bookedCount: info.dailyBookedCount, remaining, capacity: DAILY_CAPACITY };
    });
    return { serviceName, month, homeServicePolicy: POLICY, timeZone: "Asia/Manila", dailyCapacity: DAILY_CAPACITY, slotCapacity: SLOT_CAPACITY, patientActiveLimit: 1, singleService: true, serverNow: new Date(now).toISOString(), days };
  }
  function assertBookable(root, service, scheduledAt, now, excludedId = "") {
    if (typeof scheduledAt !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledAt) || !Number.isFinite(Date.parse(scheduledAt))) throw new BookingError("Choose a valid appointment time with its timezone.");
    const location = appointmentLocation({ scheduledAt });
    const info = listSlots(root, service, location.date, now, excludedId);
    const slot = info.slots.find(row => row.startTime === location.time);
    if (!slot || slot.closed || slot.isBreak) throw new BookingError("This time is unavailable. Choose another time.", 409, "SLOT_UNAVAILABLE");
    if (Date.parse(scheduledAt) !== Date.parse(location.date + "T" + slot.startTime + ":00+08:00")) throw new BookingError("Choose the exact start time of an available slot.");
    if (slot.status === "unavailable") throw new BookingError("This time has already passed. Choose a later date.", 409, "SLOT_EXPIRED");
    if (info.dailyRemaining === 0) throw new BookingError("This day is fully booked (3 patients). Choose another date.", 409, "HOME_SERVICE_DAY_FULL");
    if (slot.status === "full") throw new BookingError("This home-service time is already booked. Choose another available time.", 409, "SLOT_FULL");
    return { slot, ...location };
  }
  function saveSchedule(root, input, actor, now) {
    if (actor.role !== "admin") throw new BookingError("Only an administrator can change home-service slots.", 403, "BOOKING_FORBIDDEN");
    const serviceName = String(input.serviceName || "").trim(), date = requireDate(input.date);
    const current = config(root, serviceName, date), revision = Number(input.revision);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== Number(current?.revision || 0)) throw new BookingError("This schedule changed. Reload before saving.", 409, "SCHEDULE_CONFLICT");
    const slots = validateSlots(input.slots);
    for (const slot of slots) {
      if (!defaultSlots().some(window => window.id === slot.id) || slot.capacity !== 1 || slot.isBreak) {
        throw new BookingError("Home visits use 7–9 AM, 9–11 AM and 1–3 PM only, with one patient per slot.");
      }
    }
    const active = bookings(root, date).filter(([, item]) => normalizeService(item.serviceName || item.reason) === normalizeService(serviceName));
    const count = slot => active.filter(([, item]) => overlaps(item, slot)).length;
    for (const slot of slots) {
      const booked = count(slot);
      if (booked > slot.capacity || slot.isBreak && booked) throw new BookingError("Keep existing reservations or move/cancel them before changing this time.", 409, "SLOT_HAS_BOOKINGS");
      if (slot.capacity > DAILY_CAPACITY && !(slot.closed && slot.capacity === booked)) throw new BookingError("Home-service capacity is at most 3 patients per day.");
    }
    for (const old of defaultSlots()) if (!slots.some(slot => slot.id === old.id)) slots.push({ ...old, closed: true });
    const validated = validateSlots(slots);
    root.homeServiceSlotSchedules ||= {}; root.homeServiceSlotSchedules[date] ||= {};
    root.homeServiceSlotSchedules[date][serviceKey(serviceName)] = { configured: true, homeServicePolicy: POLICY, serviceName, date, slots: validated, revision: revision + 1, updatedAt: new Date(now).toISOString(), updatedBy: actor.uid };
    return listSlots(root, serviceName, date, now);
  }
  return { DAILY_CAPACITY, defaultSlots, listSlots, calendar, assertBookable, saveSchedule, bookings };
};
