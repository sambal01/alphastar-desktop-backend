# Queue visits in Patient Records

Desktop Patient Records includes a read-only **Queue Visits** tab with each
linked ticket's recorded date/time, service, destination and current status.
View opens read-only details and can export that displayed snapshot as PDF.

The Add Patient to Queue form supports registered mobile patients and saved
clinic-only patient records. Mobile selection sends `userId`. Clinic-only
selection sends `clinicRecordId` (the `clinic_` plus 32-hex record key), never a
fake Auth UID. Leaving the selection blank still permits a walk-in name.
Selecting a record does not create or enable a mobile account.

The staff-only POST `/api/staff/queue` validates clinic-only identity within the
existing transaction. The referenced `patientProfiles` entry must be an existing,
nondeleted `clinic_only` record with matching `recordId` and no `userId`; mobile
ownership/appointment references cannot be combined with it. The server uses the
saved profile name and patient number. Same-day active patient/service duplicates
reuse the existing ticket; different patients with the same name remain separate.
The same linkage validation is included in both local backend source trees.

Add Patient now blocks a second ongoing ticket for a saved patient, including
another service or an older still-active visit. The form shows a red inline
warning and disables Add Patient; the backend transaction enforces the same
rule if the local list is stale. Completed, cancelled, skipped and deleted
tickets do not block a new visit. A retry of the same saved request remains
idempotent; an existing-ticket response for a different request is not shown
as a new successful addition. Free-text walk-ins are checked by exact
case/spacing-normalized name; select a saved record to distinguish namesakes.

Existing visits are matched by explicit account/clinic record identifiers, or
unambiguous saved patient-number references in older records. Conflicting
references, deleted tickets and same-name-only walk-ins are not linked. No
automatic name/email matching, retroactive reassignment or data migration occurs.
Walk-ins without a saved patient reference remain visible in Queue Monitoring,
not a guessed person's record. Home-service appointments remain separate.

This is a source change, not a deployment. Restart the Desktop application and
its backend. A remote backend needs the matching queue-link change deployed
separately before clinic-only selection can be used against it.
