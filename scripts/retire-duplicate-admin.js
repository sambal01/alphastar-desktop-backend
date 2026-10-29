"use strict";
// Explicit maintenance command. Public account-management APIs still protect Admins.
const path = require("node:path"), crypto = require("node:crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const store = require("../src/persistent-store");
const fs = require("node:fs");
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
(async () => {
  const email = option("--target"), keepEmail = option("--keep"), expectedId = option("--expected-id");
  if (!args.includes("--target") || !args.includes("--keep") || !args.includes("--expected-id") || email === keepEmail) throw new Error("Supply distinct --target and --keep emails and --expected-id.");
  const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) : JSON.parse(fs.readFileSync(path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS), "utf8"));
  const app = initializeApp({ credential: cert(credential), databaseURL: process.env.FIREBASE_DATABASE_URL });
  const auth = getAuth(app), db = getDatabase(app);
  const [target, keep] = await Promise.all([auth.getUserByEmail(email), auth.getUserByEmail(keepEmail)]);
  if (target.uid === keep.uid || keep.disabled) throw new Error("The retained administrator must be a separate active account.");
  const [targetSnap, keepSnap, staffSnap] = await Promise.all([db.ref("users/" + target.uid).get(), db.ref("users/" + keep.uid).get(), db.ref("staff/" + target.uid).get()]);
  const targetUser = targetSnap.val(), keptUser = keepSnap.val(), targetStaff = staffSnap.val();
  if (!targetUser || !targetStaff || targetUser.role !== "admin" || keptUser?.role !== "admin" ||
    keptUser.active === false || keptUser.accountStatus === "inactive" ||
    (targetUser.publicId || targetUser.accountId) !== expectedId ||
    String(targetUser.email).toLowerCase() !== email.toLowerCase()) throw new Error("Account identity/protection checks failed; nothing removed.");
  if (!args.includes("--apply")) { console.log(JSON.stringify({ dryRun: true, target: email, publicId: expectedId, keep: keepEmail })); return; }
  const key = crypto.createHash("sha256").update(target.uid + ":password").digest("hex");
  const emailKey = crypto.createHash("sha256").update(email.toLowerCase()).digest("hex");
  const registry = (await db.ref("emailRegistry/" + emailKey).get()).val();
  const auditId = "account_" + crypto.randomUUID();
  const event = { id: auditId, actorId: keep.uid, actorRole: "admin", action: "duplicate_admin_account_deleted",
    targetId: target.uid, targetType: "staff", source: "desktop", createdAt: new Date().toISOString() };
  // Permanent Auth deletion revokes this account's access. Clinical collections are untouched.
  await auth.deleteUser(target.uid);
  const updates = { ["users/" + target.uid]: null, ["staff/" + target.uid]: null,
    ["staffAccountPins/" + key]: null, ["auditLogs/" + auditId]: event };
  if (registry?.uid === target.uid) updates["emailRegistry/" + emailKey] = null;
  try { await db.ref().update(updates); }
  catch { throw new Error("Auth access was removed, but profile cleanup failed. An administrator must finish cleanup for " + expectedId + "."); }
  const dataFile = path.resolve(__dirname, "..", process.env.ALPHASTAR_DATA_FILE || "data/local-store.json");
  if (fs.existsSync(dataFile)) {
    const local = store.read(dataFile, {});
    for (const collection of ["users", "staff"]) for (const [id, row] of Object.entries(local[collection] || {}))
      if (id === target.uid || row.userId === target.uid || row.uid === target.uid) delete local[collection][id];
    if (local.emailRegistry?.[emailKey]?.uid === target.uid) delete local.emailRegistry[emailKey];
    local.auditLogs ||= {}; local.auditLogs[auditId] = event; store.write(dataFile, local);
  }
  const remaining = (await db.ref("users/" + keep.uid).get()).val();
  if (remaining?.role !== "admin") throw new Error("Retained admin verification failed.");
  console.log(JSON.stringify({ deleted: true, email, publicId: expectedId, retained: keepEmail, clinicalHistoryUntouched: true }));
})().then(() => process.exit(0)).catch(error => { console.error(error.code || error.message); process.exit(1); });
