"use strict";
const { createHash } = require("node:crypto");
const { checkedFile, firebaseFileStore, ClinicalFileError, ClinicalStorageError, MAX_FILE_BYTES } = require("./clinical-files");

// Keep bounded file bytes outside RTDB's root snapshots and normal clinic sync.
// Each chunk is well below Firestore's 1 MiB document limit. All writes are atomic.
const CHUNK_BYTES = 256 * 1024, COLLECTION = "clinicalResultBlobs", CHUNKS = "clinicalResultChunks";
const fingerprint = file => createHash("sha256").update(JSON.stringify([file.objectPath, file.hash, file.uploadedBy, file.serviceId, file.name, file.mime, file.size])).digest("hex");
function reference(database, file) {
  if (!/^clinical-results\/[A-Za-z0-9_-]{1,180}\/[A-Za-z0-9_-]{1,180}$/.test(file.objectPath || "")) throw new ClinicalFileError("Invalid private result-file reference.");
  return database.collection(COLLECTION).doc(createHash("sha256").update(file.objectPath).digest("hex"));
}
function chunkRef(ref, index) { return ref.collection(CHUNKS).doc(String(index).padStart(3, "0")); }
async function guarded(upload, work) {
  try { return await work(); }
  catch (error) {
    if (error instanceof ClinicalFileError) throw error;
    throw new ClinicalStorageError(upload);
  }
}
function firestoreFileStore(database) {
  return {
    async put(file) {
      const checked = checkedFile(file);
      if (checked.hash !== file.hash || checked.size !== file.size) throw new ClinicalFileError("The result file changed. Choose it again.");
      const ref = reference(database, file), bytes = Buffer.from(checked.base64, "base64"), count = Math.ceil(bytes.length / CHUNK_BYTES), identity = fingerprint(file);
      return guarded(true, () => database.runTransaction(async transaction => {
        const existing = await transaction.get(ref);
        if (existing.exists) {
          const saved = existing.data();
          if (saved.version !== 1 || saved.fingerprint !== identity || saved.hash !== file.hash || saved.size !== file.size || saved.chunkCount !== count) throw new ClinicalFileError("This attachment reference has already been used. Choose the file again.");
          return;
        }
        transaction.create(ref, { version: 1, fingerprint: identity, hash: file.hash, size: file.size, mime: file.mime, chunkCount: count });
        for (let index = 0; index < count; index++) transaction.create(chunkRef(ref, index), { bytes: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES) });
      }));
    },
    async read(file) {
      return guarded(false, async () => {
        const ref = reference(database, file), snapshot = await ref.get(), saved = snapshot.data();
        if (!snapshot.exists || !saved || saved.version !== 1 || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES || saved.size !== file.size || saved.hash !== file.hash || saved.mime !== file.mime || saved.fingerprint !== fingerprint(file) || saved.chunkCount !== Math.ceil(file.size / CHUNK_BYTES)) throw new ClinicalStorageError();
        const refs = Array.from({ length: saved.chunkCount }, (_, index) => chunkRef(ref, index));
        const snapshots = await database.getAll(...refs), chunks = new Map(snapshots.map(chunk => [chunk.id, chunk]));
        if (snapshots.length !== refs.length || chunks.size !== refs.length) throw new ClinicalStorageError();
        const bytes = Buffer.concat(refs.map((chunk, index) => {
          const part = chunks.get(chunk.id), value = part?.data()?.bytes;
          if (!part?.exists || !(value instanceof Uint8Array) || value.length !== Math.min(CHUNK_BYTES, file.size - index * CHUNK_BYTES)) throw new ClinicalStorageError();
          return Buffer.from(value);
        }));
        if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.hash) throw new ClinicalStorageError();
        return bytes.toString("base64");
      });
    },
  };
}
function privateFileStore(app, getFirestore = require("firebase-admin/firestore").getFirestore) {
  const store = backend => {
    if (backend === "firestore") return firestoreFileStore(getFirestore(app));
    if (backend === "storage") return firebaseFileStore(app);
    throw new ClinicalStorageError();
  };
  return {
    // New files do not require a provisioned/billed Storage bucket. Operators can
    // explicitly opt into Storage; do not silently change backends on an error.
    async put(file) {
      const storageBackend = process.env.CLINICAL_FILE_STORAGE || "firestore";
      return guarded(true, async () => { await store(storageBackend).put(file); return { storageBackend }; });
    },
    async read(file) {
      // Old unmarked files remain in Storage. New pointers are internal metadata,
      // never accepted from the client or exposed in patient responses.
      return guarded(false, () => store(file.storageBackend || "storage").read(file));
    },
  };
}
module.exports = { privateFileStore, firestoreFileStore, CHUNK_BYTES, COLLECTION, CHUNKS };
