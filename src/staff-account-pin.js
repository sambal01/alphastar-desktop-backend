"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { transactionWithLiveSnapshot } = require("./realtime-transaction");
const pbkdf2 = promisify(crypto.pbkdf2);
const ITERATIONS = 600_000;
const error = (message, status, code) => Object.assign(new Error(message), { status, code });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const validPin = pin => {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) throw error("Enter all 6 digits of your PIN.", 400, "STAFF_PIN_INVALID");
};
function equal(left, right) {
  return typeof left === "string" && typeof right === "string" && /^[a-f0-9]{64}$/.test(left) &&
    /^[a-f0-9]{64}$/.test(right) && crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function createStaffAccountPin({ getDatabase, enabled, pepper, now = Date.now,
  transact = transactionWithLiveSnapshot }) {
  // Do not silently generate a new pepper at startup: that would invalidate
  // every account PIN after a deployment. Keep it outside database backups.
  function ready() {
    if (!enabled || !/^[a-f0-9]{64}$/i.test(pepper || "")) {
      throw error("Account PIN access is not configured yet. Please contact the clinic.", 503, "STAFF_ACCOUNT_PIN_UNAVAILABLE");
    }
  }
  function reference(account) {
    ready();
    if (!account.uid || !["password"].includes(account.authProviderId)) throw error("Please sign in again.", 401, "STAFF_PIN_ACCOUNT_INVALID");
    return getDatabase().ref(`staffAccountPins/${digest(`${account.uid}:${account.authProviderId}`)}`);
  }
  function checked(row, account) {
    if (!row) return;
    if (row.authProviderId !== account.authProviderId || (row.verifier &&
      (row.version !== 1 || row.iterations !== ITERATIONS || !/^[a-f0-9]{64}$/.test(row.salt || "") ||
       !/^[a-f0-9]{64}$/.test(row.verifier) || !/^[a-f0-9]{32}$/.test(row.revision || "") || !Number.isInteger(row.failures) ||
       row.failures < 0 || !Number.isFinite(row.blockedUntil) || row.blockedUntil < 0))) {
      throw error("Your account PIN could not be checked. Please contact your administrator.", 503, "STAFF_PIN_RECORD_INVALID");
    }
  }
  let hashing = 0;
  async function verifier(account, pin, salt) {
    if (hashing >= 4) throw error("PIN checks are busy. Please try again shortly.", 503, "STAFF_PIN_BUSY");
    hashing++;
    try {
      const slowHash = await pbkdf2(pin, Buffer.from(salt, "hex"), ITERATIONS, 32, "sha256");
      return crypto.createHmac("sha256", Buffer.from(pepper, "hex"))
        .update(JSON.stringify([account.uid, account.authProviderId, salt])).update(slowHash).digest("hex");
    } finally { hashing--; }
  }
  async function newRecord(account, pin) {
    validPin(pin);
    const salt = crypto.randomBytes(32).toString("hex");
    return { version: 1, iterations: ITERATIONS, authProviderId: account.authProviderId, salt,
      verifier: await verifier(account, pin, salt), revision: crypto.randomBytes(16).toString("hex"),
      failures: 0, blockedUntil: 0, updatedAt: now() };
  }
  async function verifyPin(account, pin, forChange = false) {
      validPin(pin);
      const ref = reference(account);
      const attemptId = crypto.randomBytes(16).toString("hex");
      const changeToken = forChange ? crypto.randomBytes(32).toString("hex") : undefined;
      const expiresAt = now() + 300_000;
      let reserved;
      // Pessimistic durable reservation: crash/restart, another phone, or
      // simultaneous taps cannot reset or race the account attempt counter.
      const reservation = await transact(ref, row => {
        checked(row, account);
        if (!row?.verifier) throw error("Create your account PIN after signing in.", 409, "STAFF_PIN_NOT_CONFIGURED");
        if (row.failures >= 10) throw error("Too many incorrect attempts. Use Forgot PIN to reset your PIN with an email OTP.", 429, "STAFF_PIN_LOCKED");
        if (row.blockedUntil > now()) throw error(`Please wait ${Math.ceil((row.blockedUntil - now()) / 1000)} seconds before trying again.`, 429, "STAFF_PIN_LOCKED");
        if (row.attempt?.expiresAt > now()) throw error("A PIN check is already finishing. Please try again shortly.", 429, "STAFF_PIN_BUSY");
        const failures = row.failures + 1;
        reserved = { ...row, failures, blockedUntil: failures >= 5 ? now() + Math.min(900_000, 30_000 * 2 ** (failures - 5)) : 0,
          attempt: { id: attemptId, expiresAt: now() + 30_000 } };
        return reserved;
      });
      if (!reservation.committed || !reserved) throw error("A PIN check could not be started. Please try again.", 503, "STAFF_PIN_UNAVAILABLE");
      let matches;
      try { matches = equal(await verifier(account, pin, reserved.salt), reserved.verifier); }
      catch (cause) {
        if (cause.code === "STAFF_PIN_BUSY") {
          await transact(ref, row => {
            if (row?.revision !== reserved.revision || row?.attempt?.id !== attemptId) return;
            const { attempt, ...next } = row;
            return { ...next, failures: reserved.failures - 1, blockedUntil: 0 };
          });
        }
        throw cause;
      }
      const result = await transact(ref, row => {
        checked(row, account);
        if (row?.revision !== reserved.revision || row?.attempt?.id !== attemptId) return;
        const { attempt, ...next } = row;
        if (!matches) return next;
        return { ...next, failures: 0, blockedUntil: 0,
          ...(forChange ? { changeGrant: { hash: digest(changeToken), expiresAt, revision: row.revision } } : {}) };
      });
      if (!result.committed) throw error("Your account PIN changed during this check. Try again with your current PIN.", 409, "STAFF_PIN_CHANGED");
      if (!matches) throw error(reserved.failures >= 10 ? "Too many incorrect attempts. Use Forgot PIN to reset your PIN with an email OTP."
        : reserved.failures >= 5 ? "Incorrect PIN. Please wait before trying again, or use Forgot PIN." : "Incorrect PIN. Please try again.",
        400, "STAFF_PIN_INCORRECT");
      if (forChange) return { changeToken, expiresAt };
  }
  return {
    ready,
    recordPath: account => `staffAccountPins/${digest(`${account.uid}:${account.authProviderId}`)}`,
    prepare: newRecord,
    async status(account) {
      const row = (await reference(account).get()).val();
      checked(row, account);
      // Never expose the verifier, salt, pepper or recovery grants to the app.
      return { configured: Boolean(row?.verifier) };
    },
    async create(account, pin) {
      const ref = reference(account);
      const current = (await ref.get()).val();
      checked(current, account);
      if (current?.verifier) throw error("This account already has a PIN. Enter your existing PIN or use Forgot PIN.", 409, "STAFF_PIN_EXISTS");
      const replacement = await newRecord(account, pin);
      const result = await transact(ref, row => {
        checked(row, account);
        if (row?.verifier) return;
        return replacement;
      });
      if (!result.committed) throw error("This account already has a PIN. Enter your existing PIN or use Forgot PIN.", 409, "STAFF_PIN_EXISTS");
    },
    verify: (account, pin) => verifyPin(account, pin),
    beginChange: (account, pin) => verifyPin(account, pin, true),
    async change(account, pin, changeToken) {
      validPin(pin);
      const ref = reference(account);
      const permitted = row => row?.verifier && row.changeGrant?.revision === row.revision &&
        row.changeGrant.expiresAt > now() && /^[a-f0-9]{64}$/.test(changeToken || "") &&
        equal(row.changeGrant.hash, digest(changeToken));
      const required = () => error("Your PIN check expired or was already used. Enter your current PIN again.", 403, "STAFF_PIN_CHANGE_REQUIRED");
      const current = (await ref.get()).val();
      checked(current, account);
      if (!permitted(current)) throw required();
      const replacement = await newRecord(account, pin);
      const result = await transact(ref, row => {
        checked(row, account);
        if (!permitted(row)) return;
        return replacement; // Consume proof of the current PIN and all grants atomically.
      });
      if (!result.committed) throw required();
    },
    async issueResetGrant(account) {
      const ref = reference(account);
      const token = crypto.randomBytes(32).toString("hex");
      const result = await transact(ref, row => {
        checked(row, account);
        return { ...row, authProviderId: account.authProviderId,
          resetGrant: { hash: digest(token), expiresAt: now() + 300_000 } };
      });
      if (!result.committed) throw error("PIN reset verification could not be saved. Use Forgot PIN to try again.", 503, "STAFF_PIN_RESET_UNAVAILABLE");
      return token;
    },
    async reset(account, pin, resetToken) {
      const ref = reference(account);
      if (!/^[a-f0-9]{64}$/.test(resetToken || "")) throw error("Use Forgot PIN to verify your email before resetting your PIN.", 403, "STAFF_PIN_RESET_REQUIRED");
      const current = (await ref.get()).val();
      checked(current, account);
      if (!current?.resetGrant || current.resetGrant.expiresAt <= now() || !equal(current.resetGrant.hash, digest(resetToken))) {
        throw error("This PIN reset verification expired or was already used. Use Forgot PIN to verify your email again.", 403, "STAFF_PIN_RESET_REQUIRED");
      }
      const replacement = await newRecord(account, pin);
      const result = await transact(ref, row => {
        checked(row, account);
        if (!row?.resetGrant || row.resetGrant.expiresAt <= now() || !equal(row.resetGrant.hash, digest(resetToken))) return;
        return replacement; // Consume the grant and replace PIN atomically.
      });
      if (!result.committed) throw error("This PIN reset verification expired or was already used. Use Forgot PIN to verify your email again.", 403, "STAFF_PIN_RESET_REQUIRED");
    },
  };
}


module.exports = { createStaffAccountPin, ITERATIONS };
