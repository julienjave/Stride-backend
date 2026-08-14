# Medical files: append-only records, and view-access auditing

This document covers `MedicalFilesModule` — the last entity from the
original schema design without its own module — and a small but genuinely
important audit-consistency fix that followed from building it.

## Append-only by design: no update, no delete

Every other module in this app has update and/or archive routes.
`MedicalFilesModule` deliberately has neither. This follows directly from a
decision made back during schema design: `medical_files` has no unique
constraint per patient — each row is a discrete clinical entry over time (a
visit note, an intake record), not a single row meant to be repeatedly
overwritten. A real clinical record shouldn't be silently rewritten after
the fact; a correction belongs as a new entry (an addendum, the way real EHR
systems handle corrections), not an edit to history. `create()` and read
access are the only operations this module exposes, and that's a complete
design, not a partially-built one.

## The first real use of `targetUserId`, and an intentional exception to "GETs aren't audited"

`audit_logs.targetUserId` — "the patient profile being looked at or
changed," per its own original schema comment — had never actually been set
by anything until this module, since nothing else in the app has a natural
"target patient" concept for a *read*. The global `AuditLogInterceptor`
deliberately skips all `GET` requests everywhere else, to avoid flooding the
table with routine reads (`GET /exercises`, etc.) that carry little signal.
Medical file access is the one deliberate exception: HIPAA's real concern
with clinical records is as much about **who viewed them** as who changed
them, so `findOne()` and `findAll()` both make explicit `AuditService.log()`
calls — `ACCESS_MEDICAL_FILE` / `ACCESS_MEDICAL_FILE_LIST` — logged for
every viewer, including a patient viewing their own record.

## A real duplicate-logging bug, caught before it shipped

`create()` was initially left to the generic interceptor, since `POST
/medical-files` fits its normal shape (an authenticated mutation with a
response body containing an `id`) — genuinely audited, just under a raw
`"POST /medical-files"` action string rather than a semantic name. When this
was revisited for naming consistency with the two explicit `ACCESS_*` calls,
adding a dedicated `CREATE_MEDICAL_FILE` call *without* also changing the
interceptor would have produced **two rows for one real event** — the
generic interceptor still firing alongside the new explicit call. The fix
extended the interceptor's existing `/auth/*` exclusion to also cover
`/medical-files`, the same mechanism already in place for the same reason:
routes whose own service calls `AuditService` directly should never also be
picked up generically.

This is worth naming as a pattern for any future module that wants
semantically-named audit actions instead of the generic default: **excluding
a route from the interceptor and adding an explicit call must happen
together, in the same change** — doing only the second half silently
duplicates the audit trail rather than improving it. A blanket exclusion
also means every future mutating route added to an already-excluded module
needs its own explicit call from that point forward; there's no partial
fallback once a route prefix opts out of the generic path.
