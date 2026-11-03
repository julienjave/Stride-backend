# The practitioner's loop: the care team, invitations, and schedules as history

This entry covers the backend side of the frontend's Phases 1–3
(2026-09-24 → 2026-10-15): the months in which Stride stopped being "an
admin managing records" and became a tool a practitioner works in. Most of
the work was screens; what the backend gained underneath was a new answer
to "who may read this patient?", accounts that nobody else sets a password
for, and a schedule model that never rewrites the past. It also gained its
first database triggers.

It is condensed on purpose — four stories, not a changelog. The full list of
what was built and why is in [`PROJECT.md`](../PROJECT.md), and the current
shape of each part is in [`ARCHITECTURE.md`](../ARCHITECTURE.md). The same
period seen from the screens is the frontend journal's Phases 1–3 entry
(`docs/journal/01-the-shell-and-the-practitioners-loop.md`, TODO-LINK).

Phases 1 and 2 needed little from the backend, and what they needed was
small fixes found by building on it: a license number only an admin may
change, a duplicate license number answered with a `409` instead of a `500`,
and `{ "firstName": null }` refused instead of reaching a `NOT NULL` column.
That last one was the third time the "null trap" appeared (entries 14 and
31 had met it): `PartialType` adds `@IsOptional()`, and `@IsOptional()`
skips every rule for `null` as well as for `undefined`. The fix became a
small shared validator, `@ValidateIf(isPresent)`, which skips only an
*absent* field. It was swept across every update DTO before Phase 4.

## Who may read a patient: the care team

Before Phase 3, any practitioner of a clinic could read every patient of that
clinic, clinical data included. The new rule splits access in two. Sharing a
clinic gives **directory** access: name, date of birth, photo, who is on the
care team. **Clinical** access (programs, sessions, the medical file,
messages) needs an active **care-team link** *and* a shared clinic. A link
is a row in `care_team_members` (migration 0018). Links are ended, never
deleted, because "who treated this patient, and when" is history worth
keeping. Joining is self-service and immediate: a colleague covering on a
Monday morning can't wait for an approval. It is also audited and visible to
the patient.

The rule exists twice, on purpose. `CareTeamService` decides what the API
allows; `rls_care_team_member()` (migration 0019) decides what Postgres
returns. If a service ever forgot its check, the database would still return
zero rows. A **parity test** in `test/care-team.e2e-spec.ts` runs the same
cases through both and requires the same answers, so the two can't drift.
Switching the whole app over took one statement: the existing function
`rls_practitioner_manages_patient()`, which every clinical policy already
called, got a new body. On the day of the switch nobody lost access, because
the migration first backfilled one link for every practitioner–patient pair
that already shared a clinic.

Two details are worth keeping. First, two simultaneous "Join" clicks can't
create overlapping links. That isn't a check-then-insert in the service but
a `btree_gist` **exclusion constraint** on the link's period, so the loser
gets SQLSTATE `23P01`, translated into a `409`. Second, the first bug the
invitations' policies found was here: `rls_current_user_id()` cast
`current_setting('app.current_user_id')` straight to an integer. On a pooled
connection that had served a signed-in request earlier, that setting is not
NULL but `''`, and `''::integer` raises an error. Older policies only reached
the function behind a role check that `''` never passes. The invitations
INSERT policy was the first to call it first, and a policy refusal became a
`500`. The fix was `NULLIF(current_setting(…), '')::integer`, under the same
name and signature, so every policy picked it up at once.

## Accounts by invitation, not by registration

Public self-registration was removed. An admin or a practitioner creates the
account (`POST /users`) *without a password*, and an invitation is a
one-time permission for that existing account to choose its first one.
Nobody ever sets someone else's password. The account exists at once, so a
practitioner can assign a program before the patient opens the email.

The token follows the password-reset design from entry 12. The email carries
32 random bytes, and only their SHA-256 is stored. That's plain SHA-256, not
bcrypt: bcrypt's slowness protects guessable human passwords, a 256-bit token
can't be guessed, and a deterministic hash makes "which invitation is this?"
an indexed lookup. The token travels in request *bodies*, never in a URL,
because every URL is logged. Single use is one conditional `UPDATE` whose own
`WHERE` says "still open and not expired". Postgres locks the row it
updates, so a second tab accepting at the same moment waits, then finds the
row already accepted and changes nothing.

Two ordering lessons came out of building it:

- **Inside the transaction, the care-team link comes first.** The
  invitations INSERT policy lets a practitioner invite only a patient whose
  care team they are on, so creating a patient inserts the link, then the
  invitation. An e2e test proves that the reversed order fails against the
  real policies.
- **The email goes after the commit, and its outcome is stored.** Sending
  first and then failing the commit would leave someone holding a link to an
  invitation that never existed. A failed email doesn't undo the account
  either: the answer says `emailSent: false`. Live testing with the mail
  server stopped then found the user page saying "Sent" anyway. The outcome
  had never been stored, so the page couldn't know. `invitations.email_sent_at`
  (migrations 0022–0023) fixed it. If a screen needs to know something
  later, it belongs in the data.

Email delivery itself became ports and adapters. `EmailService` decides what
an email says, and an `EmailTransport` decides how it leaves (Resend in
production, SMTP to Mailpit in development, an in-memory outbox in the e2e
tests). `EMAIL_TRANSPORT` is required with no default: any default would be
wrong somewhere. A transport *rejects* on failure and the caller decides.
That replaced entry 17's "never throws" Resend wrapper, whose behaviour
had been part of how forgot-password avoided account enumeration (entry 28
covers how that was solved instead).

## A schedule is a history, not a field

Assigning a program got a schedule: specific weekdays, or N sessions a week.
The decision that shaped everything after it is that **a schedule is a list
of versions**, each saying "from `effective_from` on, the schedule is …"
(`program_schedules`, migration 0024). A day is judged by the latest version
starting on or before it. Change Mon/Wed/Fri to Tue/Thu today, and last
week's Mondays are still judged by Mon/Wed/Fri. An overwritten column would
have turned them into misses. Row security protects that history even from a
direct query: no `UPDATE` policy at all, and no `INSERT` or `DELETE` before
"yesterday in UTC". Yesterday is used because the database only knows UTC's
date, and every time zone's date is within one day of it.

Sessions due are **calculated, never pre-created**. One pure function,
`summarizeSchedule()` (`src/assigned-programs/schedule/`), takes the program,
its versions and its completed sessions, and answers what was done, made up,
missed, due and upcoming. It has no database, no clock and no Nest. Every
screen asks it; none branches on the schedule type. Its tests are tables on
a fixed October 2026 calendar, one row per rule. The mutation run was
humbling here: five mutations survived 35 green tests, `floor` in place of
`round` among them, because the cases chosen happened to agree with the
naive version. The rule since: for each rule, write the case the naive
version gets *wrong*.

The person corrected the model once, and the correction is the lesson. The
program page labelled a Wednesday workout done on a free Tuesday "swapped".
A swap is an exchange between two scheduled days, though; doing a later
day's workout early is doing it **early**. The fix went into the backend's
rules, as a new `done_early` state (`swap-rules.ts`), not into the screen's
words. A label that's wrong usually means the model is wrong.

One more piece of time: `sessions.local_date` is the *patient's* calendar
day, sent by their app (only it knows the time zone) and refused if it can't
be "today" anywhere on Earth. The backfill showed why it must come from the
app: a Monday 23:30 session in Montreal came out as Tuesday from its UTC
timestamp.

## The database's half of a rule: the first triggers

"A completed or cancelled program is read-only" started as a service check,
`assertProgramOpen`, and it had a race. `POST /sessions` checked the program
*before* its own transaction, so a patient starting a session at the moment
a practitioner cancelled could slip a session into an archived program.
Migration 0031 added the project's first triggers: one function guards the
program's exercises, workouts, schedule versions and new sessions, and one
guards the program row itself (only archiving is still allowed).

Where the trigger runs is what makes it close the race. It is an `AFTER`
trigger, and a row's `AFTER` triggers run in name order. The built-in
foreign-key checks are named `RI_ConstraintTrigger_…`, and upper case sorts
first. So the guard runs *after* the foreign-key check that waited on the
program row's lock for the cancel to commit, and its query then sees the
committed status. A mutation turning it into a `BEFORE` trigger, which reads
the program before any wait, turned the race test red. The tables' owner is
exempt by role membership (`pg_has_role(current_user, <owner>, 'MEMBER')`),
so migrations and the seed's reset still work with no role name in the SQL.
The refusal is SQLSTATE `23514` with the constraint name
`assigned_program_closed`, which the global `HttpExceptionFilter` turns into
the service's own `409` (no try/catch per route).

Proving a lock needed its own technique. Two requests sent "at once" rarely
overlap, so a race test that sends two proves nothing. The tests instead
hold a conflicting lock on another connection, check the request is still
unanswered after 300 ms, then release it. Even that has a trap: inserting a
child row makes Postgres take `FOR KEY SHARE` on the parent, which a test's
`FOR UPDATE` also blocks, so a test holding `FOR UPDATE` passed with the
service's own lock removed. The test holds `FOR NO KEY UPDATE` instead.

The same approach shaped tailoring a running program (migrations
0032–0033). Removing an exercise a session had used was a `500`, because
`session_exercises` references it with `RESTRICT`. The service now tries the
`DELETE` inside a **savepoint** and lets the foreign key answer. If it
refuses, the exercise is **retired** instead. Without the savepoint, the
first error would abort the whole transaction. Each session also now keeps
its *own copy* of the prescription it was given, so a later edit can't
rewrite what last month's sessions say. Copy, not reference, is the rule
entry 02 set for template → program, applied one level down. Building it
also turned up a Postgres limit worth knowing: identifiers are cut at 63
characters. Drizzle's generated name for that foreign key was 70 characters
long, so the key now has a short name the code can spell
(`session_exercises_program_exercise_fk`).

Finally, the audit convention entry 39 later spread to the whole app was
born here. If "from D on" replaces versions, the audit log is where the old
ones survive. So every program write records **one complete entry** —
before → after, the replaced rows whole — written by the service with
`AuditService.logInTransaction()` *inside* the change's own transaction, on
routes tagged `@AuditedByService()`. No change without its entry, no entry
without its change.

## Current status

Phase 3 was complete on 2026-10-14, followed by a clean-up pass and the
frontend's code-splitting pass the next day. The care-team rule is described
as it stands in [`docs/api/04-authorization.md`](../api/04-authorization.md)
and in ARCHITECTURE's
[§4](../ARCHITECTURE.md#4-who-may-do-what-and-how-its-enforced); the
database's guards are listed in its
[§4 "The database's half of the rules"](../ARCHITECTURE.md#the-databases-half-of-the-rules).
Entry 37 continues with the patient's half of the loop.
