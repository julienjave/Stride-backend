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

import {
  ALERT_THRESHOLDS,
  attendanceFacts,
  attendanceKeys,
  isAttendanceReviewed,
  isJoinNoticeFor,
  joinNoticeCutoff,
  inactivity,
  isLongRun,
  isRunning,
  missedRun,
  reviewWindowStart,
  sessionReview,
  type ReviewableSession,
} from './alert-rules'
import type {
  DayState,
  WeekState,
} from '../assigned-programs/schedule/schedule-summary'

// The To-do's rules (decided 2026-10-19). Pure, so every case is a plain
// table; dates far from today (2031) so no test depends on when it runs.
// Each threshold is tested on BOTH sides of its boundary, and the fixtures
// separating two rules make them DISAGREE (a fixture where both rules give
// the same answer can't tell which one the code uses).

const day = (date: string, state: DayState) => ({ date, state })
const week = (start: string, end: string, state: WeekState) => ({
  start,
  end,
  state,
})

describe('missedRun', () => {
  it('finds no run without judged outcomes', () => {
    expect(missedRun([], [])).toBeNull()
    expect(
      missedRun(
        [day('2031-06-02', 'due'), day('2031-06-04', 'upcoming')],
        [week('2031-06-02', '2031-06-08', 'in_progress')],
      ),
    ).toBeNull()
  })

  it('counts the misses at the END of the history, back to the first that is not one', () => {
    // An older, longer run (three misses) is history: the latest run is two.
    const days = [
      day('2031-06-02', 'missed'),
      day('2031-06-04', 'missed'),
      day('2031-06-06', 'missed'),
      day('2031-06-09', 'done'),
      day('2031-06-11', 'missed'),
      day('2031-06-13', 'missed'),
    ]
    expect(missedRun(days, [])).toStrictEqual({
      days: 2,
      weeks: 0,
      since: '2031-06-11',
    })
  })

  it('reads the days in date order, whatever order they come in', () => {
    const days = [
      day('2031-06-13', 'missed'),
      day('2031-06-09', 'done'),
      day('2031-06-11', 'missed'),
    ]
    expect(missedRun(days, [])).toStrictEqual({
      days: 2,
      weeks: 0,
      since: '2031-06-11',
    })
  })

  it('skips days not judged yet: neither a miss nor a break', () => {
    const days = [
      day('2031-06-06', 'done'),
      day('2031-06-09', 'missed'),
      day('2031-06-11', 'missed'),
      day('2031-06-13', 'missed'),
      day('2031-06-16', 'due'),
      day('2031-06-18', 'upcoming'),
    ]
    expect(missedRun(days, [])).toStrictEqual({
      days: 3,
      weeks: 0,
      since: '2031-06-09',
    })
  })

  it.each<DayState>([
    'done',
    'made_up',
    'made_up_late',
    'done_early',
    'swapped',
  ])('ends the run at a day %s', (state) => {
    const days = [
      day('2031-06-09', 'missed'),
      day('2031-06-11', state),
      day('2031-06-13', 'missed'),
    ]
    expect(missedRun(days, [])).toStrictEqual({
      days: 1,
      weeks: 0,
      since: '2031-06-13',
    })
  })

  it('counts weeks missed in a row; a week met ends the run; weeks under way are skipped', () => {
    const weeks = [
      week('2031-06-02', '2031-06-08', 'missed'),
      week('2031-06-09', '2031-06-15', 'met'),
      week('2031-06-16', '2031-06-22', 'missed'),
      week('2031-06-23', '2031-06-29', 'missed'),
      week('2031-06-30', '2031-07-06', 'in_progress'),
      week('2031-07-07', '2031-07-13', 'upcoming'),
    ]
    expect(missedRun([], weeks)).toStrictEqual({
      days: 0,
      weeks: 2,
      since: '2031-06-16',
    })
  })

  // Across a change of schedule type: days then weeks on ONE time line,
  // ordered by the day each ENDS. The week below starts BEFORE the done day
  // but ends after it: by its end it is the latest outcome (a run of one
  // week); ordered by its start, the done day would be latest (no run).
  it('orders days and weeks by the day each ends', () => {
    const days = [day('2031-06-02', 'missed'), day('2031-06-04', 'done')]
    const weeks = [week('2031-06-03', '2031-06-09', 'missed')]
    expect(missedRun(days, weeks)).toStrictEqual({
      days: 0,
      weeks: 1,
      since: '2031-06-03',
    })
  })

  it('counts a run that spans both kinds', () => {
    const days = [day('2031-06-02', 'missed'), day('2031-06-04', 'missed')]
    const weeks = [week('2031-06-05', '2031-06-11', 'missed')]
    expect(missedRun(days, weeks)).toStrictEqual({
      days: 2,
      weeks: 1,
      since: '2031-06-02',
    })
  })
})

describe('isLongRun', () => {
  it.each([
    [null, false],
    [{ days: 2, weeks: 0, since: '2031-06-02' }, false],
    [{ days: 3, weeks: 0, since: '2031-06-02' }, true],
    [{ days: 0, weeks: 1, since: '2031-06-02' }, false],
    [{ days: 0, weeks: 2, since: '2031-06-02' }, true],
    // A mixed run reaching neither threshold is not a to-do.
    [{ days: 2, weeks: 1, since: '2031-06-02' }, false],
  ])('judges %j long: %s', (run, expected) => {
    expect(isLongRun(run)).toBe(expected)
  })

  it('uses the agreed thresholds', () => {
    expect(ALERT_THRESHOLDS).toStrictEqual({
      missedDaysInARow: 3,
      missedWeeksInARow: 2,
      inactiveDays: 7,
      painAfterHigh: 7,
      painRise: 3,
      hardExercise: 8,
      reviewWindowDays: 14,
      attendanceReminderDays: 14,
    })
  })
})

describe('inactivity', () => {
  const base = {
    startDate: '2031-06-02',
    endDate: null,
    today: '2031-06-12',
    pauses: [],
  }

  it('counts from the start date up to yesterday when there was no session', () => {
    expect(inactivity({ ...base, sessionDates: [] })).toStrictEqual({
      // June 2 to June 11.
      days: 10,
      lastSessionDate: null,
    })
  })

  it('counts from the day after the LATEST session, whatever order the dates come in', () => {
    expect(
      inactivity({
        ...base,
        sessionDates: ['2031-06-03', '2031-06-05', '2031-06-04'],
      }),
    ).toStrictEqual({ days: 6, lastSessionDate: '2031-06-05' })
  })

  it("doesn't count today: a session yesterday leaves nothing to count", () => {
    expect(inactivity({ ...base, sessionDates: ['2031-06-11'] })).toStrictEqual(
      { days: 0, lastSessionDate: '2031-06-11' },
    )
  })

  it('stops at the end date when it comes before yesterday', () => {
    expect(
      inactivity({ ...base, endDate: '2031-06-08', sessionDates: [] }),
    ).toStrictEqual({ days: 7, lastSessionDate: null })
  })

  it('leaves paused days out, an open-ended pause included', () => {
    expect(
      inactivity({
        ...base,
        pauses: [{ from: '2031-06-04', to: '2031-06-05' }],
        sessionDates: [],
      }),
    ).toStrictEqual({ days: 8, lastSessionDate: null })
    expect(
      inactivity({
        ...base,
        pauses: [{ from: '2031-06-09', to: null }],
        sessionDates: [],
      }),
    ).toStrictEqual({ days: 7, lastSessionDate: null })
  })

  it('never counts days before the start date', () => {
    expect(inactivity({ ...base, sessionDates: ['2031-05-20'] })).toStrictEqual(
      { days: 10, lastSessionDate: '2031-05-20' },
    )
  })
})

describe('isRunning', () => {
  const base = {
    startDate: '2031-06-02',
    endDate: '2031-06-20',
    pauses: [],
  }
  it.each([
    ['before the start', { today: '2031-06-01' }, false],
    ['on the start date', { today: '2031-06-02' }, true],
    ['on the end date', { today: '2031-06-20' }, true],
    ['after the end date', { today: '2031-06-21' }, false],
    [
      'while paused',
      {
        today: '2031-06-10',
        pauses: [{ from: '2031-06-10', to: '2031-06-12' }],
      },
      false,
    ],
    [
      'on the last day of a pause',
      {
        today: '2031-06-12',
        pauses: [{ from: '2031-06-10', to: '2031-06-12' }],
      },
      false,
    ],
    [
      'the day after a pause',
      {
        today: '2031-06-13',
        pauses: [{ from: '2031-06-10', to: '2031-06-12' }],
      },
      true,
    ],
    [
      'during an open-ended pause',
      { today: '2031-06-15', pauses: [{ from: '2031-06-10', to: null }] },
      false,
    ],
  ])('is %s: %s', (_when, change, expected) => {
    expect(isRunning({ ...base, ...change })).toBe(expected)
  })

  it('runs with no end date', () => {
    expect(isRunning({ ...base, endDate: null, today: '2031-09-01' })).toBe(
      true,
    )
  })
})

describe('attendanceFacts', () => {
  // June 2 to 13, Mon / Wed / Fri; today June 16.
  const base = {
    startDate: '2031-06-02',
    endDate: null,
    today: '2031-06-16',
    pauses: [],
    weeks: [],
  }
  const threeMissed = [
    day('2031-06-02', 'done'),
    day('2031-06-09', 'missed'),
    day('2031-06-11', 'missed'),
    day('2031-06-13', 'missed'),
  ]

  it('reports a long run alone when the patient still came (a skip is activity)', () => {
    expect(
      attendanceFacts({
        ...base,
        days: threeMissed,
        sessionDates: ['2031-06-02', '2031-06-13'],
      }),
    ).toStrictEqual({
      missedInARow: { days: 3, weeks: 0, since: '2031-06-09' },
      inactive: null,
    })
  })

  it('reports inactivity alone when nothing was missed in a row', () => {
    expect(
      attendanceFacts({
        ...base,
        days: [day('2031-06-06', 'done'), day('2031-06-13', 'missed')],
        sessionDates: ['2031-06-06'],
      }),
    ).toStrictEqual({
      missedInARow: null,
      inactive: { days: 9, lastSessionDate: '2031-06-06' },
    })
  })

  it('reports both together', () => {
    expect(
      attendanceFacts({
        ...base,
        days: threeMissed,
        sessionDates: ['2031-06-02'],
      }),
    ).toStrictEqual({
      missedInARow: { days: 3, weeks: 0, since: '2031-06-09' },
      inactive: { days: 13, lastSessionDate: '2031-06-02' },
    })
  })

  // Today June 16; the days counted run from the day after the last
  // session to June 15 (yesterday).
  it('stays quiet one day short of each threshold', () => {
    expect(
      attendanceFacts({
        ...base,
        // Two scheduled days missed in a row — one short of three.
        days: threeMissed.slice(0, 3),
        // June 10 to 15: six days without a session — one short of seven.
        sessionDates: ['2031-06-09'],
      }),
    ).toBeNull()
  })

  it('reports inactivity from exactly seven days', () => {
    expect(
      attendanceFacts({
        ...base,
        days: [],
        // June 9 to 15: seven days.
        sessionDates: ['2031-06-08'],
      }),
    ).toStrictEqual({
      missedInARow: null,
      inactive: { days: 7, lastSessionDate: '2031-06-08' },
    })
  })

  it('says nothing about a program that is not running, however behind', () => {
    expect(
      attendanceFacts({
        ...base,
        pauses: [{ from: '2031-06-16', to: null }],
        days: threeMissed,
        sessionDates: [],
      }),
    ).toBeNull()
  })
})

describe('sessionReview', () => {
  const quiet: ReviewableSession = {
    status: 'completed',
    endReason: null,
    painBefore: 4,
    painAfter: 3,
    sessionFeedback: null,
    endNote: null,
    exercises: [
      { name: 'Heel Slides', difficultyRating: 5, feedback: null },
      { name: 'Squat', difficultyRating: null, feedback: null },
    ],
  }

  it('finds nothing to review in a quiet session', () => {
    expect(sessionReview(quiet)).toBeNull()
  })

  it('never lists a session in progress, whatever it holds', () => {
    expect(
      sessionReview({
        ...quiet,
        status: 'in_progress',
        painAfter: null,
        painBefore: 9,
        sessionFeedback: 'Ouch',
        exercises: [{ name: 'Squat', difficultyRating: 10, feedback: 'Hard' }],
      }),
    ).toBeNull()
  })

  it.each([
    ['incomplete', 'pain', ['ended_for_pain']],
    ['skipped', 'pain', ['ended_for_pain']],
    ['incomplete', 'illness', null],
    ['skipped', 'no_time', null],
  ] as const)('a session %s for %s gives %j', (status, endReason, reasons) => {
    const review = sessionReview({
      ...quiet,
      status,
      endReason,
      painBefore: null,
      painAfter: null,
    })
    expect(review?.reasons ?? null).toStrictEqual(reasons)
  })

  // High pain and a rise disagree in these fixtures: 6 → 7 is high but
  // rises by 1; 1 → 4 rises by 3 but stays low.
  it.each([
    [6, 6, null],
    [6, 7, ['pain_high']],
    [null, 7, ['pain_high']],
    [1, 3, null],
    [1, 4, ['pain_rise']],
    [null, 4, null],
    [4, null, null],
    [4, 8, ['pain_high', 'pain_rise']],
  ])('pain %s → %s gives %j', (painBefore, painAfter, reasons) => {
    const review = sessionReview({ ...quiet, painBefore, painAfter })
    expect(review?.reasons ?? null).toStrictEqual(reasons)
  })

  it('names the exercises rated hard — from 8 — in checklist order', () => {
    expect(
      sessionReview({
        ...quiet,
        exercises: [
          { name: 'Squat', difficultyRating: 9, feedback: null },
          { name: 'Heel Slides', difficultyRating: 7, feedback: null },
          { name: 'Bridge', difficultyRating: 8, feedback: null },
        ],
      }),
    ).toStrictEqual({
      reasons: ['hard_exercise'],
      hardExercises: [
        { name: 'Squat', rating: 9 },
        { name: 'Bridge', rating: 8 },
      ],
    })
  })

  it.each([
    ['the session feedback', { sessionFeedback: 'Felt great' }],
    ['the note given when stopping', { endNote: 'Had to leave' }],
    [
      'a note on an exercise',
      {
        exercises: [{ name: 'Squat', difficultyRating: 3, feedback: 'Easy' }],
      },
    ],
  ])('counts %s as the patient writing something', (_what, change) => {
    expect(sessionReview({ ...quiet, ...change })).toStrictEqual({
      reasons: ['patient_note'],
      hardExercises: [],
    })
  })

  it('lists every reason once, most clinical first', () => {
    expect(
      sessionReview({
        ...quiet,
        status: 'incomplete',
        endReason: 'pain',
        painBefore: 3,
        painAfter: 8,
        endNote: 'Knee gave way',
        exercises: [
          { name: 'Squat', difficultyRating: 10, feedback: 'Too hard' },
          { name: 'Lunge', difficultyRating: 9, feedback: 'Same' },
        ],
      }),
    ).toStrictEqual({
      reasons: [
        'ended_for_pain',
        'pain_high',
        'pain_rise',
        'hard_exercise',
        'patient_note',
      ],
      hardExercises: [
        { name: 'Squat', rating: 10 },
        { name: 'Lunge', rating: 9 },
      ],
    })
  })
})

describe('reviewWindowStart', () => {
  it('opens the window 14 days long, today included', () => {
    expect(reviewWindowStart('2031-06-14')).toBe('2031-06-01')
    expect(reviewWindowStart('2031-03-01')).toBe('2031-02-16')
  })
})

describe('attendanceKeys', () => {
  const run = { days: 3, weeks: 0, since: '2031-06-09' }

  it("takes the run's first missed day, and the first day without a session", () => {
    expect(
      attendanceKeys(
        {
          missedInARow: run,
          inactive: { days: 9, lastSessionDate: '2031-06-05' },
        },
        '2031-06-02',
      ),
    ).toStrictEqual({ missedSince: '2031-06-09', inactiveSince: '2031-06-06' })
  })

  it('starts inactivity on the start date when there was no session', () => {
    expect(
      attendanceKeys(
        { missedInARow: null, inactive: { days: 8, lastSessionDate: null } },
        '2031-06-02',
      ),
    ).toStrictEqual({ missedSince: null, inactiveSince: '2031-06-02' })
  })

  it('never starts inactivity before the start date', () => {
    expect(
      attendanceKeys(
        {
          missedInARow: null,
          inactive: { days: 8, lastSessionDate: '2031-05-20' },
        },
        '2031-06-02',
      ),
    ).toStrictEqual({ missedSince: null, inactiveSince: '2031-06-02' })
  })

  it('gives null for a fact the alert does not have', () => {
    expect(
      attendanceKeys({ missedInARow: run, inactive: null }, '2031-06-02'),
    ).toStrictEqual({ missedSince: '2031-06-09', inactiveSince: null })
  })
})

describe('isAttendanceReviewed', () => {
  // Reviewed on 10 June at 09:00 UTC, seeing a run since 2 June and no
  // session since 3 June.
  const review = {
    missedSince: '2031-06-02',
    inactiveSince: '2031-06-03',
    reviewedAt: new Date('2031-06-10T09:00:00.000Z'),
  }
  const soon = new Date('2031-06-12T09:00:00.000Z')
  const both = { missedSince: '2031-06-02', inactiveSince: '2031-06-03' }

  it('is not reviewed without a review', () => {
    expect(isAttendanceReviewed(both, null, soon)).toBe(false)
  })

  it('stays reviewed while the same facts hold', () => {
    expect(isAttendanceReviewed(both, review, soon)).toBe(true)
  })

  it('stays reviewed when a fact has gone away since', () => {
    expect(
      isAttendanceReviewed(
        { missedSince: '2031-06-02', inactiveSince: null },
        review,
        soon,
      ),
    ).toBe(true)
    expect(
      isAttendanceReviewed(
        { missedSince: null, inactiveSince: '2031-06-03' },
        review,
        soon,
      ),
    ).toBe(true)
  })

  it('comes back for a new start of either fact', () => {
    expect(
      isAttendanceReviewed(
        { missedSince: '2031-06-11', inactiveSince: '2031-06-03' },
        review,
        soon,
      ),
    ).toBe(false)
    expect(
      isAttendanceReviewed(
        { missedSince: '2031-06-02', inactiveSince: '2031-06-11' },
        review,
        soon,
      ),
    ).toBe(false)
  })

  it('comes back for a fact the review did not see', () => {
    const missedOnly = { ...review, inactiveSince: null }
    expect(isAttendanceReviewed(both, missedOnly, soon)).toBe(false)
    const inactiveOnly = { ...review, missedSince: null }
    expect(isAttendanceReviewed(both, inactiveOnly, soon)).toBe(false)
  })

  it('comes back exactly 14 × 24 hours after the review, unchanged or not', () => {
    const justBefore = new Date('2031-06-24T08:59:59.999Z')
    const atTheMoment = new Date('2031-06-24T09:00:00.000Z')
    expect(isAttendanceReviewed(both, review, justBefore)).toBe(true)
    expect(isAttendanceReviewed(both, review, atTheMoment)).toBe(false)
  })
})

describe('joinNoticeCutoff', () => {
  it('is exactly 14 × 24 hours before now — instants, not calendar days', () => {
    // Across the clocks going back in Paris (2031-10-26): 14 days of 24 hours
    // land at the same UTC time of day, whatever the local clock did.
    expect(
      joinNoticeCutoff(new Date('2031-11-03T10:00:00.000Z')),
    ).toStrictEqual(new Date('2031-10-20T10:00:00.000Z'))
  })
})

describe('isJoinNoticeFor', () => {
  // Me = practitioner 10, on the team since June 1st; Sam (20) joins June 10th.
  const ME = 10
  const MY_START = new Date('2031-06-01T09:00:00.000Z')
  const CUTOFF = new Date('2031-06-05T00:00:00.000Z')
  const samJoined = {
    practitionerId: 20,
    createdBy: 20,
    startedAt: new Date('2031-06-10T09:00:00.000Z'),
  }

  it('announces a colleague who joined after me, within the window', () => {
    expect(isJoinNoticeFor(samJoined, ME, MY_START, CUTOFF)).toBe(true)
  })

  it('announces a colleague someone ELSE added (an admin, another colleague)', () => {
    expect(
      isJoinNoticeFor({ ...samJoined, createdBy: 99 }, ME, MY_START, CUTOFF),
    ).toBe(true)
  })

  it("tells nobody who isn't on the team now", () => {
    expect(isJoinNoticeFor(samJoined, ME, undefined, CUTOFF)).toBe(false)
  })

  it('never announces my own link', () => {
    expect(
      isJoinNoticeFor(
        { ...samJoined, practitionerId: ME, createdBy: 99 },
        ME,
        MY_START,
        CUTOFF,
      ),
    ).toBe(false)
  })

  it('never announces a colleague I added myself', () => {
    expect(
      isJoinNoticeFor({ ...samJoined, createdBy: ME }, ME, MY_START, CUTOFF),
    ).toBe(false)
  })

  it('announces nothing for a backfilled link (no creator)', () => {
    expect(
      isJoinNoticeFor({ ...samJoined, createdBy: null }, ME, MY_START, CUTOFF),
    ).toBe(false)
  })

  it('tells a newcomer nothing about members who were there before them', () => {
    // My link starts AFTER Sam's — and one starting at the same instant (one
    // transaction) isn't "after" either.
    expect(
      isJoinNoticeFor(
        samJoined,
        ME,
        new Date('2031-06-11T09:00:00.000Z'),
        CUTOFF,
      ),
    ).toBe(false)
    expect(isJoinNoticeFor(samJoined, ME, samJoined.startedAt, CUTOFF)).toBe(
      false,
    )
  })

  it('keeps a join from exactly the cutoff, drops one a millisecond older', () => {
    const atCutoff = { ...samJoined, startedAt: CUTOFF }
    const justBefore = {
      ...samJoined,
      startedAt: new Date(CUTOFF.getTime() - 1),
    }
    expect(isJoinNoticeFor(atCutoff, ME, MY_START, CUTOFF)).toBe(true)
    expect(isJoinNoticeFor(justBefore, ME, MY_START, CUTOFF)).toBe(false)
  })
})
