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

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { applyDecorators } from '@nestjs/common'
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator'
import { MEDICAL_FILE_SECTION_MAX_LENGTH } from '../../database/schema/medical-files.schema'
import { IsAmendmentReason } from '../../common/validators/amendment-reason'
import {
  MEDICAL_FILE_AMENDMENT_REASON_MESSAGES,
  MEDICAL_FILE_ENTRY_TYPES,
  blankSectionMessage,
  sectionTooLongMessage,
  type MedicalFileEntryType,
  type SoapSection,
} from '../medical-file-rules'

// --- RULES -------------------------------------------------------------------------------------------------

// One SOAP section: absent or null (not written), or a string with at least
// one visible character (`\S`, unanchored — the same test as the CHECK in
// migration 0049) and at most MEDICAL_FILE_SECTION_MAX_LENGTH characters.
// @IsOptional() skips the other checks for undefined AND null — both mean
// "not written", stored as NULL.
function IsSection(section: SoapSection): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    IsString(),
    Matches(/\S/, { message: blankSectionMessage(section) }),
    MaxLength(MEDICAL_FILE_SECTION_MAX_LENGTH, {
      message: sectionTooLongMessage(section),
    }),
  )
}

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// A new entry (POST /medical-files) — an ordinary one, or an amendment of
// an earlier entry of the same patient (amendsId + amendmentReason). The
// content is a SOAP note (decided 2026-10-20; it replaced a free-form JSON
// object): an entry type and up to four sections. "At least one section" is
// the database's rule (see NO_SECTION_MESSAGE).
export class CreateMedicalFileDto {
  @IsInt()
  patientId!: number

  @IsIn(MEDICAL_FILE_ENTRY_TYPES)
  entryType!: MedicalFileEntryType

  @IsSection('subjective')
  subjective?: string | null

  @IsSection('objective')
  objective?: string | null

  @IsSection('assessment')
  assessment?: string | null

  @IsSection('plan')
  plan?: string | null

  // The entry this one corrects. Whether it belongs to this patient is the
  // database's answer (the composite foreign key, migration 0049) — it can
  // only be known by reading the file, and the database does that at the
  // moment of writing.
  @IsOptional()
  @IsInt()
  amendsId?: number | null

  // Present exactly with amendsId (common/validators/amendment-reason.ts — the
  // rule shared with range-of-motion assessments since 2026-10-31). The CHECK
  // medical_files_amendment_reason_valid (0049) holds the same rule.
  @IsAmendmentReason(MEDICAL_FILE_AMENDMENT_REASON_MESSAGES)
  amendmentReason?: string | null
}
