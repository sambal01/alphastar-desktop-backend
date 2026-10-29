# Alphastar desktop: Brevo email setup

Desktop supports the same Brevo HTTPS email delivery as Alphastar mobile. PIN and welcome emails use the mobile layout. Password-reset links keep their existing mobile-style layout and security rules.

Sender: **noreply@alphastarkasiglahan.com** (not `.con`). This sender must be verified in your Brevo account.

The logo is displayed inside email using a public HTTPS image URL. It is not sent as a separate picture attachment, for either Brevo or SMTP. Other explicitly supplied files are preserved. Some email apps may require the recipient to enable image display.

## 1. Create a Brevo API key

1. Sign in to Brevo.
2. Open your account menu, then **Settings > SMTP & API > API Keys & MCP**.
3. Choose **Generate a new API key**, complete Brevo's identity check, and name it `Alphastar Desktop`.
4. Choose an expiry date, generate the key, and copy it privately while it is visible. Use a normal API key, not an SMTP key or MCP key, for this HTTPS integration.

Official instructions: https://help.brevo.com/hc/en-us/articles/209467485-Create-and-manage-your-API-keys

## 2. Add the private backend settings

Open `C:\capstone\alphastar-desktop\backend\.env`. Keep the existing Firebase and authentication settings. Add or update these four lines; do not add duplicate settings:

```dotenv
EMAIL_PROVIDER=brevo
EMAIL_FROM_ADDRESS=noreply@alphastarkasiglahan.com
EMAIL_FROM_NAME=Alphastar Laboratory
BREVO_API_KEY=PASTE_YOUR_BREVO_API_KEY_HERE
```

Replace the placeholder with your actual API key, then save. Do not put the key in `src`, `firebase-config.js`, GitHub, the mobile APK, or chat. No IONOS mailbox password is needed for this Brevo API connection.

Until you complete this step, the existing mail configuration is unchanged. Once you select Brevo, a missing or invalid key will fail safely instead of silently sending from Gmail.

## 3. Restart the desktop backend

If the backend is running in a terminal, stop that terminal's backend with **Ctrl+C**. Then run in PowerShell:

```powershell
cd C:\capstone\alphastar-desktop
npm run backend:start
```

If the existing backend is running in the background, ask Codex to restart **only the Alphastar desktop backend** after the key has been saved. Do not end unrelated Node processes.

Restarting the desktop window alone can leave the old backend running with the old email template. An installed desktop executable also needs a new build to include frontend changes.

## 4. Test with your own registered account

1. Open Alphastar Desktop and request a new sign-in PIN or use Forgot Password.
2. Check your inbox and spam folder.
3. Confirm the sender is `noreply@alphastarkasiglahan.com` and the email contains the new layout.
4. Use the latest emailed code before it expires. Older, replaced, expired, or already-used codes remain invalid.

If delivery fails, check Brevo's transactional logs, verified sender/domain, API key, and sending quota. Successful API acceptance is not a guarantee of inbox delivery.

Official email API reference: https://developers.brevo.com/docs/send-a-transactional-email
