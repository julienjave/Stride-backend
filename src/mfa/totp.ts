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

import { applyDecorators, BadRequestException } from '@nestjs/common'
import { IsString, Matches } from 'class-validator'
import { eq } from 'drizzle-orm'
import { OTP } from 'otplib'
import type { DrizzleDb } from '../database/drizzle.provider'
import { users } from '../database/schema'
import { decryptMfaSecret } from '../auth/mfa-secret-crypto'

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// The one answer to "is this a good two-factor code, right now, for this
// account?" — signing in, turning MFA on, turning it off and the step-up of
// the email and password changes all ask it here, so they can't disagree.
//
// How a TOTP code works (RFC 6238): the authenticator app and the server
// share a secret (the QR code carries it). Both cut time into 30-second
// windows — the "time step", floor(unix seconds / 30) — and compute
// HMAC-SHA1(secret, step), shortened to 6 digits. Same secret, same step →
// same 6 digits, without the phone ever talking to the server. otplib does
// the arithmetic; the server accepts only the CURRENT step (otplib's default
// epochTolerance of 0).
//
// What otplib can't know is HISTORY: a code stays the same for its whole
// window, so a code typed on a sign-in page — seen over a shoulder, or
// relayed by a fake sign-in page — still works for the rest of those 30
// seconds. RFC 6238 §5.2: the verifier "MUST NOT accept the second attempt
// of the OTP after the successful validation has been issued for the first
// OTP". So each account remembers the step of the last code it accepted
// (`users.mfa_last_used_step`), and a code is good only if its step is LATER.
// That check is only safe under the account's row lock (`FOR UPDATE`): two
// requests with the same code at once would otherwise both read "not used
// yet". Every caller locks the row first, then calls in here.

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The refusals, in the words the sign-in page already shows for a wrong code.
export const INVALID_MFA_CODE_MESSAGE = 'Invalid authentication code'
// A right code used a second time. Said apart from "invalid": the person did
// nothing wrong (they typed what their app shows), and "wait for a new one"
// is the one thing that helps. It reveals nothing a replayer didn't know —
// they already hold a code that was right.
export const MFA_CODE_ALREADY_USED_MESSAGE =
  'This code has already been used — wait for your app to show a new one'
// The shape of a code, checked before anything is computed: 6 digits.
export const MFA_CODE_FORMAT_MESSAGE = 'The authentication code is 6 digits'
export const TOTP_CODE_INPUT = /^\d{6}$/

// One instance for the whole app. Stateless — the secret, the code and the
// clock are passed on every call — so sharing it is safe.
const otp = new OTP({ strategy: 'totp' })

// --- TYPES -------------------------------------------------------------------------------------------------

// What a check needs from the account row — read FOR UPDATE by the caller.
// `mfaSecret` is the STORED (encrypted) value; it's decrypted here, at the
// moment of use, and never held decrypted any longer.
export interface MfaCodeAccount {
  mfaSecret: string
  mfaLastUsedStep: number | null
}

export type MfaCodeRefusal = 'wrong_code' | 'code_already_used'

// A discriminated union: `ok` tells TypeScript which other field exists, so a
// caller can't read `step` from a refusal.
export type MfaCodeCheck =
  { ok: true; step: number } | { ok: false; reason: MfaCodeRefusal }

// --- VALIDATION --------------------------------------------------------------------------------------------

// The DTO rule for a field that takes ONLY a code from the authenticator
// app: a string of exactly 6 digits. Replaces `Length(6, 6)`, which let
// "abcdef" through to otplib. Composed with applyDecorators, like IsTitle.
// Only confirming set-up (enable) uses it — the proof that the app holds the
// new secret; every other code field also takes a recovery code
// (IsSecondFactorCode, second-factor.ts).
export function IsTotpCode(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    Matches(TOTP_CODE_INPUT, { message: MFA_CODE_FORMAT_MESSAGE }),
  )
}

// --- SECRETS -----------------------------------------------------------------------------------------------

// A new random secret (base32, as authenticator apps expect).
export function newMfaSecret(): string {
  return otp.generateSecret()
}

// The otpauth:// address the QR code encodes: the app reads the issuer and
// the label to name the entry ("Stride (jane@example.com)") and the secret
// to compute codes.
export function mfaKeyUri(accountLabel: string, secret: string): string {
  return otp.generateURI({ issuer: 'Stride', label: accountLabel, secret })
}

// --- CHECKING A CODE ---------------------------------------------------------------------------------------

// Pure apart from the clock: says whether `code` is good now, and if so, its
// step (for the caller to record). Never throws for a wrong code — sign-in
// answers 401 and records the failure, the other flows answer 400; each
// caller decides.
export async function checkMfaCode(
  account: MfaCodeAccount,
  code: string,
): Promise<MfaCodeCheck> {
  const result = await otp.verify({
    secret: decryptMfaSecret(account.mfaSecret),
    token: code,
  })
  // `'timeStep' in result`: the OTP class is typed for BOTH strategies, and
  // an HOTP result carries a counter instead. With strategy 'totp' a valid
  // result always has its time step — the test narrows the type for
  // TypeScript, and fails closed if that ever stopped being true.
  // (`!result.valid` is otplib's documented answer. A refused result carries
  // no step either, so the tests can't tell the two checks apart — a
  // mutation removing `!result.valid` survives, as an equivalent. Kept: the
  // library's own word for "valid", not a guess at the shape of its result.)
  if (!result.valid || !('timeStep' in result)) {
    return { ok: false, reason: 'wrong_code' }
  }
  // `<=`, not `===`: a code from an EARLIER step than the last one used is
  // refused too. With a tolerance of 0 that only happens if the server's
  // clock went backwards (an NTP correction) — exactly when a replay window
  // would otherwise reopen.
  if (
    account.mfaLastUsedStep !== null &&
    result.timeStep <= account.mfaLastUsedStep
  ) {
    return { ok: false, reason: 'code_already_used' }
  }
  return { ok: true, step: result.timeStep }
}

// The words for a refusal.
export function mfaCodeRefusalMessage(reason: MfaCodeRefusal): string {
  return reason === 'code_already_used'
    ? MFA_CODE_ALREADY_USED_MESSAGE
    : INVALID_MFA_CODE_MESSAGE
}

// Remembers that the code of `step` was used. In the caller's transaction,
// so it is rolled back with it — a step-up then spends the code again on
// its own (second-factor.ts, spendAgain). The account's row must already be
// locked.
export async function recordMfaStep(
  tx: DrizzleDb,
  userId: number,
  step: number,
): Promise<void> {
  await tx
    .update(users)
    .set({ mfaLastUsedStep: step })
    .where(eq(users.id, userId))
}

// For the flows that refuse with a 400 (turning MFA on or off, the step-up):
// check, refuse in words, or record the step — one call.
export async function useMfaCode(
  tx: DrizzleDb,
  userId: number,
  account: MfaCodeAccount,
  code: string,
): Promise<void> {
  const check = await checkMfaCode(account, code)
  if (!check.ok) {
    throw new BadRequestException(mfaCodeRefusalMessage(check.reason))
  }
  await recordMfaStep(tx, userId, check.step)
}
