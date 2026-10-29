"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
function runtime() {
  const routes = new Map(), calls = [];
  const pins = {
    status: async account => { calls.push(["status", account]); return { configured: true }; },
    create: async (...args) => { calls.push(["create", ...args]); },
    verify: async (account, pin) => {
      calls.push(["verify", account, pin]);
      if (pin !== "012345") throw Object.assign(new Error("Incorrect PIN."), { status: 400, code: "STAFF_PIN_INCORRECT" });
    },
    beginChange: async (account, pin) => { await pins.verify(account, pin); return { changeToken: "proof" }; },
    change: async (...args) => { calls.push(["change", ...args]); },
  };
  const context = vm.createContext({
    app: { post: (route, handler) => routes.set(route, handler) }, process: { env: {} }, Date,
    staffRoles: new Set(["admin", "staff", "doctor", "nurse", "receptionist"]),
    createFirebaseCustomToken: async uid => { calls.push(["token", uid]); return "synthetic-token"; },
    actorFromRequest: req => ({ ...req.staffAccess.actor, email: req.staffAccess.decoded.email }),
    id: prefix => prefix + "-test", firebaseAdminApp: () => ({}),
    sendError: (res, error) => res.status(error.status || 503).json({ ok: false, code: error.code, error: error.message }),
    sendMail: () => assert.fail("Normal PIN sign-in must never send email"),
  });
  const start = source.indexOf("function desktopPins()");
  const end = source.indexOf('app.post("/api/staff-auth/session/renew"', start);
  vm.runInContext(source.slice(start, end), context);
  context.desktopPins.service = pins;
  async function request(route, body = {}, access = { actor: { uid: "canonical-admin", role: "admin" },
    decoded: { email: "admin@example.invalid", auth_time: Date.now() / 1000 } }) {
    const req = { body, staffAccess: access }; let result, status = 200;
    const res = { set() {}, status(code) { status = code; return res; }, json(value) { result = value; } };
    await routes.get("/api/staff-auth/" + route)(req, res);
    return { status, result };
  }
  return { request, calls };
}
test("PIN status and correct PIN sign-in never send an email or create an OTP challenge", async () => {
  const r = runtime();
  const status = await r.request("start", { uid: "forged" });
  assert.equal(status.result.configured, true); assert.equal(status.result.delivery, "none");
  assert.equal("challengeToken" in status.result, false);
  const result = await r.request("verify", { pin: "012345", uid: "forged", deviceId: "device" });
  assert.equal(result.result.ok, true);
  assert.equal(r.calls.find(call => call[0] === "verify")[1].uid, "canonical-admin");
  assert.equal(r.calls.find(call => call[0] === "token")[1], "canonical-admin");
});
test("an old emailed OTP, missing PIN, or wrong PIN never issues an unlock token", async () => {
  const r = runtime();
  for (const body of [{ code: "012345", challengeToken: "old-otp" }, {}, { pin: "654321" }]) {
    assert.equal((await r.request("verify", body)).status, 400);
  }
  assert.equal(r.calls.some(call => call[0] === "token"), false);
});
test("PIN enrollment binds the authenticated UID, validates confirmation and requires a fresh login", async () => {
  const r = runtime();
  assert.equal((await r.request("pin/create", { pin: "012345", confirmPin: "654321" })).status, 400);
  assert.equal((await r.request("pin/create", { pin: "012345", confirmPin: "012345" },
    { actor: { uid: "canonical-admin" }, decoded: { auth_time: Date.now() / 1000 - 301 } })).status, 401);
  assert.equal((await r.request("pin/create", { pin: "012345", confirmPin: "012345", uid: "forged" })).status, 200);
  assert.equal(r.calls.find(call => call[0] === "create")[1].uid, "canonical-admin");
  assert.equal((await r.request("pin/create", {}, null)).status, 401);
  assert.equal((await r.request("start", {}, { actor: { uid: "patient", role: "patient" }, decoded: {} })).status, 401);
});
test("profile PIN change requires the current PIN and confirmation", async () => {
  const r = runtime();
  assert.equal((await r.request("pin/change", { currentPin: "wrong", pin: "654321", confirmPin: "654321" })).status, 400);
  assert.equal(r.calls.some(call => call[0] === "change"), false);
  assert.equal((await r.request("pin/change", { currentPin: "012345", pin: "654321", confirmPin: "654321" })).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls.find(call => call[0] === "change").slice(1))),
    [{ uid: "canonical-admin", authProviderId: "password", authTime: r.calls.find(call => call[0] === "change")[1].authTime }, "654321", "proof"]);
});
test("new account creation requires an emailed proof separately from the saved sign-in PIN", () => {
  const create = source.slice(source.indexOf('app.post("/api/staff/accounts",'), source.indexOf('app.patch("/api/staff/accounts/:userId"'));
  assert.match(create, /consumeRegistrationToken/);
  assert.match(create, /expectedMetadata: \{ adminUid: actor.uid, accountType: type \}/);
  assert.doesNotMatch(create, /sendMail\(/);
  assert.match(create, /service\.create/);
});
