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
import { CloseAssignedProgramDto } from './close-assigned-program.dto'

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

// `strict`: also refuse unknown properties, as the app's ValidationPipe does
// (whitelist + forbidNonWhitelisted) — for the cases where a property that
// doesn't belong is the point.
async function check<T extends object>(
  cls: new () => T,
  body: object,
  strict = false,
) {
  return messages(
    await validate(
      plainToInstance(cls, body),
      strict ? { whitelist: true, forbidNonWhitelisted: true } : {},
    ),
  )
}

const TODAY = '2026-10-09'

// The schedule rules of a LATER version, through AddScheduleVersionDto (a
// ScheduleVersionInputDto plus a day): workouts by the program's ids, and
// 'paused' allowed.
const MON_A_WED_B = [
  { weekday: 1, workoutId: 11 },
  { weekday: 3, workoutId: 12 },
]

describe('schedule version validation', () => {
  it.each([
    [
      'specific days with their workouts',
      { type: 'weekdays', days: MON_A_WED_B },
    ],
    [
      'days in any order',
      { type: 'weekdays', days: [...MON_A_WED_B].reverse() },
    ],
    [
      'the same workout on several days',
      {
        type: 'weekdays',
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          workoutId: 11,
        })),
      },
    ],
    [
      'a weekly count (rotation suggested)',
      { type: 'times_per_week', timesPerWeek: 3 },
    ],
    [
      'a weekly count with a rotation that repeats',
      { type: 'times_per_week', timesPerWeek: 3, rotation: [11, 12, 11] },
    ],
    ['a pause', { type: 'paused' }],
    // A form that always sends every key: null = "not this one".
    [
      'the other fields as null',
      { type: 'times_per_week', timesPerWeek: 2, days: null, rotation: null },
    ],
    [
      'the other fields as null (weekdays)',
      {
        type: 'weekdays',
        days: MON_A_WED_B,
        timesPerWeek: null,
        rotation: null,
      },
    ],
    [
      'a pause with every field null',
      { type: 'paused', days: null, timesPerWeek: null, rotation: null },
    ],
  ])('accepts %s', async (_label, schedule) => {
    expect(
      await check(AddScheduleVersionDto, { ...schedule, effectiveFrom: TODAY }),
    ).toEqual([])
  })

  it.each([
    [
      'days missing for a weekdays schedule',
      { type: 'weekdays' },
      'days: days must be an array',
    ],
    [
      'a count missing for a times-per-week schedule',
      { type: 'times_per_week' },
      'timesPerWeek: timesPerWeek must be an integer number',
    ],
    [
      'days sent with a times-per-week schedule',
      { type: 'times_per_week', timesPerWeek: 3, days: MON_A_WED_B },
      "days: days is only allowed when type is 'weekdays'",
    ],
    [
      'a count sent with a weekdays schedule',
      { type: 'weekdays', days: MON_A_WED_B, timesPerWeek: 3 },
      "timesPerWeek: timesPerWeek is only allowed when type is 'times_per_week'",
    ],
    [
      'a rotation sent with a weekdays schedule',
      { type: 'weekdays', days: MON_A_WED_B, rotation: [11] },
      "rotation: rotation is only allowed when type is 'times_per_week'",
    ],
    // A pause has nothing: days, a count or a rotation is a client bug.
    [
      'days sent with a pause',
      { type: 'paused', days: MON_A_WED_B },
      "days: days is only allowed when type is 'weekdays'",
    ],
    [
      'a count sent with a pause',
      { type: 'paused', timesPerWeek: 2 },
      "timesPerWeek: timesPerWeek is only allowed when type is 'times_per_week'",
    ],
    [
      'no days at all',
      { type: 'weekdays', days: [] },
      'days: days must contain at least 1 elements',
    ],
    // ArrayUnique compares WEEKDAYS: Monday twice, even with two workouts.
    [
      'the same weekday twice',
      {
        type: 'weekdays',
        days: [
          { weekday: 1, workoutId: 11 },
          { weekday: 1, workoutId: 12 },
        ],
      },
      'days: days must not list the same weekday twice',
    ],
    [
      'day 0 (ISO weekdays start at 1)',
      { type: 'weekdays', days: [{ weekday: 0, workoutId: 11 }] },
      'days.0.weekday: weekday must not be less than 1',
    ],
    [
      'day 8',
      { type: 'weekdays', days: [{ weekday: 8, workoutId: 11 }] },
      'days.0.weekday: weekday must not be greater than 7',
    ],
    [
      'a day without its workout',
      { type: 'weekdays', days: [{ weekday: 1 }] },
      'days.0.workoutId: workoutId must be an integer number',
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
      'an empty rotation',
      { type: 'times_per_week', timesPerWeek: 2, rotation: [] },
      'rotation: rotation must contain at least 1 elements',
    ],
    [
      'a rotation of 15 positions',
      { type: 'times_per_week', timesPerWeek: 2, rotation: Array(15).fill(11) },
      'rotation: rotation must contain no more than 14 elements',
    ],
    [
      'an unknown type',
      { type: 'monthly' },
      'type: type must be one of the following values: weekdays, times_per_week, paused',
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

  // A pause with an end (roadmap Phase 6.5): `resumeOn`, the back-on day.
  describe('resumeOn', () => {
    it.each([
      ['a back-on day', '2026-10-26'],
      ['absent', undefined],
      ['null (a form that always sends the key)', null],
    ])('accepts a pause with %s', async (_label, resumeOn) => {
      expect(
        await check(AddScheduleVersionDto, {
          type: 'paused',
          effectiveFrom: TODAY,
          resumeOn,
        }),
      ).toEqual([])
    })

    it.each([
      ['a timestamp', '2026-10-26T08:00:00Z'],
      ['an impossible day', '2026-02-30'],
      ['a number', 20261026],
    ])('refuses a resumeOn that is %s', async (_label, resumeOn) => {
      expect(
        await check(AddScheduleVersionDto, {
          type: 'paused',
          effectiveFrom: TODAY,
          resumeOn,
        }),
      ).toEqual(['resumeOn: resumeOn must be a date written as YYYY-MM-DD'])
    })

    // Refused, not ignored, on a schedule that isn't a pause: "back on" means
    // nothing for a schedule that never stopped.
    it.each([
      ['specific days', { type: 'weekdays', days: MON_A_WED_B }],
      ['a weekly count', { type: 'times_per_week', timesPerWeek: 3 }],
    ])('refuses it on %s', async (_label, schedule) => {
      expect(
        await check(AddScheduleVersionDto, {
          ...schedule,
          effectiveFrom: TODAY,
          resumeOn: '2026-10-26',
        }),
      ).toEqual(["resumeOn: resumeOn is only allowed when type is 'paused'"])
    })
  })
})

describe('CreateAssignedProgramDto', () => {
  const valid = {
    patientId: 20,
    title: 'Knee Rehab',
    startDate: TODAY,
    basedOnTemplateId: 3,
    schedule: {
      type: 'weekdays',
      days: [
        { weekday: 1, workoutIndex: 0 },
        { weekday: 3, workoutIndex: 1 },
      ],
    },
  }

  it('accepts a program with a schedule', async () => {
    expect(await check(CreateAssignedProgramDto, valid)).toEqual([])
  })

  it('accepts a weekly count with a rotation of positions', async () => {
    expect(
      await check(CreateAssignedProgramDto, {
        ...valid,
        schedule: {
          type: 'times_per_week',
          timesPerWeek: 3,
          rotation: [0, 1, 0],
        },
      }),
    ).toEqual([])
  })

  // A program starts with a real schedule; a pause comes later, as a
  // version (decided 2026-10-11).
  it('refuses a program that starts paused', async () => {
    expect(
      await check(CreateAssignedProgramDto, {
        ...valid,
        schedule: { type: 'paused' },
      }),
    ).toEqual(["schedule.type: type must be 'weekdays' or 'times_per_week'"])
  })

  // At creation, workouts are POSITIONS (the program's own don't exist
  // yet): an id there is refused, not silently read as a position.
  it.each([
    [
      'a workoutId instead of a workoutIndex',
      { type: 'weekdays', days: [{ weekday: 1, workoutId: 11 }] },
      [
        'schedule.days.0.workoutId: property workoutId should not exist',
        'schedule.days.0.workoutIndex: workoutIndex must not be less than 0',
        'schedule.days.0.workoutIndex: workoutIndex must be an integer number',
      ],
    ],
    [
      'a negative position',
      { type: 'weekdays', days: [{ weekday: 1, workoutIndex: -1 }] },
      ['schedule.days.0.workoutIndex: workoutIndex must not be less than 0'],
    ],
    [
      'a negative position in a rotation',
      { type: 'times_per_week', timesPerWeek: 2, rotation: [0, -1] },
      ['schedule.rotation: each value in rotation must not be less than 0'],
    ],
    // The same limits as a later version's (the two DTOs are separate
    // classes, so each one's decorators need their own test).
    [
      'a rotation of 15 positions',
      { type: 'times_per_week', timesPerWeek: 2, rotation: Array(15).fill(0) },
      ['schedule.rotation: rotation must contain no more than 14 elements'],
    ],
    [
      'a rotation sent with a weekdays schedule',
      {
        type: 'weekdays',
        days: [{ weekday: 1, workoutIndex: 0 }],
        rotation: [0],
      },
      [
        "schedule.rotation: rotation is only allowed when type is 'times_per_week'",
      ],
    ],
  ])('refuses %s', async (_label, schedule, expected) => {
    expect(
      await check(CreateAssignedProgramDto, { ...valid, schedule }, true),
    ).toEqual(expected)
  })

  // @ValidateNested alone would let a missing schedule through: it checks
  // an object's contents, and there's no object. @IsDefined is what refuses.
  it('refuses a program without a schedule', async () => {
    const { schedule: _schedule, ...withoutSchedule } = valid
    expect(await check(CreateAssignedProgramDto, withoutSchedule)).toEqual([
      'schedule: schedule should not be null or undefined',
    ])
  })

  // Proves the nested schedule — and each day inside it — is really
  // validated (@Type builds a NewProgramScheduleDto, then each day a
  // NewScheduleDayDto, whose decorators then run), with its path.
  it("checks the schedule's own rules, reported under schedule.", async () => {
    expect(
      await check(CreateAssignedProgramDto, {
        ...valid,
        schedule: { type: 'weekdays', days: [{ weekday: 9, workoutIndex: 0 }] },
      }),
    ).toEqual(['schedule.days.0.weekday: weekday must not be greater than 7'])
  })

  it.each([
    ['startDate', { startDate: '2026-10-09T08:00:00Z' }],
    ['endDate', { endDate: '2026-10-09T08:00:00Z' }],
  ])('refuses a timestamp as %s', async (field, change) => {
    expect(
      await check(CreateAssignedProgramDto, { ...valid, ...change }),
    ).toEqual([`${field}: ${field} must be a date written as YYYY-MM-DD`])
  })

  // "Assign again": a program id. (One source at a time is the service's
  // rule — it needs both fields' values together.)
  it('accepts basedOnProgramId as a whole number, nothing else', async () => {
    const { basedOnTemplateId: _template, ...withoutTemplate } = valid
    expect(
      await check(CreateAssignedProgramDto, {
        ...withoutTemplate,
        basedOnProgramId: 12,
      }),
    ).toEqual([])
    expect(
      await check(CreateAssignedProgramDto, {
        ...withoutTemplate,
        basedOnProgramId: '12',
      }),
    ).toEqual(['basedOnProgramId: basedOnProgramId must be an integer number'])
  })
})

describe('UpdateAssignedProgramDto', () => {
  // NOT NULL columns: an explicit null must be a 400 here, not a 500 from
  // the database (the null trap — is-present.ts).
  it.each([
    ['title', 'title: title must be a string'],
    ['startDate', 'startDate: startDate must be a date written as YYYY-MM-DD'],
    ['allowSwaps', 'allowSwaps: allowSwaps must be a boolean value'],
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

  // Step 2b-iii: the status changes only through …/cancel and …/complete,
  // so a PATCH carrying one is refused (with the app's whitelist on), not
  // silently applied — an old client fails loudly.
  it('refuses a status', async () => {
    expect(
      await check(UpdateAssignedProgramDto, { status: 'completed' }, true),
    ).toEqual(['status: property status should not exist'])
  })

  it.each([true, false])('accepts allowSwaps %p', async (allowSwaps) => {
    expect(await check(UpdateAssignedProgramDto, { allowSwaps })).toEqual([])
  })

  // "false" as a string is truthy — never read as a boolean.
  it('refuses allowSwaps as a string', async () => {
    expect(
      await check(UpdateAssignedProgramDto, { allowSwaps: 'false' }),
    ).toEqual(['allowSwaps: allowSwaps must be a boolean value'])
  })
})

describe('CloseAssignedProgramDto', () => {
  it('accepts a calendar date', async () => {
    expect(
      await check(CloseAssignedProgramDto, { today: '2026-10-11' }),
    ).toEqual([])
  })

  // Required: a server-side default would be UTC's day, wrong for half the
  // world every evening.
  it.each([
    ['nothing', {}],
    ['a timestamp', { today: '2026-10-11T08:00:00Z' }],
  ])('refuses %s', async (_label, body) => {
    expect(await check(CloseAssignedProgramDto, body)).toEqual([
      'today: today must be a date written as YYYY-MM-DD',
    ])
  })
})
