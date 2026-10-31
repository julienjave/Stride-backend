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

import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator'
import { IsAmendmentReason } from '../../common/validators/amendment-reason'
import { IsCalendarDate } from '../../common/validators/is-calendar-date'
import {
  ROM_MEASUREMENTS_MAX,
  ROM_NOTE_MAX_LENGTH,
} from '../../database/schema/range-of-motion.schema'
import {
  LOWEST_DEGREES,
  ROM_MODES,
  ROM_MOVEMENTS,
  ROM_MOVEMENT_DETAILS,
  ROM_SIDES,
  highestDegrees,
  type RomMode,
  type RomMovement,
  type RomSide,
} from '../movement-catalogue'
import {
  BLANK_NOTE_MESSAGE,
  NOTE_TOO_LONG_MESSAGE,
  NO_MEASUREMENT_MESSAGE,
  ROM_AMENDMENT_REASON_MESSAGES,
  SIDE_VALUE_MESSAGE,
  TOO_MANY_MEASUREMENTS_MESSAGE,
  degreesOutOfRangeMessage,
  noSideMessage,
  sideNeededMessage,
} from '../range-of-motion-rules'

// --- RULES THAT READ THE MOVEMENT --------------------------------------------------------------------------

// Whether a value is one of the catalogue's movements. `includes` on a
// readonly tuple of literals only accepts the tuple's own type, so the
// unknown value is widened to `readonly string[]` first.
function isMovement(value: unknown): value is RomMovement {
  return (
    typeof value === 'string' &&
    (ROM_MOVEMENTS as readonly string[]).includes(value)
  )
}

// The side depends on ANOTHER field — the movement (is it measured on a
// side?) — so, like the amendment reason, it is a rule that reads the whole
// object. When the movement itself is unknown there is nothing to compare
// with: this rule stays silent and @IsIn on `movement` says what's wrong
// (one problem, one message). Applied without @IsOptional(): a MISSING side
// must be caught for a sided movement.
function sideProblem(movement: unknown, side: unknown): string | null {
  if (!isMovement(movement)) return null
  const absent = side === undefined || side === null
  if (ROM_MOVEMENT_DETAILS[movement].sided) {
    if (absent) return sideNeededMessage(movement)
    return (ROM_SIDES as readonly unknown[]).includes(side)
      ? null
      : SIDE_VALUE_MESSAGE
  }
  return absent ? null : noSideMessage(movement)
}

// The degrees' bounds are the movement's (catalogue: highestDegrees). @IsInt
// runs first and says "must be an integer"; this one only judges a whole
// number of a known movement.
function degreesProblem(movement: unknown, degrees: unknown): string | null {
  if (!isMovement(movement) || !Number.isInteger(degrees)) return null
  const value = degrees as number
  return value < LOWEST_DEGREES || value > highestDegrees(movement)
    ? degreesOutOfRangeMessage(movement)
    : null
}

// One decorator from a rule over (movement, value) — the ValidateBy idiom of
// common/validators/amendment-reason.ts.
function ReadsMovement(
  name: string,
  rule: (movement: unknown, value: unknown) => string | null,
): PropertyDecorator {
  const problem = (args: ValidationArguments) =>
    rule((args.object as { movement?: unknown }).movement, args.value)
  return ValidateBy({
    name,
    validator: {
      validate: (_value: unknown, args: ValidationArguments) =>
        problem(args) === null,
      defaultMessage: (args: ValidationArguments) => problem(args) ?? '',
    },
  })
}

// --- DATA TRANSFER OBJECTS ---------------------------------------------------------------------------------

// One measurement of the assessment.
export class RomMeasurementDto {
  @IsIn(ROM_MOVEMENTS)
  movement!: RomMovement

  @ReadsMovement('romSide', sideProblem)
  side?: RomSide | null

  @IsIn(ROM_MODES)
  mode!: RomMode

  // A whole number of degrees (a goniometer's reading), signed: −10 is a
  // knee 10° short of straight.
  @IsInt()
  @ReadsMovement('romDegrees', degreesProblem)
  degrees!: number

  // Optional remark ("pain at end range"): absent or null = none.
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: BLANK_NOTE_MESSAGE })
  @MaxLength(ROM_NOTE_MAX_LENGTH, { message: NOTE_TOO_LONG_MESSAGE })
  note?: string | null
}

// A new assessment (POST /range-of-motion) — an ordinary one, or an
// amendment of an earlier assessment of the same patient (amendsId +
// amendmentReason): a complete new version, every measurement included.
export class CreateRomAssessmentDto {
  @IsInt()
  patientId!: number

  // The clinical day ('YYYY-MM-DD'). "Not in the future" is the database's
  // judgement (rom_assessments_measured_by_recording, against its own clock).
  @IsCalendarDate()
  measuredOn!: string

  // The medical file entry of the same visit. Whether it is THIS patient's
  // is the database's answer (the composite foreign key, 0076).
  @IsOptional()
  @IsInt()
  medicalFileEntryId?: number | null

  @IsOptional()
  @IsInt()
  amendsId?: number | null

  @IsAmendmentReason(ROM_AMENDMENT_REASON_MESSAGES)
  amendmentReason?: string | null

  // Between 1 and ROM_MEASUREMENTS_MAX, each validated as a
  // RomMeasurementDto (@ValidateNested + @Type: create-assigned-program.dto.ts
  // explains the pair). "At least one" is also the database's (a deferred
  // constraint trigger, 0077) — for a query that doesn't come through here.
  @IsArray()
  @ArrayMinSize(1, { message: NO_MEASUREMENT_MESSAGE })
  @ArrayMaxSize(ROM_MEASUREMENTS_MAX, {
    message: TOO_MANY_MEASUREMENTS_MESSAGE,
  })
  @ValidateNested({ each: true })
  @Type(() => RomMeasurementDto)
  measurements!: RomMeasurementDto[]
}
