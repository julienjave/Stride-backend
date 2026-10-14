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

import { invitationStatus } from './invitation-status'

describe('invitationStatus', () => {
  const now = new Date('2026-10-07T12:00:00Z')
  const inAnHour = new Date('2026-10-07T13:00:00Z')
  const anHourAgo = new Date('2026-10-07T11:00:00Z')

  const open = { acceptedAt: null, revokedAt: null }

  it('is pending while open and not yet expired', () => {
    expect(invitationStatus({ ...open, expiresAt: inAnHour }, now)).toBe(
      'pending',
    )
  })

  it('is expired once the expiry has passed', () => {
    expect(invitationStatus({ ...open, expiresAt: anHourAgo }, now)).toBe(
      'expired',
    )
  })

  // The boundary must agree with the database's accept condition
  // (expires_at > now()): at the exact instant, accepting already fails.
  it('is expired at the exact instant of expiry', () => {
    expect(invitationStatus({ ...open, expiresAt: now }, now)).toBe('expired')
  })

  // Closing events win over the clock: an invitation accepted on day 3 is
  // still "accepted" on day 8, not "expired".
  it('stays accepted after its expiry date', () => {
    expect(
      invitationStatus(
        { acceptedAt: anHourAgo, revokedAt: null, expiresAt: anHourAgo },
        now,
      ),
    ).toBe('accepted')
  })

  it('stays revoked after its expiry date', () => {
    expect(
      invitationStatus(
        { acceptedAt: null, revokedAt: anHourAgo, expiresAt: anHourAgo },
        now,
      ),
    ).toBe('revoked')
  })
})
