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

import { demoModeEnabled, demoTexts } from '../config/demo-mode'
import {
  DEMO_CARD_ACCOUNTS,
  DEMO_MFA_SECRET,
  DEMO_PASSWORD,
  type DemoCardAccount,
} from './demo-accounts'

// What the sign-in page's "For reviewers" card shows (decisions §46), on
// GET /auth/setup-status — the public route that page already reads, so the
// card costs no extra request. `null` outside demo mode: a real clinic's
// sign-in page publishes nothing, and its answer doesn't even say a demo mode
// exists.
//
// The words around these values (what each account is for, "don't enter real
// personal information") are the frontend's: the backend sends DATA, the
// screen decides how to say it — as for every other answer.
export interface DemoInfo {
  accounts: readonly DemoCardAccount[]
  password: string
  // For the two-factor account: added to an authenticator app by hand.
  twoFactorKey: string
  resetSchedule: string | null
  guideUrl: string | null
}

export function demoInfo(
  env: NodeJS.ProcessEnv = process.env,
): DemoInfo | null {
  if (!demoModeEnabled(env)) return null
  return {
    accounts: DEMO_CARD_ACCOUNTS,
    password: DEMO_PASSWORD,
    twoFactorKey: DEMO_MFA_SECRET,
    ...demoTexts(env),
  }
}
