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

import { UserRole } from '../users/dto/create-user.dto'
import {
  DELETE_WINDOW_MS,
  MESSAGE_TOO_LONG_MESSAGE,
  archiveColumn,
  compareByActivity,
  deleteRefusal,
  isListed,
  otherParticipantId,
  participantSide,
  readOnlyReason,
  takePage,
  toPublicMessage,
  type ConversationSummary,
  type MessageRow,
} from './message-rules'

// The messaging rules, pure: every case in milliseconds. What the database
// does with the same rules (policies, triggers) is the e2e suites' job.
// Clocks are pinned far from today (2031), the project's habit: no test can
// pass or fail because of when it runs.

const conversation = { practitionerId: 3, patientId: 6 }
const at = (iso: string) => new Date(iso)

describe('participantSide', () => {
  it('is the practitioner side for the practitioner, in the practitioner role', () => {
    expect(
      participantSide(conversation, {
        id: 3,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).toBe('practitioner')
  })

  it('is the patient side for the patient, in the patient role', () => {
    expect(
      participantSide(conversation, { id: 6, activeRole: UserRole.PATIENT }),
    ).toBe('patient')
  })

  // The active role decides, not the id alone: Morgan (practitioner AND
  // patient) signed in as a practitioner is not the patient of a
  // conversation whose patient id is hers — and the other way round. The
  // fixture makes the id match the OTHER column, so a rule reading the id
  // alone would answer a side.
  it('is no side when the id matches only the column of the role not active', () => {
    expect(
      participantSide(conversation, {
        id: 6,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).toBeNull()
    expect(
      participantSide(conversation, { id: 3, activeRole: UserRole.PATIENT }),
    ).toBeNull()
  })

  it('is no side for someone else, or for an admin', () => {
    expect(
      participantSide(conversation, {
        id: 9,
        activeRole: UserRole.PRACTITIONER,
      }),
    ).toBeNull()
    expect(
      participantSide(conversation, { id: 9, activeRole: UserRole.PATIENT }),
    ).toBeNull()
    expect(
      participantSide(conversation, { id: 3, activeRole: UserRole.ADMIN }),
    ).toBeNull()
  })
})

describe('otherParticipantId and archiveColumn', () => {
  it('names the other person, and my own archive column, from each side', () => {
    expect(otherParticipantId(conversation, 'practitioner')).toBe(6)
    expect(otherParticipantId(conversation, 'patient')).toBe(3)
    expect(archiveColumn('practitioner')).toBe('practitionerArchivedAt')
    expect(archiveColumn('patient')).toBe('patientArchivedAt')
  })
})

const row: MessageRow = {
  id: 41,
  conversationId: 7,
  senderId: 3,
  messageBody: 'Keep the band light this week',
  sentAt: at('2031-03-03T14:00:00Z'),
  readAt: null,
  deletedAt: null,
}

describe('toPublicMessage', () => {
  it('serves a message as stored while it is not deleted', () => {
    expect(toPublicMessage(row)).toStrictEqual({ ...row })
  })

  // The text is removed for EVERYONE — the function doesn't even know who
  // asks. The rest stays (the screen shows "deleted" at the right place).
  it('serves a deleted message without its text, every other field kept', () => {
    const deletedAt = at('2031-03-03T14:05:00Z')
    expect(toPublicMessage({ ...row, deletedAt })).toStrictEqual({
      ...row,
      messageBody: null,
      deletedAt,
    })
  })
})

describe('deleteRefusal', () => {
  const sentAt = row.sentAt
  const afterMs = (ms: number) => new Date(sentAt.getTime() + ms)

  it('lets the sender delete an unread message within the window', () => {
    expect(deleteRefusal(row, 3, afterMs(60_000))).toBeNull()
  })

  // "Older than the window" is strictly greater — the trigger's
  // `now() - sent_at > interval '15 minutes'`. Both edges, one millisecond
  // apart.
  it('still allows it at exactly 15 minutes, and refuses one millisecond later', () => {
    expect(deleteRefusal(row, 3, afterMs(DELETE_WINDOW_MS))).toBeNull()
    expect(deleteRefusal(row, 3, afterMs(DELETE_WINDOW_MS + 1))).toBe(
      'window_passed',
    )
  })

  it('refuses a message already read, even within the window', () => {
    const read = { ...row, readAt: afterMs(30_000) }
    expect(deleteRefusal(read, 3, afterMs(60_000))).toBe('read')
  })

  // The ORDER of the answers, with fixtures where several rules fail at
  // once: someone else's message is "not yours" whatever its state, and a
  // read message past the window is "read" (the more useful reason: the
  // other person has seen it).
  it('answers "not yours" before any state, and "read" before "too old"', () => {
    const readAndOld = { ...row, readAt: afterMs(30_000) }
    expect(deleteRefusal(readAndOld, 6, afterMs(DELETE_WINDOW_MS + 1))).toBe(
      'not_sender',
    )
    expect(deleteRefusal(readAndOld, 3, afterMs(DELETE_WINDOW_MS + 1))).toBe(
      'read',
    )
  })
})

describe('takePage', () => {
  it('drops the extra row, says there is more, and serves the page oldest first', () => {
    // Newest first, as the query returns them, with limit 3 + the extra one.
    expect(takePage([40, 39, 38, 37], 3)).toStrictEqual({
      messages: [38, 39, 40],
      hasMore: true,
    })
  })

  it('says there is no more when the page is full but nothing extra came back', () => {
    expect(takePage([40, 39, 38], 3)).toStrictEqual({
      messages: [38, 39, 40],
      hasMore: false,
    })
  })

  it('serves a short page, and an empty one', () => {
    expect(takePage([40], 3)).toStrictEqual({ messages: [40], hasMore: false })
    expect(takePage([], 3)).toStrictEqual({ messages: [], hasMore: false })
  })

  it('leaves the rows it was given unchanged (reverse would mutate them)', () => {
    const rows = [40, 39]
    takePage(rows, 3)
    expect(rows).toEqual([40, 39])
  })
})

describe('readOnlyReason', () => {
  it('is null while the two can write', () => {
    expect(readOnlyReason({ canSend: true, onCareTeam: true })).toBeNull()
  })

  it('names the deactivated account when the care team is still there', () => {
    expect(readOnlyReason({ canSend: false, onCareTeam: true })).toBe(
      'patient_deactivated',
    )
  })

  // Both true at once (an ended link AND a deactivated account): the link
  // is the answer — reactivating wouldn't make the conversation writable.
  it('names the ended care team otherwise, whatever the account', () => {
    expect(readOnlyReason({ canSend: false, onCareTeam: false })).toBe(
      'care_team_ended',
    )
  })
})

function summary(
  id: number,
  createdAt: string,
  lastSentAt: string | null,
): ConversationSummary {
  return {
    id,
    otherParticipant: {
      id: 6,
      firstName: 'Pat',
      lastName: 'Lee',
      avatarUrl: null,
    },
    lastMessage:
      lastSentAt === null
        ? null
        : toPublicMessage({
            ...row,
            conversationId: id,
            sentAt: at(lastSentAt),
          }),
    unreadCount: 0,
    archivedAt: null,
    canSend: true,
    readOnlyReason: null,
    createdAt: at(createdAt),
  }
}

describe('the list: isListed and compareByActivity', () => {
  it('lists a conversation with a message, not an empty one', () => {
    expect(
      isListed(summary(1, '2031-03-01T09:00:00Z', '2031-03-02T09:00:00Z')),
    ).toBe(true)
    expect(isListed(summary(2, '2031-03-01T09:00:00Z', null))).toBe(false)
  })

  // The fixture makes "by last message" and "by creation" DISAGREE: the
  // conversation created first has the newest message.
  it('sorts by the last message, newest first — not by when the conversation started', () => {
    const olderButActive = summary(
      1,
      '2031-03-01T09:00:00Z',
      '2031-03-05T09:00:00Z',
    )
    const newerButQuiet = summary(
      2,
      '2031-03-03T09:00:00Z',
      '2031-03-04T09:00:00Z',
    )
    expect(
      [newerButQuiet, olderButActive].sort(compareByActivity).map((s) => s.id),
    ).toEqual([1, 2])
  })

  it("uses an empty conversation's start as its moment", () => {
    const empty = summary(3, '2031-03-06T09:00:00Z', null)
    const active = summary(1, '2031-03-01T09:00:00Z', '2031-03-05T09:00:00Z')
    expect([active, empty].sort(compareByActivity).map((s) => s.id)).toEqual([
      3, 1,
    ])
  })

  it('breaks a tie with the newer conversation (the higher id) first', () => {
    const a = summary(4, '2031-03-01T09:00:00Z', '2031-03-05T09:00:00Z')
    const b = summary(5, '2031-03-01T09:00:00Z', '2031-03-05T09:00:00Z')
    expect([a, b].sort(compareByActivity).map((s) => s.id)).toEqual([5, 4])
    expect([b, a].sort(compareByActivity).map((s) => s.id)).toEqual([5, 4])
  })
})

describe('messages', () => {
  it('names the limit in the too-long message', () => {
    expect(MESSAGE_TOO_LONG_MESSAGE).toBe(
      'A message can be at most 5000 characters',
    )
  })
})
