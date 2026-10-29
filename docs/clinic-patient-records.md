# Clinic-only patient records

The Desktop Add Patient Record form defaults to **No mobile account**. An
administrator can enter demographics/contact details and an optional email.
This saves a patient profile, not a Firebase Auth account, and sends no email,
OTP, invitation or mobile registration. Staff retain read-only directory access.
There is no name/email matching or automatic merge with mobile accounts.

## Interface

`PUT /api/staff/clinic-patients/:recordId` requires the existing authenticated
staff session/PIN middleware and a currently active Admin role, rechecked inside
the database transaction. `recordId` is `clinic_` plus 32 lowercase random hex
characters. The form generates it once and reuses it on retry.

Required JSON strings: `fullName` (1–120 characters), `birthDate` (valid,
non-future YYYY-MM-DD), `phone` (1–40), and `address` (1–500). Optional strings:
`email` (blank or valid email, at most 254) and `gender` (blank, Female, Male,
Intersex, Other, Prefer not to say). Unknown/security/identity/medical fields
are rejected. Email is contact information only, not a verified identity.

Success is `{ ok: true, profile }`. The returned profile contains `recordId`,
`recordKind: "clinic_only"`, generated `patientNumber`, the supplied fields and
timestamps. No `userId`, login, password or medical answers are returned/created.
Records live in `patientProfiles/{recordId}` and use existing staff sync/read
permissions. The Desktop mapper leaves `userId` empty and keeps `clinicRecordId`
separate; clinic-only profiles do not become Patient Accounts or mobile owners.

Repeated identical saves to the same ID return the existing profile without a
duplicate patient/audit entry. Updated details retain the ID and creation data;
an atomic audit records changed field names, not patient values. Existing mobile
profiles cannot be overwritten through this endpoint. Their unchanged PATCH
endpoint still verifies the explicit Firebase Auth UID. Legacy local-to-mobile
repair still requires explicit account selection and same-patient confirmation.

Errors use `{ ok: false, code, error }` with 400 validation, 401 authentication,
403 permissions, 409 conflicting record reference/state, or 503 storage failure.
Responses are non-cacheable. Failed/unconfirmed saves keep the form for retry;
success is shown only after the backend confirms the same clinic record ID.

## Local checks

From the Desktop root:

```powershell
node --test backend/test/patient-records.test.js src/js/tests/patient-record-save.test.cjs src/js/tests/medical-records-navigation.test.cjs
node test/run-patient-record-link-electron.cjs
```

The HTTP test runs the real
route and Desktop client on loopback against synthetic transactional storage;
the Electron test blocks external traffic. Neither verifies production Firebase
access or deploys anything. Restart the Desktop backend/app to load these source
changes; a remotely hosted backend would require a separate deployment.
