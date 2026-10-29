# Desktop inventory saves

The desktop workspace uses `PUT /api/staff/manage/inventory/:id` to save a medicine and `DELETE /api/staff/manage/inventory/:id` to remove one. These are fixed inventory routes, not generic database-write endpoints. The former missing handler caused `Saved locally. No Alphastar endpoint for PUT ...`.

Both routes require the existing verified staff session. The current saved account and optional staff record are checked again inside a Firebase Realtime Database transaction. Admin can create, edit and delete medicines. Staff can update the stock of existing medicines only; unchanged metadata may accompany that stock update. Other roles, inactive accounts, unknown fields and unsafe record IDs are rejected.

PUT accepts `name`, `generic`, `category`, `unit`, `stock`, `reorder`, `cost`, `price`, `supplier`, `expiry`, `location` and `status`. New medicines require a name and unit. Stock/reorder levels are non-negative safe integers; prices are finite non-negative numbers; non-empty expiry dates must be real `YYYY-MM-DD` dates. A partial update preserves other saved fields. Server-generated timestamps, actor IDs and the audit record cannot be supplied by the client.

Successful replies are `{ ok: true, item: { id, ...medicineFields } }` or `{ ok: true, id }` for legacy deletion calls. Inventory and its audit event commit together; errors do not acknowledge a save. No-op retries do not add another audit event. DELETE preserves prior stock-transaction history, but is no longer offered in the Medicine Inventory UI. The client checks the confirmation ID before marking its snapshot synchronized and keeps local changes on failure.

Stock actions use `POST /api/staff/manage/inventory/:id/stock` with `{ requestId, mode: "add" | "remove", quantity }`. Admin and Staff can apply whole quantities from 1 through 9,999. A root transaction rechecks the canonical role and authoritative balance, prevents negative stock under simultaneous removals, and writes the movement and audit together. Exact retries reuse the receipt; conflicting reuse of a request ID returns 409. The UI waits for the confirmed item and transaction before changing its balance. Remarks are not requested.

The health response advertises `capabilities.inventoryManagement: 1`. Fully exit and reopen Alphastar Desktop to restart the local backend; Ctrl+R alone is insufficient. Hosted desktop backends must deploy this module and its server registration. No mobile APK, website deployment, Firebase rules or credentials change is required.

Run `node --test backend/test/inventory.test.js backend/test/patient-records.test.js`. The tests use real desktop-client HTTP calls and real Express routes against isolated in-memory database/Auth fixtures; they do not update real clinic data or establish live Firebase behavior.

## Inventory workspace and requested samples

Medicine Stock has an explicit Medicine ID column and a single outlined Manage button per row. Manage matches the Home Service Appointments layout with a summary and Medicine information, Stock, and Supply sections. Admin and Staff get Add Stock and Remove Stock; Edit Medicine remains Admin-only. Zero-stock removal is disabled. Stock forms open inside Manage; X, Cancel, Escape or the inner backdrop returns to the same Manage view. Pending saves cannot be dismissed or submitted twice. Delete and Remarks are removed from this UI; saved movements/audits are preserved. The Transactions toolbar, medicine icons and automatic-status sentence remain removed. Column widths total 100%, rows are even, and narrower screens use responsive cards without horizontal scrolling. Run `npm run test:inventory-ui` for the offline click/layout regression in light/dark themes.

The explicitly requested demonstration import is separate from application startup:

```powershell
node backend/scripts/seed-sample-medicines.js --expected-project alpha-star-clinic-mobile
node backend/scripts/seed-sample-medicines.js --expected-project alpha-star-clinic-mobile --apply
```

The first command is read-only. Apply adds only the five reserved `SAMPLE-MED-001` through `SAMPLE-MED-005` records, clearly named SAMPLE and marked as demonstration data, with quantities 100/80/60/40/30. These are not physical clinic stock. The initial import uses zero prices and blank expiry dates. A scoped inventory transaction preserves all existing medicine records, refuses occupied non-sample IDs and never resets edits on rerun; a separate idempotent system audit records the import. The script requires the existing desktop Admin SDK configuration and an exact project/database match; it changes no credentials or security rules. `backend/test/sample-medicines.test.js` verifies this behavior locally.

### Explicitly requested completion of the five samples

```powershell
node backend/scripts/complete-sample-medicine-details.js --expected-project alpha-star-clinic-mobile
node backend/scripts/complete-sample-medicine-details.js --expected-project alpha-star-clinic-mobile --apply
```

Dry run shows the exact missing fields before any write. Apply requires all five original demo identities and fills only blanks or the original zero-price placeholders. Fictional cost/selling-price pairs are PHP 1.50/3, 5/8, 2/5, 15/25 and 2.50/5 in sample-ID order. The demonstration expiry date is December 31, 2027. These are not real prices or product expiries; Manage and Edit Medicine display a plain demo notice.

Stock balances, existing nonblank metadata, unrelated medicines and transaction history are untouched. Completion is audited and marked once; reruns preserve subsequent edits, including newly cleared fields or zero prices. Manage → Edit Medicine loads all eleven saved fields without creating another medicine. Add Medicine remains the blank form for a genuinely new record. `backend/test/complete-sample-details.test.js` covers scoped completion, refusals, stock preservation and retry behavior.
