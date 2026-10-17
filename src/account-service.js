"use strict";

const crypto = require("node:crypto");

class AccountError extends Error {
  constructor(message, status = 400, code = "ACCOUNT_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function clean(value, length = 160) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, length);
}

function accountType(value = "staff") {
  const normalized = clean(value, 40).toLowerCase();
  const aliases = { admin: "admin", administrator: "admin", "system administrator": "admin", doctor: "doctor", nurse: "nurse", staff: "staff", receptionist: "staff", "medical assistant": "staff", "lab technician": "staff" };
  if (!Object.hasOwn(aliases, normalized)) throw new AccountError("Choose Admin, Staff, Doctor, or Nurse.");
  return aliases[normalized];
}

function requireAdministrator(access) {
  // Authorization is derived from the verified session and saved account records.
  if (!access || access.actor?.role !== "admin") {
    throw new AccountError("Only an administrator can manage clinic accounts.", 403, "ADMIN_REQUIRED");
  }
}

function accountId(value) {
  const uid = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || ["__proto__", "constructor", "prototype"].includes(uid)) throw new AccountError("Invalid account reference.");
  return uid;
}

function createAccountService({ database, auth, pins, cache = () => {}, now = () => new Date().toISOString() }) {
  if (!database || !auth) throw new AccountError("Account saving is unavailable. Please contact your administrator.", 503, "FIREBASE_ADMIN_REQUIRED");

  async function reservePublicId(type) {
    const prefix = { admin: "ADM", doctor: "DOC", nurse: "NRS", staff: "STF" }[type];
    const snapshots = await Promise.all([database.ref("users").get(), database.ref("staff").get()]);
    const pattern = new RegExp(`^${prefix}-(\\d+)$`, "i");
    let highest = 0;
    for (const snapshot of snapshots) {
      for (const [key, record] of Object.entries(snapshot.val() || {})) {
        for (const value of [key, record?.id, record?.publicId, record?.accountId, record?.adminId, record?.doctorId, record?.staffId]) {
          const match = pattern.exec(String(value || ""));
          if (match) highest = Math.max(highest, Number(match[1]));
        }
      }
    }
    const result = await database.ref(`accountCounters/${prefix}`).transaction((current) => Math.max(Number(current) || 0, highest) + 1);
    if (!result.committed) throw new AccountError("Unable to reserve an account number. Please try again.", 409);
    return `${prefix}-${String(result.snapshot.val()).padStart(3, "0")}`;
  }

  function audit(actor, uid, action, timestamp) {
    const id = `account_${crypto.randomUUID()}`;
    return { id, actorId: actor.uid, actorEmail: actor.email || "", actorRole: actor.role, action, targetId: uid, targetType: "staff", source: "desktop", createdAt: timestamp, timestamp };
  }

  async function persist(user, staff, event, patches = null, pinRecord = null) {
    const updates = { [`auditLogs/${event.id}`]: event };
    if (pinRecord) updates[pins.recordPath({ uid: user.userId, authProviderId: "password" })] = pinRecord;
    if (patches) {
      for (const [collection, patch] of Object.entries(patches)) {
        for (const [field, value] of Object.entries(patch)) updates[`${collection}/${user.userId}/${field}`] = value;
      }
    } else {
      updates[`users/${user.userId}`] = user;
      updates[`staff/${staff.userId}`] = staff;
    }
    // One Firebase commit prevents a saved login role without its staff profile.
    await database.ref().update(updates);
    try { await cache({ user, staff, audit: event }); }
    catch { console.warn("Account saved in Firebase; local account cache could not be refreshed."); }
    return { user, staff, profile: staff };
  }

  async function create(input, actor) {
    if (pins) {
      pins.ready();
      if (typeof input.pin !== "string" || !/^\d{6}$/.test(input.pin) || input.pin !== input.confirmPin) throw new AccountError("Create and confirm the same 6-digit PIN.");
    }
    const type = accountType(input.accountType || input.role || "staff");
    if (type === "nurse") throw new AccountError("Choose Admin, Staff, or Doctor for new accounts.");
    const name = clean(input.name || input.fullName, 120);
    const contact = clean(input.contact || input.contactNumber, 40);
    const email = String(input.email || "").trim().toLowerCase();
    const password = input.password;
    if (!name || !contact || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError("Enter the account holder's name, contact number, and email address.");
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      throw new AccountError("Enter a password with 8–128 characters.");
    }
    const publicId = await reservePublicId(type);
    let createdAuth;
    try {
      createdAuth = await auth.createUser({ email, password, displayName: name, emailVerified: false, disabled: false });
    } catch (error) {
      if (error.code === "auth/email-already-exists") throw new AccountError("Email is already registered. Use a different email or sign in.", 409, "EMAIL_EXISTS");
      throw error;
    }
    const uid = accountId(createdAuth.uid);
    const timestamp = now();
    const base = {
      id: uid, uid, userId: uid, publicId, accountId: publicId,
      accountType: type, accountRole: type === "admin" ? "admin" : "staff", role: type === "admin" ? "admin" : "staff",
      name, fullName: name, displayName: name, email, normalizedEmail: email,
      contact, contactNumber: contact, emailVerified: false, active: true, status: "active", accountStatus: "active",
      createdAt: timestamp, updatedAt: timestamp, createdBy: actor.uid,
    };
    const user = { ...base, authProviderId: "password" };
    const staff = { ...base, jobTitle: clean(input.jobTitle, 80) || { admin: "System Administrator", doctor: "Doctor", nurse: "Nurse", staff: "Staff" }[type], schedule: clean(input.schedule, 80) };
    const event = audit(actor, uid, "staff_account_created", timestamp);
    try {
      const pinRecord = pins ? await pins.prepare({ uid, authProviderId: "password" }, input.pin) : null;
      return await persist(user, staff, event, null, pinRecord);
    } catch (error) {
      try { await auth.deleteUser(uid); }
      catch { throw new AccountError("Account saving failed and registration needs administrator recovery before retrying.", 503, "ACCOUNT_RECOVERY_REQUIRED"); }
      throw new AccountError("The account could not be saved. Check the connection and retry.", 503, "ACCOUNT_SAVE_FAILED");
    }
  }

  async function update(uidValue, input, actor, { ownProfile = false } = {}) {
    const password = input.password;
    if (password !== undefined) {
      if (ownProfile || actor?.role !== "admin") throw new AccountError("Only administrators can set account passwords through account management.", 403);
      if (typeof password !== "string" || password.length < 8 || password.length > 128) throw new AccountError("Enter a password with 8–128 characters.");
    }
    const uid = accountId(uidValue);
    const [userSnapshot, staffSnapshot] = await Promise.all([database.ref(`users/${uid}`).get(), database.ref(`staff/${uid}`).get()]);
    const previousUser = userSnapshot.val();
    const previousStaff = staffSnapshot.val() || {};
    if (!previousUser) throw new AccountError("Account not found. Refresh the account list.", 404, "ACCOUNT_NOT_FOUND");
    const savedRole = String(previousUser.role || previousStaff.accountType || previousStaff.role || "").toLowerCase();
    if (!["admin", "staff", "doctor", "nurse", "receptionist"].includes(savedRole)) throw new AccountError("This is not a clinic team account.", 403);
    if (input.email !== undefined && String(input.email).trim().toLowerCase() !== previousUser.email) throw new AccountError("The sign-in email stays linked to this registered account.");
    if (input.role !== undefined && accountType(input.role) !== accountType(savedRole)) throw new AccountError("Account access cannot be changed through profile editing.", 403);
    const timestamp = now();
    const shared = { userId: uid, updatedAt: timestamp };
    const details = {};
    if (input.name !== undefined) {
      const name = clean(input.name, 120);
      if (!name) throw new AccountError("Enter the account holder's name.");
      Object.assign(shared, { name, fullName: name, displayName: name });
    }
    if (input.contact !== undefined) Object.assign(shared, { contact: clean(input.contact, 40), contactNumber: clean(input.contact, 40) });
    for (const field of ["address", "schedule", "jobTitle"]) {
      if (input[field] !== undefined) details[field] = clean(input[field], field === "address" ? 500 : 80);
    }
    if (input.photoURL !== undefined) details.photoURL = String(input.photoURL || "").slice(0, 2_000_000);
    if (input.status !== undefined && !ownProfile) {
      if (!["active", "inactive"].includes(input.status)) throw new AccountError("Choose Active or Inactive.");
      if (input.status === "inactive" && (uid === actor.uid || savedRole === "admin")) throw new AccountError("Administrator accounts and your own account must remain active.", 403);
      Object.assign(shared, { status: input.status, accountStatus: input.status, active: input.status === "active" });
    }
    const user = { ...previousUser, ...shared };
    const staffPatch = { ...details, ...shared };
    const identityDefaults = { id: uid, role: savedRole, accountRole: savedRole === "admin" ? "admin" : "staff", accountType: previousUser.accountType || savedRole, email: previousUser.email || "" };
    for (const [field, value] of Object.entries(identityDefaults)) {
      if (!previousStaff[field]) staffPatch[field] = value;
    }
    const staff = { ...previousStaff, ...staffPatch };
    const authPatch = {};
    if (shared.displayName) authPatch.displayName = shared.displayName;
    if (shared.active !== undefined) authPatch.disabled = !shared.active;
    let previousAuth;
    if (Object.keys(authPatch).length) {
      previousAuth = await auth.getUser(uid);
      await auth.updateUser(uid, authPatch);
    }
    let result;
    try {
      result = await persist(user, staff, audit(actor, uid, ownProfile ? "staff_profile_updated" : "staff_account_updated", timestamp), { users: shared, staff: staffPatch });
    } catch (error) {
      if (previousAuth) {
        const rollback = {};
        if ("displayName" in authPatch) rollback.displayName = previousAuth.displayName || null;
        if ("disabled" in authPatch) rollback.disabled = Boolean(previousAuth.disabled);
        try { await auth.updateUser(uid, rollback); }
        catch { throw new AccountError("Account saving failed. Ask your administrator to check the account before retrying.", 503, "ACCOUNT_RECOVERY_REQUIRED"); }
      }
      throw new AccountError("Changes could not be saved. Please try again.", 503, "ACCOUNT_SAVE_FAILED");
    }
    if (password !== undefined) {
      try { await auth.updateUser(uid, { password }); }
      catch { throw new AccountError("Account details were saved, but the password could not be changed. Enter the new password and try again.", 503, "PASSWORD_UPDATE_FAILED"); }
    }
    return result;
  }

  async function remove(uidValue, actor) {
    if (actor?.role !== "admin") {
      throw new AccountError("Only administrators can delete clinic accounts.", 403);
    }
    const uid = accountId(uidValue);
    if (uid === actor.uid) {
      throw new AccountError("You cannot delete the account currently signed in.", 403);
    }

    const [userSnapshot, staffSnapshot] = await Promise.all([
      database.ref(`users/${uid}`).get(),
      database.ref(`staff/${uid}`).get(),
    ]);
    const user = userSnapshot.val();
    const staff = staffSnapshot.val() || {};
    if (!user) throw new AccountError("Account not found. Refresh the account list.", 404, "ACCOUNT_NOT_FOUND");
    const role = String(user.role || staff.accountRole || staff.role || "").toLowerCase();
    if (!['staff', 'doctor', 'nurse', 'receptionist'].includes(role)) {
      throw new AccountError("Administrator accounts cannot be deleted.", 403, "ACCOUNT_DELETE_PROTECTED");
    }

    const timestamp = now();
    const event = audit(actor, uid, "staff_account_deleted", timestamp);
    try {
      await auth.deleteUser(uid);
    } catch (error) {
      if (error.code === "auth/user-not-found") {
        throw new AccountError("The sign-in account was already removed. Refresh the account list.", 404, "ACCOUNT_NOT_FOUND");
      }
      throw error;
    }

    try {
      await database.ref().update({
        [`users/${uid}`]: null,
        [`staff/${uid}`]: null,
        [`auditLogs/${event.id}`]: event,
      });
    } catch {
      throw new AccountError("The sign-in was removed, but the account profile could not be cleared. Ask an administrator to refresh and finish cleanup.", 503, "ACCOUNT_DELETE_CLEANUP_REQUIRED");
    }

    try {
      await cache({ deletedUser: user, deletedStaff: staff, audit: event });
    } catch {
      console.warn("Account removed from Firebase; local account cache could not be refreshed.");
    }
    return { publicId: user.publicId || staff.publicId || "", userId: uid };
  }

  return { create, remove, update };
}

module.exports = { AccountError, accountType, requireAdministrator, createAccountService };
