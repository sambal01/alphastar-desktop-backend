"use strict";
// Real HTTP routes + isolated in-memory database/auth for integration tests.
// This fixture never loads .env, firebase-admin credentials, or live records.
const express = require("express");
const { once } = require("node:events");
const { registerBookingRoutes } = require("../../src/scheduling-routes");
const DAY = "2027-02-10";
const NOW = Date.parse(DAY + "T06:00:00+08:00");
async function startBookingHttpFixture(options = {}) {
  let root = {
    users: Object.fromEntries(["admin", "staff", ...Array.from({ length: 10 }, (_, index) => "p" + index)].map(uid => [uid, { role: uid === "admin" ? "admin" : uid === "staff" ? "staff" : "patient" }])),
    services: { vaccination_services: { service_name: "Vaccination Services", status: "active" } }, appointments: {},
  };
  let pending = Promise.resolve(), fault = "";
  const snapshot = value => ({ val: () => structuredClone(value) }), listeners = new Set(), traffic = [];
  const database = { ref(path = "") { return {
    get: async () => snapshot(path ? path.split("/").reduce((value, key) => value?.[key], root) ?? null : root),
    on(_event, callback) { listeners.add(callback); queueMicrotask(() => { if (listeners.has(callback)) callback(snapshot(root)); }); },
    off(_event, callback) { listeners.delete(callback); },
    transaction(update) {
      const run = pending.then(() => {
        const next = update(structuredClone(root));
        if (next === undefined) return { committed: false, snapshot: snapshot(root) };
        root = next; return { committed: true, snapshot: snapshot(root) };
      });
      pending = run.catch(() => {}); return run;
    },
  }; } };
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    res.on("finish", () => traffic.push({ method: req.method, path: req.path, status: res.statusCode }));
    if (fault === "json-error") return res.status(503).json({ code: "BOOKING_UNAVAILABLE", error: "Synthetic availability unavailable." });
    if (fault === "html-error") return res.status(502).type("html").send("<html>Synthetic proxy error</html>");
    if (fault === "old-backend" && req.path.startsWith("/api/booking/")) {
      return res.json({ serviceName: req.query.service, date: req.query.date, month: req.query.month, slots: [], days: [] });
    }
    next();
  });
  const workers = registerBookingRoutes(app, {
    getFirebaseApp: () => ({}), getDatabase: () => database, now: options.now || (() => NOW), dispatchPush: false,
    getAuth: () => ({ verifyIdToken: async uid => {
      const user = root.users[uid]; if (!user) throw Error("Synthetic token invalid");
      return { uid, role: user.role, email: uid + "@example.invalid" };
    } }),
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  return {
    base: origin + "/api", traffic, database, workers, setFault: value => { fault = value; }, read: () => structuredClone(root),
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
    fetch(url, options) {
      if (new URL(url).origin !== origin) throw Error("Test blocked a non-local request");
      return fetch(url, options);
    },
  };
}
module.exports = { DAY, startBookingHttpFixture };
