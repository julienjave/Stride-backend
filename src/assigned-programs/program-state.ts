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

import { ConflictException } from '@nestjs/common'
import { addDays } from '../common/calendar-date'

// A program's LIFE: active, then completed or cancelled — both FINAL — or
// archived (decisions §5, "Settled 2026-10-11", point 3). The rules as pure
// functions, shared by AssignedProgramsService (every write on a program)
// and SessionsService (starting a session), so "may this program still
// change?" has one answer everywhere.

// --- TYPES -------------------------------------------------------------------------------------------------

export interface ProgramState {
  status: 'active' | 'completed' | 'cancelled'
  isArchived: boolean
}

// --- RULES -------------------------------------------------------------------------------------------------

// Only an ACTIVE, not archived program may change — its prescription, its
// workouts, its schedule, its dates — or get a new session. A completed or
// cancelled program is part of the clinical record, kept read-only (to
// continue it: "Assign again", a new program); an archived one is deleted
// as far as the app is concerned.
//
// 409 Conflict, like every "the request is fine, the program's STATE stands
// in the way" refusal (deleting a workout that has exercises, say).
export function assertProgramOpen(program: ProgramState) {
  if (program.isArchived) {
    throw new ConflictException(
      'This program was deleted, so it can no longer change',
    )
  }
  if (program.status !== 'active') {
    throw new ConflictException(
      `This program is ${program.status}, so it can no longer change. To continue it, assign it again`,
    )
  }
}

// The end date of a program being cancelled or completed EARLY, on `today`
// (the practitioner's date, sent by their app):
//   - YESTERDAY: the decision is taken today, so today mustn't become a day
//     the patient missed;
//   - TODAY if a session was completed today — today was done, and is part
//     of the program;
//   - never AFTER the end it already has (a program closed after its end
//     date keeps it: nothing past it was ever expected);
//   - never BEFORE its start (a program started today and cancelled today
//     ends on its start — the database requires end >= start, and a
//     one-day program is legitimate).
export function closingEndDate(program: {
  startDate: string
  endDate: string | null
  today: string
  completedToday: boolean
}): string {
  let end = program.completedToday ? program.today : addDays(program.today, -1)
  if (program.endDate !== null && program.endDate < end) end = program.endDate
  if (end < program.startDate) end = program.startDate
  return end
}

// What closing the program on `today` WOULD do — cancel or complete — from
// its dates and its session rows. One function for both the real thing
// (AssignedProgramsService.close, under the program's row lock) and the
// preview the confirmation dialog asks for first (GET …/closing), so what
// the dialog promises and what the button does can't disagree.
//   - Cancel with no session at all → archived (no end date: it's gone).
//   - Otherwise → cancelled / completed, ending on closingEndDate().
// "A session" is ANY row, started-and-abandoned included (decided
// 2026-10-11): it records something that happened. "Completed today" looks
// at completed sessions only — an abandoned one doesn't make today a day
// of the program.
export interface ClosingPlan {
  outcome: 'archived' | 'cancelled' | 'completed'
  endDate: string | null
}

export function planClosing(
  action: 'cancel' | 'complete',
  program: { startDate: string; endDate: string | null },
  sessions: { localDate: string; status: string }[],
  today: string,
): ClosingPlan {
  if (action === 'cancel' && sessions.length === 0) {
    return { outcome: 'archived', endDate: null }
  }
  return {
    outcome: action === 'cancel' ? 'cancelled' : 'completed',
    endDate: closingEndDate({
      startDate: program.startDate,
      endDate: program.endDate,
      today,
      completedToday: sessions.some(
        (s) => s.status === 'completed' && s.localDate === today,
      ),
    }),
  }
}