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

import { Transform } from 'class-transformer'
import { applyDecorators } from '@nestjs/common'
import { ValidateBy } from 'class-validator'
import { and, count, eq, isNull, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../database/drizzle.provider'
import { mfaRecoveryCodes } from '../database/schema'
import {
  checkMfaCode,
  mfaCodeRefusalMessage,
  type MfaCodeAccount,
  type MfaCodeRefusal,
  recordMfaStep,
  TOTP_CODE_INPUT,
} from './totp'
import {
  hashRecoveryCode,
  normaliseRecoveryCode,
  RECOVERY_CODE_INPUT,
} from './recovery-codes'

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// "A recovery code is accepted wherever a code is asked" (the person's
// choice, decisions §14): signing in, turning MFA off, asking for new
// recovery codes, the step-ups of the email and password changes, and an
// admin's own step-up for a reset. Each of those asks for "the second
// factor" — this file decides which kind was typed and spends it:
//   - 6 digits → a code from the authenticator app (mfa/totp.ts: no code
//     twice, its step recorded);
//   - two groups of 5 → a recovery code: marked used by ONE statement,
//     `UPDATE … SET used_at = now() WHERE … AND used_at IS NULL RETURNING`.
//     Two requests with the same code can't both win: the second one's
//     UPDATE waits for the first's row lock, then re-reads the row (READ
//     COMMITTED re-checks the WHERE on the new version), finds it used, and
//     changes nothing — refused.
// Spending happens in the caller's transaction, on the account's locked row,
// like recordMfaStep: if the action is refused or rolled back, the code
// isn't spent.

// --- CONSTANTS ---------------------------------------------------------------------------------------------

export const SECOND_FACTOR_FORMAT_MESSAGE =
  'Enter the 6-digit code from your authenticator app, or one of your recovery codes'
// Wrong, or used already: one answer — which of the two it is helps only
// someone guessing.
export const INVALID_RECOVERY_CODE_MESSAGE =
  'This recovery code is not valid, or has already been used'

// --- TYPES -------------------------------------------------------------------------------------------------

export type SecondFactorRefusal = MfaCodeRefusal | 'wrong_recovery_code'

export type SecondFactorCheck =
  | { ok: true; kind: 'totp' }
  | { ok: true; kind: 'recovery_code'; remaining: number }
  | { ok: false; reason: SecondFactorRefusal }

export type SecondFactorUse = Extract<SecondFactorCheck, { ok: true }>

// --- VALIDATION --------------------------------------------------------------------------------------------

// The DTO rule for a field that takes either kind. Trimmed first (a code
// pasted with a space around it), then: 6 digits, or a recovery code's
// shape. ValidateBy with the two patterns their own files define — not a
// third copy of either.
export function IsSecondFactorCode(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim() : value,
    ),
    ValidateBy({
      name: 'isSecondFactorCode',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          (TOTP_CODE_INPUT.test(value) || RECOVERY_CODE_INPUT.test(value)),
        defaultMessage: () => SECOND_FACTOR_FORMAT_MESSAGE,
      },
    }),
  )
}

// --- SPENDING ONE ------------------------------------------------------------------------------------------

// Checks `input` for the account and, if good, spends it — in `tx`, on the
// account's LOCKED row. Never throws for a refusal: sign-in answers 401 and
// records it, the others answer 400 (secondFactorRefusalMessage).
export async function trySecondFactor(
  tx: DrizzleDb,
  userId: number,
  account: MfaCodeAccount,
  input: string,
): Promise<SecondFactorCheck> {
  const recoveryCode = normaliseRecoveryCode(input)
  if (recoveryCode === null) {
    const check = await checkMfaCode(account, input)
    if (!check.ok) return check
    await recordMfaStep(tx, userId, check.step)
    return { ok: true, kind: 'totp' }
  }

  // used_at's value is the guard trigger's (now()); it just has to be
  // non-null here. The account condition: row security (the UPDATE policy)
  // already limits this to the signed-in account's own codes, so a mutation
  // removing it survives the tests — equivalent, and kept: it says the rule
  // in the code, and it is what lets the lookup use the (user_id,
  // code_hash) index. Removing BOTH layers fails the e2e test "refused for
  // another account".
  const spent = await tx
    .update(mfaRecoveryCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        eq(mfaRecoveryCodes.codeHash, hashRecoveryCode(recoveryCode)),
        isNull(mfaRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id })
  if (spent.length === 0) return { ok: false, reason: 'wrong_recovery_code' }

  // How many are left — the notice and the audit entry say it, so the
  // person knows when to ask for new ones.
  const [left] = await tx
    .select({ remaining: count() })
    .from(mfaRecoveryCodes)
    .where(
      and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)),
    )
  return { ok: true, kind: 'recovery_code', remaining: left.remaining }
}

// The words for a refusal.
export function secondFactorRefusalMessage(
  reason: SecondFactorRefusal,
): string {
  return reason === 'wrong_recovery_code'
    ? INVALID_RECOVERY_CODE_MESSAGE
    : mfaCodeRefusalMessage(reason)
}
