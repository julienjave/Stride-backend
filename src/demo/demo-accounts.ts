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

// The demo's PUBLISHED data (decisions §14, §46): the shared password, the
// two-factor account's key and recovery codes, and the four accounts the
// sign-in page's card lists. In src/ (moved from scripts/seed/dataset.ts on
// 2026-11-02) because the running app now needs them too — the card's answer
// and the locks — and the app can't import from scripts/ (the build compiles
// src/ only). The seed imports them from here: ONE copy, so the card can never
// publish a password the seed didn't set.
//
// None of this is a secret: it is in docs/demo-accounts.md and on the
// demo's sign-in page. A real clinic's deployment has no account with these
// addresses, and DEMO_MODE off publishes nothing.

import type { UserRole } from '../users/dto/create-user.dto'

// One password for every seeded account that has one.
export const DEMO_PASSWORD = 'password123'

// The two-factor account's authenticator key and recovery codes. The app
// itself never makes a key or a code like these (it draws them at random);
// the seed puts them in place after turning two-factor on the real way.
// Base32 (A–Z, 2–7), 32 symbols = 160 bits, the size the app draws.
export const DEMO_MFA_SECRET = 'STRIDEDEMOTWOFACTORSTRIDEDEMOTWO'
// The app's shape (src/mfa/recovery-codes.ts): 10 codes, 5 + 5 symbols of
// its alphabet (no 0 / o, 1 / l / i). Easy to type, on purpose.
export const DEMO_RECOVERY_CODES = [
  'strde-22222',
  'strde-33333',
  'strde-44444',
  'strde-55555',
  'strde-66666',
  'strde-77777',
  'strde-88888',
  'strde-99999',
  'strde-aaaaa',
  'strde-bbbbb',
]

export interface DemoCardAccount {
  email: string
  // The role the card names it by (the account may hold more — not these four).
  role: `${UserRole}`
  // Signing in asks for a two-factor code: the card shows the key.
  twoFactor: boolean
}

// The card's accounts, in the order shown (the person's choice, §46): one per
// role, then two-factor sign-in. The same four are LOCKED in demo mode
// (demo-lock.guard.ts): the card publishes their passwords, so no reviewer may
// change what the others need to sign in. dataset.spec.ts checks each is
// seeded with this role (and Casey with two-factor).
export const DEMO_CARD_ACCOUNTS: readonly DemoCardAccount[] = [
  { email: 'admin@stride.test', role: 'admin', twoFactor: false },
  { email: 'alex@stride.test', role: 'practitioner', twoFactor: false },
  { email: 'pat@stride.test', role: 'patient', twoFactor: false },
  { email: 'casey@stride.test', role: 'patient', twoFactor: true },
]

// Stored addresses are already normalised (trimmed, A–Z lowercased — decisions
// §12), so a plain comparison is enough.
export function isDemoCardAccount(email: string): boolean {
  return DEMO_CARD_ACCOUNTS.some((account) => account.email === email)
}
