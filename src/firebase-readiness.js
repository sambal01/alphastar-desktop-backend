const SUCCESS_REFRESH_MS = 30_000;
const FAILURE_RETRY_MS = 5_000;
const PROBE_TIMEOUT_MS = 20_000;

const unavailable = {
  ok: false,
  realtimeDatabase: false,
  firestore: false,
};

function errorCode(error) {
  const code = error?.code ?? error?.status;
  if (typeof code === "number") return code;
  return typeof code === "string" && /^[a-z0-9_/-]{1,60}$/i.test(code) ? code : "READ_FAILED";
}

async function probe(read) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read).then(() => null, errorCode),
      new Promise(resolve => { timer = setTimeout(() => resolve("PROBE_TIMEOUT"), PROBE_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createFirebaseReadiness({ getFirebaseApp, getDatabase, getFirestore }) {
  let result;
  let previousErrors = {};
  let nextProbeAt = 0;
  let probePending = false;

  async function checkFirebase() {
    const app = getFirebaseApp();
    if (!app) return ["ADMIN_UNAVAILABLE", "ADMIN_UNAVAILABLE"];

    return Promise.all([
      probe(() => getDatabase(app).ref("clinicSettings/availability").get()),
      probe(() => getFirestore(app).doc("_alphastarReadiness/connection").get()),
    ]);
  }

  async function refreshReadiness() {
    const [realtimeDatabaseError, firestoreError] = await checkFirebase().catch(error => {
      const code = errorCode(error);
      return [code, code];
    });
    const realtimeDatabase = realtimeDatabaseError === null;
    const firestore = firestoreError === null;
    const latest = { ok: realtimeDatabase && firestore, realtimeDatabase, firestore };
    const stateChanged = previousErrors.realtimeDatabaseError !== realtimeDatabaseError
      || previousErrors.firestoreError !== firestoreError;

    if (stateChanged && !latest.ok) {
      console.warn("Firebase readiness check failed.", {
        ...latest,
        realtimeDatabaseError,
        firestoreError,
      });
    } else if (stateChanged && result && latest.ok) {
      console.info("Firebase readiness restored.");
    }

    previousErrors = { realtimeDatabaseError, firestoreError };
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