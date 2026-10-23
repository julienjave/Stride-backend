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

import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import type { DrizzleDb } from '../database/drizzle.provider'
import { users } from '../database/schema'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { errorMessage } from '../common/error-message'
import {
  isCurrentPassword,
  WRONG_PASSWORD_MESSAGE,
} from '../common/current-password'
import { INVALID_MFA_CODE_MESSAGE } from './totp'
import {
  secondFactorRefusalMessage,
  trySecondFactor,
  type SecondFactorUse,
} from './second-factor'

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// "Step-up authentication": a signed-in session proves someone signed in at
// some point — not that the account's owner is at the keyboard NOW. So the
// changes that could hand the account to someone else ask again:
//   - the current PASSWORD, always (common/current-password.ts);
//   - for an account with two-factor sign-in ON, a current SECOND FACTOR too
//     — a code from the app, or a recovery code (decisions §14).
// Five routes ask it: changing the email, changing the password, turning MFA
// off, asking for new recovery codes, and an admin's reset of someone's MFA
// (the ADMIN's own step-up). Starting set-up asks the password alone (MFA is
// off then).
//
// A service, not a plain function (it was one in pass 1), because using a
// RECOVERY code has consequences every caller would otherwise repeat: an
// audit entry in the transaction, and a notice email after the commit. The
// caller gets a receipt and calls `afterCommit()` once its transaction is
// committed — never before: no email about a use that was rolled back.

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// An account with two-factor sign-in on, and no code sent. The frontend shows
// the code field only for such accounts; this is what a request without it
// gets (an older screen, a direct API call).
export const MFA_CODE_REQUIRED_MESSAGE =
  'Enter the 6-digit code from your authenticator app'

// The account's columns a step-up reads. Selected by the caller (with
// whatever else it needs) from the account's row LOCKED FOR UPDATE: the
// second factor is SPENT here, and two requests with the same code must not
// both find it unused. The name and email are for the notice.
export const STEP_UP_COLUMNS = {
  email: users.email,
  firstName: users.firstName,
  passwordHash: users.passwordHash,
  mfaEnabled: users.mfaEnabled,
  mfaSecret: users.mfaSecret,
  mfaLastUsedStep: users.mfaLastUsedStep,
}

// --- TYPES -------------------------------------------------------------------------------------------------

export interface StepUpAccount {
  email: string
  firstName: string
  passwordHash: string | null
  mfaEnabled: boolean
  mfaSecret: string | null
  mfaLastUsedStep: number | null
}

// What the request brought: the password always; the code when it sent one.
export interface StepUpProof {
  currentPassword: string
  mfaCode?: string
}

// What a caller does after ITS commit: send the notice a recovery code's use
// calls for (nothing for an app code, or no second factor).
export interface StepUpReceipt {
  afterCommit(): void
}

const NOTHING_AFTER_COMMIT: StepUpReceipt = { afterCommit: () => undefined }

// --- SERVICE -----------------------------------------------------------------------------------------------

@Injectable()
export class StepUpService {
  private readonly logger = new Logger(StepUpService.name)

  constructor(
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
  ) {}

  // The whole step-up, inside the caller's transaction, on the locked row:
  //   1. the password — always; a wrong one refuses before any code is
  //      looked at (a code is not even spent on a request that fails here);
  //   2. for an account with two-factor on, a second factor: missing → its
  //      own 400; wrong or already used → its words; a good one is SPENT in
  //      this transaction (an app code's step recorded, a recovery code
  //      marked used — then its entry written, its notice in the receipt).
  // Throws a 400 on any refusal — the transaction then rolls back, nothing
  // is changed.
  async confirm(
    tx: DrizzleDb,
    userId: number,
    account: StepUpAccount,
    proof: StepUpProof,
  ): Promise<StepUpReceipt> {
    if (
      !(await isCurrentPassword(account.passwordHash, proof.currentPassword))
    ) {
      throw new BadRequestException(WRONG_PASSWORD_MESSAGE)
    }
    if (!account.mfaEnabled) return NOTHING_AFTER_COMMIT
    if (proof.mfaCode === undefined) {
      throw new BadRequestException(MFA_CODE_REQUIRED_MESSAGE)
    }
    // ON with no secret can't be stored (users_mfa_enabled_has_secret), but
    // TypeScript can't see a CHECK. If it ever happened, refuse — never skip
    // the code check because there is nothing to check it against.
    if (account.mfaSecret === null) {
      throw new BadRequestException(INVALID_MFA_CODE_MESSAGE)
    }
    const check = await trySecondFactor(
      tx,
      userId,
      {
        mfaSecret: account.mfaSecret,
        mfaLastUsedStep: account.mfaLastUsedStep,
      },
      proof.mfaCode,
    )
    if (!check.ok) {
      throw new BadRequestException(secondFactorRefusalMessage(check.reason))
    }
    return this.afterSecondFactor(tx, userId, account, check)
  }

  // What a SPENT second factor leaves behind — shared with signing in, which
  // spends one without the password step (MfaService.verifySignIn). An app
  // code: nothing (its step is recorded; a sign-in or a change records
  // itself). A recovery code: a security event of its own — ONE more entry,
  // MFA_RECOVERY_CODE_USED with how many are left, in the transaction (the
  // stated exception to "one entry per request", like a clinic removal's
  // per-patient entries), and a notice to the account's inbox after the
  // commit: if someone else holds the codes, the owner hears of it at once.
  async afterSecondFactor(
    tx: DrizzleDb,
    userId: number,
    account: { email: string; firstName: string },
    use: SecondFactorUse,
  ): Promise<StepUpReceipt> {
    if (use.kind === 'totp') return NOTHING_AFTER_COMMIT
    await this.auditService.logInTransaction(tx, {
      performedBy: userId,
      action: 'MFA_RECOVERY_CODE_USED',
      targetUserId: userId,
      entityType: 'users',
      entityId: userId,
      details: { remaining: use.remaining },
    })
    return {
      // Fire-and-forget: the action IS done whatever the mail server does; a
      // failure is logged with its reason.
      afterCommit: () => {
        this.emailService
          .sendRecoveryCodeUsedNotice({
            to: account.email,
            firstName: account.firstName,
            remaining: use.remaining,
          })
          .catch((error: unknown) =>
            this.logger.error(
              `Failed to send the recovery-code notice to ${account.email}: ${errorMessage(error)}`,
            ),
          )
      },
    }
  }
}
