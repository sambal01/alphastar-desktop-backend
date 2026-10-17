"use strict";

// Mobile bookings are home visits; clinic/walk-in queue operations remain separate.
function isHomeServiceAppointment(appointment = {}) {
  const normalized = value => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const source = normalized(appointment.bookingSource || appointment.booking_source || appointment.source);
  const mode = [appointment.visitType, appointment.appointmentType, appointment.bookingType, appointment.serviceMode]
    .some(value => ["home", "home_service", "home_visit", "house_call"].includes(normalized(value)));
  return mode || source === "mobile" ||
    (!source && String(appointment.recordKey || appointment.id || "").startsWith("mobile_")) ||
    /\bhome[\s_-]*(service|visit)\b/i.test(String(appointment.serviceName || appointment.reason || ""));
}

module.exports = { isHomeServiceAppointment };
