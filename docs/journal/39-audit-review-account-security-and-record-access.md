# Phase 6: an audit trail worth reading, accounts that hold, and record access instead of a back door

This entry covers the backend side of the frontend's Phase 6
(2026-10-20 → 2026-10-29), the longest phase. On the screen it brought the
medical file, the audit log viewer, two-factor enrolment, email and password
changes, and the records export. Underneath, three threads ran through it:
making every change and every clinical read leave one honest trace, finding
the account-security bugs that only reading the code closely could show, and
replacing "admins can read everything" with a narrow, recorded way to give a
record to someone outside the care team.

Condensed to four stories; [`PROJECT.md`](../PROJECT.md) has the rest. The
frontend journal's Phase 6 entry
([`docs/journal/04-honest-states-plain-words-and-account-pages.md`](https://github.com/julienjave/Stride-frontend/blob/main/docs/journal/04-honest-states-plain-words-and-account-pages.md))
covers the screens, among them
the one-sentence failure wording and the loading states that now span the
whole app.

## The audit review: from a safety net to a rule the build enforces

Entry 10 designed the audit log around one global interceptor that recorded
every mutating request. By Phase 6 its weaknesses were plain. It recorded
*that* something changed, never *what*. A `PATCH` that changed a patient's
sets left `PATCH /assigned-programs/3/exercises/5` and nothing else. It wrote
**after** the response, fire-and-forget, so a change could succeed while its
entry was lost. And services that also wrote explicit entries (after their
own commit, on another connection) produced **duplicates**: joining a care
team left a `CARE_TEAM_JOINED` *and* a `POST /users/6/care-team`.

The review moved every write in the app — clinical, account and library
alike — to the convention born in entry 36: one complete entry (who, what,
about whom, before → after), written in the change's own transaction.
Then it **deleted the interceptor**. What replaced it is a test.
`src/audit/audit-tags.spec.ts` reads every controller's route metadata the
way Nest does, and fails the build for any non-`GET` route that is tagged
neither `@AuditedByService()` nor `@NotAudited(reason)`. Forgetting the
audit trail used to be silent. Now it is a red build, at the moment the
route is written.

"Same transaction" is a claim, so it got a test that can fail. The test
plants a trigger, as the owner, that refuses `USER_UPDATED` rows. The `PATCH`
then answers `500` *and the stored name is unchanged*. A mutant turning the
entry back into a fire-and-forget write changes the name and loses only the
entry, so it fails. Sign-in events are the one exception: they change no
row, so there is no transaction to share. They are written on their own
connection and *awaited* before answering, and their planted-trigger test
proves a refused audit write also refuses the sign-in.

Reads came next. Programs, sessions, pain alerts and the medical file, when
read by someone other than the patient, write one entry per patient shown,
awaited before the answer is sent (`AuditService.logReads`). A read changes
nothing to roll back, so the guarantee becomes "no answer without its
trace". The medical file goes further and records every read, the patient's
own included. Clinical entries are kept whole, but an admin sees their
details withheld (`CLINICAL_AREAS` classifies every area and is checked by
the compiler). Retention is decided — 6 years, HIPAA's period for required
documentation — but no purge job exists yet; the open items say so.

## Reading the account code closely, before building its screens

Two-factor enrolment was "only screens" on the roadmap. Reading the backend
first found four real problems, and a smaller one. **Set-up never looked at
whether two-factor was already on**: it replaced the *working* secret with
no code asked, the person's authenticator stopped matching, and their next
sign-in failed. Clicking "set up" twice was enough. **A stolen session could
enrol its own authenticator** on someone else's account, since set-up and
enable asked for the session only. **There was no way back from a lost
phone.** **Enable could race a set-up** in another tab and turn two-factor
on with a secret nobody had scanned. And, smaller: **a code could be used
twice within its 30-second window**. otplib is a pure function of secret,
code and clock, so remembering which step was used is the app's job. The
fixes:

- `users.mfa_last_used_step` (migration 0056), compared and written **under
  the account's row lock**. Without the lock, a second request's plain read
  returns the last *committed* value at once — READ COMMITTED never waits on
  row locks for a plain `SELECT` — and both requests accept the same code.
  `whileHolding` (entry 37) holds the first write uncommitted to prove it.
- Set-up asks for the password and refuses while two-factor is on (`409`);
  turning it off asks for the password *and* a code; the email and password
  changes ask an MFA account for its code too (one shared step-up rule).
- **Recovery codes** carry about 49.5 bits of randomness (10 symbols from an
  alphabet of 31). Stored as plain SHA-256, a stolen table could be guessed
  offline in about a day on a GPU. bcrypt would need one slow comparison per
  stored code, because no index can find a salted hash. So they are stored
  as an **HMAC**, keyed by a subkey of `MFA_ENCRYPTION_KEY` derived for this
  use only. Without the key, nobody can compute the hash of a guess at all.
- The admin's reset locks two rows, the admin's and the target's, in one
  agreed order (`ORDER BY id FOR UPDATE`). Two admins resetting each other at
  once can't then deadlock.
- A wrong password or code in any step-up is counted **after** the change's
  rollback, in a transaction of its own (`.catch`, then
  `step_up_failures + 1` computed by Postgres). Counted inside, the rollback
  would erase it. The fifth failure in a row signs that session out. A later
  pass closed the mirror case: a code that *passed* is spent again after its
  change rolls back, using `GREATEST(stored step, step)` so a later code used
  in between is never re-opened.

Changing an email (pass 1) needed emails to have **one spelling**: trimmed,
with **A–Z only** lowercased, under a CHECK (`users_email_normalized`,
migration 0052). Why only A–Z? Three places compute "the normal spelling":
the app, the CHECK and the migration. Postgres's `lower()` follows the
server's locale; under `C.UTF-8` it lowercases `É`, under `COLLATE "C"` it
doesn't. If any two of the three disagree on one input, either the CHECK
refuses what the app stores or a rewritten address stops matching its
lookup. A parity e2e test feeds É, the Turkish İ, ß and the titlecase ǅ
through both sides. The migration *refuses to run* when two accounts would
collide, naming them: two accounts are two histories, and choosing between
them is a person's decision. The duplicate check stopped being a read before
the insert, which is a TOCTOU race. The UNIQUE constraint now decides and its
`23505` becomes the `409`. A test holding an uncommitted insert of the same
address shows the old code answering `500` and the new one `409`.
`grantRole` and `addMember` got the same fix two days later.

## Admins out of clinical data, and record access instead

Phase 5 had taken admins out of messages and the medical files' backend pass
out of the file. Phase 6's privacy pass finished the job for programs and
sessions: `@Roles` on the routes, and 17 `ALTER POLICY` statements in
migration 0059 removing `rls_is_admin()`. Four mutants putting it back
survived, and they are equivalent rather than untested. A write policy's
admin branch can't be reached once the `SELECT` policy hides the row, because
Postgres applies the table's `SELECT` policy to the rows an `UPDATE` or
`DELETE` targets. They were removed anyway, so the policies say what is
meant.

A deactivation then showed a quieter failure. Deactivating a practitioner
should end their care-team links, but row security never raises an error for
an `UPDATE` it doesn't allow: it simply makes the rows invisible, and "0 rows
updated" looks like success. In the two cases where the links' `UPDATE`
policy would skip them silently, the service now **refuses** the
deactivation instead. A guarantee that can silently not apply should fail
loudly.

What admins *do* sometimes need — a patient's complaint, a court order — is
not standing access, so the "break-glass read" idea was reframed as **record
access**, built on the records export:

- **The export reads as the patient**, under the patient's own row security
  (`applyUserContext`), so a copy can never hold more than the patient
  themselves can see. It runs in one **REPEATABLE READ** transaction, so
  every table is read at one moment. A test holds an `ACCESS EXCLUSIVE` lock
  and an uncommitted change on one table while the export runs: the export
  waits, and the copy shows the value *before* the change. The PDF is drawn
  inside the transaction, then its `RECORDS_EXPORTED` entry is inserted, then
  the commit, and only then are the bytes sent. No copy leaves without its
  trace.
- **The emailed link** (for a patient who can't sign in) asks the date of
  birth. Two tabs spending one link meet Postgres's **serialization
  failure** (`40001`): under REPEATABLE READ, a transaction may not update a
  row another transaction changed after its snapshot. The manual's remedy is
  to run the whole transaction again, and `retriedOnce` does, once. A wrong
  date is counted *after* the rollback, as the step-up failures are.
- **A complaint review** gives one admin a 7-day grant to one patient's PDF.
  The care team is told who and when, never why. Row security has no
  per-column policies, so the reason lives in a second table,
  `complaint_review_reasons`, readable by admins only.
- **A legal disclosure** writes **two** audit entries. The order (recipient,
  basis, reference) is in a non-clinical area admins must read to answer for
  it; the ids of what left are in a clinical one, withheld from admins. One
  entry would have to break one of those two rules.

## Current status

Phase 6 was feature-complete on 2026-10-28 and its tidy-up on 2026-10-29.
The audit trail as it stands is ARCHITECTURE's
[§5](../ARCHITECTURE.md#5-the-audit-trail); sign-in and the step-up are its
[§6](../ARCHITECTURE.md#6-accounts-sign-in-and-sessions) and
[`docs/api/01-authentication.md`](../api/01-authentication.md); record
access is
[`04-authorization.md` § Admins and clinical data](../api/04-authorization.md#admins-and-clinical-data)
and ARCHITECTURE's
[§8 "The records export"](../ARCHITECTURE.md#the-records-export).
