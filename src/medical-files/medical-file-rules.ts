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

// The medical file's rules and words (Phase 6, decided 2026-10-20), written
// once for the DTO, the service and the tests — the shape of
// messaging/message-rules.ts. The database holds the same rules as
// constraints and policies (migrations 0049 / 0050); the e2e suite checks
// the two agree.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import {
  MEDICAL_FILE_SECTION_MAX_LENGTH,
  medicalFileEntryTypeEnum,
} from '../database/schema/medical-files.schema'
import { amendmentReasonMessages } from '../common/validators/amendment-reason'

// --- TYPES -------------------------------------------------------------------------------------------------

// The three entry types, read from the database enum itself
// (`enumValues`) — the DTO's @IsIn list and the column can't drift apart.
export const MEDICAL_FILE_ENTRY_TYPES = medicalFileEntryTypeEnum.enumValues
export type MedicalFileEntryType = (typeof MEDICAL_FILE_ENTRY_TYPES)[number]

// The four SOAP sections, in the order a note is written and read, with the
// word a person sees for each (used in the DTO's messages).
export const SOAP_SECTIONS = [
  'subjective',
  'objective',
  'assessment',
  'plan',
] as const
export type SoapSection = (typeof SOAP_SECTIONS)[number]
export const SECTION_LABELS: Record<SoapSection, string> = {
  subjective: 'Subjective',
  objective: 'Objective',
  assessment: 'Assessment',
  plan: 'Plan',
}

// --- MESSAGES ----------------------------------------------------------------------------------------------

export const blankSectionMessage = (section: SoapSection) =>
  `${SECTION_LABELS[section]} can't be blank`
export const sectionTooLongMessage = (section: SoapSection) =>
  `${SECTION_LABELS[section]} can be at most ${MEDICAL_FILE_SECTION_MAX_LENGTH} characters`
// The one rule across fields — "at least one section" — is the database's
// CHECK alone (medical_files_has_content); the service answers its refusal
// with this sentence. Why not also in the DTO: class-validator checks one
// property at a time, and the CHECK already gives this exact answer — a
// second copy that no test could tell apart (deep-dive, "two layers giving
// one answer").
export const NO_SECTION_MESSAGE =
  'An entry needs at least one section: Subjective, Objective, Assessment or Plan'

// The amendment reason's four sentences (the rule is shared with
// range-of-motion assessments — common/validators/amendment-reason.ts).
export const MEDICAL_FILE_AMENDMENT_REASON_MESSAGES =
  amendmentReasonMessages('an entry')
export const REASON_WITHOUT_AMENDMENT_MESSAGE =
  MEDICAL_FILE_AMENDMENT_REASON_MESSAGES.withoutAmendment
export const AMENDMENT_NEEDS_REASON_MESSAGE =
  MEDICAL_FILE_AMENDMENT_REASON_MESSAGES.needsReason
export const BLANK_REASON_MESSAGE = MEDICAL_FILE_AMENDMENT_REASON_MESSAGES.blank
export const REASON_TOO_LONG_MESSAGE =
  MEDICAL_FILE_AMENDMENT_REASON_MESSAGES.tooLong

// A practitioner writing to the file of a patient who isn't on their care
// team — the INSERT policy's refusal (42501), the only reason left once the
// role guard has let a practitioner through.
export const NOT_ON_CARE_TEAM_WRITE_MESSAGE =
  'You can only add entries to the medical file of a patient on your care team'
export const NOT_ON_CARE_TEAM_READ_MESSAGE =
  "You do not have permission to view this patient's medical file"
export const OWN_FILE_ONLY_MESSAGE = 'You can only view your own medical file'
export const PATIENT_ID_REQUIRED_MESSAGE = 'patientId is required'
// amendsId names no entry of THIS patient: another patient's entry, an id
// that doesn't exist, or the new entry's own (future) id — the composite
// foreign key and the not-self CHECK refuse all three the same way.
export const AMENDS_UNKNOWN_ENTRY_MESSAGE =
  "The entry to amend isn't in this patient's medical file"
// The entry was amended already — by someone else a moment ago, or long
// since: corrections are a chain, so the next one amends the LATEST version.
export const ALREADY_AMENDED_MESSAGE =
  'This entry has already been amended — amend its latest version instead'
export const entryNotFoundMessage = (id: number) =>
  `Medical file entry ${id} not found`
