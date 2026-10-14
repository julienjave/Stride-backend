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

// --- TYPES -------------------------------------------------------------------------------------------------

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

// The three columns the status is derived from (see invitations.schema.ts:
// the status is never stored, so it can never disagree with them).
export interface InvitationTimestamps {
  acceptedAt: Date | null
  revokedAt: Date | null
  expiresAt: Date
}

// --- FUNCTION ----------------------------------------------------------------------------------------------

// A pure function — no database, no clock of its own: `now` is a parameter,
// so a test can ask "what is this invitation's status at 12:00:00?" without
// waiting or faking time.
//
// Order matters. A closed invitation stays closed after its expiry date
// passes: an invitation accepted on day 3 is "accepted" forever, not
// "expired" on day 8. So the two closing events are checked first.
//
// The expiry boundary matches the database's accept condition
// (expires_at > now(), in InvitationsService.accept): at the exact instant
// of expiry, it's already expired in both places.
export function invitationStatus(
  invitation: InvitationTimestamps,
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.acceptedAt !== null) return 'accepted'
  if (invitation.revokedAt !== null) return 'revoked'
  if (invitation.expiresAt.getTime() <= now.getTime()) return 'expired'
  return 'pending'
}
