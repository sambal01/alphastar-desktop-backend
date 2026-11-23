const SUCCESS_REFRESH_MS = 30_000;
const FAILURE_RETRY_MS = 5_000;
const PROBE_TIMEOUT_MS = 20_000;

const unavailable = {
  ok: false,
  realtimeDatabase: false,
  firestore: false,
};

async function reachable(read) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read).then(() => true, () => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createFirebaseReadiness({ getFirebaseApp, getDatabase, getFirestore }) {
  let result;
  let nextProbeAt = 0;
  let probePending = false;

  async function checkFirebase() {
    const app = getFirebaseApp();
    if (!app) return unavailable;

    const [realtimeDatabase, firestore] = await Promise.all([
      reachable(() => getDatabase(app).ref("clinicSettings/availability").get()),
      reachable(() => getFirestore(app).doc("_alphastarReadiness/connection").get()),
    ]);
    return { ok: realtimeDatabase && firestore, realtimeDatabase, firestore };
  }

  async function refreshReadiness() {
    const latest = await checkFirebase().catch(() => unavailable);
    const stateChanged = result?.realtimeDatabase !== latest.realtimeDatabase
      || result?.firestore !== latest.firestore;
    if (stateChanged && !latest.ok) {
      console.warn("Firebase readiness check failed.", {
        realtimeDatabase: latest.realtimeDatabase,
        firestore: latest.firestore,
      });
    } else if (stateChanged && result && latest.ok) {
      console.info("Firebase readiness restored.");
    }
    result = latest;
    nextProbeAt = Date.now() + (result.ok ? SUCCESS_REFRESH_MS : FAILURE_RETRY_MS);
    probePending = false;
  }

  return function firebaseReadiness(_req, res) {
    // Render gives each request five seconds. Keep slow SDK startup off the response path.
    if (!probePending && Date.now() >= nextProbeAt) {
      probePending = true;
      setImmediate(refreshReadiness);
    }

    const current = result || unavailable;
    res.set("Cache-Control", "no-store");
    return res.status(current.ok ? 200 : 503).json(current);
  };
}

module.exports = { createFirebaseReadiness };
