# Phase 6.5: what a rollback can't undo, two accounts for one person, and a job with no user

This entry covers Phase 6.5 (2026-10-29 → 2026-10-30), opened once Phase 6
was feature-complete. It added few features. It closed gaps of two kinds:
data left behind (files in storage, duplicate patient accounts), and rules
only a service kept, which now got a database half too, the way the
closed-program guard did in entry 36. It also answered a question that had
been deferred since Phase 4: how a scheduled job reads data under row
security when there is no user.

Condensed to four stories; [`PROJECT.md`](../PROJECT.md) has the rest. The
merge's screens and the paged users list are the frontend journal's Phase
6.5 entry (TODO-LINK).

## Files a transaction can't roll back

A transaction rolls back rows. A photo already uploaded to storage is
another system's state, and nothing rolls it back. Three kinds of leftover
file had accumulated: uploads whose row update then failed, the own photos
of a deleted program, and the targets of best-effort deletes that had
themselves failed. Each got its own fix.

- **Undo what you stored, when the next step fails.** The code that stored a
  file deletes it again if the transaction after it fails
  (`src/storage/compensation.ts`, now used by avatars, clinic logos, the
  library's photos and a program's own photos). This is a compensating
  action — the saga pattern, inside one service. Files are stored one at a
  time (`storeAll`), because with `Promise.all` an upload still in flight
  when another failed would land *after* the undo. The honest limit is
  written in the code: a connection lost *during* the commit reports an
  error without knowing whether the commit happened, and deleting then could
  leave a saved row naming a missing file. That case is rare, and the
  sweeper below catches the opposite one.
- **Archiving a program empties its own photos inside the archiving
  transaction**, then deletes the files after the commit. The closed-program
  guard made those rows final, so migration 0070 gave it exactly one
  exception: archived, and nothing else changing. Every exercise row is
  locked `FOR UPDATE` first. Otherwise a photo upload committing at that
  moment would be judged on the old snapshot, skipped, and its files left
  behind.
- **A sweeper, run by hand** (`npm run storage:sweep`): it lists every file,
  then reads every key the database references, and prints what no row
  uses. It deletes only with `--delete`, and never a file younger than 24
  hours, which covers an upload whose row isn't saved yet. The read runs
  with `SET LOCAL row_security = off`. That isn't a bypass. A role that row
  security *would* filter gets error `42501` instead of a silently short
  list, and a short list here would mean deleting files that are in use. A
  convention test fails if a schema column named `…_path` or `media_urls`
  isn't on the sweeper's list.

## Two accounts for one person

A patient invited once as `jane@work.com` and again as `jane@home.com` is
two accounts, and their history splits in two. Detection came first. A new
patient with the same date of birth and the same normalised name as an
existing one gets a `409` with `reason: 'possible_duplicate'`, and the form
can resend with `allowPossibleDuplicate`. The decision is recorded in the
creation's audit entry. Names are normalised in TypeScript, in four ordered
steps: lowercase; write out the letters Unicode doesn't treat as letter +
accent (ß, æ, ø, ł…); `NFKD`; keep only letters and digits of any script. An
admin sees every match. A practitioner sees only the matches their own
directory would show, plus a bare "others exist", because row security lets
their connection *read* every candidate but the answer must not repeat what
their directory hides. The first full e2e run then failed **154 tests**:
fixture helpers in eleven suites created patients with the same name and
birth date. The check was right, and the fixtures now say so explicitly.

The merge was harder, and it is where Stride's first **`SECURITY DEFINER`**
function appeared. Entry 33 had argued, with evidence, that the `user_clinics`
pass didn't need one; here one was needed. An admin asks for the merge, but
the rows to move (programs, sessions, the file, messages) are ones row
security has hidden from admins since entries 38–39. A definer function runs with its
owner's rights, and because such a door is dangerous, `merge_patients()`
(migrations 0071–0072) has five locks:

| Lock | What it stops |
| --- | --- |
| `SET search_path = public, pg_temp` | a caller's own `users` table or `now()` function, found earlier on the path, running with the owner's rights (`pg_temp` LAST — left out, it is searched first) |
| `SET row_security = off` | an owner that row security would filter "succeeding" with nothing moved — it fails instead |
| `REVOKE EXECUTE … FROM PUBLIC` + a named `GRANT` | any other role calling it at all |
| the caller checked inside | a session that isn't an active admin acting as admin |
| every rule checked again | a direct call that skipped the service's checks |

Overlapping care-team links were the subtle part. An exclusion constraint
forbids two links of one patient and practitioner with overlapping periods,
so the duplicate's link can't simply be moved onto the survivor. Postgres's
**multiranges** compute "the time the survivor isn't already covered" in one
expression:
`tstzmultirange(tstzrange(start, end)) - range_agg(…)`. `unnest` then gives
each piece, and each piece becomes a new link. The merge writes **two**
audit entries, for the reason entry 39's legal disclosure did. The act (who
merged which accounts) is the admins' own. Which programs, sessions and
files the patient has is clinical, and is withheld from them.

## The database's half of two service rules

Migration 0073 gave two rules that only services had kept a trigger each.
A **care-team link** may now be changed in exactly the one way the app
changes it: only its end, only while it is current (an ended link is final,
so it can't be re-opened to bring access back with no audit entry), and
only to `now()` (no backdating). Column `GRANT`s were considered and
rejected. They need the app role's name, which is an environment variable a
migration can't read. They can't express "ended is final" or "the end is
now". And their refusal is the same `42501` as row security's. The trigger's
refusal names itself, `care_team_member_end_only`, and becomes a `409`. An
**open program's end date** can no longer move into the past either; closing
keeps its own rule.

Two things the mutation run taught are worth keeping. A mutant dropping
`OLD.status = 'active'` from the end-date guard survived at first, because
the only statement it matters for is one nobody had tested: re-opening a
closed program while backdating its end. Two `BEFORE` triggers fire in name
order, and `assigned_program_end_date_guard` sorts before
`closed_program_guard`, so without the clause the answer would be "in the
past" instead of the truer "closed". A test now sends that statement. The
second lesson is a fixture that lied. The first re-open test planted its
ended link on a patient who by then had a later link to the same
practitioner, so re-opening was refused by the *exclusion constraint* — on
the old database too. The test still failed there, but for the wrong reason
(a different constraint name). Each refusal test is now proven to *succeed*
with the triggers disabled (`ALTER TABLE … DISABLE TRIGGER`), so only the
trigger can be what refuses it.

## A job with no user

"You have a new message" emails were the last clinical leftover. The email
never carries the text, because email isn't a secure channel for clinical
content. A sweep every minute emails someone with a message unread for 15
minutes, at most **once per conversation until they read it** (the person's
rule: "not every 15 minutes"). Every policy starts from "who is asking", and
a sweep asks as nobody. That is the "system actor" question entry 37 had
avoided by computing alerts per request, and which an audit purge will need
answered too.

The answer here is a second definer function, `claim_message_notices()`
(migration 0075), the narrowest door available. A "system" branch in three
tables' policies would be a door any request could open by setting a value;
a separate database role would be a second identity to deploy and rotate.
The function does one thing. It locks the conversations that are due with
`FOR UPDATE SKIP LOCKED`, so a second sweep (another instance, or a slow one)
*skips* rows the first holds instead of waiting, then finds them marked.
In one statement, a data-modifying CTE marks each recipient's side as
notified and returns who to email — no message text. It refuses to run
inside a request (`42501`). The marker is cleared only when that person
reads the conversation, and a guard trigger lets the app clear a marker but
never set one. Six SQL mutants survived at first, each because a side's rule
had been tested only where both sides agreed. Two tests where the sides
disagree killed them.

## Current status

Phase 6.5 was green on 2026-10-30. The merge, the guards and the notices are
described as they stand in ARCHITECTURE's
[§4](../ARCHITECTURE.md#the-databases-half-of-the-rules) (the two
`SECURITY DEFINER` functions and every guard trigger) and
[§8](../ARCHITECTURE.md#object-storage) (compensation and the sweeper). The
sweeper is run by hand. Scheduling it, like the audit purge, is an open item
in the journal's [README](README.md#known-open-items).
