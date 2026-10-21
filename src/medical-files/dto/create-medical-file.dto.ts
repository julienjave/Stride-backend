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
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator'
import {
  AMENDMENT_REASON_MAX_LENGTH,
  MEDICAL_FILE_SECTION_MAX_LENGTH,
} from '../../database/schema/medical-files.schema'
import {
  AMENDMENT_NEEDS_REASON_MESSAGE,
  BLANK_REASON_MESSAGE,
  MEDICAL_FILE_ENTRY_TYPES,
  REASON_TOO_LONG_MESSAGE,
  REASON_WITHOUT_AMENDMENT_MESSAGE,
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

// The amendment reason depends on ANOTHER field (amendsId), which the
// built-in decorators can't express — each looks at one value. A custom
// constraint receives the whole object (`args.object`), so it can compare
// the two. It is applied WITHOUT @IsOptional(), so it also runs when the
// reason is missing — that's how "an amendment needs a reason" is caught.
// The checks, in order (the first that fails names the message):
//   - not an amendment (amendsId absent or null): the reason must be absent;
//   - an amendment: a string, visible, at most AMENDMENT_REASON_MAX_LENGTH.
// The CHECK medical_files_amendment_reason_valid (0049) holds the same rule.
function amendmentReasonProblem(
  dto: CreateMedicalFileDto,
  value: unknown,
): string | null {
  const amending = dto.amendsId !== undefined && dto.amendsId !== null
  if (!amending) {
    return value === undefined || value === null
      ? null
      : REASON_WITHOUT_AMENDMENT_MESSAGE
  }
  if (typeof value !== 'string') return AMENDMENT_NEEDS_REASON_MESSAGE
  if (!/\S/.test(value)) return BLANK_REASON_MESSAGE
  if (value.length > AMENDMENT_REASON_MAX_LENGTH) return REASON_TOO_LONG_MESSAGE
  return null
}

@ValidatorConstraint({ name: 'amendmentReason' })
class AmendmentReasonRule implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    return (
      amendmentReasonProblem(args.object as CreateMedicalFileDto, value) ===
      null
    )
  }

  defaultMessage(args: ValidationArguments): string {
    return (
      amendmentReasonProblem(args.object as CreateMedicalFileDto, args.value) ??
      ''
    )
  }
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

  @Validate(AmendmentReasonRule)
  amendmentReason?: string | null
}
