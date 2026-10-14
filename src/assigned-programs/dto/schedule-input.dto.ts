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
  IsIn,
  IsInt,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator'
import { Type } from 'class-transformer'

// --- TYPES -------------------------------------------------------------------------------------------------

// Same values as the database's schedule_type enum (program-schedules.schema.ts).
export enum ScheduleType {
  WEEKDAYS = 'weekdays',
  TIMES_PER_WEEK = 'times_per_week',
  PAUSED = 'paused',
}

// A rotation lists the workouts in the order the patient goes through them
// (A, B, C, then A again). Up to 14 positions: two weeks of daily sessions —
// a cycle longer than that is hard to follow, and the limit keeps a client
// from sending thousands.
export const MAX_ROTATION_LENGTH = 14

// --- VALIDATOR HELPERS -------------------------------------------------------------------------------------

// The schedule a field belongs to: the object being validated, read through
// class-validator's `args.object`.
interface WithType {
  type: ScheduleType
}

// Fails whenever it runs on a schedule whose type isn't `type`. Combined
// with the @ValidateIf below, that means "this field was SENT, but it
// doesn't belong to this kind of schedule" — e.g. days on a 'times_per_week'
// schedule. Refused (400) rather than silently ignored: a client sending
// both probably has a bug, and saving one half of what it sent would hide
// it.
function OnlyForType(type: ScheduleType, options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'onlyForType',
      validator: {
        validate: (_value: unknown, args) =>
          (args?.object as WithType).type === type,
        defaultMessage: () =>
          `$property is only allowed when type is '${type}'`,
      },
    },
    options,
  )
}

// How each field's validation is switched on — @ValidateIf(condition) runs
// the field's other validators only when the condition is true:
//   - the field is REQUIRED for this type and the type was chosen → it must
//     be present and valid (a missing `days` fails @IsArray: "days must be
//     an array");
//   - another type, but the field was sent anyway → OnlyForType fails;
//   - another type, field absent (undefined or null) → nothing runs.
// null counts as "absent" for the other type, so a form that always sends
// every key (`{ timesPerWeek: null }`) isn't refused for it.
const requiredFor = (type: ScheduleType, field: string) => (dto: object) =>
  (dto as WithType).type === type ||
  (dto as Record<string, unknown>)[field] != null

// An OPTIONAL field of one type: checked only when sent.
const sentWith = (field: string) => (dto: object) =>
  (dto as Record<string, unknown>)[field] != null

// --- ONE DAY -----------------------------------------------------------------------------------------------

// ISO weekdays: 1 = Monday … 7 = Sunday (Postgres's `isodow`).
class WeekdayField {
  @IsInt()
  @Min(1)
  @Max(7)
  weekday!: number
}

// A day of a NEW program's schedule. The program's workouts don't exist
// yet when it's assigned (they're copied from the template in the same
// request), so a day names its workout by POSITION in the template: 0 = A,
// 1 = B… — never an id, which would have to be a TEMPLATE workout's id and
// would mean something different from a program workout's id. Two names for
// two meanings: `workoutIndex` here, `workoutId` in later versions.
export class NewScheduleDayDto extends WeekdayField {
  @IsInt()
  @Min(0)
  workoutIndex!: number
}

// A day of a later schedule version: the program's own workout, by id.
export class ScheduleDayDto extends WeekdayField {
  @IsInt()
  workoutId!: number
}

// --- THE SCHEDULE GIVEN WHEN ASSIGNING ---------------------------------------------------------------------

// POST /assigned-programs → `schedule`: the program's FIRST version, from
// its start date. Only the two "real" schedules — a program doesn't start
// paused (a pause is a later version; decided 2026-10-11).
//
//   { type: 'weekdays', days: [{ weekday: 1, workoutIndex: 0 },
//                              { weekday: 3, workoutIndex: 1 }] }
//   { type: 'times_per_week', timesPerWeek: 3, rotation: [0, 1, 2] }
//
// `rotation` is optional: without it, every workout in order (A, B, C…) —
// the suggestion the practitioner can change (decisions §5, point 3).
export class NewProgramScheduleDto {
  @IsIn([ScheduleType.WEEKDAYS, ScheduleType.TIMES_PER_WEEK], {
    message: "type must be 'weekdays' or 'times_per_week'",
  })
  type!: ScheduleType

  // One entry per scheduled day, in any order (the service sorts them).
  // ArrayUnique with a selector compares the WEEKDAYS: Monday twice — even
  // with two workouts — is refused (one session per day counts; decided
  // 2026-10-10). @ValidateNested + @Type turn each item into a real
  // NewScheduleDayDto so its own decorators run.
  @ValidateIf(requiredFor(ScheduleType.WEEKDAYS, 'days'))
  @OnlyForType(ScheduleType.WEEKDAYS)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique((day: { weekday?: unknown }) => day?.weekday, {
    message: 'days must not list the same weekday twice',
  })
  @ValidateNested({ each: true })
  @Type(() => NewScheduleDayDto)
  days?: NewScheduleDayDto[] | null

  // Sessions per PROGRAM week (weeks start on the program's start day —
  // decisions §5, point 6). 7 = every day.
  @ValidateIf(requiredFor(ScheduleType.TIMES_PER_WEEK, 'timesPerWeek'))
  @OnlyForType(ScheduleType.TIMES_PER_WEEK)
  @IsInt()
  @Min(1)
  @Max(7)
  timesPerWeek?: number | null

  // Workout positions (0 = A) in rotation order; may repeat (A, B, A, C).
  @ValidateIf(sentWith('rotation'))
  @OnlyForType(ScheduleType.TIMES_PER_WEEK)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ROTATION_LENGTH)
  @IsInt({ each: true })
  @Min(0, { each: true })
  rotation?: number[] | null
}

// --- A LATER SCHEDULE VERSION ------------------------------------------------------------------------------

// POST /assigned-programs/:id/schedules (with `effectiveFrom`, in
// AddScheduleVersionDto): the program exists, so workouts are named by the
// program's own ids. And a version may be 'paused' — no days, no count, no
// rotation: nothing is due until a later version resumes.
export class ScheduleVersionInputDto {
  @IsEnum(ScheduleType)
  type!: ScheduleType

  @ValidateIf(requiredFor(ScheduleType.WEEKDAYS, 'days'))
  @OnlyForType(ScheduleType.WEEKDAYS)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique((day: { weekday?: unknown }) => day?.weekday, {
    message: 'days must not list the same weekday twice',
  })
  @ValidateNested({ each: true })
  @Type(() => ScheduleDayDto)
  days?: ScheduleDayDto[] | null

  @ValidateIf(requiredFor(ScheduleType.TIMES_PER_WEEK, 'timesPerWeek'))
  @OnlyForType(ScheduleType.TIMES_PER_WEEK)
  @IsInt()
  @Min(1)
  @Max(7)
  timesPerWeek?: number | null

  // Program workout ids in rotation order; may repeat.
  @ValidateIf(sentWith('rotation'))
  @OnlyForType(ScheduleType.TIMES_PER_WEEK)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ROTATION_LENGTH)
  @IsInt({ each: true })
  rotation?: number[] | null
}
