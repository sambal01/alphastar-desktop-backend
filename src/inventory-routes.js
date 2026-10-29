"use strict";

const crypto = require("node:crypto");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const TEXT_FIELDS = { name: 160, generic: 160, category: 80, unit: 40, supplier: 160, location: 160, status: 40 };
const NUMBER_FIELDS = ["stock", "reorder", "cost", "price"];
const FIELDS = [...Object.keys(TEXT_FIELDS), ...NUMBER_FIELDS, "expiry"];

class InventoryError extends Error {
  constructor(message, status = 400, code = "INVENTORY_INVALID") {
    super(message); this.status = status; this.code = code;
  }
}
function itemId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,180}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) {
    throw new InventoryError("Select a valid medicine reference.");
  }
  return value;
}
function active(account) {
  return account && !account.disabled && !account.deleted && !account.deletedAt && account.active !== false &&
    ![account.status, account.accountStatus].some(value => ["inactive", "disabled", "blocked", "suspended", "deleted"].includes(String(value || "").trim().toLowerCase()));
}
function inventoryRole(root, actor) {
  const user = Object.hasOwn(root.users || {}, actor.uid) ? root.users[actor.uid] : null;
  const staff = Object.hasOwn(root.staff || {}, actor.uid) ? root.staff[actor.uid] : null;
  const role = String(user?.role || user?.accountRole || staff?.accountRole || staff?.role || "").trim().toLowerCase();
  if (!active(user) || (staff && !active(staff)) || !["admin", "staff"].includes(role)) {
    throw new InventoryError("Only an active Admin or Staff account can update inventory.", 403, "INVENTORY_FORBIDDEN");
  }
  return role;
}
function itemPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !FIELDS.includes(key))) {
    throw new InventoryError("Only medicine inventory fields can be saved here.");
  }
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (Object.hasOwn(TEXT_FIELDS, key)) {
      if (typeof value !== "string" || value.length > TEXT_FIELDS[key]) throw new InventoryError("A medicine field is invalid or too long.");
      patch[key] = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
      if (["name", "unit"].includes(key) && !patch[key]) throw new InventoryError("Enter a medicine name and unit.");
    } else if (NUMBER_FIELDS.includes(key)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER ||
        (["stock", "reorder"].includes(key) && !Number.isSafeInteger(value))) throw new InventoryError("Stock and reorder levels must be whole, non-negative numbers; prices cannot be negative.");
      patch[key] = value;
    } else {
      if (typeof value !== "string" || (value !== "" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value + "T00:00:00Z")) || new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value))) {
        throw new InventoryError("Enter a valid medicine expiry date.");
      }
      patch.expiry = value;
    }
  }
  return patch;
}
function publicItem(item) {
  return Object.fromEntries(["id", ...FIELDS, "createdAt", "updatedAt"].filter(key => item[key] !== undefined).map(key => [key, item[key]]));
}
function changeInventory(root, id, patch, actor, now, auditId, remove = false) {
  const role = inventoryRole(root, actor), previous = Object.hasOwn(root.inventory || {}, id) ? root.inventory[id] : null;
  if (role !== "admin" && (remove || !previous || Object.entries(patch).some(([key, value]) => key !== "stock" && value !== previous[key]))) {
    throw new InventoryError("Only Admin can add, delete or change medicine details. Staff can update existing stock only.", 403, "INVENTORY_FORBIDDEN");
  }
  if (remove && !previous) return { id };
  if (!remove && !previous && (!patch.name || !patch.unit)) throw new InventoryError("Enter a medicine name and unit.");
  const changedFields = remove ? [] : Object.keys(patch).filter(key => patch[key] !== previous?.[key]);
  if (!remove && previous && !changedFields.length) return { item: publicItem({ ...previous, id }) };
  const timestamp = new Date(now).toISOString();
  root.inventory ||= {};
  let item;
  if (remove) delete root.inventory[id];
  else {
    const defaults = previous || { stock: 0, reorder: 0, cost: 0, price: 0, createdAt: timestamp, createdBy: actor.uid };
    root.inventory[id] = { ...defaults, ...patch, id, updatedAt: timestamp, updatedBy: actor.uid };
    item = publicItem(root.inventory[id]);
  }
  const action = remove ? "inventory_deleted" : previous ? "inventory_updated" : "inventory_created";
  root.auditLogs ||= {};
  root.auditLogs[auditId] = { id: auditId, action, type: action, actorId: actor.uid, actorRole: role,
    source: "desktop", targetId: id, targetType: "inventory", targetCollection: "inventory", status: "success",
    createdAt: timestamp, timestamp, details: { changedFields } };
  return remove ? { id } : { item };
}
function changeInventoryStock(root, id, input, actor, now) {
  const role = inventoryRole(root, actor);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["requestId", "mode", "quantity"].includes(key))) throw new InventoryError("Choose a valid stock action.");
  const requestId = itemId(input.requestId), quantity = input.quantity, mode = input.mode;
  if (!["add", "remove"].includes(mode) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999) throw new InventoryError("Enter a whole quantity from 1 to 9,999.");
  const previous = Object.hasOwn(root.inventory || {}, id) ? root.inventory[id] : null;
  if (!previous || previous.deleted || previous.deletedAt) throw new InventoryError("Medicine record was not found.", 404, "INVENTORY_NOT_FOUND");
  const transactionId = "stock_" + crypto.createHash("sha256").update(JSON.stringify([actor.uid, id, requestId])).digest("hex").slice(0, 40);
  const saved = root.stockTransactions?.[transactionId];
  if (saved) {
    if (saved.medicineId !== id || saved.mode !== mode || saved.quantity !== (mode === "add" ? quantity : -quantity) || saved.actorId !== actor.uid) throw new InventoryError("This stock request was already used for another quantity.", 409, "INVENTORY_CONFLICT");
    return { item: publicItem({ ...previous, id }), transaction: saved };
  }
  const before = typeof previous.stock === "number" || typeof previous.stock === "string" && previous.stock.trim() ? Number(previous.stock) : NaN;
  if (!Number.isSafeInteger(before) || before < 0) throw new InventoryError("This medicine has an invalid stock balance. Ask Admin to correct it.", 409, "INVENTORY_CONFLICT");
  const after = before + (mode === "add" ? quantity : -quantity);
  if (!Number.isSafeInteger(after) || after < 0) throw new InventoryError("Not enough stock. Refresh Manage and choose a smaller quantity.", 409, "INVENTORY_INSUFFICIENT");
  const timestamp = new Date(now).toISOString();
  root.inventory[id] = { ...previous, id, stock: after, updatedAt: timestamp, updatedBy: actor.uid };
  const account = root.staff?.[actor.uid] || root.users?.[actor.uid] || {};
  const transaction = { id: transactionId, requestId, medicineId: id, medicine: previous.name, mode,
    type: mode === "add" ? "restock" : "removed", quantity: after - before, before, after,
    actorId: actor.uid, actorRole: role, by: String(account.name || account.fullName || (role === "admin" ? "Administrator" : "Clinic Staff")).slice(0, 160),
    createdAt: timestamp, date: timestamp, remarks: "" };
  root.stockTransactions ||= {}; root.stockTransactions[transactionId] = transaction;
  root.auditLogs ||= {};
  root.auditLogs[transactionId] = { id: transactionId, actorId: actor.uid, actorRole: role, action: mode === "add" ? "inventory_stock_added" : "inventory_stock_removed",
    targetId: id, targetType: "inventory", source: "desktop", status: "success", createdAt: timestamp, details: { quantity, before, after, transactionId } };
  return { item: publicItem(root.inventory[id]), transaction };
}
function registerInventoryRoutes(app, options = {}) {
  function handler(remove) {
    return async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        const access = req.staffAccess;
        if (!access?.database || !access.actor?.uid) throw new InventoryError("Sign in to the desktop again.", 401, "INVENTORY_UNAUTHORIZED");
        const id = itemId(req.params.id), patch = remove ? {} : itemPatch(req.body);
        const now = (options.now || Date.now)(), auditId = "inventory_" + crypto.randomUUID();
        let failure, saved;
        const result = await transactionWithLiveSnapshot(access.database.ref(), current => {
          failure = undefined; saved = undefined;
          const root = structuredClone(current || {});
          try { saved = changeInventory(root, id, patch, access.actor, now, auditId, remove); return root; }
          catch (error) { failure = error; return undefined; }
        });
        if (failure) throw failure;
        if (!result.committed || !saved) throw new InventoryError("Inventory changed while saving. Refresh inventory and try again.", 409, "INVENTORY_CONFLICT");
        res.json({ ok: true, ...saved });
      } catch (error) {
        res.status(error instanceof InventoryError ? error.status : 503).json({ ok: false,
          code: error instanceof InventoryError ? error.code : "INVENTORY_UNAVAILABLE",
          error: error instanceof InventoryError ? error.message : "Inventory could not be saved to the server. Your local changes are kept; try again." });
      }
    };
  }
  // Intentionally fixed to inventory: never expose arbitrary collection writes.
  app.put("/api/staff/manage/inventory/:id", handler(false));
  app.delete("/api/staff/manage/inventory/:id", handler(true));
  app.post("/api/staff/manage/inventory/:id/stock", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const access = req.staffAccess;
      if (!access?.database || !access.actor?.uid) throw new InventoryError("Sign in to the desktop again.", 401, "INVENTORY_UNAUTHORIZED");
      const id = itemId(req.params.id), now = (options.now || Date.now)();
      let failure, saved;
      const result = await transactionWithLiveSnapshot(access.database.ref(), current => {
        failure = undefined; saved = undefined;
        const root = structuredClone(current || {});
        try { saved = changeInventoryStock(root, id, req.body, access.actor, now); return root; }
        catch (error) { failure = error; return undefined; }
      });
      if (failure) throw failure;
      if (!result.committed || !saved) throw new InventoryError("Stock changed while saving. Retry this stock request.", 409, "INVENTORY_CONFLICT");
      res.json({ ok: true, ...saved });
    } catch (error) {
      res.status(error instanceof InventoryError ? error.status : 503).json({ ok: false, code: error instanceof InventoryError ? error.code : "INVENTORY_UNAVAILABLE",
        error: error instanceof InventoryError ? error.message : "Stock could not be confirmed by the server. Your quantity is kept; try again." });
    }
  });
}
module.exports = { registerInventoryRoutes, __test: { changeInventory, changeInventoryStock, itemPatch, itemId, InventoryError } };
