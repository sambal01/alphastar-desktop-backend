# Alphastar desktop backend

Private source repository for the existing desktop API. This initial backend baseline includes the shared patient authenticator access guard and reviewed dependency updates. The Electron UI, local account data, environment secrets and Firebase credentials are not published here.

## Run locally

Use Node.js 22. Run npm ci, copy .env.example to a local .env using your editor, supply the existing server settings privately, then run npm start. Never commit the filled .env. The existing desktop application normally uses port 4100. Do not start a second process on that port while the desktop backend is already running.

## Authenticator policy

The mobile backend owns patient authenticator setup and verification. This backend only enforces the shared patientAuthenticator/{uid} policy for bearer-authenticated Admin SDK requests and sync streams. It does not need PATIENT_AUTHENTICATOR_KEY or an OTP library. Keep it connected to the same Firebase project/Realtime Database as the mobile backend. Never issue MFA proof claims manually.

## Verification

Run npm run check and npm test. Dependency compatibility tests compile synthetic SMTP messages into memory without sending email and verify patched proxy-address and Google HTTP dependencies. The authenticator guard tests use synthetic users only.

## Hosting is separate

Publishing this repository does not create a Render service or change the desktop API URL. No separate desktop backend service was present in the confirmed Render workspace during this release. Keep the existing local setup unless a separate hosting plan is approved. The local data/ store needs a persistence/backup design before hosting on an ephemeral filesystem. Configure Firebase credentials and email secrets only through server secret settings. Never publish patient data or local accounts.
