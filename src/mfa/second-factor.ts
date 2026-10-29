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
import { mfaRecoveryCodes, users } from '../database/schema'
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
// like recordMfaStep: if the action is then refused or rolled back, the
// spend is rolled back with it. A step-up spends it AGAIN afterwards, in a
// transaction of its own (spendAgain below — StepUpAttempt): a code that was
// shown to work must not work twice, whatever happened next.

// --- CONSTANTS ---------------------------------------------------------------------------------------------

export const SECOND_FACTOR_FORMAT_MESSAGE =
  'Enter the 6-digit code from your authenticator app, or one of your recovery codes'
// Wrong, or used already: one answer — which of the two it is helps only
// someone guessing.
export const INVALID_RECOVERY_CODE_MESSAGE =
  'This recovery code is not valid, or has already been used'

// --- TYPES -------------------------------------------------------------------------------------------------

export type SecondFactorRefusal = MfaCodeRefusal | 'wrong_recovery_code'

// A good code says WHAT was spent — an app code's step, a recovery code's
// hash (never the code itself) — so it can be spent again if the
// transaction that spent it is rolled back (spendAgain).
export type SecondFactorCheck =
  | { ok: true; kind: 'totp'; step: number }
  | {
      ok: true
      kind: 'recovery_code'
      codeHash: string
      remaining: number
    }
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
    return { ok: true, kind: 'totp', step: check.step }
  }

  // used_at's value is the guard trigger's (now()); it just has to be
  // non-null here. The account condition: row security (the UPDATE policy)
  // already limits this to the signed-in account's own codes, so a mutation
  // removing it survives the tests — equivalent, and kept: it says the rule
  // in the code, and it is what lets the lookup use the (user_id,
  // code_hash) index. Removing BOTH layers fails the e2e test "refused for
  // another account".
  const codeHash = hashRecoveryCode(recoveryCode)
  const remaining = await spendRecoveryCode(tx, userId, codeHash)
  if (remaining === null) return { ok: false, reason: 'wrong_recovery_code' }
  return { ok: true, kind: 'recovery_code', codeHash, remaining }
}

// Marks the recovery code of `codeHash` used — if it is the account's and
// still unused — and answers how many are left; null when there was nothing
// to spend. ONE UPDATE is the check and the write (see the file's comment).
async function spendRecoveryCode(
  tx: DrizzleDb,
  userId: number,
  codeHash: string,
): Promise<number | null> {
  const spent = await tx
    .update(mfaRecoveryCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        eq(mfaRecoveryCodes.codeHash, codeHash),
        isNull(mfaRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id })
  if (spent.length === 0) return null

  // How many are left — the notice and the audit entry say it, so the
  // person knows when to ask for new ones.
  const [left] = await tx
    .select({ remaining: count() })
    .from(mfaRecoveryCodes)
    .where(
      and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)),
    )
  return left.remaining
}

// Spends again a second factor that passed in a transaction since ROLLED
// BACK (a step-up whose change then failed — StepUpAttempt). In `tx`, a new
// transaction. Answers what this spend did:
//   - an app code: its step recorded — with GREATEST, never lowering the
//     stored one: between the rollback and now, another request may have
//     used a LATER code, and putting the earlier step back would make that
//     later code usable a second time. (GREATEST ignores a NULL: the first
//     step ever recorded is simply this one.) Nothing else to say;
//   - a recovery code: spent if it is still unused (another request, or new
//     codes, may have got there first) → how many are left, or null if
//     there was nothing to spend.
export async function spendAgain(
  tx: DrizzleDb,
  userId: number,
  use: SecondFactorUse,
): Promise<{ recoveryCodesLeft: number | null }> {
  if (use.kind === 'totp') {
    await tx
      .update(users)
      .set({
        mfaLastUsedStep: sql`GREATEST(${users.mfaLastUsedStep}, ${use.step})`,
      })
      .where(eq(users.id, userId))
    return { recoveryCodesLeft: null }
  }
  return {
    recoveryCodesLeft: await spendRecoveryCode(tx, userId, use.codeHash),
  }
}

// The words for a refusal.
export function secondFactorRefusalMessage(
  reason: SecondFactorRefusal,
): string {
  return reason === 'wrong_recovery_code'
    ? INVALID_RECOVERY_CODE_MESSAGE
    : mfaCodeRefusalMessage(reason)
}
