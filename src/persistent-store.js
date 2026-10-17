"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function parse(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved data");
  return value;
}
function read(file, defaults) {
  if (!fs.existsSync(file) && !fs.existsSync(file + ".bak")) atomicWrite(file, defaults);
  try { return { ...structuredClone(defaults), ...parse(file) }; }
  catch {
    try { return { ...structuredClone(defaults), ...parse(file + ".bak") }; }
    catch { throw new Error("Saved clinic data could not be read. Files were preserved; restore a valid backup before continuing."); }
  }
}
function write(file, value) {
  if (fs.existsSync(file)) {
    let previous;
    try { previous = parse(file); }
    catch { previous = parse(file + ".bak"); }
    atomicWrite(file + ".bak", previous);
  }
  atomicWrite(file, value);
}
module.exports = { read, write };
