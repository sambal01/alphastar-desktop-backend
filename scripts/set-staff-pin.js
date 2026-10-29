"use strict";
const fs = require("node:fs"), path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const { createStaffAccountPin } = require("../src/staff-account-pin");
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
function readPin() {
  return new Promise((resolve, reject) => {
    let value = "";
    const terminal = process.stdin.isTTY;
    if (terminal) process.stdin.setRawMode(true);
    process.stdout.write("Enter the new 6-digit PIN (hidden): ");
    const finish = () => {
      process.stdin.off("data", receive);
      if (terminal) process.stdin.setRawMode(false);
      process.stdin.pause(); process.stdout.write("\n"); resolve(value);
    };
    const receive = data => {
      for (const char of data.toString()) {
        if (char === "\u0003") { reject(new Error("Cancelled; PIN not changed.")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on("data", receive); process.stdin.resume();
  });
}
(async () => {
  if (!args.includes("--email") || !args.includes("--expected-id")) throw new Error("Supply --email and --expected-id.");
  const email = option("--email"), expectedId = option("--expected-id");
  const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) : JSON.parse(fs.readFileSync(path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS), "utf8"));
  const app = initializeApp({ credential: cert(credential), databaseURL: process.env.FIREBASE_DATABASE_URL });
  const authUser = await getAuth(app).getUserByEmail(email), database = getDatabase(app);
  const profile = (await database.ref("users/" + authUser.uid).get()).val();
  if (!profile || !["admin", "staff"].includes(profile.role) || (profile.publicId || profile.accountId) !== expectedId ||
    String(profile.email).toLowerCase() !== email.toLowerCase() || profile.active === false || authUser.disabled) throw new Error("Active clinic account identity checks failed.");
  const rules = (await database.getRulesJSON()).rules;
  if (rules[".read"] !== false || Object.keys(rules).some(key => key.startsWith("$")) ||
    (rules.staffAccountPins && rules.staffAccountPins[".read"] !== false)) throw new Error("PIN records must be backend-only before setup.");
  const pins = createStaffAccountPin({ getDatabase: () => database, enabled: process.env.STAFF_ACCOUNT_PIN_ENABLED === "true", pepper: process.env.STAFF_PIN_PEPPER });
  pins.ready();
  const account = { uid: authUser.uid, authProviderId: "password" };
  if ((await pins.status(account)).configured) throw new Error("This account already has a PIN; use the authorized PIN-change flow.");
  let pin = await readPin();
  if (!/^\d{6}$/.test(pin)) throw new Error("Enter exactly six digits.");
  await pins.create(account, pin); await pins.verify(account, pin); pin = "";
  console.log(JSON.stringify({ configured: true, verified: true, email, publicId: expectedId }));
})().then(() => process.exit(0)).catch(error => { console.error(error.code || error.message); process.exit(1); });
