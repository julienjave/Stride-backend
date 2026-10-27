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

import { RECORDS_EXPORT_DOB_ATTEMPTS } from '../database/schema'

// --- TYPES -------------------------------------------------------------------------------------------------

export type RecordsExportLinkStatus =
  'open' | 'used' | 'replaced' | 'locked' | 'expired'

// The columns the status is derived from (records-export-links.schema.ts:
// it is never stored, so it can never disagree with them).
export interface RecordsExportLinkState {
  usedAt: Date | null
  replacedAt: Date | null
  dobFailures: number
  expiresAt: Date
}

// --- FUNCTION ----------------------------------------------------------------------------------------------

// A pure function — `now` is a parameter, so a test can ask "what is this
// link at 12:00:00?" without waiting. The service passes the DATABASE's
// now(), the clock the guard trigger judges expiry by.
//
// Order matters, as for invitations: a link that ENDED (used, replaced,
// locked) stays what ended it after its expiry passes — used on day 1 is
// "used" forever, not "expired" on day 4. Used and replaced can't both be
// set (records_export_links_used_or_replaced); a link locked by wrong dates
// of birth can't be used or replaced afterwards (the guard trigger), so
// whichever is set is the one that happened.
//
// The expiry boundary is the trigger's: at the exact instant of expiry, the
// link is already expired.
export function recordsExportLinkStatus(
  link: RecordsExportLinkState,
  now: Date,
): RecordsExportLinkStatus {
  if (link.usedAt !== null) return 'used'
  if (link.replacedAt !== null) return 'replaced'
  if (link.dobFailures >= RECORDS_EXPORT_DOB_ATTEMPTS) return 'locked'
  if (link.expiresAt.getTime() <= now.getTime()) return 'expired'
  return 'open'
}
