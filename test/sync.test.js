"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { once } = require("node:events");
const express = require("express");
const { registerSyncRoutes, __test: { STAFF_PATHS, PATIENT_PATHS } } = require("../src/sync-routes");

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("Timed out waiting for a live update.");
    await pause(5);
  }
}

function fixture(config = {}) {
  const state = {
    users: { admin: { role: "admin" }, staff: { role: "staff" }, patient: { role: "patient" }, other: { role: "patient" } },
    staff: { admin: { role: "admin" }, staff: { role: "staff" } },
    patientProfiles: { patient: { fullName: "Private patient name" } },
    appointments: { a1: { userId: "patient", status: "pending", notes: "Private visit" }, a2: { userId: "other", status: "pending" } },
    queueEntries: {}, medicalRecords: {}, notifications: {}, payments: {},
  };
  const subscriptions = new Set();
  const reads = [];
  const tokenChecks = [];
  const routes = new Map();
  let revoked = false;
  const snap = (value) => ({ val: () => structuredClone(value ?? null), child: (key) => snap(value?.[key]) });
  const lookup = (path) => path.split("/").reduce((value, key) => value?.[key], state);
  const database = { ref(path) {
    assert.ok(path, "Sync must never read the database root.");
    function query(field, uid) {
      const read = () => field && uid !== undefined ? Object.fromEntries(Object.entries(lookup(path) || {}).filter(([, value]) => value?.[field] === uid)) : lookup(path);
      const ref = {
        get: async () => { reads.push({ path, field, uid }); return snap(read()); },
        orderByChild: (next) => query(next, uid),
        equalTo: (next) => query(field, next),
        on: (_, listener, cancel) => {
          const item = { path, field, uid, ref, listener, cancel, read, previous: JSON.stringify(read()) };
          subscriptions.add(item);
          if (config.cancelPath === path) cancel(new Error("Database listener unavailable"));
          else if (config.silentPath !== path) listener(snap(read()));
        },
        off: (_, listener) => { for (const item of subscriptions) if (item.ref === ref && item.listener === listener) subscriptions.delete(item); },
      };
      return ref;
    }
    return query();
  } };
  const options = {
    getFirebaseApp: () => ({}), getDatabase: () => database,
    getAuth: () => ({ verifyIdToken: async (token, checkRevoked) => {
      tokenChecks.push({ token, checkRevoked });
      if (revoked || token === "invalid") throw new Error("revoked");
      if (config.authWait) await config.authWait;
      return { uid: token, exp: Math.ceil((Date.now() + 3600000) / 1000), ...config.claims };
    } }),
    debounceMs: 5, heartbeatMs: 50000, revalidateMs: 50000, timeoutMs: 500,
    ...config.options,
  };
  registerSyncRoutes({ get: (path, handler) => routes.set(path, handler) }, options);
  return {
    state, reads, tokenChecks, subscriptions,
    revoke: () => { revoked = true; },
    emit() {
      for (const item of [...subscriptions]) {
        const value = item.read();
        const serialized = JSON.stringify(value);
        if (serialized !== item.previous) { item.previous = serialized; item.listener(snap(value)); }
      }
    },
    mount(app) { for (const [path, handler] of routes) app.get(path, handler); },
    async request(audience = "staff", token = "admin", responseOptions = {}) {
      const req = Object.assign(new EventEmitter(), { headers: token ? { authorization: `Bearer ${token}` } : {}, ...responseOptions.request });
      const chunks = [];
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200, headersSent: false, ended: false, destroyed: false, blocked: responseOptions.blocked || false,
        set: () => res,
        status: (code) => { res.statusCode = code; return res; },
        json: (body) => { res.body = body; res.ended = true; return res; },
        flushHeaders: () => { res.headersSent = true; },
        write: (chunk) => { assert.equal(res.ended, false); chunks.push(chunk); return !res.blocked; },
        end: () => { res.ended = true; res.emit("close"); },
        destroy: () => { res.destroyed = true; res.end(); },
      });
      await routes.get(`/api/${audience}/sync/stream`)(req, res);
      return { req, res, chunks, events: (event = "change") => chunks.filter((chunk) => chunk.startsWith(`event: ${event}\n`)).map((chunk) => JSON.parse(chunk.split("data: ")[1])), close: () => res.end() };
    },
  };
}

test("requires a verified, unrevoked Bearer token and a configured backend", async () => {
  const f = fixture();
  for (const token of ["", "invalid"]) {
    const stream = await f.request("staff", token);
    assert.equal(stream.res.statusCode, 401);
    assert.equal(stream.res.body.code, "SYNC_UNAUTHENTICATED");
    assert.equal(f.subscriptions.size, 0);
  }
  assert.ok(f.tokenChecks.every((check) => check.checkRevoked === true));
  const unavailable = await fixture({ options: { getFirebaseApp: () => null } }).request();
  assert.equal(unavailable.res.statusCode, 503);
});

test("canonical records deny stale admin claims, missing users, and inactive accounts", async () => {
  const claimedAdmin = fixture({ claims: { admin: true, role: "admin" } });
  assert.equal((await claimedAdmin.request("staff", "patient")).res.statusCode, 403);
  assert.equal((await claimedAdmin.request("staff", "missing")).res.statusCode, 403);
  for (const collection of ["users", "staff"]) {
    for (const values of [{ accountStatus: "suspended" }, { status: "inactive" }, { active: false }, { disabled: true }, { deletedAt: "today" }]) {
      const f = fixture();
      Object.assign(f.state[collection].admin, values);
      assert.equal((await f.request()).res.statusCode, 403);
      assert.equal(f.subscriptions.size, 0);
    }
  }
  assert.equal((await fixture().request("patient", "staff")).res.statusCode, 403);
});

test("staff receives one initial invalidation and coalesced paths without any row data", async (t) => {
  const f = fixture();
  const stream = await f.request();
  t.after(stream.close);
  await until(() => stream.events().length === 1);
  assert.deepEqual(stream.events()[0], { paths: [...STAFF_PATHS] });
  assert.equal(f.subscriptions.size, STAFF_PATHS.length);
  f.state.appointments.a1.status = "approved";
  f.emit();
  f.state.queueEntries.q1 = { userId: "patient", notes: "Secret queue notes" };
  f.emit();
  f.state.appointments.a1.status = "completed";
  f.emit();
  await until(() => stream.events().length === 2);
  assert.deepEqual(stream.events()[1], { paths: ["appointments", "queueEntries"] });
  assert.doesNotMatch(stream.chunks.join(""), /Private|Secret|approved|completed|a1/);
  stream.close();
  assert.equal(f.subscriptions.size, 0);
  assert.equal(stream.req.listenerCount("aborted"), 0);
  assert.equal(stream.res.listenerCount("drain"), 0);
});

test("staff without an admin role never subscribes to audit logs", async (t) => {
  const f = fixture({ claims: { admin: true } });
  const stream = await f.request("staff", "staff");
  t.after(stream.close);
  await until(() => stream.events().length);
  assert.equal(f.subscriptions.size, STAFF_PATHS.length - 1);
  assert.equal([...f.subscriptions].some((entry) => entry.path === "auditLogs"), false);
  assert.equal(stream.events()[0].paths.includes("auditLogs"), false);
});

test("patient subscriptions use own records and userId queries, ignoring another patient's changes", async (t) => {
  const f = fixture();
  const stream = await f.request("patient", "patient");
  t.after(stream.close);
  await until(() => stream.events().length);
  assert.deepEqual(stream.events()[0], { paths: [...PATIENT_PATHS] });
  assert.deepEqual(f.reads.map((read) => read.path).sort(), ["staff/patient", "users/patient"]);
  for (const subscription of f.subscriptions) {
    if (["users/patient", "patientProfiles/patient"].includes(subscription.path)) assert.equal(subscription.field, undefined);
    else { assert.equal(subscription.field, "userId"); assert.equal(subscription.uid, "patient"); }
  }
  f.state.appointments.a2.status = "completed";
  f.state.patientProfiles.other = { fullName: "Other private name" };
  f.emit();
  await pause(25);
  assert.equal(stream.events().length, 1);
  f.state.appointments.a1.status = "approved";
  f.state.notifications.n1 = { userId: "patient", body: "Private notification" };
  f.emit();
  await until(() => stream.events().length === 2);
  assert.deepEqual(stream.events()[1], { paths: ["appointments", "notifications"] });
  assert.doesNotMatch(stream.chunks.join(""), /Private|Other private|userId|patient"/);
});

test("a reconnect invalidates every watched path after changes made while disconnected", async (t) => {
  const f = fixture();
  const first = await f.request("patient", "patient");
  await until(() => first.events().length);
  first.close();
  f.state.appointments.a1.status = "completed";
  f.emit();
  const second = await f.request("patient", "patient");
  t.after(second.close);
  await until(() => second.events().length);
  assert.deepEqual(second.events()[0].paths, [...PATIENT_PATHS]);
  assert.equal(f.subscriptions.size, PATIENT_PATHS.length);
});

test("saved access changes and deletions close existing streams immediately", async () => {
  for (const change of [(f) => { f.state.users.admin.role = "staff"; }, (f) => { f.state.staff.admin.accountStatus = "disabled"; }, (f) => { delete f.state.users.admin; }]) {
    const f = fixture();
    const stream = await f.request();
    change(f);
    f.emit();
    assert.equal(stream.res.ended, true);
    assert.equal(stream.events("error")[0].code, "SYNC_FORBIDDEN");
    assert.equal(f.subscriptions.size, 0);
  }
});

test("periodic verification detects revoked tokens and detached staff-account changes", async (t) => {
  for (const revoke of [true, false]) {
    const f = fixture({ options: { revalidateMs: 10 } });
    const stream = await f.request("patient", "patient");
    t.after(stream.close);
    if (revoke) f.revoke();
    else f.state.staff.patient = { accountStatus: "blocked" };
    await until(() => stream.res.ended);
    assert.equal(stream.events("error")[0].code, revoke ? "SYNC_UNAUTHENTICATED" : "SYNC_FORBIDDEN");
    assert.ok(f.tokenChecks.length >= 2);
    assert.equal(f.subscriptions.size, 0);
  }
});

test("token expiry closes the stream without waiting for the heartbeat", async (t) => {
  const expiration = Math.floor(Date.now() / 1000) + 1;
  const f = fixture({ claims: { exp: expiration }, options: { now: () => expiration * 1000 - 20 } });
  const stream = await f.request();
  t.after(stream.close);
  await until(() => stream.res.ended);
  assert.equal(stream.events("error")[0].code, "SYNC_UNAUTHENTICATED");
  assert.equal(f.subscriptions.size, 0);
});

test("subscription cancellation during setup and missing initial data clean up listeners", async (t) => {
  for (const config of [{ cancelPath: "appointments" }, { silentPath: "appointments", options: { timeoutMs: 20 } }]) {
    const f = fixture(config);
    const stream = await f.request();
    t.after(stream.close);
    await until(() => stream.res.ended);
    assert.equal(stream.events("error")[0].code, "SYNC_UNAVAILABLE");
    assert.equal(stream.events().length, 0);
    assert.equal(f.subscriptions.size, 0);
  }
});

test("backpressure keeps only pending collection names and resumes on drain", async (t) => {
  const f = fixture();
  const stream = await f.request("staff", "admin", { blocked: true });
  t.after(stream.close);
  for (let index = 0; index < 50; index += 1) { f.state.appointments.a1.status = String(index); f.emit(); }
  await pause(20);
  assert.equal(stream.chunks.length, 1);
  stream.res.blocked = false;
  stream.res.emit("drain");
  assert.deepEqual(stream.events()[0], { paths: [...STAFF_PATHS] });
  assert.equal(stream.chunks.length, 2);
});

test("a connection that cannot drain is destroyed and releases all listeners", async (t) => {
  const f = fixture({ options: { timeoutMs: 20 } });
  const stream = await f.request("staff", "admin", { blocked: true });
  t.after(stream.close);
  await until(() => stream.res.destroyed);
  assert.equal(stream.chunks.length, 1);
  assert.equal(f.subscriptions.size, 0);
});

test("heartbeats keep idle connections alive and request abort cleans up", async () => {
  const f = fixture({ options: { heartbeatMs: 10 } });
  const stream = await f.request();
  await until(() => stream.events("heartbeat").length);
  stream.req.emit("aborted");
  assert.equal(f.subscriptions.size, 0);
  const chunks = stream.chunks.length;
  await pause(25);
  assert.equal(stream.chunks.length, chunks);
});

test("an already aborted request never installs Firebase listeners", async () => {
  const f = fixture();
  await f.request("staff", "admin", { request: { aborted: true } });
  assert.equal(f.subscriptions.size, 0);
});

test("HTTP SSE delivers mobile writes to staff and staff decisions to the owning patient", async (t) => {
  const f = fixture();
  const app = express();
  f.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  async function connect(audience, token) {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${audience}/sync/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = [];
    const reader = response.body.getReader();
    const finished = (async () => {
      let buffered = "";
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffered.indexOf("\n\n")) >= 0) {
            const frame = buffered.slice(0, split);
            buffered = buffered.slice(split + 2);
            if (frame.startsWith("event: change\n")) events.push(JSON.parse(frame.split("data: ")[1]));
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
    })();
    return { events, close: async () => { controller.abort(); await finished; } };
  }
  const staff = await connect("staff", "staff");
  const patient = await connect("patient", "patient");
  const other = await connect("patient", "other");
  await until(() => staff.events.length && patient.events.length && other.events.length);
  f.state.appointments.newMobileBooking = { userId: "patient", status: "pending" };
  f.emit();
  await until(() => staff.events.length === 2 && patient.events.length === 2);
  assert.equal(other.events.length, 1);
  assert.deepEqual(staff.events[1], { paths: ["appointments"] });
  f.state.appointments.newMobileBooking.status = "approved";
  f.state.notifications.decision = { userId: "patient", text: "Your appointment is approved" };
  f.emit();
  await until(() => patient.events.length === 3);
  assert.deepEqual(patient.events[2], { paths: ["appointments", "notifications"] });
  assert.equal(other.events.length, 1);
  await Promise.all([staff.close(), patient.close(), other.close()]);
  await until(() => f.subscriptions.size === 0);
});
