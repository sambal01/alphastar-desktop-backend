# Desktop account PINs

Desktop sign-in uses the account password first, then the saved six-digit PIN.
Normal sign-in and Add Account do not send or require an emailed OTP. Password
recovery and separately requested email changes retain their email verification.
Forgot PIN is a separate, self-service recovery flow: a one-time email OTP proves
ownership before creating a new PIN. The existing account PIN is never emailed.

## Self-service Forgot PIN

After password sign-in, choose Forgot PIN on the locked PIN screen. The backend
uses the current Firebase Auth UID and its registered email, never an arbitrary
recipient, selected account, or email supplied by the renderer. Staff access and
active-account checks apply to every recovery request, before and after OTP
verification. Disabled/deleted/non-staff accounts cannot recover a staff PIN.

1. POST /api/staff-auth/pin/recovery/send sends a one-time OTP using the configured
   Brevo/SMTP provider and returns challengeToken, expiresAt, resendAfterSeconds
   and maskedEmail. The optional email must match the signed-in account.
2. POST /api/staff-auth/pin/recovery/verify takes challengeToken and the six-digit
   code. It consumes the OTP and returns resetToken and expiresAt.
3. POST /api/staff-auth/pin/recovery/confirm takes resetToken, pin and confirmPin.
   Both PINs must be identical six-digit strings. The grant is consumed atomically;
   the previous PIN, attempt counters and older grants are replaced. The user must
   then enter the new PIN normally; recovery does not unlock the workspace.

The OTP purpose is staff_pin_recovery_otp, isolated from password reset, mobile
PINs and email changes. Existing request cooldowns, hourly limits, expiry and
maximum wrong-code attempts apply. The reset grant is a random 32-byte token,
stored only as a hash, bound to this UID/provider, expires after five minutes and
can be used once. No OTP, new PIN or grant is written to application logs.
If mail delivery fails its challenge is invalidated; recovery remains locked and
returns a safe 503 error. It does not fall back to returning a code in a response.
The backend must advertise /api/health capabilities.staffPinRecovery=1. Restart
the local backend after updating; Render requires a separate backend deployment.

Refreshing the initial PIN screen with F5 or Ctrl+R restores that account's PIN
screen, not the password form. PIN-setup status is saved with the existing window
session; no password, PIN, partial digits or verification request is saved. An
expired authentication token is refreshed before the PIN is sent to the backend.
Network failures leave the PIN screen locked; invalid or revoked authentication
still requires password sign-in. Confirmed logout removes the account session.
This refresh fix does not change Remember me or add persistent token storage.

## Forms

- New accounts: Admin enters the password, Create PIN and Confirm PIN. The PIN
  verifier, user and staff profile are saved in one Firebase update. PIN/password
  values are not included in welcome emails.
- Update Profile: use Create PIN and Confirm PIN for initial setup after a recent
  password sign-in. To replace an existing PIN, also enter Current PIN.
- Editing a managed account PIN: enter your own signed-in Admin PIN to authorize
  resetting that account's PIN. Ordinary profile editing cannot change a role,
  email or account PIN without the dedicated authorized PIN operation.
- Email ownership is not marked verified simply because an Admin entered an
  email address during account creation.

## Inactivity lock

After a successful PIN check, ten minutes without mouse clicks, keyboard input,
typing or wheel scrolling locks the desktop workspace. Background sync, clocks,
window focus and reopening a minimized window do not extend the deadline. A short
minimize keeps the current screen; sleep/resume and F5 check elapsed wall time.
Missing, expired or future-dated saved activity requires the PIN before rendering
the clinical workspace. Activity timestamps are scoped to the signed-in UID.

The lock screen matches the mobile mint PIN design, masks all digits and submits
automatically after six digits. Incorrect PINs clear and refocus the input. Unlock
requires the backend's saved-PIN verification; network failures never unlock.
It returns to the existing page/form instead of starting a new Dashboard session.
Ordinary unfinished fields and modals remain hidden/inert until unlock; password
and PIN fields are cleared and excluded from drafts. Live subscriptions pause.

This is an application privacy gate, not a server-side token revocation or an
encryption mechanism for the existing local clinic cache. Backend authorization
and its PIN attempt limits still apply. Fully reopen the desktop app after the
main-process timer setting changes; Ctrl+R reloads renderer changes only.

Run npm run test:idle-lock-ui for the isolated actual-renderer regression and
node --test test/desktop-pin-lock.test.js for fake-clock boundary tests. Both use
synthetic accounts with no clinic network access or real PINs.

## Backend configuration

Set STAFF_ACCOUNT_PIN_ENABLED=true and STAFF_PIN_PEPPER to a persistent random
32-byte value encoded as 64 hexadecimal characters in backend/.env. These values
belong only on the backend. Never put the pepper in the renderer, public Expo
variables, screenshots, Git, or logs. Back it up securely and reuse it on every
backend instance/deployment. Do not generate another pepper when restarting.

Existing configured PINs require the same pepper used at enrollment. Deploying
to Render requires copying the existing server-only pepper securely, not creating
a new one. Local changes do not update a running backend or deploy to Render.

The Firebase rules must deny root client reads and all client reads/writes of
staffAccountPins. Firebase Admin accesses this backend-only collection. Editing
local rules is not a production rules deployment. Keep shared mobile rules aligned.

## PIN security

The staff store is separate from patient PINs. Verifiers are bound to the staff
UID and password provider, using a random salt, PBKDF2-HMAC-SHA256 with 600,000
iterations and a server-only HMAC pepper. PINs are never saved as plaintext,
in profiles, browser storage, form drafts, responses or audit records.

Failed attempts persist in Firebase across backend restarts. An increasing delay
starts after five failures; ten failures require Forgot PIN email recovery. Changing
a PIN requires a one-use current-PIN proof. Setup cannot replace an existing PIN.
Fresh initial enrollment requires a password authentication within five minutes.

## Administrator maintenance

The CLI scripts require Firebase Admin credentials; ordinary app clients cannot
run them. set-staff-pin.js accepts the PIN through hidden terminal input and never
through command-line arguments. It verifies the exact email/public ID and active
clinic role, refuses overwrite, checks private rules, then verifies the new PIN.

retire-duplicate-admin.js defaults to a dry run. Explicit --apply permanently
removes only the verified duplicate's Auth account and user/staff records, with
an audit record. A separate active Admin must be retained. Clinical collections
and historical reviews/appointments are not deleted. The public account-management
API still protects administrator accounts from ordinary deletion.

Restart the local backend and reload the desktop renderer after updating.
The renderer checks /api/health for saved-PIN support before submitting any PIN
or calling the older sign-in endpoint. An outdated running backend must be fully
restarted; Ctrl+R reloads only the renderer. For an app-managed local backend,
completely exit the desktop and reopen it so its child backend is restarted.

Test
with synthetic accounts: correct/incorrect PIN, setup mismatch, current-PIN change,
Admin-only managed reset, disabled accounts, reconnect/restart, and no stored PINs.
