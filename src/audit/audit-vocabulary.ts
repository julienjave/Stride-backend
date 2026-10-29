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

// The audit log's VOCABULARY (the audit log viewer, decided with the person
// 2026-10-21): every action the app writes, with its KIND, and every
// entity_type, with a readable AREA. One list, in one place:
//   - `AuditEntry` (audit.service.ts) types `action` and `entityType` with
//     the keys below, so writing an action this file doesn't know is a
//     COMPILE error — the list can't fall behind the code;
//   - the viewer's "Kind" filter is computed from it, in SQL;
//   - `GET /audit-logs/actions` serves it to the screen's action filter.
//
// Stored values are NEVER rewritten (an audit trail is append-only): the
// spellings below are the ones in the table — 'assigned-programs' with a
// hyphen next to table names with underscores — and the AREA is what a
// person reads. An action no longer written stays listed: old rows have it.

// --- KINDS ----------------------------------------------------------------------------------------------

// - change:  something was created, changed or removed (and its trail
//            commits with it — the audit convention);
// - view:    someone else's clinical data was READ (the audit review's step
//            2, and the medical files' reads);
// - sign_in: an account signed in, failed to, signed out or switched role
//            — events about a session, not about data.
export const AUDIT_KINDS = ['change', 'view', 'sign_in'] as const
export type AuditKind = (typeof AUDIT_KINDS)[number]

// --- ACTIONS --------------------------------------------------------------------------------------------

// `as const satisfies …`: `satisfies` checks every value IS a kind (a typo
// like 'veiw' fails to compile) while `as const` keeps the KEYS as literal
// types — which is what lets `AuditAction` below be a union of exactly
// these names rather than plain `string`.
export const AUDIT_ACTIONS = {
  // Sign-in and account security
  REGISTER_CLINIC: 'change',
  LOGIN_SUCCESS: 'sign_in',
  LOGIN_FAILURE: 'sign_in',
  LOGIN_BLOCKED_DEACTIVATED: 'sign_in',
  MFA_LOGIN_FAILURE: 'sign_in',
  LOGOUT: 'sign_in',
  ROLE_SWITCHED: 'sign_in',
  MFA_SETUP_STARTED: 'change',
  MFA_ENABLED: 'change',
  MFA_DISABLED: 'change',
  // Two-factor recovery (decisions §14, pass 2): a recovery code spent —
  // with how many are left — wherever a code is asked (a security event, so
  // under "sign-ins" with the wrong codes); new codes replacing the old;
  // an admin turning someone's two-factor sign-in off.
  MFA_RECOVERY_CODE_USED: 'sign_in',
  // A step-up refused (decisions §16, privacy and security pass 2): a wrong
  // current password, or a wrong / used second factor, where a change asks
  // them again — with which change, why, the failures in a row, and whether
  // that ended the session (the 5th). A security event like a wrong code at
  // sign-in, so under "sign-ins".
  STEP_UP_FAILED: 'sign_in',
  MFA_RECOVERY_CODES_REGENERATED: 'change',
  MFA_RESET_BY_ADMIN: 'change',
  PASSWORD_RESET_REQUESTED: 'change',
  PASSWORD_RESET_COMPLETED: 'change',
  // Changing one's own password from the profile (decisions §13): the
  // current password checked, the other sessions ended, a pending email
  // change and an unused reset link cancelled — never the password itself.
  PASSWORD_CHANGED: 'change',
  // Changing one's own sign-in email (decisions §12): asked (the address
  // asked for), confirmed from the new inbox (from → to), cancelled (why).
  EMAIL_CHANGE_REQUESTED: 'change',
  EMAIL_CHANGE_CONFIRMED: 'change',
  EMAIL_CHANGE_CANCELLED: 'change',

  // Accounts
  USER_CREATED: 'change',
  USER_UPDATED: 'change',
  USER_ROLE_GRANTED: 'change',
  USER_AVATAR_CHANGED: 'change',
  USER_AVATAR_REMOVED: 'change',
  USER_DEACTIVATED: 'change',
  USER_REACTIVATED: 'change',

  // Invitations
  INVITATION_SENT: 'change',
  INVITATION_RESENT: 'change',
  INVITATION_REVOKED: 'change',
  INVITATION_ACCEPTED: 'change',

  // Care teams
  CARE_TEAM_JOINED: 'change',
  CARE_TEAM_MEMBER_ADDED: 'change',
  CARE_TEAM_ENDED: 'change',

  // Clinics
  CLINIC_CREATED: 'change',
  CLINIC_UPDATED: 'change',
  CLINIC_LOGO_CHANGED: 'change',
  CLINIC_LOGO_REMOVED: 'change',
  CLINIC_MEMBER_ADDED: 'change',
  CLINIC_MEMBER_REMOVED: 'change',
  CLINIC_DEACTIVATED: 'change',
  CLINIC_REACTIVATED: 'change',

  // Exercise library
  EXERCISE_CREATED: 'change',
  EXERCISE_UPDATED: 'change',
  EXERCISE_ARCHIVED: 'change',
  EXERCISE_PHOTOS_ADDED: 'change',
  EXERCISE_PHOTOS_REORDERED: 'change',
  EXERCISE_PHOTO_REMOVED: 'change',

  // Templates
  TEMPLATE_CREATED: 'change',
  TEMPLATE_DUPLICATED: 'change',
  TEMPLATE_UPDATED: 'change',
  TEMPLATE_ARCHIVED: 'change',
  TEMPLATE_WORKOUT_ADDED: 'change',
  TEMPLATE_WORKOUT_RENAMED: 'change',
  TEMPLATE_WORKOUT_REMOVED: 'change',
  TEMPLATE_WORKOUTS_REORDERED: 'change',
  TEMPLATE_EXERCISE_ADDED: 'change',
  TEMPLATE_EXERCISE_UPDATED: 'change',
  TEMPLATE_EXERCISE_REMOVED: 'change',
  TEMPLATE_EXERCISES_REORDERED: 'change',

  // Assigned programs
  ASSIGNED_PROGRAM_CREATED: 'change',
  ASSIGNED_PROGRAM_UPDATED: 'change',
  ASSIGNED_PROGRAM_SCHEDULE_SET: 'change',
  ASSIGNED_PROGRAM_CANCELLED: 'change',
  ASSIGNED_PROGRAM_COMPLETED: 'change',
  ASSIGNED_PROGRAM_ARCHIVED: 'change',
  ASSIGNED_PROGRAM_WORKOUT_ADDED: 'change',
  ASSIGNED_PROGRAM_WORKOUT_RENAMED: 'change',
  ASSIGNED_PROGRAM_WORKOUT_REMOVED: 'change',
  ASSIGNED_PROGRAM_WORKOUTS_REORDERED: 'change',
  ASSIGNED_PROGRAM_EXERCISE_ADDED: 'change',
  ASSIGNED_PROGRAM_EXERCISE_UPDATED: 'change',
  ASSIGNED_PROGRAM_EXERCISE_REMOVED: 'change',
  ASSIGNED_PROGRAM_EXERCISE_RETIRED: 'change',
  ASSIGNED_PROGRAM_EXERCISES_REORDERED: 'change',
  ASSIGNED_PROGRAM_EXERCISE_PHOTOS_ADDED: 'change',
  ASSIGNED_PROGRAM_EXERCISE_PHOTOS_REORDERED: 'change',
  ASSIGNED_PROGRAM_EXERCISE_PHOTO_REMOVED: 'change',
  PROGRAMS_VIEWED: 'view',
  PROGRAM_VIEWED: 'view',
  PROGRAM_SUMMARY_VIEWED: 'view',
  PROGRAM_SESSIONS_VIEWED: 'view',
  PROGRAM_CLOSING_PREVIEWED: 'view',

  // Sessions
  SESSION_STARTED: 'change',
  SESSION_UPDATED: 'change',
  SESSION_EXERCISE_UPDATED: 'change',
  SESSION_COMPLETED: 'change',
  SESSION_STOPPED: 'change',
  SESSION_SKIPPED: 'change',
  SESSION_VIEWED: 'view',

  // The practitioners' "For review" list (pain and attendance alerts)
  SESSION_REVIEWED: 'change',
  PROGRAM_ALERT_REVIEWED: 'change',
  // A practitioner marked a care-team join notice as seen (decisions §25):
  // a row written, so a change — like the two reviews above.
  CARE_TEAM_JOIN_REVIEWED: 'change',
  // … and a complaint review's notice (decisions §25, pass 2).
  COMPLAINT_REVIEW_NOTICE_REVIEWED: 'change',
  ALERTS_VIEWED: 'view',

  // Messaging (who wrote to whom and when — never the text)
  CONVERSATION_STARTED: 'change',
  MESSAGE_SENT: 'change',
  MESSAGE_DELETED: 'change',
  // "Mark as read" WRITES read_at — a change, despite its name.
  CONVERSATION_READ: 'change',
  CONVERSATION_ARCHIVED: 'change',
  CONVERSATION_UNARCHIVED: 'change',

  // Medical files (entry ids only — never the notes)
  MEDICAL_FILE_ENTRY_CREATED: 'change',
  MEDICAL_FILE_ENTRY_AMENDED: 'change',
  MEDICAL_FILE_VIEWED: 'view',
  MEDICAL_FILE_ENTRY_VIEWED: 'view',

  // The records export (decisions §20): a copy of the patient's record —
  // medical file, programs, sessions — handed to the patient as a PDF. A
  // READ of clinical data (every row in it was read to write it), so a
  // view, with the ids of what went in — never the content.
  RECORDS_EXPORTED: 'view',
  // The emailed link (pass 2): an admin sent one to the patient's address
  // (a change — a way into the record now exists) …
  RECORDS_EXPORT_LINK_SENT: 'change',
  // … and someone holding it typed a wrong date of birth: a failed proof,
  // like a failed sign-in.
  RECORDS_EXPORT_LINK_REFUSED: 'sign_in',

  // The complaint review (decisions §25, pass 2): an admin opened a
  // time-boxed access to one patient's record, with a reason — and ended it
  // early. Each copy made under it is a RECORDS_EXPORTED (via
  // complaint_review, performed by the admin).
  COMPLAINT_REVIEW_OPENED: 'change',
  COMPLAINT_REVIEW_ENDED: 'change',

  // The legal disclosure (decisions §25, pass 3): an admin recorded an order
  // and made its one copy — to whom, under what, which parts and period, a
  // hold. Its copy is ALSO a RECORDS_EXPORTED (via legal_disclosure,
  // performed by the admin), written in the same transaction: the two
  // entries have different readers (this one's details are shown to admins,
  // the copy's ids are clinical and withheld).
  LEGAL_DISCLOSURE_MADE: 'change',
  // … and a practitioner on the care team marked its notice as reviewed.
  LEGAL_DISCLOSURE_NOTICE_REVIEWED: 'change',

  // Merging two accounts of the same patient (decisions §27, pass 3): TWO
  // entries for one merge, written in its transaction — like a legal
  // disclosure, because they have different readers. PATIENT_MERGED is the
  // admins' own act (which accounts, the care-team links, clinics,
  // invitations, profile fields): shown to admins. PATIENT_MERGE_RECORDS_MOVED
  // lists every program, session, medical file and message that moved — which
  // records a patient HAS is clinical (records_exports' reasoning), so its
  // details are withheld from admins; it is the record a mistaken merge is
  // repaired from.
  PATIENT_MERGED: 'change',
  PATIENT_MERGE_RECORDS_MOVED: 'change',
} as const satisfies Record<string, AuditKind>

export type AuditAction = keyof typeof AUDIT_ACTIONS

// --- AREAS ----------------------------------------------------------------------------------------------

// entity_type as stored → what the viewer shows.
export const AUDIT_AREAS = {
  users: 'Accounts',
  // A pending change of sign-in email is about the account too.
  email_change_requests: 'Accounts',
  invitations: 'Invitations',
  care_team_members: 'Care teams',
  clinics: 'Clinics',
  user_clinics: 'Clinic members',
  exercises: 'Exercise library',
  program_templates: 'Templates',
  'assigned-programs': 'Programs',
  sessions: 'Sessions',
  // "For review", as the practitioner's home calls it since 2026-10-19 — not
  // "To-do", a name kept free for a real to-do list (roadmap, Phase 7).
  session_reviews: 'For review',
  program_alert_reviews: 'For review',
  care_team_join_reviews: 'For review',
  complaint_review_notice_reviews: 'For review',
  alerts: 'For review',
  conversations: 'Messages',
  messages: 'Messages',
  medical_files: 'Medical files',
  // No table of that name: an export is a document made on request, never
  // stored. The entry is about the patient (target_user_id), with no
  // entity id.
  records_exports: 'Records exports',
  // The emailed links themselves (a table: who sent one, when, used or not).
  records_export_links: 'Records exports',
  complaint_reviews: 'Complaint reviews',
  legal_disclosures: 'Legal disclosures',
  legal_disclosure_notice_reviews: 'For review',
  patient_merges: 'Patient merges',
  // No table of that name: the clinical half of a merge's record (the ids of
  // what moved), kept apart so its area can be withheld.
  patient_merge_records: 'Patient merges',
} as const satisfies Record<string, string>

export type AuditEntityType = keyof typeof AUDIT_AREAS

// Whether an area's entries hold CLINICAL content (decided with the person
// 2026-10-23, decisions §16). Admins — the only readers of the audit log —
// read no program, session, message or medical file; an entry's `details`
// would hand them the same content (a session's pain scores and notes, a
// prescription before → after). The entries stay COMPLETE in the database —
// the only record of a prescription's earlier values — but GET /audit-logs
// answers them without their details (see detailsShownToAdmins).
//
// `satisfies Record<AuditEntityType, boolean>`: every area must be
// classified — a new area left out, or a stray key, fails to compile, so no
// area is ever shown by default.
export const CLINICAL_AREAS = {
  users: false,
  email_change_requests: false,
  invitations: false,
  care_team_members: false,
  clinics: false,
  user_clinics: false,
  exercises: false,
  program_templates: false,
  'assigned-programs': true,
  sessions: true,
  session_reviews: true,
  program_alert_reviews: true,
  // Which colleague joined which patient's team, and that someone saw it —
  // directory-level, like the care team itself (care_team_members: false).
  care_team_join_reviews: false,
  // That a practitioner saw "a review of this record was opened" — about
  // the review, not the record.
  complaint_review_notice_reviews: false,
  // That a practitioner saw "this record was disclosed" — about the
  // disclosure, not the record.
  legal_disclosure_notice_reviews: false,
  alerts: true,
  conversations: true,
  messages: true,
  medical_files: true,
  // The ids of every note, program and session handed out: which records a
  // patient HAS is clinical information too.
  records_exports: true,
  // A link's entries say who sent it to which address, when it expires, how
  // many wrong dates of birth — nothing from the record.
  records_export_links: false,
  // Who opened a review, why, until when, who ended it — the admins' own
  // act, written by them (the reason is on the patient's page too). Nothing
  // from the record: the copies' entries (records_exports) hold its ids,
  // and stay withheld.
  complaint_reviews: false,
  // To whom a record was disclosed, under what order, which PARTS and
  // period, the hold — the admins' own act, all of it on the patient's page
  // too. Nothing from the record: the copy's entry (records_exports) holds
  // its ids, and stays withheld.
  legal_disclosures: false,
  // Which two accounts were merged, by whom; the care-team links, clinics,
  // invitations and profile fields involved — account-level, like users.
  patient_merges: false,
  // The ids of every program, session, medical file and message moved.
  patient_merge_records: true,
} as const satisfies Record<AuditEntityType, boolean>

// --- LOOKUPS --------------------------------------------------------------------------------------------

// Object.hasOwn, not `action in AUDIT_ACTIONS`: `in` also finds what an
// object INHERITS — 'toString' or 'constructor' would count as known.
// `Object.hasOwn` sees only the keys written above.
function isKnownAction(action: string): action is AuditAction {
  return Object.hasOwn(AUDIT_ACTIONS, action)
}

// The kind of a STORED action. A row the list doesn't know (one written
// before this vocabulary existed — the old generic interceptor recorded
// writes) is a change: the same rule the SQL filter applies (see
// kindCondition in audit.service.ts), so a row's label and the filter that
// finds it always agree.
export function kindOf(action: string): AuditKind {
  return isKnownAction(action) ? AUDIT_ACTIONS[action] : 'change'
}

// The area of a STORED entity_type; an unknown one is shown as stored
// rather than hidden.
export function areaOf(entityType: string): string {
  return Object.hasOwn(AUDIT_AREAS, entityType)
    ? AUDIT_AREAS[entityType as AuditEntityType]
    : entityType
}

// Whether an entry's details may be shown to an admin: only for an area
// KNOWN not to be clinical. A stored entity type the vocabulary doesn't know
// (a row older than it) is withheld — the safe side: what it holds can't be
// judged.
export function detailsShownToAdmins(entityType: string): boolean {
  return (
    Object.hasOwn(CLINICAL_AREAS, entityType) &&
    !CLINICAL_AREAS[entityType as AuditEntityType]
  )
}

// Every action of one kind — what the SQL filter matches against.
export function actionsOfKind(kind: AuditKind): AuditAction[] {
  return (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter(
    (action) => AUDIT_ACTIONS[action] === kind,
  )
}
