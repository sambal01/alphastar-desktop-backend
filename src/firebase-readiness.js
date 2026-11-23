// Read-only probes for deployment. No record contents are returned.
const CACHE_MS = 30_000;
const TIMEOUT_MS = 3_000;

async function reachable(read) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createFirebaseReadiness({ getFirebaseApp, getDatabase, getFirestore }) {
  let cached;
  let expiresAt = 0;
  let pending;

  async function check() {
    const app = getFirebaseApp();
    const [realtimeDatabase, firestore] = app ? await Promise.all([
      reachable(() => getDatabase(app).ref("clinicSettings/availability").get()),
      reachable(() => getFirestore(app).doc("_alphastarReadiness/connection").get()),
    ]) : [false, false];
    return { ok: realtimeDatabase && firestore, realtimeDatabase, firestore };
  }

  return async function firebaseReadiness(_req, res) {
    res.set("Cache-Control", "no-store");
    if (!cached || Date.now() >= expiresAt) {
      pending ||= check()
        .catch(() => ({ ok: false, realtimeDatabase: false, firestore: false }))
        .then(result => {
          cached = result;
          expiresAt = Date.now() + CACHE_MS;
          pending = null;
        });
      await pending;
    }
    return res.status(cached.ok ? 200 : 503).json(cached);
  };
}

module.exports = { createFirebaseReadiness };
