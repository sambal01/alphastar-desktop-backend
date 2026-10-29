"use strict";

// Explicit, idempotent maintenance operation. Never run from application startup.
const path = require("node:path"), fs = require("node:fs");
const { transactionWithLiveSnapshot } = require("../src/realtime-transaction");
const SEED = "inventory-samples-v1";
const SAMPLE_MEDICINES = Object.freeze([
  ["Paracetamol", "Acetaminophen", "Analgesic", "Tablets", 100],
  ["Amoxicillin", "Amoxicillin", "Antibiotic", "Capsules", 80],
  ["Cetirizine", "Cetirizine", "Antihistamine", "Tablets", 60],
  ["Salbutamol", "Salbutamol", "Bronchodilator", "Ampoules", 40],
  ["Metformin", "Metformin", "Antidiabetic", "Tablets", 30],
].map(([name, generic, category, unit, stock], index) => Object.freeze({
  id: `SAMPLE-MED-${String(index + 1).padStart(3, "0")}`, name: `SAMPLE - ${name}`, generic,
  category, unit, stock, reorder: 10, cost: 0, price: 0, expiry: "",
  supplier: "Sample supplier (not real stock)", location: "DEMO ONLY - not for patient use", status: "demo",
  sampleData: true, sampleSeed: SEED,
})));

function addSamples(current, now) {
  if (current !== null && current !== undefined && (typeof current !== "object" || Array.isArray(current))) throw new Error("Inventory has an unexpected format; nothing was changed.");
  const inventory = structuredClone(current || {}), added = [], existing = [];
  for (const item of SAMPLE_MEDICINES) {
    if (Object.hasOwn(inventory, item.id)) {
      if (inventory[item.id]?.sampleSeed !== SEED || inventory[item.id]?.sampleData !== true) throw new Error("A reserved sample ID is already in use; nothing was overwritten.");
      existing.push(item.id); // Never reset a quantity or metadata changed after the first import.
    } else {
      inventory[item.id] = { ...item, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), createdBy: "maintenance:sample-inventory" };
      added.push(item.id);
    }
  }
  return { inventory, added, existing };
}
async function seedSamples(database, { apply = false, now = Date.now() } = {}) {
  const ref = database.ref("inventory");
  if (!apply) {
    const plan = addSamples((await ref.get()).val(), now);
    return { mode: "dry-run", added: plan.added, existing: plan.existing, writes: 0 };
  }
  let plan, failure;
  const result = await transactionWithLiveSnapshot(ref, current => {
    plan = undefined; failure = undefined;
    try { plan = addSamples(current, now); return plan.added.length ? plan.inventory : undefined; }
    catch (error) { failure = error; return undefined; }
  });
  if (failure) throw failure;
  if (!plan || (!result.committed && plan.added.length)) throw new Error("Sample inventory was not committed. Retry after checking the connection.");
  const auditId = "inventory-samples-v1", timestamp = new Date(now).toISOString();
  const auditRef = database.ref(`auditLogs/${auditId}`);
  const audit = await transactionWithLiveSnapshot(auditRef, current => current || { id: auditId, action: "inventory_samples_added", type: "inventory_samples_added",
    actorId: "maintenance:sample-inventory", actorRole: "system", source: "desktop", status: "success", targetType: "inventory", targetCollection: "inventory",
    createdAt: timestamp, timestamp, summary: "Added five explicitly requested SAMPLE medicines with demonstration quantities, not physical clinic stock.",
    details: { sampleSeed: SEED, sampleCount: SAMPLE_MEDICINES.length, itemIds: SAMPLE_MEDICINES.map(item => item.id) } });
  if (!audit.committed) throw new Error("Sample inventory audit was not committed. Retry to finish its confirmation without resetting stock.");
  const verified = (await ref.get()).val() || {};
  if (!SAMPLE_MEDICINES.every(item => verified[item.id]?.sampleSeed === SEED && verified[item.id]?.sampleData === true)) {
    throw new Error("Sample inventory confirmation failed. Check the connection before retrying.");
  }
  return { mode: "apply", added: plan.added, existing: plan.existing, sampleRecordsVerified: SAMPLE_MEDICINES.length };
}
async function main(args = process.argv.slice(2), operation = seedSamples) {
  const dotenv = require("dotenv");
  dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });
  dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: false, quiet: true });
  const expected = args[args.indexOf("--expected-project") + 1];
  if (!args.includes("--expected-project") || !expected || args.some(arg => !["--expected-project", expected, "--apply"].includes(arg))) {
    throw new Error("Supply --expected-project PROJECT_ID; add --apply only after reviewing the dry run.");
  }
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  const databaseURL = process.env.FIREBASE_DATABASE_URL || process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL;
  if (!projectId || projectId !== expected || !databaseURL || new URL(databaseURL).hostname !== `${projectId}-default-rtdb.firebaseio.com`) {
    throw new Error("The configured desktop Firebase project/database does not match the explicitly selected target.");
  }
  const rawCredential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || (process.env.GOOGLE_APPLICATION_CREDENTIALS ? fs.readFileSync(path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS), "utf8") : "");
  if (!rawCredential) throw new Error("Existing desktop Firebase Admin credentials are required; no credentials were changed.");
  const credential = JSON.parse(rawCredential);
  if (credential.project_id !== expected) throw new Error("The existing service account belongs to a different project.");
  const { initializeApp, cert, deleteApp } = require("firebase-admin/app");
  const app = initializeApp({ credential: cert(credential), projectId, databaseURL }, "sample-inventory-maintenance");
  let timer;
  try {
    const result = await Promise.race([operation(require("firebase-admin/database").getDatabase(app), { apply: args.includes("--apply") }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Sample inventory operation timed out. Verify the five sample IDs before retrying.")), 45000); })]);
    console.log(JSON.stringify({ projectId, ...result, samples: SAMPLE_MEDICINES.map(({ id, name, stock, unit }) => ({ id, name, stock, unit })) }, null, 2));
  } finally { clearTimeout(timer); await deleteApp(app); }
}
if (require.main === module) main().catch(error => {
  const message = /Inventory has|reserved sample|not committed|confirmation failed|Supply --|configured desktop|credentials are required|different project|timed out/.test(error.message)
    ? error.message : "The sample inventory operation failed. Check the configured backend connection; no credentials were printed.";
  console.error(message); process.exitCode = 1;
});
module.exports = { SAMPLE_MEDICINES, addSamples, seedSamples, main };
