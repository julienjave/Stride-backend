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

// A legal disclosure's SCOPE (decisions §25, pass 3): the patient's record,
// as loaded, narrowed to what the order covers — the parts chosen and the
// period. Minimum necessary, applied to data: what isn't in scope never
// reaches the document, and so never reaches the copy's audit entry either
// (its ids are read from the narrowed record — records-export.service.ts).
//
// PURE, like record-content.ts: plain data in, plain data out, tested without
// a database. Each part is filtered by ITS OWN date (the person's choice):
//   - a medical file entry by the day it was written;
//   - a session by its day;
//   - a message by the day it was sent;
//   - a program if its dates overlap the period.
// "The day" of a moment is read in the copy's time zone (dayOf).

// --- IMPORTS -----------------------------------------------------------------------------------------------

import {
  dayInPeriod,
  dayOf,
  datesOverlapPeriod,
  type DisclosurePart,
  type DisclosurePeriod,
} from '../legal-disclosures/legal-disclosure-rules'
import type { RecordData, RecordProgram } from './record-content'

// --- SCOPE -------------------------------------------------------------------------------------------------

export interface RecordScope {
  parts: readonly DisclosurePart[]
  period: DisclosurePeriod
}

export function scopeRecord(
  record: RecordData,
  scope: RecordScope,
  timeZone: string,
): RecordData {
  const parts = new Set(scope.parts)
  const inPeriod = (moment: Date) =>
    dayInPeriod(dayOf(moment, timeZone), scope.period)

  return {
    patient: record.patient,
    madeAt: record.madeAt,
    // Each VERSION of a note on its own: an amendment written in the period
    // is in, the version it replaced only if it was written in the period too
    // (the document says when a version here was corrected later).
    medicalFile: parts.has('medical_file')
      ? record.medicalFile.filter((entry) => inPeriod(entry.createdAt))
      : [],
    programs: scopePrograms(
      record.programs,
      parts.has('programs'),
      parts.has('sessions'),
      scope.period,
    ),
    // Present only when the order covers messages — absent, the document
    // has no messages part at all. A conversation with nothing in the period
    // is left out rather than shown empty.
    ...(parts.has('messages')
      ? {
          conversations: (record.conversations ?? [])
            .map((conversation) => ({
              ...conversation,
              messages: conversation.messages.filter((message) =>
                inPeriod(message.sentAt),
              ),
            }))
            .filter((conversation) => conversation.messages.length > 0),
        }
      : {}),
    // Never in a disclosed copy: the patient's accounting lists OTHER
    // disclosures, which no order covers. (`disclosures` is left out — its
    // absence is what tells the document not to print it.)
  }
}

// The programs a disclosure holds, each with the sessions it holds:
//   - with "programs": every program whose dates overlap the period;
//   - with "sessions": every program with a session in the period, with
//     those sessions (a program is the sessions' context: its heading says
//     what they were part of);
//   - with both: either — the overlap, with its sessions of the period.
// The workouts stay on every program kept: a session names its workout
// ("Workout A · Mobility"), and the document prints the prescription only
// when "programs" is included.
function scopePrograms(
  programs: RecordProgram[],
  withPrograms: boolean,
  withSessions: boolean,
  period: DisclosurePeriod,
): RecordProgram[] {
  const kept: RecordProgram[] = []
  for (const program of programs) {
    const sessions = withSessions
      ? program.sessions.filter((session) =>
          dayInPeriod(session.localDate, period),
        )
      : []
    const overlaps =
      withPrograms &&
      datesOverlapPeriod(program.startDate, program.endDate, period)
    if (overlaps || sessions.length > 0) kept.push({ ...program, sessions })
  }
  return kept
}
