"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AccountError, createAccountService, requireAdministrator } = require("../src/account-service");

const NOW = "2026-09-10T03:00:00.000Z";
const administrator = { uid: "admin_auth", role: "admin", email: "admin@example.invalid" };

test("only the trusted email-verification option marks a new account verified", async () => {
  const unverified = fixture();
  const original = await unverified.service.create(input({ emailVerified: true }), administrator);
  assert.equal(original.user.emailVerified, false); assert.equal(unverified.authAccounts()[original.user.userId].emailVerified, false);
  const verified = fixture();
  const created = await verified.service.create(input(), administrator, { emailVerified: true });
  assert.equal(created.user.emailVerified, true); assert.equal(created.staff.emailVerified, true);
  assert.equal(verified.authAccounts()[created.user.userId].emailVerified, true);
});

test("administrators set passwords in Auth without copying them to records or logs", async () => {
  const f = fixture();
  const creationPassword = "Created-private-password-123";
  const created = await f.service.create(input({ password: creationPassword }), administrator);
  const uid = created.user.userId;
  assert.equal(f.authAccounts()[uid].password, creationPassword);
  assert.equal(JSON.stringify({ records: f.read(), cache: f.cache }).includes(creationPassword), false);
  const password = "New-private-password-123";
  await f.service.update(uid, { password }, administrator);
  assert.equal(f.authAccounts()[uid].password, password);
  assert.equal(JSON.stringify({ records: f.read(), cache: f.cache }).includes(password), false);
  await f.service.update(uid, { name: "Updated Name" }, administrator);
  assert.equal(f.authAccounts()[uid].password, password);
});

test("password changes reject Staff, own-profile requests, and invalid passwords before writes", async () => {
  const f = fixture();
  for (const [password, actor, options] of [
    ["Valid-password123", { uid: "staff", role: "staff" }, {}],
    ["Valid-password123", administrator, { ownProfile: true }],
    ["short", administrator, {}],
    ["alllowercase123!", administrator, {}],
    ["ALLUPPERCASE123!", administrator, {}],
    ["NoNumberHere!", administrator, {}],
    ["NoSpecialCharacter123", administrator, {}],
    [123456789, administrator, {}],
  ]) {
    await assert.rejects(f.service.update("target", { password }, actor, options));
  }
  assert.equal(f.authCalls.length, 0);
  assert.equal(f.commits.length, 0);
});

test("account creation enforces every displayed password requirement before Auth writes", async () => {
  for (const password of ["alllowercase123!", "ALLUPPERCASE123!", "NoNumberHere!", "NoSpecialCharacter123"]) {
    const f = fixture();
    await assert.rejects(f.service.create(input({ password }), administrator), /uppercase and lowercase letters/);
    assert.equal(f.authCalls.length, 0);
    assert.equal(f.commits.length, 0);
  }
});

function fixture(initial = {}, options = {}) {
  let state = structuredClone(initial);
  let sequence = 0;
  let transactionChain = Promise.resolve();
  const accounts = structuredClone(options.authAccounts || {});
  const cache = [];
  const commits = [];
  const authCalls = [];

  function read(path = "", source = state) {
    return structuredClone(path ? path.split("/").reduce((value, key) => value?.[key], source) ?? null : source);
  }

  function write(target, path, value) {
    const keys = path.split("/");
    const last = keys.pop();
    const parent = keys.reduce((current, key) => current[key] ||= {}, target);
    parent[last] = structuredClone(value);
  }

  const snapshot = (value) => ({ val: () => structuredClone(value) });
  const database = {
    ref(path = "") {
      return {
        get: async () => snapshot(read(path)),
        transaction(update) {
          const pending = transactionChain.then(() => {
            const next = update(read(path));
            if (next === undefined) return { committed: false, snapshot: snapshot(read(path)) };
            write(state, path, next);
            return { committed: true, snapshot: snapshot(next) };
          });
          transactionChain = pending.catch(() => {});
          return pending;
        },
        async update(updates) {
          assert.equal(path, "", "related account records must be committed together at the database root");
          if (options.failSave) throw new Error("Simulated Firebase write failure");
          const next = structuredClone(state);
          for (const [key, value] of Object.entries(updates)) write(next, key, value);
          state = next;
          commits.push(structuredClone(updates));
        },
      };
    },
  };
  const auth = {
    async createUser(input) {
      authCalls.push({ method: "createUser", input: structuredClone(input) });
      if (Object.values(accounts).some((account) => account.email === input.email)) {
        throw Object.assign(new Error("Email exists"), { code: "auth/email-already-exists" });
      }
      const uid = `created_auth_${++sequence}`;
      accounts[uid] = { uid, ...structuredClone(input) };
      return structuredClone(accounts[uid]);
    },
    async getUser(uid) {
      authCalls.push({ method: "getUser", uid });
      if (!accounts[uid]) throw Object.assign(new Error("User missing"), { code: "auth/user-not-found" });
      return structuredClone(accounts[uid]);
    },
    async updateUser(uid, patch) {
      authCalls.push({ method: "updateUser", uid, patch: structuredClone(patch) });
      if (!accounts[uid]) throw new Error("User missing");
      Object.assign(accounts[uid], structuredClone(patch));
      await options.onAuthUpdate?.({ uid, patch, write: (path, value) => write(state, path, value) });
      return structuredClone(accounts[uid]);
    },
    async deleteUser(uid) {
      authCalls.push({ method: "deleteUser", uid });
      if (options.failAuthRollback) throw new Error("Simulated Auth rollback failure");
      delete accounts[uid];
    },
  };
  const service = createAccountService({
    database,
    auth,
    pins: options.pins,
    now: () => NOW,
    cache: async (value) => {
      const commit = commits.find((updates) => updates[`auditLogs/${value.audit.id}`]);
      assert.ok(commit, "the remote account commit must finish before local caching");
      for (const [path, expected] of Object.entries(commit)) {
        assert.deepEqual(read(path), expected, `${path} must be saved remotely before caching`);
      }
      cache.push(structuredClone(value));
    },
  });
  return { service, read, cache, commits, authCalls, authAccounts: () => structuredClone(accounts) };
}

function input(overrides = {}) {
  return {
    name: "New Clinic Member",
    contact: "09170000000",
    email: "new.member@example.invalid",
    accountType: "staff",
    password: "New-private-password-123",
    ...overrides,
  };
}

test("account and PIN verifier are committed together without plaintext PIN in records or responses", async () => {
  const { createStaffAccountPin } = require("../src/staff-account-pin");
  const pins = createStaffAccountPin({ enabled: true, pepper: "a".repeat(64), getDatabase: () => ({}) });
  const f = fixture({}, { pins });
  const result = await f.service.create(input({ pin: "012345", confirmPin: "012345" }), administrator);
  const uid = result.user.userId;
  const commit = f.commits[0];
  assert.ok(commit[`users/${uid}`]);
  assert.ok(commit[`staff/${uid}`]);
  assert.match(commit[pins.recordPath({ uid, authProviderId: "password" })].verifier, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify({ database: f.read(), cache: f.cache, result }).includes("012345"), false);
});

test("missing or mismatched PIN is rejected before Auth creation when saved PINs are enabled", async () => {
  const pins = { ready() {}, prepare() { assert.fail("Must validate first"); } };
  for (const values of [{}, { pin: "012345", confirmPin: "543210" }, { pin: 123456, confirmPin: 123456 }]) {
    const f = fixture({}, { pins });
    await assert.rejects(f.service.create(input(values), administrator), /6-digit PIN/);
    assert.equal(f.authCalls.length, 0); assert.equal(f.commits.length, 0);
  }
});

function savedAccount(role = "admin", uid = "admin_auth") {
  const publicId = role === "admin" ? "ADM-0001" : "STF-0007";
  return {
    users: {
      [uid]: {
        role, accountType: role, publicId, email: "existing@example.invalid", fullName: "Existing Member",
        accountStatus: "active", emailVerified: true, createdAt: "2026-01-01", customData: { retain: true },
      },
    },
    staff: {
      [uid]: {
        userId: uid, role, accountType: role, publicId, ...(role === "admin" ? { adminId: publicId } : { staffId: publicId }),
        email: "existing@example.invalid", name: "Existing Member", contact: "09170000001", address: "Clinic address",
        active: true, schedule: "Weekdays", jobTitle: role === "admin" ? "System Administrator" : "Staff", customStaffField: "retain",
      },
    },
  };
}

function existingAuth(uid = "admin_auth") {
  return { [uid]: { uid, email: "existing@example.invalid", displayName: "Existing Member", disabled: false } };
}

test("creating an account atomically saves its login record, profile, and audit before caching", async () => {
  const f = fixture();
  const result = await f.service.create(input(), administrator);
  const uid = result.user.userId;

  assert.equal(f.commits.length, 1);
  assert.equal(Object.keys(f.commits[0]).length, 3);
  assert.deepEqual(f.read(`users/${uid}`), result.user);
  assert.deepEqual(f.read(`staff/${uid}`), result.staff);
  assert.deepEqual(result.profile, result.staff);
  assert.equal(f.cache.length, 1);
  assert.equal(f.cache[0].audit.actorId, administrator.uid);
  assert.equal(f.cache[0].audit.targetId, uid);
  assert.equal(f.cache[0].audit.action, "staff_account_created");
  assert.equal(result.user.accountStatus, "active");
  assert.equal(result.staff.active, true);
  assert.equal(result.user.createdAt, NOW);
  assert.equal(f.authAccounts()[uid].email, result.user.email);
});

test("deleting a clinic account removes its Auth sign-in and profile but retains an audit record", async () => {
  const targetId = "staff_auth";
  const f = fixture(savedAccount("staff", targetId), {
    authAccounts: {
      [targetId]: {
        uid: targetId,
        email: "existing@example.invalid",
        displayName: "Existing Member",
      },
    },
  });

  const result = await f.service.remove(targetId, administrator);

  assert.equal(result.userId, targetId);
  assert.equal(f.read(`users/${targetId}`), null);
  assert.equal(f.read(`staff/${targetId}`), null);
  assert.equal(f.authAccounts()[targetId], undefined);
  const audit = Object.values(f.read("auditLogs") || {})[0];
  assert.equal(audit.action, "staff_account_deleted");
  assert.equal(audit.targetId, targetId);
});

test("account deletion protects the last active administrator", async () => {
  const f = fixture(savedAccount("admin", "other_admin"), {
    authAccounts: {
      other_admin: { uid: "other_admin", email: "existing@example.invalid" },
    },
  });
  await assert.rejects(f.service.remove("other_admin", administrator), {
    code: "LAST_ACTIVE_ADMIN",
  });
  await assert.rejects(f.service.remove(administrator.uid, administrator));
  assert.equal(f.authCalls.length, 0);
});

test("an administrator can delete their own account while another remains active", async () => {
  const first = savedAccount("admin", administrator.uid);
  const second = savedAccount("admin", "other_admin");
  const f = fixture({ users: { ...first.users, ...second.users }, staff: { ...first.staff, ...second.staff } }, {
    authAccounts: { ...existingAuth(administrator.uid), ...existingAuth("other_admin") },
  });
  assert.equal((await f.service.deletionTarget(administrator.uid, administrator)).role, "admin");
  assert.equal((await f.service.remove(administrator.uid, administrator)).userId, administrator.uid);
  assert.equal(f.read(`users/${administrator.uid}`), null);
  assert.deepEqual(f.read("users/other_admin"), second.users.other_admin);
});

test("concurrent admin deletions leave one active administrator", async () => {
  const first = savedAccount("admin", administrator.uid);
  const second = savedAccount("admin", "other_admin");
  const f = fixture({ users: { ...first.users, ...second.users }, staff: { ...first.staff, ...second.staff } }, {
    authAccounts: { ...existingAuth(administrator.uid), ...existingAuth("other_admin") },
  });
  const results = await Promise.allSettled([
    f.service.remove(administrator.uid, administrator),
    f.service.remove("other_admin", { ...administrator, uid: "other_admin" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "LAST_ACTIVE_ADMIN");
  assert.equal(Object.values(f.read("users")).filter(user => user?.role === "admin" && user.active !== false).length, 1);
});

test("registration ignores caller-provided account identity, access overrides, and security material", async () => {
  const f = fixture();
  const result = await f.service.create(input({
    email: "  MEMBER@EXAMPLE.INVALID ",
    userId: "injected_uid", uid: "injected_uid", id: "injected_uid", publicId: "ADM-9999", accountId: "ADM-9999",
    role: "admin", accountRole: "admin", accountStatus: "inactive", status: "inactive", active: false,
    createdBy: "injected_actor", createdAt: "injected_time",
    accountVerificationToken: "injected_verification_token", idToken: "injected_auth_token", admin: true,
  }), administrator);

  assert.equal(result.user.userId, "created_auth_1");
  assert.equal(result.user.publicId, "STF-001");
  assert.equal(result.user.role, "staff");
  assert.equal(result.staff.accountRole, "staff");
  assert.equal(result.user.email, "member@example.invalid");
  assert.equal(result.user.accountStatus, "active");
  assert.equal(result.user.createdBy, administrator.uid);
  const saved = JSON.stringify({ database: f.read(), cache: f.cache });
  for (const forbidden of ["injected_", "ADM-9999", "accountVerificationToken", "idToken", '"password":', '"admin":true']) {
    assert.equal(saved.includes(forbidden), false, `must not persist ${forbidden}`);
  }
});

test("admin, staff, and doctor registrations use canonical desktop access roles", async () => {
  for (const [type, role, prefix] of [["admin", "admin", "ADM"], ["staff", "staff", "STF"], ["doctor", "staff", "DOC"]]) {
    const f = fixture();
    const result = await f.service.create(input({ accountType: type }), administrator);
    assert.equal(result.user.role, role, `${type} must have a supported desktop login role`);
    assert.equal(result.staff.role, role);
    assert.equal(result.user.accountRole, role);
    assert.equal(result.user.accountType, type);
    assert.equal(result.staff.accountType, type);
    assert.equal(result.user.publicId, `${prefix}-001`);
  }
});

test("new accounts reject the retired Nurse type before creating a user", async () => {
  for (const values of [{ accountType: "nurse" }]) {
    const f = fixture();
    await assert.rejects(f.service.create(input(values), administrator));
    assert.equal(f.authCalls.length, 0);
    assert.equal(f.commits.length, 0);
  }
});

test("a failed remote registration removes newly created Auth and never reports or caches success", async () => {
  const f = fixture({}, { failSave: true });
  await assert.rejects(f.service.create(input(), administrator), { code: "ACCOUNT_SAVE_FAILED", status: 503 });
  assert.deepEqual(f.authAccounts(), {});
  assert.deepEqual(f.authCalls.map((call) => call.method), ["createUser", "deleteUser"]);
  assert.equal(f.read("users"), null);
  assert.equal(f.read("staff"), null);
  assert.equal(f.read("auditLogs"), null);
  assert.equal(f.cache.length, 0);
  assert.equal(f.commits.length, 0);
});

test("a failed Auth rollback returns an explicit recovery error and never creates saved profiles", async () => {
  const f = fixture({}, { failSave: true, failAuthRollback: true });
  await assert.rejects(f.service.create(input(), administrator), { code: "ACCOUNT_RECOVERY_REQUIRED", status: 503 });
  assert.equal(f.read("users"), null);
  assert.equal(f.read("staff"), null);
  assert.equal(f.cache.length, 0);
});

test("duplicate Auth email preserves the existing login and creates no database account", async () => {
  const authAccounts = { existing: { uid: "existing", email: "new.member@example.invalid", displayName: "Original" } };
  const f = fixture({}, { authAccounts });
  await assert.rejects(f.service.create(input(), administrator), { code: "EMAIL_EXISTS", status: 409 });
  assert.deepEqual(f.authAccounts(), authAccounts);
  assert.equal(f.read("users"), null);
  assert.equal(f.cache.length, 0);
  assert.equal(f.authCalls.some((call) => call.method === "deleteUser"), false);
});

test("editing an existing admin preserves canonical remote data even with an empty local cache", async () => {
  const initial = savedAccount();
  const f = fixture(initial, { authAccounts: existingAuth() });
  assert.equal(f.cache.length, 0);
  const result = await f.service.update("admin_auth", {
    name: "Updated Administrator", contact: "09170000002", address: "Updated clinic address",
    uid: "injected_uid", userId: "injected_uid", publicId: "STF-999", accountId: "STF-999", accountType: "staff",
    accountVerificationToken: "injected_verification_token",
  }, administrator, { ownProfile: true });

  assert.equal(result.user.role, "admin");
  assert.equal(result.user.accountType, "admin");
  assert.equal(result.user.publicId, "ADM-0001");
  assert.equal(result.user.email, initial.users.admin_auth.email);
  assert.equal(result.user.fullName, "Updated Administrator");
  assert.equal(result.user.createdAt, initial.users.admin_auth.createdAt);
  assert.deepEqual(result.user.customData, { retain: true });
  assert.equal(result.staff.adminId, "ADM-0001");
  assert.equal(result.staff.role, "admin");
  assert.equal(result.staff.accountType, "admin");
  assert.equal(result.staff.schedule, "Weekdays");
  assert.equal(result.staff.customStaffField, "retain");
  assert.equal(result.staff.address, "Updated clinic address");
  assert.equal(result.staff.contact, "09170000002");
  assert.equal(f.authAccounts().admin_auth.displayName, "Updated Administrator");
  assert.equal(f.cache[0].audit.action, "staff_profile_updated");
  assert.equal(JSON.stringify({ remote: f.read(), cache: f.cache }).includes("injected_"), false);
});

test("a failed profile save restores Auth changes and preserves remote records and empty cache", async () => {
  const initial = savedAccount();
  const authAccounts = existingAuth();
  const f = fixture(initial, { authAccounts, failSave: true });
  await assert.rejects(f.service.update("admin_auth", { name: "Unsaved Name" }, administrator, { ownProfile: true }), {
    code: "ACCOUNT_SAVE_FAILED", status: 503,
  });
  assert.deepEqual(f.read(), initial);
  assert.deepEqual(f.authAccounts(), authAccounts);
  assert.equal(f.cache.length, 0);
  assert.deepEqual(f.authCalls.filter((call) => call.method === "updateUser").map((call) => call.patch.displayName), ["Unsaved Name", "Existing Member"]);
});

test("profile saves preserve unrelated remote edits made after the account was loaded", async () => {
  let concurrentEdits = 0;
  const f = fixture(savedAccount(), {
    authAccounts: existingAuth(),
    onAuthUpdate: ({ uid, write }) => {
      concurrentEdits += 1;
      write(`users/${uid}/concurrentUserField`, { changedBy: "another_session" });
      write(`staff/${uid}/address`, "Address saved by another session");
      write(`staff/${uid}/concurrentStaffField`, { retain: true });
    },
  });
  const result = await f.service.update("admin_auth", { name: "Updated Administrator" }, administrator, { ownProfile: true });

  assert.equal(concurrentEdits, 1);
  assert.equal(result.user.fullName, "Updated Administrator");
  assert.equal(f.read("users/admin_auth/fullName"), "Updated Administrator");
  assert.equal(f.read("staff/admin_auth/name"), "Updated Administrator");
  assert.deepEqual(f.read("users/admin_auth/concurrentUserField"), { changedBy: "another_session" });
  assert.deepEqual(f.read("staff/admin_auth/concurrentStaffField"), { retain: true });
  assert.equal(f.read("staff/admin_auth/address"), "Address saved by another session");
  assert.equal(f.read("users/admin_auth/role"), "admin");
  assert.equal(f.read("staff/admin_auth/adminId"), "ADM-0001");
  assert.equal(f.commits.length, 1);
  assert.equal(f.cache.length, 1);
});

test("updating a missing account cannot create an orphan profile", async () => {
  const f = fixture();
  await assert.rejects(f.service.update("missing_auth", { name: "Missing" }, administrator), { code: "ACCOUNT_NOT_FOUND", status: 404 });
  assert.deepEqual(f.read(), {});
  assert.equal(f.authCalls.length, 0);
  assert.equal(f.cache.length, 0);
});

test("profile updates reject changes to account email or access role", async () => {
  for (const patch of [{ email: "different@example.invalid" }, { role: "staff" }]) {
    const initial = savedAccount();
    const f = fixture(initial, { authAccounts: existingAuth() });
    await assert.rejects(f.service.update("admin_auth", patch, administrator), AccountError);
    assert.deepEqual(f.read(), initial);
    assert.equal(f.authCalls.length, 0);
    assert.equal(f.cache.length, 0);
  }
});

test("administrators and the acting account cannot be deactivated", async () => {
  for (const [role, uid, actor] of [
    ["admin", "other_admin", administrator],
    ["staff", "own_staff", { uid: "own_staff", role: "staff" }],
  ]) {
    const initial = savedAccount(role, uid);
    const f = fixture(initial, { authAccounts: existingAuth(uid) });
    await assert.rejects(f.service.update(uid, { status: "inactive" }, actor), { status: 403 });
    assert.deepEqual(f.read(), initial);
    assert.equal(f.authCalls.length, 0);
    assert.equal(f.cache.length, 0);
  }
});

test("own profile updates ignore status injection", async () => {
  const f = fixture(savedAccount(), { authAccounts: existingAuth() });
  const result = await f.service.update("admin_auth", { status: "inactive", active: false, accountStatus: "inactive" }, administrator, { ownProfile: true });
  assert.equal(result.user.accountStatus, "active");
  assert.equal(result.staff.active, true);
  assert.equal(f.authAccounts().admin_auth.disabled, false);
});

test("administrator status changes update Auth, canonical login status, and staff status together", async () => {
  const f = fixture(savedAccount("staff", "staff_auth"), { authAccounts: existingAuth("staff_auth") });
  const result = await f.service.update("staff_auth", { status: "inactive" }, administrator);
  assert.equal(result.user.accountStatus, "inactive");
  assert.equal(result.user.status, "inactive");
  assert.equal(result.staff.active, false);
  assert.equal(f.authAccounts().staff_auth.disabled, true);
  assert.equal(f.commits.length, 1);
  assert.equal(f.cache.length, 1);
});

test("account management requires administrator access", () => {
  for (const access of [null, { actor: { role: "patient" } }, { actor: { role: "staff" }, decoded: { role: "admin" } }, { actor: { role: "doctor" }, decoded: { source: "desktop" } }]) {
    assert.throws(() => requireAdministrator(access), { code: "ADMIN_REQUIRED", status: 403 });
  }
  assert.doesNotThrow(() => requireAdministrator({ actor: administrator }));
  assert.throws(() => requireAdministrator({ actor: { role: "staff" }, decoded: { admin: true } }), { code: "ADMIN_REQUIRED" });
});

test("concurrent registrations reserve unique account numbers beyond existing ADM-0001", async () => {
  const initial = savedAccount();
  const f = fixture(initial);
  const created = await Promise.all([1, 2, 3].map((number) => f.service.create(input({
    accountType: "admin", email: `new.admin.${number}@example.invalid`,
  }), administrator)));
  assert.deepEqual(created.map((result) => result.user.publicId).sort(), ["ADM-002", "ADM-003", "ADM-004"]);
  assert.equal(new Set(created.map((result) => result.user.userId)).size, 3);
  assert.equal(f.read("accountCounters/ADM"), 4);
  assert.deepEqual(f.read("users/admin_auth"), initial.users.admin_auth);
  assert.equal(Object.keys(f.read("users")).length, 4);
  assert.equal(Object.keys(f.read("staff")).length, 4);
  assert.equal(f.cache.length, 3);
});
