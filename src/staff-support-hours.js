"use strict";
const STAFF_SUPPORT_HOURS = "Staff Support is available daily from 7:00 AM to 5:00 PM (Philippine time).";
function staffSupportHours(at = Date.now()) {
  const date = new Date(Number(at) + 8 * 60 * 60 * 1000);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return { open: Number.isFinite(date.getTime()) && minutes >= 420 && minutes < 1020, timeZone: "Asia/Manila", opensAt: "07:00", closesAt: "17:00", message: STAFF_SUPPORT_HOURS };
}
function assertStaffSupportOpen(at) {
  if (!staffSupportHours(at).open) throw Object.assign(Error(STAFF_SUPPORT_HOURS), { status: 403, code: "STAFF_SUPPORT_CLOSED" });
}
module.exports = { staffSupportHours, assertStaffSupportOpen, STAFF_SUPPORT_HOURS };
