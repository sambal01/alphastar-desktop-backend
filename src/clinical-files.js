"use strict";
const { createHash } = require("node:crypto");
const MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_FILES = 8, MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const RESULT_FILE_TYPES = Object.freeze({
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "text/plain": [".txt"],
  "text/csv": [".csv"],
  "application/msword": [".doc"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.ms-powerpoint": [".ppt"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
});
class ClinicalFileError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = "CLINICAL_FILE_INVALID"; }
}
class ClinicalStorageError extends ClinicalFileError {
  constructor(upload = false) { super(upload ? "Your draft is saved, but the result file could not be uploaded. Please retry. If it continues, ask the clinic administrator to check private file access and Firebase usage limits." : "This result file could not be opened. Please try again."); this.status = 503; this.code = "CLINICAL_STORAGE_UNAVAILABLE"; }
}
function checkedFile(input) {
  const name = typeof input.name === "string" ? input.name.trim() : "", mime = String(input.mime || "").toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
  if (!RESULT_FILE_TYPES[mime] || !RESULT_FILE_TYPES[mime].includes(extension) || !name || name.length > 160 || /[\\/\u0000-\u001f\u007f]/.test(name)) throw new ClinicalFileError("Choose a PDF, image, text, Word, Excel, or PowerPoint file with a valid filename.");
  if (typeof input.base64 !== "string" || input.base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new ClinicalFileError("Choose a valid file up to 2 MB.");
  const bytes = Buffer.from(input.base64, "base64");
  if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString("base64") !== input.base64) throw new ClinicalFileError("Choose a valid file up to 2 MB.");
  let valid = false, width = 0, height = 0;
  if (mime === "application/pdf") valid = bytes.subarray(0, 5).toString() === "%PDF-" && /%%EOF\s*$/.test(bytes.subarray(-1024).toString());
  else if (mime === "image/png") {
    valid = bytes.length >= 45 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && bytes.subarray(12, 16).toString() === "IHDR" && bytes.subarray(-8, -4).toString() === "IEND";
    if (valid) { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  } else if (mime === "image/jpeg") {
    valid = bytes.length >= 12 && bytes.subarray(0, 3).toString("hex") === "ffd8ff" && bytes.subarray(-2).toString("hex") === "ffd9";
    for (let offset = 2; valid && offset + 4 < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]; if ([0xd9, 0xda].includes(marker)) break;
      const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
  }
  if (["text/plain", "text/csv"].includes(mime)) valid = !bytes.includes(0);
  if (["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(mime)) valid = bytes.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1";
  if (["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation"].includes(mime)) valid = ["504b0304", "504b0506"].includes(bytes.subarray(0, 4).toString("hex"));
  if (!valid || ["image/jpeg", "image/png"].includes(mime) && (!width || !height || width * height > 12000000 || width > 6000 || height > 6000)) throw new ClinicalFileError("The file does not match its type, or the image is too large. Use a supported result file up to 2 MB; images must be up to 12 megapixels.");
  return { name, mime, size: bytes.length, base64: input.base64, hash: createHash("sha256").update(bytes).digest("hex") };
}
function fileMetadata(file) { return { id: file.id, serviceId: file.serviceId, name: file.name, mime: file.mime, size: file.size, uploadedAt: file.uploadedAt }; }
function firebaseFileStore(app) {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || app?.options?.storageBucket || (app?.options?.projectId ? app.options.projectId + ".firebasestorage.app" : "");
  if (!bucketName) throw new ClinicalStorageError();
  const bucket = require("firebase-admin/storage").getStorage(app).bucket(bucketName);
  return {
    async put(file) {
      const object = bucket.file(file.objectPath);
      const fingerprint = createHash("sha256").update(JSON.stringify([file.hash, file.uploadedBy, file.serviceId, file.name])).digest("hex");
      try {
        await object.save(Buffer.from(file.base64, "base64"), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { contentType: file.mime, cacheControl: "private, no-store", metadata: { fingerprint } } });
      } catch (error) {
        if ([402, 403, 404].includes(Number(error.code))) throw new ClinicalStorageError(true);
        if (Number(error.code) !== 412) throw error;
        const [metadata] = await object.getMetadata();
        if (metadata.metadata?.fingerprint !== fingerprint) throw new ClinicalFileError("This attachment reference has already been used. Choose the file again.");
      }
    },
    async read(file) {
      let bytes;
      try { [bytes] = await bucket.file(file.objectPath).download(); }
      catch (error) { if ([403, 404].includes(Number(error.code))) throw new ClinicalStorageError(); throw error; }
      if (bytes.length !== file.size || bytes.length > MAX_FILE_BYTES || createHash("sha256").update(bytes).digest("hex") !== file.hash) throw Error("The stored result file could not be verified.");
      return bytes.toString("base64");
    },
  };
}
module.exports = { checkedFile, fileMetadata, firebaseFileStore, ClinicalFileError, ClinicalStorageError, RESULT_FILE_TYPES, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES };
