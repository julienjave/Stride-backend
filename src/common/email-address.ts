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
import { Transform } from 'class-transformer'
import { isUniqueViolation, USERS_EMAIL_UNIQUE } from '../database/pg-errors'

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// Emails are case-insensitive since the "Change email" item (Phase 6, pass 1,
// decided with the person 2026-10-22). Before, nothing lowercased an email:
// `Jane@x.com` and `jane@x.com` could be two accounts, and someone who was
// invited as `Jane@x.com` couldn't sign in — nor get a reset link — by typing
// `jane@x.com`.
//
// The person chose to STORE every email in one normalised spelling (rather
// than keep what was typed and compare with lower() in every query): one
// spelling in the database means a plain `email = $1` is right everywhere,
// the UNIQUE constraint on users.email already means "unique ignoring case",
// and no query can forget a lower(). Three pieces make that hold:
//
// - normalizeEmail() below: THE definition of the spelling.
// - @NormalizeEmail(): applies it to every email a request brings in (sign
//   in, forgot password, create a user, set up the first clinic), before
//   validation, so the services only ever see the normalised value.
// - The database's CHECK users_email_normalized (migration 0052): refuses a
//   row whose email isn't in that spelling, whatever wrote it — the app, the
//   seed, a query typed by hand.

// --- NORMALISATION ------------------------------------------------------------------------------------------

// Trims the spaces around the address and lowercases A–Z. Nothing else.
//
// Why only A–Z, not toLowerCase() on the whole string: the database checks
// the same rule (the CHECK above), and the two implementations must agree on
// EVERY input. JavaScript's toLowerCase() follows Unicode everywhere;
// Postgres's lower() follows the database's locale (measured: on a C.UTF-8
// database it lowercases 'É', under COLLATE "C" it doesn't). A server set up
// with another locale would then disagree with the app about which spelling
// is "normal", and an address the app stored could break the CHECK, or one
// the migration lowercased could stop matching what the app looks up. Pinned
// to A–Z on both sides — here a regex, in SQL `lower(email COLLATE "C")` —
// the rule is the same on every server.
//
// What it means for the rare address with accented letters: 'Émile@x.com'
// and 'émile@x.com' stay two different spellings. Email providers treat the
// part before the @ as the provider's business (the standard even allows it
// to be case-sensitive); in practice every provider ignores the case of
// A–Z, which is what this covers.
//
// trim() removes every kind of whitespace at the ends (spaces, tabs, line
// breaks — a pasted address often carries one); the database's btrim()
// checks spaces only. They can't disagree on an address the app accepts:
// @IsEmail() refuses any whitespace left INSIDE, and trim() leaves none at
// the ends.
export function normalizeEmail(email: string): string {
  return email.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

// --- DECORATOR ---------------------------------------------------------------------------------------------

// Put on a DTO's email field. class-transformer runs @Transform while the
// global ValidationPipe turns the request's JSON into the DTO instance
// (`transform: true`, main.ts) — BEFORE class-validator checks it — so:
// - @IsEmail() and @MaxLength() judge the normalised value (an address
//   pasted with a trailing space is accepted, as the person meant it);
// - the controller, the service and the audit entry all receive it.
//
// A value that isn't a string is passed through untouched, so @IsEmail()
// refuses it with its usual message (normalising a number would throw).
export function NormalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  )
}

// --- DUPLICATES ---------------------------------------------------------------------------------------------

export const DUPLICATE_EMAIL_MESSAGE = 'A user with this email already exists'

// Runs a write that inserts a user, and turns the database's refusal of a
// taken email into a 409 — the unique constraint decides, not a check made
// beforehand. Creating an account used to READ first ("is this email
// taken?") and write after: two requests for the same address could both
// read "free", and the second then hit the constraint as a 500. Reading
// first also added nothing the constraint doesn't already say. With the
// email normalised, the constraint is case-insensitive too, so it is the
// one judge.
//
// Any other error (another constraint, a connection failure) is rethrown
// as it was.
export async function translateDuplicateEmail<T>(
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write()
  } catch (error) {
    rethrowDuplicateEmail(error)
  }
}

// The same translation, for a promise's .catch() — registerClinic uses it on
// its transaction, which keeps that long callback where it is. Always
// throws: the 409 for a taken email, otherwise the error it was given.
export function rethrowDuplicateEmail(error: unknown): never {
  if (isUniqueViolation(error, USERS_EMAIL_UNIQUE)) {
    throw new ConflictException(DUPLICATE_EMAIL_MESSAGE)
  }
  throw error
}
