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

import { ValidateBy, type ValidationArguments } from 'class-validator'
import { AMENDMENT_REASON_MAX_LENGTH } from '../../database/schema/medical-files.schema'

// --- THE RULE ----------------------------------------------------------------------------------------------

// An AMENDMENT's reason (append-only records: a correction is a new version
// pointing at the old one, with why). Written once for the two records that
// are amended this way — medical file entries (Phase 6) and range-of-motion
// assessments (Phase 7) — so the rule can't differ between them. Moved here
// from the medical file's DTO on 2026-10-31, unchanged.
//
// The reason depends on ANOTHER field (amendsId), which the built-in
// decorators can't express — each looks at one value. A custom rule receives
// the whole object (`args.object`), so it can compare the two. It is applied
// WITHOUT @IsOptional(), so it also runs when the reason is missing — that's
// how "an amendment needs a reason" is caught. The checks, in order (the
// first that fails names the message):
//   - not an amendment (amendsId absent or null): the reason must be absent;
//   - an amendment: a string, visible, at most AMENDMENT_REASON_MAX_LENGTH.
// Each table's CHECK (`…_amendment_reason_valid`) holds the same rule.

// The four sentences — only the first names the record ("an entry",
// "an assessment").
export interface AmendmentReasonMessages {
  withoutAmendment: string
  needsReason: string
  blank: string
  tooLong: string
}

// The three sentences every amended record shares, and the one that differs.
export function amendmentReasonMessages(
  record: string,
): AmendmentReasonMessages {
  return {
    withoutAmendment: `Only an amendment (${record} with amendsId) has an amendment reason`,
    needsReason: 'An amendment needs a reason',
    blank: "The amendment reason can't be blank",
    tooLong: `The amendment reason can be at most ${AMENDMENT_REASON_MAX_LENGTH} characters`,
  }
}

// Pure, for the decorator and the tests: the problem, or null.
export function amendmentReasonProblem(
  amendsId: unknown,
  value: unknown,
  messages: AmendmentReasonMessages,
): string | null {
  const amending = amendsId !== undefined && amendsId !== null
  if (!amending) {
    return value === undefined || value === null
      ? null
      : messages.withoutAmendment
  }
  if (typeof value !== 'string') return messages.needsReason
  if (!/\S/.test(value)) return messages.blank
  if (value.length > AMENDMENT_REASON_MAX_LENGTH) return messages.tooLong
  return null
}

// --- DECORATOR ---------------------------------------------------------------------------------------------

// ValidateBy builds a decorator from a function (the IsCalendarDate idiom).
// Both callbacks receive the ValidationArguments, whose `object` is the
// whole DTO — that is where amendsId is read. (class-validator always passes
// them; its interface marks them optional, and a method's parameters may be
// declared stricter than that.)
export function IsAmendmentReason(
  messages: AmendmentReasonMessages,
): PropertyDecorator {
  const problem = (args: ValidationArguments) =>
    amendmentReasonProblem(
      (args.object as { amendsId?: unknown }).amendsId,
      args.value,
      messages,
    )
  return ValidateBy({
    name: 'amendmentReason',
    validator: {
      validate: (_value: unknown, args: ValidationArguments) =>
        problem(args) === null,
      defaultMessage: (args: ValidationArguments) => problem(args) ?? '',
    },
  })
}
