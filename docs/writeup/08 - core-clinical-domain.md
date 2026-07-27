# Completing the core clinical domain

This document covers `ProgramsModule`, `AssignedProgramsModule`, and
`SessionsModule` — the three modules that complete the entire practitioner-
prescribes → patient-completes loop described in the original project spec.

## `ProgramsModule`: presets, and a nested owned sub-resource

`program_templates` follows the established DTO/service/controller template,
visible to any authenticated user (a preset library is more useful shared
across a practice than hidden per-practitioner) but editable only by its
creator or an admin — the same visibility/ownership split already used for
the exercise library.

`template_exercises` introduced a new structural shape: a **nested resource**
that only ever makes sense inside a specific parent, and whose every mutation
needs two checks, not one — an ownership check on the *parent* template
(`assertCanModify`, fetched first), and a second check that the specific
child row id in the URL actually belongs to the template in the URL. Without
the second check, a valid `template_exercises` id belonging to a *different*
template (which its actual owner has every right to edit, on its own URL)
could be edited through the wrong template's route instead. Reordering reuses
the same permutation-validation pattern built for exercise image reordering,
adapted from array position to an explicit `sortOrder` column update, run
inside a transaction so a partial reorder can't be left half-applied.

## `AssignedProgramsModule`: where copy-not-reference is finally built

This is the module the schema was designed around from the start. Two
creation paths — from a template (server copies the template's current
exercises) or ad-hoc (practitioner supplies the list directly) — both
resolve into the same atomic transaction, and from the moment it commits,
`assigned_program_exercises` rows are completely independent of
`template_exercises`. Editing or deleting the source template afterward never
touches an already-assigned patient's program — verified directly by testing
it: assign from a template, edit the template's title, re-fetch the assigned
program, confirm nothing changed.

One implementation detail worth recording: the full "program with its
exercises" read cannot be nested inside the creation transaction itself. A
read using the pooled connection (`this.db`) issued *inside* an uncommitted
transaction block would not reliably see rows the transaction has inserted
but not yet committed (different connections, read-committed isolation) — so
the detailed read happens as a separate step immediately after the
transaction resolves, not nested inside it.

Authorization introduced a new DTO validation shape:
`ValidateNested({ each: true })` paired with `@Type()` from
`class-transformer`, for an array of *objects* (each exercise entry in an
ad-hoc assignment), as opposed to `@IsString({ each: true })` for an array of
plain values. `@Type()` tells class-transformer which class to actually
instantiate each array element as; `ValidateNested` is what makes
class-validator recurse into each of those instances.

Visibility and management both route through `UsersService.isPatientManagedBy`
— injected directly (a one-directional module dependency, since `UsersModule`
needs nothing back), rather than duplicating clinic-scoping logic a third
time. A patient can view their own program; a managing practitioner or admin
can view and edit; the patient themselves cannot edit their own prescription.

## `SessionsModule`: patient-only writes, broader read access

`session_exercises` differs structurally from every other "exercises" table
in this schema: it doesn't copy exercise details, it genuinely **references**
`assignedProgramExerciseId`. This is deliberate — the *prescription*
(target sets/reps) lives on the assigned program; a session only tracks
*actual performance* against that same prescribed slot, which is a live
reference relationship, not a snapshot.

Starting a session auto-generates its checklist: the service copies the
program's *current* list of prescribed exercises into fresh, all-incomplete
`session_exercises` rows. This is a separate concept from the copy-not-
reference pattern in `AssignedProgramsModule` — each row still points back
at its `assignedProgramExerciseId` rather than duplicating sets/reps: it's
pre-populating "here's today's list," not creating a permanent independent
snapshot.

The state machine (`pending → in_progress → completed/skipped`) runs through
one generic `PATCH` endpoint rather than several single-purpose ones — the
service sets `startedAt`/`completedAt` itself based on the requested status
transition, never trusting a client-supplied timestamp for either, matching
the same server-authoritative-timestamp rule applied to `created_at`/`sent_at`
everywhere else in this schema.

Authorization here is the most restrictive split in the app: every mutating
route is patient-and-self only, full stop — there is no practitioner or admin
branch in the ownership check at all. Practitioners and admins get read
access through the same three-tier visibility pattern used elsewhere, but
literally no write path into session data, matching the original spec's
explicit framing of checking off, timing, and rating exercises as patient
actions.

## A recurring bug worth naming as a pattern, not three separate incidents

Across this phase, several `no overload matches` / type errors traced back to
the same root cause: a Drizzle column's actual expected JS type not matching
what a DTO validator produces. `@IsDateString()` keeps a value as a string;
`timestamp()` columns (default mode) expect a real `Date` object;
`date()` columns (default mode) expect a string. There is no single rule that
holds across the whole schema — it depends on which column type is on the
receiving end of a given insert/update, and needs checking per case rather
than assumed from a previous, superficially similar field.
