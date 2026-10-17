"use strict";

// Shared with the desktop backend: Admin SDK reads bypass Firebase Rules.
// Keep this module independent of enrollment keys and OTP libraries so every
// API host can enforce policy even when it does not offer authenticator setup.
function createPatientAuthenticatorAccess({ getFirebaseApp, getAuth, getDatabase }) {
  async function assertAccess(decoded) {
    if (!decoded || typeof decoded.uid !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(decoded.uid)) {
      throw Object.assign(new Error("Sign in again with your original account."), { status: 401, code: "PATIENT_AUTHENTICATOR_REQUIRED" });
    }
    const instance = getFirebaseApp();
    if (!instance) throw Object.assign(new Error("Security verification is temporarily unavailable."), { status: 503 });
    let row;
    try { row = (await getDatabase(instance).ref(`patientAuthenticator/${decoded.uid}`).get()).val(); }
    catch { throw Object.assign(new Error("Security verification is temporarily unavailable. Please try again."), { status: 503 }); }
    if (row == null) return;
    if (row.version !== 1 || typeof row.enabled !== "boolean" || (row.enabled &&
        (!/^[a-f0-9]{64}$/.test(row.revision || "") || !["password", "google.com"].includes(row.provider)))) throw Object.assign(new Error("Your security settings could not be checked."), { status: 503 });
    if (row.transition || (row.enabled && (decoded.firebase?.sign_in_provider !== "custom" ||
        decoded.alphastarMfaRevision !== row.revision || decoded.alphastarMfaProvider !== row.provider ||
        !["password", "google.com"].includes(row.provider)))) {
      throw Object.assign(new Error("Sign in and complete authenticator verification."), { status: 401, code: "PATIENT_AUTHENTICATOR_REQUIRED" });
    }
  }
  async function middleware(req, res, next) {
    const token = String(req.headers.authorization || "").match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return next(); // Existing route guards still require a token.
    let decoded;
    try {
      const instance = getFirebaseApp();
      if (!instance) throw Error();
      decoded = await getAuth(instance).verifyIdToken(token, true);
    } catch { return res.status(401).json({ ok: false, error: "Your sign-in expired. Please sign in again." }); }
    try { await assertAccess(decoded); return next(); }
    catch (cause) { return res.status(cause.status || 503).json({ ok: false, code: cause.code, error: cause.message }); }
  }
  return { assertAccess, middleware };
}

module.exports = { createPatientAuthenticatorAccess };
