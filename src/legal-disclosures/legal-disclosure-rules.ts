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

// The legal disclosure's PURE rules and words (decisions §25, pass 3): which
// parts a disclosure can hold, how a legal basis is said, which dates fall in
// its period. Plain data in, plain data out — shared by the routes
// (legal-disclosures.service.ts) and the document (records-export/
// record-content.ts), and tested without a database.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import type { LegalBasis } from '../database/schema'

// --- PARTS -------------------------------------------------------------------------------------------------

// What a disclosure can hold, in the order the document and every list show
// them. `messages` exists ONLY here in the whole app: the patient's own copy
// and a complaint review's never hold messages (decisions §25).
export const DISCLOSURE_PARTS = [
  'medical_file',
  'programs',
  'sessions',
  'messages',
] as const
export type DisclosurePart = (typeof DISCLOSURE_PARTS)[number]

// The parts as the database stores them (one boolean column each) …
export interface DisclosurePartFlags {
  includesMedicalFile: boolean
  includesPrograms: boolean
  includesSessions: boolean
  includesMessages: boolean
}

// … and back and forth. The API speaks in a list (`['medical_file',
// 'messages']`) — easy to send, easy to read — always answered in
// DISCLOSURE_PARTS' order, whatever order was sent.
export function partFlags(
  parts: readonly DisclosurePart[],
): DisclosurePartFlags {
  return {
    includesMedicalFile: parts.includes('medical_file'),
    includesPrograms: parts.includes('programs'),
    includesSessions: parts.includes('sessions'),
    includesMessages: parts.includes('messages'),
  }
}

export function partsFromFlags(flags: DisclosurePartFlags): DisclosurePart[] {
  const included: Record<DisclosurePart, boolean> = {
    medical_file: flags.includesMedicalFile,
    programs: flags.includesPrograms,
    sessions: flags.includesSessions,
    messages: flags.includesMessages,
  }
  return DISCLOSURE_PARTS.filter((part) => included[part])
}

// --- THE PERIOD --------------------------------------------------------------------------------------------

// The days an order covers, each side optional (null: no limit on that
// side). Days are 'YYYY-MM-DD' strings — and strings of that shape compare in
// calendar order, so `<=` on them is a date comparison.
export interface DisclosurePeriod {
  from: string | null
  to: string | null
}

// Is `day` in the period (both ends included)?
export function dayInPeriod(day: string, period: DisclosurePeriod): boolean {
  return (
    (period.from === null || period.from <= day) &&
    (period.to === null || day <= period.to)
  )
}

// Do a program's dates overlap the period? A program runs from its first
// day to its last (null: no end yet). Two ranges overlap when each starts
// before the other ends.
export function datesOverlapPeriod(
  startDate: string,
  endDate: string | null,
  period: DisclosurePeriod,
): boolean {
  return (
    (period.to === null || startDate <= period.to) &&
    (period.from === null || endDate === null || period.from <= endDate)
  )
}

// The DAY a moment falls on in a time zone, as 'YYYY-MM-DD' ('en-CA' writes
// dates in that shape). A note written at 23:30 in Montreal on March 31 is a
// March 31 note there, and an April 1 one in Paris: the period is read in the
// zone the copy is made in — the admin's — and the document says which.
export function dayOf(moment: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(moment)
}

// --- WORDS -------------------------------------------------------------------------------------------------

// The legal basis as a heading of the patient's accounting says it ("Why")
// and the admin's list shows it: a short noun phrase, capitalised.
export const LEGAL_BASIS_LABELS: Record<LegalBasis, string> = {
  court_order: 'A court order',
  subpoena: 'A subpoena, with the assurances the law requires',
  required_by_law: 'Required by law',
  law_enforcement: 'A request from law enforcement',
  health_oversight:
    'A health oversight agency (an inspection or licensing body)',
  coroner: 'A coroner or medical examiner',
  other: 'Another legal basis',
}

// The same, inside a sentence — the stamp on every page: "Disclosed to …
// under a court order on …". Shorter: a stamp is one line.
export const LEGAL_BASIS_IN_SENTENCE: Record<LegalBasis, string> = {
  court_order: 'a court order',
  subpoena: 'a subpoena',
  required_by_law: 'a legal requirement',
  law_enforcement: 'a law enforcement request',
  health_oversight: 'a health oversight request',
  coroner: "a coroner's request",
  other: 'another legal basis',
}

// "A court order" — or, for "other", the explanation the admin wrote
// ("Another legal basis: …"), which is the only thing that says why.
export function legalBasisText(
  basis: LegalBasis,
  explanation: string | null,
): string {
  return basis === 'other' && explanation !== null
    ? `${LEGAL_BASIS_LABELS.other}: ${explanation}`
    : LEGAL_BASIS_LABELS[basis]
}

const PART_WORDS: Record<DisclosurePart, string> = {
  medical_file: 'medical file',
  programs: 'exercise programs',
  sessions: 'sessions',
  messages: 'messages',
}

// "Medical file, sessions and messages" — the parts in their fixed order, as
// a phrase with its first letter capitalised.
export function partsText(parts: readonly DisclosurePart[]): string {
  const words = DISCLOSURE_PARTS.filter((part) => parts.includes(part)).map(
    (part) => PART_WORDS[part],
  )
  const phrase =
    words.length <= 1
      ? (words[0] ?? '')
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

// The parts NOT included, for the copy's "Not included:" line — lower case,
// joined the same way; null when everything was included.
export function missingPartsText(
  parts: readonly DisclosurePart[],
): string | null {
  const missing = DISCLOSURE_PARTS.filter((part) => !parts.includes(part))
  return missing.length === 0 ? null : partsText(missing).toLowerCase()
}

// "March 1, 2026 to April 30, 2026", "from March 1, 2026", "up to April 30,
// 2026", or "all dates" — the period, given a way to write one day.
export function periodText(
  period: DisclosurePeriod,
  dayText: (day: string) => string,
): string {
  const { from, to } = period
  if (from !== null && to !== null) {
    return from === to ? dayText(from) : `${dayText(from)} to ${dayText(to)}`
  }
  if (from !== null) return `from ${dayText(from)}`
  if (to !== null) return `up to ${dayText(to)}`
  return 'all dates'
}

// --- THE REQUEST'S RULES -----------------------------------------------------------------------------------

// What the DTO can't check field by field: rules BETWEEN fields, and against
// today. One pure function, so each rule is tested on its own; the service
// answers its sentence as a 400.
export const EXPLANATION_REQUIRED_MESSAGE =
  'Explain the legal basis when it is "other"'
export const EXPLANATION_ONLY_WITH_OTHER_MESSAGE =
  'Only the legal basis "other" has an explanation — the others say it themselves'
export const RECEIVED_IN_FUTURE_MESSAGE =
  "The request can't have been received after today"
export const PERIOD_ORDER_MESSAGE =
  'The period must start on or before its last day'
export const STATEMENT_REQUIRED_MESSAGE =
  "Holding a disclosure back needs the agency's statement asking for it"
export const STATEMENT_ONLY_WITH_HOLD_MESSAGE =
  "Only a disclosure held back has the agency's statement — give the date it ends, or leave the statement out"
export const HOLD_IN_FUTURE_MESSAGE =
  'A disclosure can only be held back until a day after today'

export interface DisclosureRequestDates {
  legalBasis: LegalBasis
  basisExplanation: string | null
  receivedOn: string
  periodFrom: string | null
  periodTo: string | null
  withheldUntil: string | null
  withholdingStatement: string | null
}

// The first rule the request breaks, or null when it breaks none. `today` is
// the day in the admin's zone (the zone the copy is made in): "received
// after today" and "held until a day after today" are about THEIR calendar.
export function disclosureRequestRefusal(
  request: DisclosureRequestDates,
  today: string,
): string | null {
  const isOther = request.legalBasis === 'other'
  if (isOther && request.basisExplanation === null) {
    return EXPLANATION_REQUIRED_MESSAGE
  }
  if (!isOther && request.basisExplanation !== null) {
    return EXPLANATION_ONLY_WITH_OTHER_MESSAGE
  }
  if (request.receivedOn > today) return RECEIVED_IN_FUTURE_MESSAGE
  if (
    request.periodFrom !== null &&
    request.periodTo !== null &&
    request.periodFrom > request.periodTo
  ) {
    return PERIOD_ORDER_MESSAGE
  }
  if (request.withheldUntil !== null && request.withholdingStatement === null) {
    return STATEMENT_REQUIRED_MESSAGE
  }
  if (request.withheldUntil === null && request.withholdingStatement !== null) {
    return STATEMENT_ONLY_WITH_HOLD_MESSAGE
  }
  if (request.withheldUntil !== null && request.withheldUntil <= today) {
    return HOLD_IN_FUTURE_MESSAGE
  }
  return null
}
