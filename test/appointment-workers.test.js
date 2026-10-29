"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
test("imported desktop server helpers never start workers; the server entry starts reminder, expiry and push sweeps", () => {
  const source = fs.readFileSync(require.resolve("../src/server"), "utf8");
  const block = source.slice(source.indexOf("const bookingRoutes = registerBookingRoutes("), source.indexOf("registerQueueRoutes(app,"));
  for (const entry of [false, true]) {
    const calls = [], module = {}, workers = Object.fromEntries(["processDueAppointments", "dispatchPush"].map(name => [name, () => { calls.push(name); return Promise.resolve(); }]));
    vm.runInNewContext(block, { app: {}, firebaseAdminApp() {}, registerBookingRoutes: () => workers, require: { main: entry ? module : {} }, module, console,
      setInterval(fn, interval) { calls.push(interval); return { unref() {} }; } });
    assert.deepEqual(calls, entry ? [60000, "processDueAppointments", "dispatchPush"] : []);
  }
});
