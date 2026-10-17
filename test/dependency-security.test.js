"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

test("backend lockfile retains the reviewed security fixes", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "../package-lock.json"), "utf8"));
  const minimum = { "proxy-addr": "2.0.8", "@grpc/grpc-js": "1.14.5", qs: "6.16.0", nodemailer: "10.1.2", uuid: "11.1.1" };
  for (const [name, version] of Object.entries(minimum)) {
    const rows = Object.entries(lock.packages).filter(([key]) => key.endsWith(`node_modules/${name}`));
    assert.ok(rows.length, `${name} is present`);
    for (const [key, row] of rows) {
      const actual = row.version.split(".").map(Number), floor = version.split(".").map(Number);
      const different = actual.findIndex((value, index) => value !== floor[index]);
      assert.ok(different === -1 || actual[different] > floor[different], `${key} must be >= ${version}`);
    }
  }
});

test("patched SMTP dependency compiles verification mail without sending any email", async () => {
  const transport = require("nodemailer").createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const result = await transport.sendMail({ from: "Alphastar <noreply@example.invalid>", to: "test@example.invalid", subject: "Verification code", text: "Synthetic verification code: 123456", html: "<p>Synthetic verification code: <strong>123456</strong></p>" });
  assert.match(result.message.toString(), /Subject: Verification code/);
  assert.match(result.message.toString(), /123456/);
});

test("Google HTTP dependencies retain their CommonJS UUID v4 API", () => {
  for (const name of ["gaxios", "google-gax", "teeny-request"]) {
    const scopedRequire = createRequire(require.resolve(name));
    assert.match(scopedRequire("uuid").v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(require(name));
  }
});

test("proxy address patch does not trust arbitrary IPv4 clients for a short mapped IPv6 subnet", () => {
  const proxyaddr = require("proxy-addr");
  let trust;
  try { trust = proxyaddr.compile("::ffff:10.0.0.0/8"); } catch { return; }
  assert.equal(trust("203.0.113.10"), false);
});
