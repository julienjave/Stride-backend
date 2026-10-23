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

import { actionsOfKind, areaOf, kindOf } from './audit-vocabulary'

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
    })

    it('shows an entity type it does not know as stored', () => {
      expect(areaOf('mystery_table')).toBe('mystery_table')
      expect(areaOf('constructor')).toBe('constructor')
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
      ])
    })

    it('puts every other action among the changes', () => {
      const changes = actionsOfKind('change')
      // 99 actions (the 3 email-change ones and PASSWORD_CHANGED since
      // 2026-10-22), 9 views, 6 sign-ins.
      expect(changes).toHaveLength(99 - 9 - 6)
      expect(changes).toContain('EMAIL_CHANGE_CONFIRMED')
      expect(changes).toContain('PASSWORD_CHANGED')
      expect(changes).toContain('CONVERSATION_READ')
      expect(changes).toContain('REGISTER_CLINIC')
    })
  })
})
