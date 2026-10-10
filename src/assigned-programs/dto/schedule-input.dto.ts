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
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator'

// --- TYPES -------------------------------------------------------------------------------------------------

// Same values as the database's schedule_type enum (program-schedules.schema.ts).
export enum ScheduleType {
  WEEKDAYS = 'weekdays',
  TIMES_PER_WEEK = 'times_per_week',
}

// --- VALIDATOR HELPER --------------------------------------------------------------------------------------

// Fails whenever it runs on a schedule whose type isn't `type`. Combined
// with the @ValidateIf below, that means "this field was SENT, but it
// doesn't belong to this kind of schedule" — e.g. weekdays on a
// 'times_per_week' schedule. Refusing it (400) rather than silently
// ignoring it: a client sending both probably has a bug, and saving one
// half of what it sent would hide that.
function OnlyForType(type: ScheduleType, options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'onlyForType',
      validator: {
        validate: (_value: unknown, args) =>
          (args?.object as ScheduleInputDto).type === type,
        defaultMessage: () =>
          `$property is only allowed when type is '${type}'`,
      },
    },
    options,
  )
}

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// A schedule, as the practitioner sets it (decisions §5). Exactly one of
// `weekdays` / `timesPerWeek` goes with each type — the database enforces
// the same rule (program_schedules_fields_match_type), this gives a clear
// 400 before ever reaching it.
//
// How each field's validation is switched on — @ValidateIf(condition) runs
// the field's other validators only when the condition is true:
//   - the field's own type was chosen → the field is REQUIRED and must be
//     valid (a missing `weekdays` fails @IsArray: "weekdays must be an
//     array");
//   - another type, but the field was sent anyway → OnlyForType fails;
//   - another type, field absent (undefined or null) → nothing runs.
// null counts as "absent" for the other type, so a form that always sends
// both keys (`{ timesPerWeek: null }`) isn't refused for it.
export class ScheduleInputDto {
  @IsEnum(ScheduleType)
  type!: ScheduleType

  // ISO weekdays: 1 = Monday … 7 = Sunday. Any order is accepted here; the
  // service SORTS them before saving (the database accepts one spelling per
  // set — {1,3,5}, never {5,1,3}). Duplicates are refused rather than
  // merged: [1, 1] is more likely a client bug than an intention.
  @ValidateIf(
    (dto: ScheduleInputDto) =>
      dto.type === ScheduleType.WEEKDAYS || dto.weekdays != null,
  )
  @OnlyForType(ScheduleType.WEEKDAYS)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays?: number[] | null

  // Sessions per PROGRAM week (weeks start on the program's start day —
  // decisions §5, point 6). 7 = every day.
  @ValidateIf(
    (dto: ScheduleInputDto) =>
      dto.type === ScheduleType.TIMES_PER_WEEK || dto.timesPerWeek != null,
  )
  @OnlyForType(ScheduleType.TIMES_PER_WEEK)
  @IsInt()
  @Min(1)
  @Max(7)
  timesPerWeek?: number | null
}