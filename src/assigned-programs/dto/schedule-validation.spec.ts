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

// class-transformer's @Type() (on CreateAssignedProgramDto.schedule) reads
// TypeScript's design-time type information through the Reflect metadata
// API, which this polyfill adds. A running Nest app loads it at startup
// (main.ts → @nestjs/core); a spec that only imports DTOs has to load it
// itself, first, before any decorated class is defined.
import 'reflect-metadata'
import { validate, type ValidationError } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { AddScheduleVersionDto } from './add-schedule-version.dto'
import { CreateAssignedProgramDto } from './create-assigned-program.dto'
import { UpdateAssignedProgramDto } from './update-assigned-program.dto'

// Every message, flattened to "path: message" — nested errors (inside
// `schedule`) included, the way the ValidationPipe reports them.
function messages(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = prefix + error.property
    return [
      ...Object.values(error.constraints ?? {}).map((m) => `${path}: ${m}`),
      ...messages(error.children ?? [], `${path}.`),
    ]
  })
}

async function check<T extends object>(cls: new () => T, body: object) {
  return messages(await validate(plainToInstance(cls, body)))
}

const TODAY = '2026-10-09'

// The schedule rules, through AddScheduleVersionDto (it IS a
// ScheduleInputDto, plus a day).
describe('schedule validation', () => {
  it.each([
    ['specific days', { type: 'weekdays', weekdays: [1, 3, 5] }],
    ['days in any order', { type: 'weekdays', weekdays: [5, 1] }],
    ['every day', { type: 'weekdays', weekdays: [1, 2, 3, 4, 5, 6, 7] }],
    ['a weekly count', { type: 'times_per_week', timesPerWeek: 3 }],
    // A form that always sends both keys: null = "not this one".
    [
      'the other field as null',
      { type: 'times_per_week', timesPerWeek: 2, weekdays: null },
    ],
    [
      'the other field as null (weekdays)',
      { type: 'weekdays', weekdays: [2], timesPerWeek: null },
    ],
  ])('accepts %s', async (_label, schedule) => {
    expect(
      await check(AddScheduleVersionDto, { ...schedule, effectiveFrom: TODAY }),
    ).toEqual([])
  })

  it.each([
    [
      'weekdays missing for a weekdays schedule',
      { type: 'weekdays' },
      'weekdays: weekdays must be an array',
    ],
    [
      'a count missing for a times-per-week schedule',
      { type: 'times_per_week' },
      'timesPerWeek: timesPerWeek must be an integer number',
    ],
    [
      'weekdays sent with a times-per-week schedule',
      { type: 'times_per_week', timesPerWeek: 3, weekdays: [1] },
      "weekdays: weekdays is only allowed when type is 'weekdays'",
    ],
    [
      'a count sent with a weekdays schedule',
      { type: 'weekdays', weekdays: [1], timesPerWeek: 3 },
      "timesPerWeek: timesPerWeek is only allowed when type is 'times_per_week'",
    ],
    [
      'no days at all',
      { type: 'weekdays', weekdays: [] },
      'weekdays: weekdays must contain at least 1 elements',
    ],
    [
      'the same day twice',
      { type: 'weekdays', weekdays: [1, 1] },
      "weekdays: All weekdays's elements must be unique",
    ],
    [
      'day 0 (ISO weekdays start at 1)',
      { type: 'weekdays', weekdays: [0, 1] },
      'weekdays: each value in weekdays must not be less than 1',
    ],
    [
      'day 8',
      { type: 'weekdays', weekdays: [8] },
      'weekdays: each value in weekdays must not be greater than 7',
    ],
    [
      'a fractional day',
      { type: 'weekdays', weekdays: [1.5] },
      'weekdays: each value in weekdays must be an integer number',
    ],
    [
      'zero times a week',
      { type: 'times_per_week', timesPerWeek: 0 },
      'timesPerWeek: timesPerWeek must not be less than 1',
    ],
    [
      'eight times a week',
      { type: 'times_per_week', timesPerWeek: 8 },
      'timesPerWeek: timesPerWeek must not be greater than 7',
    ],
    [
      'an unknown type',
      { type: 'monthly' },
      'type: type must be one of the following values: weekdays, times_per_week',
    ],
  ])('refuses %s', async (_label, schedule, expected) => {
    expect(
      await check(AddScheduleVersionDto, { ...schedule, effectiveFrom: TODAY }),
    ).toContain(expected)
  })

  it.each([
    ['missing', undefined],
    ['a timestamp', '2026-10-09T08:00:00Z'],
    ['an impossible day', '2026-02-30'],
  ])('refuses an effectiveFrom that is %s', async (_label, effectiveFrom) => {
    expect(
      await check(AddScheduleVersionDto, {
        type: 'times_per_week',
        timesPerWeek: 3,
        effectiveFrom,
      }),
    ).toEqual([
      'effectiveFrom: effectiveFrom must be a date written as YYYY-MM-DD',
    ])
  })
})

describe('CreateAssignedProgramDto', () => {
  const valid = {
    patientId: 20,
    title: 'Knee Rehab',
    startDate: TODAY,
    basedOnTemplateId: 3,
    schedule: { type: 'weekdays', weekdays: [1, 3, 5] },
  }

  it('accepts a program with a schedule', async () => {
    expect(await check(CreateAssignedProgramDto, valid)).toEqual([])
  })

  // @ValidateNested alone would let a missing schedule through: it checks
  // an object's contents, and there's no object. @IsDefined is what refuses.
  it('refuses a program without a schedule', async () => {
    const { schedule: _schedule, ...withoutSchedule } = valid
    expect(await check(CreateAssignedProgramDto, withoutSchedule)).toEqual([
      'schedule: schedule should not be null or undefined',
    ])
  })

  // Proves the nested schedule is really validated (@Type builds a
  // ScheduleInputDto, whose decorators then run), with its path.
  it("checks the schedule's own rules, reported under schedule.", async () => {
    expect(
      await check(CreateAssignedProgramDto, {
        ...valid,
        schedule: { type: 'weekdays', weekdays: [9] },
      }),
    ).toEqual([
      'schedule.weekdays: each value in weekdays must not be greater than 7',
    ])
  })

  it.each([
    ['startDate', { startDate: '2026-10-09T08:00:00Z' }],
    ['endDate', { endDate: '2026-10-09T08:00:00Z' }],
  ])('refuses a timestamp as %s', async (field, change) => {
    expect(
      await check(CreateAssignedProgramDto, { ...valid, ...change }),
    ).toEqual([`${field}: ${field} must be a date written as YYYY-MM-DD`])
  })
})

describe('UpdateAssignedProgramDto', () => {
  // NOT NULL columns: an explicit null must be a 400 here, not a 500 from
  // the database (the null trap — is-present.ts).
  it.each([
    ['title', 'title: title must be a string'],
    ['startDate', 'startDate: startDate must be a date written as YYYY-MM-DD'],
    [
      'status',
      'status: status must be one of the following values: active, completed, on_hold, cancelled',
    ],
  ])('refuses null for %s', async (field, expected) => {
    // toContain: a null title also fails @MaxLength — any refusal will do,
    // as long as null never reaches the database.
    expect(await check(UpdateAssignedProgramDto, { [field]: null })).toContain(
      expected,
    )
  })

  // endDate is nullable: null means "no end date any more" (open-ended).
  it('accepts null for endDate', async () => {
    expect(await check(UpdateAssignedProgramDto, { endDate: null })).toEqual([])
  })

  it('accepts a PATCH that sends nothing', async () => {
    expect(await check(UpdateAssignedProgramDto, {})).toEqual([])
  })
})