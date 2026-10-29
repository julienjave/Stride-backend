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

// The patient merge's PURE rules (decisions §27, pass 3): which two accounts
// may be merged, and how the database's account of a merge is split between
// its two audit entries. Plain data in, plain data out — tested without a
// database. The service gathers the facts and runs the merge
// (patient-merges.service.ts); the database checks the same conditions again
// inside merge_patients() (migration 0072), so a direct call can't skip them.

// --- WHO MAY BE MERGED -------------------------------------------------------------------------------------

// One account as the rule needs it: does it exist, which roles it holds, is
// it active, was it already merged away.
export interface MergeAccountFacts {
  roles: string[]
  isActive: boolean
  alreadyMerged: boolean
}

// A refusal: the HTTP status the service throws, and the words.
export interface MergeRefusal {
  status: 400 | 404 | 409
  message: string
}

export const MERGE_INTO_ITSELF_MESSAGE =
  "An account can't be merged into itself."
export const NOT_PATIENTS_MESSAGE = 'Only two patient accounts can be merged.'
export const MERGED_IS_STAFF_MESSAGE =
  'This account is also a practitioner or admin account. Merging it away would deactivate it, so it cannot be merged.'
export const ALREADY_MERGED_MESSAGE =
  'One of these accounts was already merged into another.'
export const SURVIVOR_DEACTIVATED_MESSAGE =
  'The account to keep is deactivated. Reactivate it first.'

// The first reason the merge of `merged` INTO `survivor` is refused, or null
// when it may go ahead. The order is the order a person would want to hear
// them in — "doesn't exist" before anything about what it is:
//   - the same account twice: 400 (the request makes no sense, whatever
//     the data);
//   - a missing account: 404, naming the id;
//   - either isn't a patient: 409 — merging is about one PERSON's record;
//   - the account merged AWAY holds another role: 409 — the merge
//     deactivates it, and a practitioner or admin would lose their access.
//     (The SURVIVOR may hold other roles: nothing is taken from it.);
//   - either was already merged away: 409 — a merged account is an empty,
//     deactivated shell; merging into one, or merging one again, would
//     move records into (or out of) nowhere;
//   - the survivor is deactivated: 409 — the records would move to an
//     account nobody can sign in with. (The account merged AWAY may be
//     deactivated already: a former duplicate is a common case.)
export function mergeRefusal(
  mergedId: number,
  survivorId: number,
  merged: MergeAccountFacts | undefined,
  survivor: MergeAccountFacts | undefined,
): MergeRefusal | null {
  if (mergedId === survivorId) {
    return { status: 400, message: MERGE_INTO_ITSELF_MESSAGE }
  }
  if (!merged) return { status: 404, message: `User ${mergedId} not found` }
  if (!survivor) {
    return { status: 404, message: `User ${survivorId} not found` }
  }
  if (
    !merged.roles.includes('patient') ||
    !survivor.roles.includes('patient')
  ) {
    return { status: 409, message: NOT_PATIENTS_MESSAGE }
  }
  if (merged.roles.some((role) => role !== 'patient')) {
    return { status: 409, message: MERGED_IS_STAFF_MESSAGE }
  }
  if (merged.alreadyMerged || survivor.alreadyMerged) {
    return { status: 409, message: ALREADY_MERGED_MESSAGE }
  }
  if (!survivor.isActive) {
    return { status: 409, message: SURVIVOR_DEACTIVATED_MESSAGE }
  }
  return null
}

// --- WHAT THE DATABASE DID ---------------------------------------------------------------------------------

// merge_patients()'s answer (jsonb), key by key — every id it touched.
export interface MergeSummary {
  mergeId: number
  mergedId: number
  survivorId: number
  wasActive: boolean
  assignedProgramIds: number[]
  sessionIds: number[]
  medicalFileIds: number[]
  movedConversationIds: number[]
  combinedConversations: { from: number; into: number; messageIds: number[] }[]
  movedCareTeamLinkIds: number[]
  newCareTeamLinkIds: number[]
  endedCareTeamLinkIds: number[]
  complaintReviewIds: number[]
  endedComplaintReviewIds: number[]
  legalDisclosureIds: number[]
  addedClinicIds: number[]
  revokedInvitationIds: number[]
  closedExportLinkIds: number[]
  filledFields: string[]
}

// The two audit entries' details. ONE summary, split by who may read it
// (audit-vocabulary.ts: patient_merges is shown to admins,
// patient_merge_records is clinical and withheld):
//   - `account`: the admins' own act — the two accounts, whether the merged
//     one was still active, the care-team links, record-access grants,
//     clinics, invitations and export links involved, the profile fields
//     filled, and how many sign-in sessions ended;
//   - `records`: which programs, sessions, medical files, conversations and
//     messages moved — which records a patient HAS is clinical information.
// Every key of the summary lands in exactly one of the two (a test checks
// it), so nothing the merge did goes unrecorded.
export function mergeAuditDetails(
  summary: MergeSummary,
  signedOutSessions: number,
): {
  account: Record<string, unknown>
  records: Record<string, unknown>
} {
  const {
    assignedProgramIds,
    sessionIds,
    medicalFileIds,
    movedConversationIds,
    combinedConversations,
    ...account
  } = summary
  return {
    account: { ...account, signedOutSessions },
    records: {
      mergeId: summary.mergeId,
      mergedId: summary.mergedId,
      survivorId: summary.survivorId,
      assignedProgramIds,
      sessionIds,
      medicalFileIds,
      movedConversationIds,
      combinedConversations,
    },
  }
}
