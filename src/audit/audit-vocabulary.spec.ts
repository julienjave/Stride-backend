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

import {
  actionsOfKind,
  areaOf,
  detailsShownToAdmins,
  kindOf,
} from './audit-vocabulary'

// The list itself is checked by the compiler (AuditEntry's types); these
// check the lookups the viewer and the filter rely on.
describe('audit vocabulary', () => {
  describe('kindOf', () => {
    it('gives each known action its kind', () => {
      expect(kindOf('USER_UPDATED')).toBe('change')
      expect(kindOf('SESSION_VIEWED')).toBe('view')
      expect(kindOf('PROGRAM_CLOSING_PREVIEWED')).toBe('view')
      expect(kindOf('LOGOUT')).toBe('sign_in')
    })

    // A stored action from before the vocabulary — the same answer the
    // SQL filter gives (NOT IN the view and sign-in lists).
    it('treats an action it does not know as a change', () => {
      expect(kindOf('POST /users/6')).toBe('change')
    })

    // `in` would find inherited names; only the listed ones count.
    it("does not mistake an object's inherited names for actions", () => {
      expect(kindOf('toString')).toBe('change')
      expect(kindOf('constructor')).toBe('change')
    })
  })

  describe('areaOf', () => {
    it('names each stored entity type, both spellings included', () => {
      expect(areaOf('assigned-programs')).toBe('Programs')
      expect(areaOf('medical_files')).toBe('Medical files')
      expect(areaOf('alerts')).toBe('For review')
      expect(areaOf('session_reviews')).toBe('For review')
      expect(areaOf('program_alert_reviews')).toBe('For review')
      expect(areaOf('care_team_join_reviews')).toBe('For review')
      expect(areaOf('records_exports')).toBe('Records exports')
      expect(areaOf('records_export_links')).toBe('Records exports')
    })

    it('shows an entity type it does not know as stored', () => {
      expect(areaOf('mystery_table')).toBe('mystery_table')
      expect(areaOf('constructor')).toBe('constructor')
    })
  })

  // What an admin may read in an entry's details (decisions §16): the full
  // classification written out, so an area moved by mistake shows here — and
  // the clinical areas, every one, withheld.
  describe('detailsShownToAdmins', () => {
    it('shows the details of accounts, clinics, care teams and the library', () => {
      for (const type of [
        'users',
        'email_change_requests',
        'invitations',
        'care_team_members',
        'clinics',
        'user_clinics',
        'exercises',
        'program_templates',
        'records_export_links',
        // A care-team join notice seen (2026-10-28): who joined whose team —
        // directory-level, like care_team_members.
        'care_team_join_reviews',
      ]) {
        expect([type, detailsShownToAdmins(type)]).toEqual([type, true])
      }
    })

    it('withholds the details of every clinical area', () => {
      for (const type of [
        'assigned-programs',
        'sessions',
        'session_reviews',
        'program_alert_reviews',
        'alerts',
        'conversations',
        'messages',
        'medical_files',
        'records_exports',
      ]) {
        expect([type, detailsShownToAdmins(type)]).toEqual([type, false])
      }
    })

    it("withholds an entity type it doesn't know — what it holds can't be judged", () => {
      expect(detailsShownToAdmins('mystery_table')).toBe(false)
      // Inherited names aren't areas (Object.hasOwn, not `in`).
      expect(detailsShownToAdmins('constructor')).toBe(false)
      expect(detailsShownToAdmins('toString')).toBe(false)
    })
  })

  // The two closed lists the SQL filter matches — written out, so a kind
  // changed by mistake in the vocabulary shows here.
  describe('actionsOfKind', () => {
    it('lists the reads of others’ clinical data', () => {
      expect(actionsOfKind('view')).toEqual([
        'PROGRAMS_VIEWED',
        'PROGRAM_VIEWED',
        'PROGRAM_SUMMARY_VIEWED',
        'PROGRAM_SESSIONS_VIEWED',
        'PROGRAM_CLOSING_PREVIEWED',
        'SESSION_VIEWED',
        'ALERTS_VIEWED',
        'MEDICAL_FILE_VIEWED',
        'MEDICAL_FILE_ENTRY_VIEWED',
        'RECORDS_EXPORTED',
      ])
    })

    it('lists the sign-in events', () => {
      expect(actionsOfKind('sign_in')).toEqual([
        'LOGIN_SUCCESS',
        'LOGIN_FAILURE',
        'LOGIN_BLOCKED_DEACTIVATED',
        'MFA_LOGIN_FAILURE',
        'LOGOUT',
        'ROLE_SWITCHED',
        'MFA_RECOVERY_CODE_USED',
        'STEP_UP_FAILED',
        'RECORDS_EXPORT_LINK_REFUSED',
      ])
    })

    it('puts every other action among the changes', () => {
      const changes = actionsOfKind('change')
      // 106 actions (the 3 email-change ones and PASSWORD_CHANGED since
      // 2026-10-22, the 3 two-factor recovery ones since 2026-10-23,
      // STEP_UP_FAILED since 2026-10-24, RECORDS_EXPORTED and the emailed
      // link's two since 2026-10-26, CARE_TEAM_JOIN_REVIEWED and the
      // complaint review's three since 2026-10-28) — 110 —, 10 views, 9
      // sign-ins.
      expect(changes).toHaveLength(110 - 10 - 9)
      expect(changes).toContain('CARE_TEAM_JOIN_REVIEWED')
      expect(changes).toContain('COMPLAINT_REVIEW_OPENED')
      expect(changes).toContain('COMPLAINT_REVIEW_ENDED')
      expect(changes).toContain('COMPLAINT_REVIEW_NOTICE_REVIEWED')
      expect(changes).toContain('RECORDS_EXPORT_LINK_SENT')
      expect(changes).toContain('MFA_RECOVERY_CODES_REGENERATED')
      expect(changes).toContain('MFA_RESET_BY_ADMIN')
      expect(changes).toContain('EMAIL_CHANGE_CONFIRMED')
      expect(changes).toContain('PASSWORD_CHANGED')
      expect(changes).toContain('CONVERSATION_READ')
      expect(changes).toContain('REGISTER_CLINIC')
    })
  })
})
