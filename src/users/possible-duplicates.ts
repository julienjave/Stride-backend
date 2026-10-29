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

// "Is this new patient someone Stride already has?" (decisions §27, pass 2)
//
// The only thing that makes an account unique is its email, so the same
// person invited twice under two addresses becomes two accounts — and their
// record splits in two. Hospitals catch this with a Master Patient Index:
// patients matched on demographic data, a human deciding. Stride does the
// smallest useful version: when a patient is created, look for an existing
// patient with the SAME date of birth and the SAME name — and warn, never
// refuse (two real people can share both).
//
// Pure functions here; UsersService runs the query and decides what each
// role may be told (src/users/users.service.ts, possibleDuplicateRefusal).

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { ConflictException } from '@nestjs/common'

// --- THE RULE ----------------------------------------------------------------------------------------------

// A name as the comparison sees it. Typed by different people, on different
// days, the same name comes out differently: "Zoë" and "Zoe", "JEAN-LUC"
// and "Jean Luc", "O'Brien" and "OBrien", " Marie  " and "Marie". Step by
// step:
//   1. lower case (first: some capitals lower to a letter + a mark, which
//      step 3 then removes — "İ" becomes "i" + a dot above);
//   2. a few letters that are NOT "a letter + an accent" in Unicode, and so
//      survive step 3, written out the way people type them without the key
//      ("ß" → "ss", "æ" → "ae"…);
//   3. NFKD splits every accented letter into its base letter and a separate
//      combining mark ("é" → "e" + "´");
//   4. anything that is neither a letter nor a digit is removed — the marks
//      step 3 split off (a combining mark is neither), and spaces, hyphens,
//      apostrophes, dots — so "Zoë" reads "zoe", and "Jean-Luc", "Jean Luc"
//      and "JeanLuc" agree.
// Unicode property escapes (\p{…}) need the `u` flag; with it, the pattern
// understands letters of every script, not only A–Z.
//
// One normaliser, in one place, unit-tested: the database only narrows the
// candidates by date of birth (an exact `date` comparison), and the names
// are compared here.
const WRITTEN_OUT: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
}

export function identityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (letter) => WRITTEN_OUT[letter])
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

export interface PersonName {
  firstName: string
  lastName: string
}

// The same person, by name: both names equal once normalised — or SWAPPED
// (first and last typed in each other's fields, a common slip; with the date
// of birth equal too, a swap is far more likely a slip than a coincidence).
export function sameName(a: PersonName, b: PersonName): boolean {
  const [aFirst, aLast] = [identityName(a.firstName), identityName(a.lastName)]
  const [bFirst, bLast] = [identityName(b.firstName), identityName(b.lastName)]
  // A name with no letter or digit at all ("—", an emoji) normalises to "":
  // two such names would be "equal" without saying anything about the
  // person. No warning rather than a false one.
  if (!aFirst || !aLast) return false
  const same = aFirst === bFirst && aLast === bLast
  const swapped = aFirst === bLast && aLast === bFirst
  return same || swapped
}

// --- THE ANSWER --------------------------------------------------------------------------------------------

export const POSSIBLE_DUPLICATE_REASON = 'possible_duplicate'

export const POSSIBLE_DUPLICATE_MESSAGE =
  'A patient with this name and date of birth may already be in Stride.'

// The 409 a creation answers when it found a possible duplicate and wasn't
// told to go ahead (`allowPossibleDuplicate`). 409 Conflict: the request is
// well-formed (not a 400) and the patient doesn't exist yet (not a 404) — it
// conflicts with what the server already holds. `reason` lets the screen
// tell it apart from the other 409 of the same route (an email already
// taken); the rest of the body is what this requester may be shown —
// UsersService decides that per role.
export function possibleDuplicateConflict(
  shown: Record<string, unknown>,
): ConflictException {
  return new ConflictException({
    message: POSSIBLE_DUPLICATE_MESSAGE,
    reason: POSSIBLE_DUPLICATE_REASON,
    ...shown,
  })
}
