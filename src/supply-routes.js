"use strict";

const crypto = require("node:crypto");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const { createNumberedItem, inventoryItemIdentity, assertUniqueInventoryItem } = require("./inventory-numbering");

const TEXT_FIELDS = { name: 160, category: 80, unit: 40, supplier: 160, location: 160 };
const NUMBER_FIELDS = ["stock", "reorder"];
const FIELDS = [...Object.keys(TEXT_FIELDS), ...NUMBER_FIELDS];

class SupplyError extends Error {
  constructor(message, status = 400, code = "SUPPLY_INVALID") { super(message); this.status = status; this.code = code; }
}
function supplyId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,180}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw new SupplyError("Select a valid supply reference.");
  return value;
}
function active(account) {
  return account && !account.disabled && !account.deleted && !account.deletedAt && account.active !== false &&
    ![account.status, account.accountStatus].some(value => ["inactive", "disabled", "blocked", "suspended", "deleted"].includes(String(value || "").trim().toLowerCase()));
}
function roleFor(root, actor, { allowDoctor = false } = {}) {
  const user = Object.hasOwn(root.users || {}, actor.uid) ? root.users[actor.uid] : null;
  const staff = Object.hasOwn(root.staff || {}, actor.uid) ? root.staff[actor.uid] : null;
  let role = String(user?.role || user?.accountRole || staff?.accountRole || staff?.role || "").trim().toLowerCase();
  if (allowDoctor && role === "staff" && String(staff?.accountType || user?.accountType || "").trim().toLowerCase() === "doctor") role = "doctor";
  if (!active(user) || (staff && !active(staff)) || !(allowDoctor ? ["admin", "staff", "doctor"] : ["admin", "staff"]).includes(role)) throw new SupplyError("Only an active Admin or Staff account can manage supply stock.", 403, "SUPPLY_FORBIDDEN");
  return role;
}
function patchFrom(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !FIELDS.includes(key))) throw new SupplyError("Only supply inventory fields can be saved here.");
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (Object.hasOwn(TEXT_FIELDS, key)) {
      if (typeof value !== "string" || value.length > TEXT_FIELDS[key]) throw new SupplyError("A supply field is invalid or too long.");
      patch[key] = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
      if (["name", "unit"].includes(key) && !patch[key]) throw new SupplyError("Enter a supply name and unit.");
    } else {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SupplyError("Stock and reorder levels must be whole, non-negative numbers.");
      patch[key] = value;
    }
  }
  return patch;
}
function publicItem(item) {
  return Object.fromEntries(["id", ...FIELDS, "createdAt", "updatedAt"].filter(key => item[key] !== undefined).map(key => [key, item[key]]));
}
function updateSupply(root, id, patch, actor, now, auditId) {
  const role = roleFor(root, actor), previous = Object.hasOwn(root.supplies || {}, id) ? root.supplies[id] : null;
  if (role !== "admin") throw new SupplyError("Only an Admin can add or edit supply details. Staff can update stock.", 403, "SUPPLY_FORBIDDEN");
  if (!previous && root.suppliesArchive?.[id]) throw new SupplyError("This supply was deleted. Use Add Supply to create a new record.", 409, "SUPPLY_NOT_FOUND");
  if (!previous && (!patch.name || !patch.unit)) throw new SupplyError("Enter a supply name and unit.");
  if (!previous || inventoryItemIdentity({ ...previous, ...patch }) !== inventoryItemIdentity(previous)) assertUniqueInventoryItem(root, "supplies", { ...previous, ...patch }, id, SupplyError);
  if (previous && Object.hasOwn(patch, "stock") && patch.stock !== previous.stock) throw new SupplyError("Use Add Stock or Remove Stock to change an existing supply balance.", 409, "SUPPLY_STOCK_ACTION_REQUIRED");
  const changedFields = Object.keys(patch).filter(key => patch[key] !== previous?.[key]);
  if (previous && !changedFields.length) return { item: publicItem({ ...previous, id }) };
  const timestamp = new Date(now).toISOString();
  root.supplies ||= {};
  root.supplies[id] = { ...(previous || { stock: 0, reorder: 0, createdAt: timestamp, createdBy: actor.uid }), ...patch, id, updatedAt: timestamp, updatedBy: actor.uid };
  root.auditLogs ||= {};
  root.auditLogs[auditId] = { id: auditId, action: previous ? "supply_updated" : "supply_created", type: previous ? "supply_updated" : "supply_created",
    actorId: actor.uid, actorRole: role, source: "desktop", targetId: id, targetType: "supply", targetCollection: "supplies", status: "success", createdAt: timestamp, timestamp, details: { changedFields } };
  return { item: publicItem(root.supplies[id]) };
}
function deleteSupply(root, id, actor, now, auditId) {
  const role = roleFor(root, actor, { allowDoctor: true });
  if (!["admin", "doctor"].includes(role)) throw new SupplyError("Only an Admin or Doctor can delete supplies.", 403, "SUPPLY_FORBIDDEN");
  const previous = root.supplies?.[id];
  if (!previous) return { id };
  const timestamp = new Date(now).toISOString();
  root.suppliesArchive ||= {}; root.suppliesArchive[id] = { ...previous, id, deletedAt: timestamp, deletedBy: actor.uid };
  delete root.supplies[id];
  root.auditLogs ||= {}; root.auditLogs[auditId] = { id: auditId, actorId: actor.uid, actorRole: role, action: "supply_deleted", type: "supply_deleted",
    targetId: id, targetType: "supply", targetCollection: "supplies", source: "desktop", status: "success", timestamp, createdAt: timestamp, details: {} };
  return { id };
}
function updateSupplyStock(root, id, input, actor, now) {
  const role = roleFor(root, actor);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["requestId", "mode", "quantity"].includes(key))) throw new SupplyError("Choose a valid stock action.");
  const requestId = supplyId(input.requestId), quantity = input.quantity, mode = input.mode;
  if (!["add", "remove"].includes(mode) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999) throw new SupplyError("Enter a whole quantity from 1 to 9,999.");
  const previous = Object.hasOwn(root.supplies || {}, id) ? root.supplies[id] : null;
  if (!previous || previous.deleted || previous.deletedAt) throw new SupplyError("Supply record was not found.", 404, "SUPPLY_NOT_FOUND");
  const transactionId = "supply_stock_" + crypto.createHash("sha256").update(JSON.stringify([actor.uid, id, requestId])).digest("hex").slice(0, 36);
  const saved = root.supplyStockTransactions?.[transactionId];
  if (saved) {
    if (saved.supplyId !== id || saved.mode !== mode || saved.quantity !== (mode === "add" ? quantity : -quantity) || saved.actorId !== actor.uid) throw new SupplyError("This stock request was already used for another quantity.", 409, "SUPPLY_CONFLICT");
    return { item: publicItem({ ...previous, id }), transaction: saved };
  }
  const before = Number(previous.stock);
  if (!Number.isSafeInteger(before) || before < 0) throw new SupplyError("This supply has an invalid stock balance. Ask Admin to correct it.", 409, "SUPPLY_CONFLICT");
  const after = before + (mode === "add" ? quantity : -quantity);
  if (!Number.isSafeInteger(after) || after < 0) throw new SupplyError("Not enough stock. Refresh the supply record and choose a smaller quantity.", 409, "SUPPLY_INSUFFICIENT");
  const timestamp = new Date(now).toISOString();
  root.supplies[id] = { ...previous, id, stock: after, updatedAt: timestamp, updatedBy: actor.uid };
  const account = root.staff?.[actor.uid] || root.users?.[actor.uid] || {};
  const transaction = { id: transactionId, requestId, supplyId: id, supply: previous.name, mode, quantity: after - before, before, after,
    actorId: actor.uid, actorRole: role, by: String(account.name || account.fullName || (role === "admin" ? "Administrator" : "Clinic Staff")).slice(0, 160), createdAt: timestamp };
  root.supplyStockTransactions ||= {}; root.supplyStockTransactions[transactionId] = transaction;
  root.auditLogs ||= {};
  root.auditLogs[transactionId] = { id: transactionId, actorId: actor.uid, actorRole: role, action: mode === "add" ? "supply_stock_added" : "supply_stock_removed",
    targetId: id, targetType: "supply", targetCollection: "supplies", source: "desktop", status: "success", createdAt: timestamp, details: { quantity, before, after, transactionId } };
  return { item: publicItem(root.supplies[id]), transaction };
}
function registerSupplyRoutes(app, options = {}) {
  async function transact(req, apply) {
    const access = req.staffAccess;
    if (!access?.database || !access.actor?.uid) throw new SupplyError("Sign in to the desktop again.", 401, "SUPPLY_UNAUTHORIZED");
    const now = (options.now || Date.now)();
    let failure, saved;
    const result = await transactionWithLiveSnapshot(access.database.ref(), current => {
      failure = undefined; saved = undefined;
      const root = structuredClone(current || {});
      try { saved = apply(root, access.actor, now); return root; }
      catch (error) { failure = error; return undefined; }
    });
    if (failure) throw failure;
    if (!result.committed || !saved) throw new SupplyError("Supply stock changed while saving. Refresh and try again.", 409, "SUPPLY_CONFLICT");
    return saved;
  }
  const route = handler => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...await handler(req) }); }
    catch (error) { res.status(error instanceof SupplyError ? error.status : 503).json({ ok: false, code: error instanceof SupplyError ? error.code : "SUPPLY_UNAVAILABLE", error: error instanceof SupplyError ? error.message : "Supply inventory could not be saved. Try again." }); }
  };
  app.post("/api/staff/manage/supplies", route(req => {
    if (!req.body || Object.keys(req.body).some(key => !["requestId", "item"].includes(key))) throw new SupplyError("Choose a valid supply creation request.");
    const requestId = supplyId(req.body.requestId), patch = patchFrom(req.body.item), auditId = "supply_" + crypto.randomUUID();
    return transact(req, (root, actor, now) => {
      if (roleFor(root, actor) !== "admin") throw new SupplyError("Only an Admin can add supplies.", 403, "SUPPLY_FORBIDDEN");
      return createNumberedItem(root, { collection: "supplies", prefix: "SUP", width: 4, requestId, patch, actor, ErrorClass: SupplyError,
        read: publicItem, save: id => updateSupply(root, id, patch, actor, now, auditId) });
    });
  }));
  app.delete("/api/staff/manage/supplies/:id", route(req => {
    const id = supplyId(req.params.id), auditId = "supply_" + crypto.randomUUID();
    return transact(req, (root, actor, now) => deleteSupply(root, id, actor, now, auditId));
  }));
  app.put("/api/staff/manage/supplies/:id", route(req => {
    const id = supplyId(req.params.id), patch = patchFrom(req.body), auditId = "supply_" + crypto.randomUUID();
    return transact(req, (root, actor, now) => updateSupply(root, id, patch, actor, now, auditId));
  }));
  app.post("/api/staff/manage/supplies/:id/stock", route(req => {
    const id = supplyId(req.params.id);
    return transact(req, (root, actor, now) => updateSupplyStock(root, id, req.body, actor, now));
  }));
}

module.exports = { registerSupplyRoutes, __test: { SupplyError, patchFrom, supplyId, updateSupply, updateSupplyStock } };
