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

import { recordsExportLinkStatus } from './records-export-link-status'

describe('recordsExportLinkStatus', () => {
  const now = new Date('2026-10-26T12:00:00Z')
  const open = {
    usedAt: null,
    replacedAt: null,
    dobFailures: 0,
    expiresAt: new Date('2026-10-29T12:00:00Z'),
  }
  const past = new Date('2026-10-20T12:00:00Z')
  const earlier = new Date('2026-10-25T12:00:00Z')

  it('is open until something ends it', () => {
    expect(recordsExportLinkStatus(open, now)).toBe('open')
    // Four wrong dates: still one try left.
    expect(recordsExportLinkStatus({ ...open, dobFailures: 4 }, now)).toBe(
      'open',
    )
  })

  it('is used, replaced or locked by what ended it', () => {
    expect(recordsExportLinkStatus({ ...open, usedAt: earlier }, now)).toBe(
      'used',
    )
    expect(recordsExportLinkStatus({ ...open, replacedAt: earlier }, now)).toBe(
      'replaced',
    )
    expect(recordsExportLinkStatus({ ...open, dobFailures: 5 }, now)).toBe(
      'locked',
    )
  })

  // What ended a link stays its status once the expiry passes.
  it('keeps what ended it after the expiry', () => {
    const expired = { ...open, expiresAt: past }
    expect(recordsExportLinkStatus({ ...expired, usedAt: earlier }, now)).toBe(
      'used',
    )
    expect(
      recordsExportLinkStatus({ ...expired, replacedAt: earlier }, now),
    ).toBe('replaced')
    expect(recordsExportLinkStatus({ ...expired, dobFailures: 5 }, now)).toBe(
      'locked',
    )
    // A link used after four wrong tries was USED.
    expect(
      recordsExportLinkStatus(
        { ...open, usedAt: earlier, dobFailures: 4 },
        now,
      ),
    ).toBe('used')
  })

  // The trigger's boundary: at the exact instant of expiry, it's over.
  it('expires at the instant of expiry, not a moment later', () => {
    expect(recordsExportLinkStatus({ ...open, expiresAt: now }, now)).toBe(
      'expired',
    )
    expect(
      recordsExportLinkStatus(
        { ...open, expiresAt: new Date(now.getTime() + 1) },
        now,
      ),
    ).toBe('open')
  })
})
