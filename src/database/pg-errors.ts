/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// Postgres reports every failure with a five-character SQLSTATE code. 23505
// is "unique_violation": an INSERT or UPDATE tried to store a value that a
// UNIQUE constraint already holds for another row. The code is part of the
// SQL standard, so it is stable across Postgres versions — safer to match
// on than the human-readable error message, which can change.
export const PG_UNIQUE_VIOLATION = '23505'

// 23P01 is "exclusion_violation": a row would break an EXCLUDE constraint —
// a rule of the form "no two rows may have X equal AND Y overlapping". The
// care team uses one: no two OVERLAPPING periods for the same patient and
// practitioner (migration 0019).
export const PG_EXCLUSION_VIOLATION = '23P01'

// 23503 is "foreign_key_violation": a row points at a row that doesn't exist
// — or a DELETE would leave rows pointing at nothing (with NO ACTION /
// RESTRICT foreign keys, as the workout keys are).
export const PG_FOREIGN_KEY_VIOLATION = '23503'

// 23514 is "check_violation": a row breaks a CHECK constraint. Also what the
// closed-program guard raises (migration 0031), with its own constraint name
// below, so it reads like any other constraint refusal.
export const PG_CHECK_VIOLATION = '23514'

// 42501 is "insufficient_privilege" — among other things, what Postgres
// raises when a row breaks a row-level security policy's WITH CHECK ("new
// row violates row-level security policy for table …"). It carries no
// constraint name (a policy isn't a constraint), so it is matched on the
// code alone, and only where one known policy can be the reason — a
// message sent after its care-team link ended (migration 0048).
export const PG_INSUFFICIENT_PRIVILEGE = '42501'

// 40001 is "serialization_failure": a REPEATABLE READ (or SERIALIZABLE)
// transaction tried to change a row that another transaction changed and
// committed AFTER this one's snapshot was taken. Postgres can't let it
// write on top of a version it never saw, so it refuses — and the cure the
// Postgres manual gives is to run the whole transaction again, from a new
// snapshot. The records export's emailed link meets it (two downloads with
// the same link at once): RecordsExportLinksService retries.
export const PG_SERIALIZATION_FAILURE = '40001'

// Constraint names this app translates into a 409. Drizzle names a column's
// .unique() constraint `<table>_<column>_unique` (see migration 0000).
// Kept as named constants so the service and its tests can't disagree on
// the spelling.
export const PRACTITIONER_LICENSE_NUMBER_UNIQUE =
  'practitioner_profiles_license_number_unique'

// Named by hand in migration 0019 (Drizzle can't declare EXCLUDE
// constraints), so it must match that file exactly.
export const CARE_TEAM_NO_OVERLAP = 'care_team_members_no_overlap'

// The partial unique index allowing at most one OPEN invitation per account
// (migration 0020). Hit when two "send invitation" requests race: the loser's
// INSERT finds the winner's fresh open invitation. InvitationsService turns it
// into a 409.
export const INVITATIONS_ONE_OPEN = 'invitations_one_open_per_user'

// The same rule for the records export's emailed links (migration 0061):
// at most one open link per patient. Hit when two "send a link" requests
// race; RecordsExportLinksService turns it into a 409.
export const RECORDS_EXPORT_LINKS_ONE_OPEN =
  'records_export_links_one_open_per_patient'

// One schedule version per program per day (program-schedules.schema.ts,
// migration 0024). Hit when two schedule changes for the same program and
// day race. AssignedProgramsService.addScheduleVersion turns it into a 409.
export const PROGRAM_SCHEDULES_ONE_PER_DAY =
  'program_schedules_program_effective_from_unique'

// The composite foreign keys from exercises and sessions to their workout
// (programs.schema.ts, sessions.schema.ts, migration 0026). Deleting a
// workout checks it's empty first; these catch the rare request that adds
// an exercise (or starts a session) between that check and the delete — the
// database refuses the delete, and the service turns that into the same 409
// the check gives.
export const TEMPLATE_EXERCISES_WORKOUT_FK = 'template_exercises_workout_fk'
export const ASSIGNED_PROGRAM_EXERCISES_WORKOUT_FK =
  'assigned_program_exercises_workout_fk'
export const SESSIONS_WORKOUT_FK = 'sessions_workout_fk'
// …and from a schedule version's days and rotation (step 2b-ii, migration
// 0028).
export const PROGRAM_SCHEDULE_DAYS_WORKOUT_FK =
  'program_schedule_days_workout_fk'
export const PROGRAM_SCHEDULE_ROTATION_WORKOUT_FK =
  'program_schedule_rotation_workout_fk'

// Not a real CHECK: the name the closed-program triggers (migration 0031)
// give their refusal — a completed, cancelled or archived program can no
// longer change. HttpExceptionFilter turns it into a 409, whichever route
// hit it.
export const ASSIGNED_PROGRAM_CLOSED = 'assigned_program_closed'

// The foreign key from a session's checklist row to the program exercise it
// is (sessions.schema.ts — named explicitly in migration 0032; its old,
// generated name was over Postgres's 63-character limit and got cut).
// RESTRICT: when it refuses deleting a program exercise, a session used it,
// and AssignedProgramsService.removeExercise RETIRES the exercise instead.
// SessionsService.create meets it from the other side: an exercise deleted
// while a session was starting with it.
export const SESSION_EXERCISES_PROGRAM_EXERCISE_FK =
  'session_exercises_program_exercise_fk'

// Not a real CHECK either: the name migration 0033's trigger gives its
// refusal — a retired program exercise can no longer change. Reached through
// the API only by a request racing the removal (the service refuses first
// otherwise); HttpExceptionFilter turns it into a 409.
export const ASSIGNED_PROGRAM_EXERCISE_RETIRED =
  'assigned_program_exercise_retired'

// A title must hold something visible (programs.schema.ts, migration 0035) —
// the database's half of the DTOs' IsTitle() rule. Reached through the API
// only by a write that skipped the DTOs (none does today); HttpExceptionFilter
// turns it into the DTOs' own 400, so the client can't tell which layer
// refused.
export const PROGRAM_TEMPLATES_TITLE_NOT_BLANK =
  'program_templates_title_not_blank'
export const ASSIGNED_PROGRAMS_TITLE_NOT_BLANK =
  'assigned_programs_title_not_blank'

// Sessions (Phase 4 step 1, migrations 0037 / 0038). The two partial unique
// indexes: one OPEN session per program (two starts racing — the second
// gets 23505, which SessionsService.create turns into a 409), and one SKIP
// per program per day (two skips racing — SessionsService.skip, the same).
export const SESSIONS_ONE_OPEN_PER_PROGRAM = 'sessions_one_open_per_program'
export const SESSIONS_ONE_SKIP_PER_DAY = 'sessions_one_skip_per_day'
// The trigger refusing a change to a FINISHED session's checklist (0038) —
// reachable through the API by a tick racing a Finish: the service's own
// check passed before the Finish committed, and the trigger, which waits
// for it, refuses. HttpExceptionFilter turns it into the service's 409.
export const SESSION_EXERCISE_SESSION_FINISHED =
  'session_exercise_session_finished'
// The trigger refusing a session on a day that already has a COMPLETED one
// of the same program (migration 0041, one session a day) — reachable
// through the API by a start racing a Finish: SessionsService.create's own
// check read the day before the Finish committed; the trigger waits for it,
// then refuses. HttpExceptionFilter turns it into the service's 409.
export const SESSION_ONE_COMPLETED_PER_DAY = 'session_one_completed_per_day'
// A program exercise's own photos are at most 10 (programs.schema.ts,
// migration 0042) — the database's half of AssignedProgramsService's check,
// which runs first under the row's lock. HttpExceptionFilter turns it into
// a 409, like the service's.
export const ASSIGNED_PROGRAM_EXERCISES_PHOTO_LIMIT =
  'assigned_program_exercises_photo_limit'
// Messaging (Phase 5, migrations 0047 / 0048). The two CHECKs on a message's
// text — the database's half of IsMessageBody, which refuses both first —
// and the guards: a message's text is fixed, "read" is set once by the
// recipient, "deleted" once by the sender while unread and within 15
// minutes, a conversation's participants are fixed. HttpExceptionFilter
// turns each into the answer the service's own checks give.
export const MESSAGES_BODY_NOT_BLANK = 'messages_body_not_blank'
export const MESSAGES_BODY_MAX_LENGTH = 'messages_body_max_length'
export const MESSAGE_CONTENT_FIXED = 'message_content_fixed'
export const MESSAGE_READ_BY_RECIPIENT = 'message_read_by_recipient'
export const MESSAGE_DELETE_WINDOW = 'message_delete_window'
export const CONVERSATION_PARTICIPANTS_FIXED = 'conversation_participants_fixed'
// Medical files (Phase 6, migration 0049). The CHECK "at least one section"
// is the only judge of that rule (the DTO checks one field at a time); the
// composite foreign key and the not-self CHECK refuse an amendsId that names
// no entry of this patient; the unique index lets an entry be amended once.
// MedicalFilesService turns each into its answer (400, 400, 409).
export const MEDICAL_FILES_HAS_CONTENT = 'medical_files_has_content'
export const MEDICAL_FILES_NOT_SELF_AMENDING = 'medical_files_not_self_amending'
export const MEDICAL_FILES_AMENDS_SAME_PATIENT_FK =
  'medical_files_amends_same_patient_fk'
export const MEDICAL_FILES_ONE_AMENDMENT_PER_ENTRY =
  'medical_files_one_amendment_per_entry'
// Emails (Phase 6, "Change email", pass 1 — migration 0052). The UNIQUE
// constraint on users.email (drizzle's name, migration 0000) — case-
// insensitive in effect since every email is stored normalised: two requests
// creating the same account race to it, and translateDuplicateEmail
// (common/email-address.ts) turns the loser's 23505 into the 409. And the
// CHECK that every stored email IS normalised — no translation: every write
// normalises first (the DTOs' @NormalizeEmail()), so reaching it is a bug
// that should stay a loud 500.
export const USERS_EMAIL_UNIQUE = 'users_email_unique'
export const USERS_EMAIL_NORMALIZED = 'users_email_normalized'
// One row per role per account, one per account per clinic (drizzle's names,
// migration 0000). Granting a role and adding a clinic member used to READ
// first ("already has it?") and insert after: two requests at once both read
// "no" and the second hit the constraint as a 500. Now the constraint is the
// only judge (privacy and security pass 2, decisions §16): UsersService.
// grantRole and ClinicsService.addMember turn its 23505 into their 409.
export const USER_ROLES_USER_ROLE_UNIQUE = 'user_roles_user_role_unique'
export const USER_CLINICS_USER_CLINIC_UNIQUE = 'user_clinics_user_clinic_unique'

// --- HELPER ------------------------------------------------------------------------------------------------

// The shape we read off a Postgres error. node-postgres's DatabaseError
// carries `code` and `constraint`; everything is optional because the value
// being inspected is `unknown` until proven otherwise.
interface PgErrorFields {
  code?: unknown
  constraint?: unknown
  cause?: unknown
}

// True when `error` is (or wraps) a Postgres error with this SQLSTATE `code`
// — optionally on one specific constraint. The shared engine behind
// isUniqueViolation and isExclusionViolation below.
//
// Why walk `cause`: drizzle-orm (0.44+) does not rethrow the driver's error
// as-is. It wraps it in a DrizzleQueryError (which adds the failing SQL and
// its parameters) and puts the original node-postgres error in `.cause`.
// Checking only the top-level error would therefore never match. The loop
// follows the `cause` chain a few levels down, so this keeps working
// whether the error arrives wrapped, unwrapped, or wrapped twice.
//
// Why a constraint name, not just the code: a table can have several
// unique constraints, and each deserves its own message ("license number
// already in use" must not be shown when the real collision was on
// something else). Passing no constraint matches ANY unique violation.
function isPgError(error: unknown, code: string, constraint?: string): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current !== 'object') {
      return false
    }
    const fields = current as PgErrorFields
    if (fields.code === code) {
      return constraint === undefined || fields.constraint === constraint
    }
    current = fields.cause
  }
  return false
}

// A unique violation (23505), optionally on one named constraint.
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  return isPgError(error, PG_UNIQUE_VIOLATION, constraint)
}

// An exclusion violation (23P01), optionally on one named constraint.
// Same reasoning as isUniqueViolation: the constraint decides atomically,
// so translating ITS verdict into a 409 is correct under concurrency,
// where a "check first, then insert" would have a race window.
export function isExclusionViolation(
  error: unknown,
  constraint?: string,
): boolean {
  return isPgError(error, PG_EXCLUSION_VIOLATION, constraint)
}

// A foreign-key violation (23503), optionally on one named constraint. Same
// reasoning again: when a check and a write can be separated by another
// request, the constraint's verdict is the reliable one.
export function isForeignKeyViolation(
  error: unknown,
  constraint?: string,
): boolean {
  return isPgError(error, PG_FOREIGN_KEY_VIOLATION, constraint)
}

// A check violation (23514), optionally on one named constraint.
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  return isPgError(error, PG_CHECK_VIOLATION, constraint)
}

// A row-level security refusal on a write (42501). No constraint name to
// narrow it: call it only around ONE write whose policy has one possible
// reason left once the service's own checks have passed.
export function isRowSecurityViolation(error: unknown): boolean {
  return isPgError(error, PG_INSUFFICIENT_PRIVILEGE)
}

// A serialization failure (40001): no constraint to narrow it — the whole
// transaction is what failed, and what to do is to run it again.
export function isSerializationFailure(error: unknown): boolean {
  return isPgError(error, PG_SERIALIZATION_FAILURE)
}
