"use strict";
const crypto = require("node:crypto");

function inventoryItemIdentity(item) {
  return [item?.name, item?.unit].map(value => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()).join("\u0000");
}
function assertUniqueInventoryItem(root, collection, item, exceptId, ErrorClass) {
  const key = inventoryItemIdentity(item);
  if (Object.entries(root[collection] || {}).some(([id, row]) => id !== exceptId && !row.deleted && !row.deletedAt && inventoryItemIdentity(row) === key)) {
    throw new ErrorClass("This " + (collection === "supplies" ? "supply" : "medicine") + " already exists. Use Manage to add stock or edit its details.", 409, "INVENTORY_DUPLICATE");
  }
}

// Allocate inside the same live database transaction as the item and audit.
// A stable form request survives retries without creating duplicate stock.
function createNumberedItem(root, { collection, prefix, width, requestId, patch, actor, ErrorClass, save, read }) {
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(Object.keys(patch).sort().map(key => [key, patch[key]]))).digest("hex");
  const prior = root.inventoryCreationRequests?.[collection]?.[requestId];
  if (prior) {
    if (prior.actorId !== actor.uid || prior.fingerprint !== fingerprint || !root[collection]?.[prior.id]) {
      throw new ErrorClass("This creation request was already used. Reopen Add Item before creating another record.", 409);
    }
    return { item: read(root[collection][prior.id]), requestId };
  }
  const pattern = new RegExp("^" + prefix + "-(\\d+)$");
  let sequence = Number(root.inventorySequences?.[collection]) || 0;
  for (const id of [...Object.keys(root[collection] || {}), ...Object.keys(root[collection + "Archive"] || {})]) {
    const match = pattern.exec(id);
    if (match && Number.isSafeInteger(Number(match[1]))) sequence = Math.max(sequence, Number(match[1]));
  }
  sequence++;
  if (!Number.isSafeInteger(sequence)) throw new ErrorClass("Inventory numbering is unavailable. Contact the administrator.", 409);
  const id = prefix + "-" + String(sequence).padStart(width, "0"), result = save(id);
  root.inventorySequences ||= {}; root.inventorySequences[collection] = sequence;
  root.inventoryCreationRequests ||= {}; root.inventoryCreationRequests[collection] ||= {};
  root.inventoryCreationRequests[collection][requestId] = { id, actorId: actor.uid, fingerprint };
  return { ...result, requestId };
}
module.exports = { createNumberedItem, inventoryItemIdentity, assertUniqueInventoryItem };
