"use strict";

const { randomUUID } = require("node:crypto");

const events = {
  desktop_login: ["Desktop Sign-in Verified", "Signed in to AlphaStar Desktop after account verification."],
  desktop_pin_verified: ["Desktop PIN Verified", "Verified the account PIN to unlock AlphaStar Desktop."],
  desktop_pin_failed: ["Desktop PIN Check Failed", "The account PIN check was not accepted on AlphaStar Desktop."],
  desktop_logout: ["Desktop Sign-out", "Signed out of AlphaStar Desktop."],
};

async function recordDesktopSystemEvent(access, action) {
  const { actor, database, decoded, auditIdentity } = access || {};
  if (!database || !actor?.uid || actor.role === "patient" || !Object.hasOwn(events, action)) return false;

  const [actionLabel, summary] = events[action];
  const createdAt = new Date().toISOString();
  const actorRole = actor.role === "admin" ? "admin" : auditIdentity?.doctor ? "doctor" : actor.role;
  const row = {
    id: `audit_${randomUUID()}`,
    action,
    type: action,
    actionLabel,
    actorId: actor.uid,
    actorRole,
    actorName: auditIdentity?.name || "",
    actorEmail: String(decoded?.email || "").trim().toLowerCase().slice(0, 254),
    source: "desktop",
    status: action === "desktop_pin_failed" ? "failed" : "success",
    summary,
    targetId: actor.uid,
    targetType: "users",
    targetCollection: "users",
    createdAt,
    timestamp: createdAt,
    auditVersion: 1,
  };

  let timer;
  try {
    await Promise.race([
      database.ref(`auditLogs/${row.id}`).set(row),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Audit acknowledgement timed out.")), 1500);
      }),
    ]);
    return true;
  } catch {
    console.warn("Desktop authentication activity could not be recorded.");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { recordDesktopSystemEvent };
