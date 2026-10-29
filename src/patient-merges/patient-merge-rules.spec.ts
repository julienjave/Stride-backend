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

import {
  ALREADY_MERGED_MESSAGE,
  MERGE_INTO_ITSELF_MESSAGE,
  MERGED_IS_STAFF_MESSAGE,
  NOT_PATIENTS_MESSAGE,
  SURVIVOR_DEACTIVATED_MESSAGE,
  mergeAuditDetails,
  mergeRefusal,
  type MergeAccountFacts,
  type MergeSummary,
} from './patient-merge-rules'

const patient = (
  overrides: Partial<MergeAccountFacts> = {},
): MergeAccountFacts => ({
  roles: ['patient'],
  isActive: true,
  alreadyMerged: false,
  ...overrides,
})

describe('mergeRefusal', () => {
  it('lets two active patient accounts be merged', () => {
    expect(mergeRefusal(2, 1, patient(), patient())).toBeNull()
  })

  it('lets a DEACTIVATED account be merged away (a former duplicate)', () => {
    expect(
      mergeRefusal(2, 1, patient({ isActive: false }), patient()),
    ).toBeNull()
  })

  it('lets the survivor hold other roles too — nothing is taken from it', () => {
    expect(
      mergeRefusal(2, 1, patient(), patient({ roles: ['patient', 'admin'] })),
    ).toBeNull()
  })

  it('refuses the same account twice with a 400, before looking at anything', () => {
    expect(mergeRefusal(3, 3, undefined, undefined)).toStrictEqual({
      status: 400,
      message: MERGE_INTO_ITSELF_MESSAGE,
    })
  })

  it('answers 404 naming the missing account — the merged one first', () => {
    expect(mergeRefusal(2, 1, undefined, undefined)).toStrictEqual({
      status: 404,
      message: 'User 2 not found',
    })
    expect(mergeRefusal(2, 1, patient(), undefined)).toStrictEqual({
      status: 404,
      message: 'User 1 not found',
    })
  })

  it.each([
    ['the merged account', patient({ roles: ['practitioner'] }), patient()],
    ['the survivor', patient(), patient({ roles: ['admin'] })],
  ])('refuses when %s is not a patient', (_, merged, survivor) => {
    expect(mergeRefusal(2, 1, merged, survivor)).toStrictEqual({
      status: 409,
      message: NOT_PATIENTS_MESSAGE,
    })
  })

  it('refuses to merge AWAY an account that is also staff', () => {
    expect(
      mergeRefusal(
        2,
        1,
        patient({ roles: ['patient', 'practitioner'] }),
        patient(),
      ),
    ).toStrictEqual({ status: 409, message: MERGED_IS_STAFF_MESSAGE })
  })

  it.each([
    ['the merged account', patient({ alreadyMerged: true }), patient()],
    ['the survivor', patient(), patient({ alreadyMerged: true })],
  ])('refuses when %s was already merged away', (_, merged, survivor) => {
    expect(mergeRefusal(2, 1, merged, survivor)).toStrictEqual({
      status: 409,
      message: ALREADY_MERGED_MESSAGE,
    })
  })

  it('refuses a deactivated survivor', () => {
    expect(
      mergeRefusal(2, 1, patient(), patient({ isActive: false })),
    ).toStrictEqual({ status: 409, message: SURVIVOR_DEACTIVATED_MESSAGE })
  })
})

describe('mergeAuditDetails', () => {
  const summary: MergeSummary = {
    mergeId: 7,
    mergedId: 2,
    survivorId: 1,
    wasActive: true,
    assignedProgramIds: [10],
    sessionIds: [20, 21],
    medicalFileIds: [30],
    movedConversationIds: [40],
    combinedConversations: [{ from: 41, into: 42, messageIds: [50, 51] }],
    movedCareTeamLinkIds: [60],
    newCareTeamLinkIds: [61],
    endedCareTeamLinkIds: [62],
    complaintReviewIds: [70],
    endedComplaintReviewIds: [70],
    legalDisclosureIds: [80],
    addedClinicIds: [90],
    revokedInvitationIds: [100],
    closedExportLinkIds: [110],
    filledFields: ['phone'],
  }

  it('keeps everything clinical out of the account entry, and every id in one of the two', () => {
    const { account, records } = mergeAuditDetails(summary, 3)

    expect(account).toStrictEqual({
      mergeId: 7,
      mergedId: 2,
      survivorId: 1,
      wasActive: true,
      movedCareTeamLinkIds: [60],
      newCareTeamLinkIds: [61],
      endedCareTeamLinkIds: [62],
      complaintReviewIds: [70],
      endedComplaintReviewIds: [70],
      legalDisclosureIds: [80],
      addedClinicIds: [90],
      revokedInvitationIds: [100],
      closedExportLinkIds: [110],
      filledFields: ['phone'],
      signedOutSessions: 3,
    })
    expect(records).toStrictEqual({
      mergeId: 7,
      mergedId: 2,
      survivorId: 1,
      assignedProgramIds: [10],
      sessionIds: [20, 21],
      medicalFileIds: [30],
      movedConversationIds: [40],
      combinedConversations: [{ from: 41, into: 42, messageIds: [50, 51] }],
    })
    // Nothing the merge did is left out of both.
    const recorded = new Set([...Object.keys(account), ...Object.keys(records)])
    for (const key of Object.keys(summary)) {
      expect(recorded.has(key)).toBe(true)
    }
  })
})
