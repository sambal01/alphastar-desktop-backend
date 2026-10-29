# Desktop SMPE corrections and mobile parity

Local implementation contract. Do not deploy Firebase rules, change roles, or modify real patient records as part of source verification.

## Existing data

The canonical record remains `medicalRecords/{recordKey}`. Desktop uses the same `personalBackground`, `medicalHistory`, `medicalHistoryDetails`, and `physicalAssessment` keys as Alphastar Mobile. There are 15 personal/guardian fields, 25 current medical-history questions, six vital-sign fields and assessment remarks. Preserve legacy additional-condition information without adding a 26th question.

## Save corrections

`PATCH /api/staff/medical-records/:recordId/assessment`

- Requires the existing verified, non-revoked staff session middleware. Recheck the saved active staff role inside the transaction; never trust a client-supplied role, user ID, author or status.
- Applies only to the current pending SMPE version. Completed history is read-only.
- Body: `expectedRevision` (positive integer), `expectedSubmittedAt` (exact stored timestamp), `reason` (1–500 trimmed characters), and `physicalAssessment`. This is a field-level patch, not a whole replacement.
- The user explicitly chose **vital signs only**. Patient/guardian personal information, medical-history answers and their details remain read-only, including against forged API requests. Accept only the six known vital-sign fields and assessment remarks, as strings of at most 120 characters. Do not infer a diagnosis or generate measurements. A blank vital means not recorded, not zero.
- Reject unknown fields, nested values, arrays, invalid formats, dangerous object keys, and attempts to change ownership, approval, version, source or review metadata.
- Recheck both version markers and pending status before writing. A concurrent submission, edit or approval returns `409 SMPE_STALE` or `409 SMPE_COMPLETED`, with no write.
- Preserve a full before-change snapshot in `revisionHistory`, increment `revision`, and save editor UID/name/time/reason on the new current version. Keep the original patient submission time and immutable `reviewHistory` unchanged. A no-op returns `unchanged: true` and creates no extra revision or notification.
- Add one owner-only notification and a staff audit entry containing record reference, revision and changed field names, not answers, measurements or the reason.
- Success: `200 { ok: true, record, unchanged, notification? }`, with canonical `recordKey` and `Cache-Control: no-store`.
- Errors: `400 SMPE_INVALID`, `401 SMPE_UNAUTHORIZED`, `403 SMPE_FORBIDDEN`, `404 SMPE_NOT_FOUND`, the two conflicts above, or sanitized `503 SMPE_UNAVAILABLE`.

## Desktop interaction

Read mode matches mobile: Patient Information, Guardian Information, Medical History and Vital Signs. Use aligned labels and values, consistent headings, accessible controls and responsive grids.

An explicit **Edit Vital Signs** mode leaves the patient/guardian and medical-history sections read-only and uses an in-memory assessment draft only; do not persist measurements in local storage. Save and Cancel are separate from Approve & Complete. A failed save retains the draft. Incoming live updates must not overwrite it. Disable approval and PDF export of unsaved changes; PDFs always represent a saved version. Require a new acknowledgment after saving a corrected revision. History stays read-only, including its exact PDF snapshot.

## Verification

Use fictional records only. Test field parity, authorization and revoked access, safe input, exact version checks, concurrent edits/approval, preservation of original answers/history, privacy of audit/notification messages, mobile-visible canonical data, read-only history, draft retention, separate approval, PDF output, and desktop/narrow light/dark layouts. No actual patient update, public deploy, APK build or Firebase configuration change is authorized by this local implementation task.
