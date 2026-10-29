"use strict";

// Explicit one-time completion of the five requested demo records. Never run
// at startup. Prices and dates below are fictional demonstration values.
const { SAMPLE_MEDICINES, main } = require("./seed-sample-medicines");
const { transactionWithLiveSnapshot } = require("../src/realtime-transaction");
const VERSION = "inventory-sample-details-v1";
const SAMPLE_DETAILS = Object.freeze(Object.fromEntries(SAMPLE_MEDICINES.map((item, index) => [item.id, Object.freeze({
  ...item, cost: [1.5, 5, 2, 15, 2.5][index], price: [3, 8, 5, 25, 5][index], expiry: "2027-12-31",
})])));
const blank = value => value === undefined || value === null || String(value).trim() === "";

function fillMissingSampleDetails(current, now = Date.now()) {
  if (!current || typeof current !== "object" || Array.isArray(current)) throw Error("Inventory has an unexpected format; nothing was changed.");
  const inventory = structuredClone(current), updated = [], preserved = [];
  for (const sample of SAMPLE_MEDICINES) {
    const record = inventory[sample.id];
    if (!record || record.sampleData !== true || record.sampleSeed !== sample.sampleSeed || record.id && record.id !== sample.id) {
      throw Error("A requested sample is missing or its demo identity changed; nothing was overwritten.");
    }
    if (!Number.isSafeInteger(record.stock) || record.stock < 0) throw Error("A sample stock balance is invalid; nothing was changed.");
    if (record.sampleDetailsVersion === VERSION) { preserved.push(sample.id); continue; }
    const fields = [];
    for (const key of ["name", "generic", "category", "unit", "reorder", "cost", "price", "supplier", "expiry", "location"]) {
      // Zero prices were deliberately used as unknown placeholders in v1.
      // Never change existing stock or any non-placeholder edited metadata.
      if (blank(record[key]) || ["cost", "price"].includes(key) && Number(record[key]) === 0) {
        record[key] = SAMPLE_DETAILS[sample.id][key]; fields.push(key);
      }
    }
    if (!fields.length) { preserved.push(sample.id); continue; }
    Object.assign(record, { sampleDetailsVersion: VERSION, sampleDetailsFields: fields,
      sampleDetailsNote: "Fictional demonstration prices and expiry date; not physical clinic stock.",
      updatedAt: new Date(now).toISOString(), updatedBy: "maintenance:sample-inventory" });
    updated.push({ id: sample.id, fields, values: Object.fromEntries(fields.map(key => [key, record[key]])) });
  }
  return { inventory, updated, preserved };
}

async function completeSamples(database, { apply = false, now = Date.now() } = {}) {
  const ref = database.ref("inventory");
  if (!apply) {
    const plan = fillMissingSampleDetails((await ref.get()).val(), now);
    return { mode: "dry-run", operation: VERSION, updated: plan.updated, preserved: plan.preserved, writes: 0 };
  }
  let plan, failure;
  const result = await transactionWithLiveSnapshot(ref, current => {
    plan = undefined; failure = undefined;
    try { plan = fillMissingSampleDetails(current, now); return plan.updated.length ? plan.inventory : undefined; }
    catch (error) { failure = error; return undefined; }
  });
  if (failure) throw failure;
  if (!plan || !result.committed && plan.updated.length) throw Error("Sample details were not committed. Check the connection and retry.");
  if (SAMPLE_MEDICINES.some(sample => plan.inventory[sample.id].sampleDetailsVersion === VERSION)) {
    const timestamp = new Date(now).toISOString();
    // A rerun can finish this audit if the first call committed inventory but
    // lost its connection before saving the audit. It never resets later edits.
    let auditExists = false;
    const audit = await transactionWithLiveSnapshot(database.ref(`auditLogs/${VERSION}`), current => {
      auditExists = Boolean(current);
      if (current) return undefined;
      return {
      id: VERSION, action: "inventory_sample_details_completed", type: "inventory_sample_details_completed",
      actorId: "maintenance:sample-inventory", actorRole: "system", source: "desktop", status: "success",
      targetType: "inventory", targetCollection: "inventory", createdAt: timestamp, timestamp,
      summary: "Completed missing demo medicine fields with explicitly requested fictional prices and expiry dates; stock unchanged.",
      details: { version: VERSION, items: SAMPLE_MEDICINES.filter(sample => plan.inventory[sample.id].sampleDetailsVersion === VERSION)
        .map(sample => ({ id: sample.id, fields: plan.inventory[sample.id].sampleDetailsFields })) },
      };
    });
    if (!audit.committed && !auditExists) throw Error("Sample details audit was not committed. Retry to finish without resetting the samples.");
  }
  const saved = (await ref.get()).val() || {};
  for (const sample of SAMPLE_MEDICINES) {
    const record = saved[sample.id], planned = plan.inventory[sample.id];
    if (!record || record.sampleData !== true || record.sampleSeed !== sample.sampleSeed ||
      plan.updated.find(row => row.id === sample.id)?.fields.some(key => record[key] !== planned[key])) {
      throw Error("Sample details confirmation failed. Review the five sample IDs before retrying.");
    }
  }
  return { mode: "apply", operation: VERSION, updated: plan.updated, preserved: plan.preserved, sampleRecordsVerified: SAMPLE_MEDICINES.length };
}

if (require.main === module) main(process.argv.slice(2), completeSamples).catch(error => {
  const safe = /^(Inventory has|A requested sample|A sample stock|Sample details|Supply --|The configured desktop|Existing desktop Firebase|The existing service account|Sample inventory operation)/.test(error.message);
  console.error(safe ? error.message : "Sample details completion failed. Check the configured backend connection; no credentials were printed.");
  process.exitCode = 1;
});
module.exports = { VERSION, SAMPLE_DETAILS, fillMissingSampleDetails, completeSamples };
