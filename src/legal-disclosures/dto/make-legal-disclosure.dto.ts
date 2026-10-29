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

import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator'
import {
  LEGAL_BASES,
  LEGAL_DISCLOSURE_EXPLANATION_MAX,
  LEGAL_DISCLOSURE_NAME_MAX,
  LEGAL_DISCLOSURE_REFERENCE_MAX,
  LEGAL_DISCLOSURE_STATEMENT_MAX,
  type LegalBasis,
} from '../../database/schema'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'
import { IsTimeZone } from '../../common/validators/is-time-zone'
import {
  DISCLOSURE_PARTS,
  type DisclosurePart,
} from '../legal-disclosure-rules'

// --- MESSAGES ----------------------------------------------------------------------------------------------

export const BLANK_RECIPIENT_MESSAGE = "The recipient's name can't be blank"
export const NO_PART_MESSAGE = 'Choose at least one part of the record'

// "Can't be blank — leave it out if there is none": an OPTIONAL text sent
// empty is a client's mistake worth hearing about (the screen leaves an
// empty field out), not a silent "none" (the complaint review's rule).
function blankOptional(what: string): string {
  return `${what} can't be blank — leave it out if there is none`
}

// --- DTO ---------------------------------------------------------------------------------------------------

// POST /users/:id/legal-disclosures — the order's details, the parts and
// period it covers, and (optionally) a hold. Each field's own rules are here;
// the rules BETWEEN fields (an explanation only with "other", a statement
// exactly with a hold, the period's order, nothing dated after today) are
// disclosureRequestRefusal's (legal-disclosure-rules.ts), checked by the
// service. The database's CHECKs and policies say the same again (0068,
// 0069). Texts are stored as sent — the screen trims before sending.
export class MakeLegalDisclosureDto {
  // WHO receives it: a person, and the organisation they act for.
  @IsString()
  @MaxLength(LEGAL_DISCLOSURE_NAME_MAX)
  @Matches(/\S/, { message: BLANK_RECIPIENT_MESSAGE })
  recipientName!: string

  @IsOptional()
  @IsString()
  @MaxLength(LEGAL_DISCLOSURE_NAME_MAX)
  @Matches(/\S/, { message: blankOptional("The recipient's organisation") })
  recipientOrganisation?: string

  // WHY: one of the legal bases (the enum's list).
  @IsIn(LEGAL_BASES)
  legalBasis!: LegalBasis

  @IsOptional()
  @IsString()
  @MaxLength(LEGAL_DISCLOSURE_EXPLANATION_MAX)
  @Matches(/\S/, { message: blankOptional('The explanation') })
  basisExplanation?: string

  // The order's own number, and the day it reached the clinic.
  @IsOptional()
  @IsString()
  @MaxLength(LEGAL_DISCLOSURE_REFERENCE_MAX)
  @Matches(/\S/, { message: blankOptional('The order reference') })
  orderReference?: string

  @IsCalendarDate()
  receivedOn!: string

  // WHAT: at least one part, each once.
  @IsArray()
  @ArrayNotEmpty({ message: NO_PART_MESSAGE })
  @ArrayUnique()
  @IsIn(DISCLOSURE_PARTS, { each: true })
  parts!: DisclosurePart[]

  // The period the order covers, as days (each side optional).
  @IsOptional()
  @IsCalendarDate()
  periodFrom?: string

  @IsOptional()
  @IsCalendarDate()
  periodTo?: string

  // THE HOLD (HIPAA 164.528(a)(2)): the day the patient may see it, and the
  // agency's statement asking for it.
  @IsOptional()
  @IsCalendarDate()
  withheldUntil?: string

  @IsOptional()
  @IsString()
  @MaxLength(LEGAL_DISCLOSURE_STATEMENT_MAX)
  @Matches(/\S/, { message: blankOptional("The agency's statement") })
  withholdingStatement?: string

  // The admin's browser's zone: the document's moments, the days of the
  // period, "today" for the checks, and the start of the hold's day. Optional
  // like the export's (UTC without it, said on the first page).
  @IsOptional()
  @IsTimeZone()
  timeZone?: string
}
