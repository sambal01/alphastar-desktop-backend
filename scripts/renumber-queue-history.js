"use strict";

const path = require("node:path");
const dotenv = require("dotenv");
const { cert, getApp, getApps, initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: false, quiet: true });

function historyStatus(entry = {}) {
  return String(entry.status || entry.journeyStatus || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isHistoryEntry(entry = {}) {
  return !entry.deletedAt && ["done", "completed", "cancelled", "canceled"].includes(historyStatus(entry));
}

function timestamp(entry = {}) {
  return Date.parse(entry.completedAt || entry.cancelledAt || entry.checkedInAt || entry.createdAt || entry.updatedAt || "") || 0;
}

function queueNumber(value) {
  return `A-${String(value).padStart(3, "0")}`;
}

function normalizeHistory(root) {
  const history = Object.entries(root.queueEntries || {})
    .filter(([, entry]) => entry && isHistoryEntry(entry))
    .sort(([leftId, left], [rightId, right]) => timestamp(left) - timestamp(right) || leftId.localeCompare(rightId));

  let changed = 0;
  history.forEach(([id, entry], index) => {
    const previousQueueNo = String(entry.queueNo || "");
    const nextQueueNo = queueNumber(index + 1);
    if (previousQueueNo === nextQueueNo && Number(entry.queueNumber) === index + 1) return;

    entry.queueNo = nextQueueNo;
    entry.queueNumber = index + 1;
    changed += 1;

    const appointmentReference = String(entry.appointmentId || entry.appointmentRecordId || "");
    Object.values(root.appointmentServices || {}).forEach((step) => {
      if (!step || String(step.appointment_id || "") !== appointmentReference) return;
      if (String(step.queue_number || "") === previousQueueNo) step.queue_number = nextQueueNo;
    });

    root.queueEntries[id] = entry;
  });

  return { changed, count: history.length };
}

function firebaseApp() {
  if (getApps().length) return getApp();
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
  const credential = serviceAccountJson
    ? cert(JSON.parse(serviceAccountJson))
    : serviceAccountPath
      ? cert(require(path.resolve(serviceAccountPath)))
      : null;
  if (!credential) throw new Error("Firebase Admin credentials are not configured.");
  return initializeApp({
    credential,
    databaseURL: process.env.FIREBASE_DATABASE_URL || process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL || undefined,
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || undefined,
  });
}

async function main() {
  const ref = getDatabase(firebaseApp()).ref();
  let result = { changed: 0, count: 0 };
  const transaction = await ref.transaction((current) => {
    const root = current && typeof current === "object" ? current : {};
    result = normalizeHistory(root);
    return root;
  });

  if (!transaction.committed) throw new Error("Queue History could not be updated. Please try again.");
  console.log(JSON.stringify({ ok: true, historyEntries: result.count, renumbered: result.changed }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Queue History renumbering failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { __test: { isHistoryEntry, normalizeHistory, queueNumber } };
