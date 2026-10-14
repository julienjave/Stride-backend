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

import { Test } from '@nestjs/testing'
import {
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import {
  InvitationsService,
  type InvitationSummary,
} from './invitations.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { invitations } from '../database/schema'
import { CareTeamService } from '../care-team/care-team.service'
import { EmailService } from '../email/email.service'
import { AuditService } from '../audit/audit.service'
import { UserRole } from '../users/dto/create-user.dto'

// The decisions InvitationsService makes before and around the database:
// who may act, which accounts are refused, how a race and a failed email
// are reported. The queries themselves — and the policies that check the
// same rule again — are tested against the real database in
// test/invitations.e2e-spec.ts.
describe('InvitationsService', () => {
  let service: InvitationsService
  let db: {
    query: { users: { findFirst: jest.Mock } }
    transaction: jest.Mock
    select: jest.Mock
  }
  let careTeamService: { isOnCareTeam: jest.Mock }
  let emailService: { sendInvitationEmail: jest.Mock }
  let auditService: { log: jest.Mock }

  const admin = { id: 1, activeRole: UserRole.ADMIN }
  const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER }

  // The invited account, passwordless and active unless a test says
  // otherwise.
  const account = {
    id: 42,
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    isActive: true,
    passwordHash: null as string | null,
  }

  const summary: InvitationSummary = {
    id: 100,
    status: 'pending',
    createdAt: new Date(),
    expiresAt: new Date(),
    acceptedAt: null,
    revokedAt: null,
    emailSentAt: new Date(),
    invitedBy: { id: 7, firstName: 'Alice', lastName: 'Martin' },
    revokedBy: null,
  }

  // A stand-in transaction for send()/revoke(): withRlsContext() runs two
  // set_config calls through tx.execute(), then the service's UPDATE
  // (update().set().where().returning()) and INSERT
  // (insert().values().returning()). `closedRows` is what the UPDATE closes.
  function fakeTransaction(closedRows: { id: number }[]) {
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(closedRows),
          }),
        }),
      }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 100, userId: 42 }]),
        }),
      }),
    }
    db.transaction.mockImplementation((cb: (t: typeof tx) => unknown) => cb(tx))
    return tx
  }

  beforeEach(async () => {
    db = {
      query: { users: { findFirst: jest.fn().mockResolvedValue(account) } },
      transaction: jest.fn(),
      select: jest.fn(),
    }
    careTeamService = { isOnCareTeam: jest.fn().mockResolvedValue(false) }
    emailService = {
      sendInvitationEmail: jest.fn().mockResolvedValue(undefined),
    }
    auditService = { log: jest.fn().mockResolvedValue(undefined) }

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: DRIZZLE, useValue: db },
        { provide: CareTeamService, useValue: careTeamService },
        { provide: EmailService, useValue: emailService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile()
    service = moduleRef.get(InvitationsService)

    // The read-back after a write builds the response with its own query;
    // its shape is the e2e suite's business. Stubbed here.
    jest.spyOn(service as any, 'findSummaryOrThrow').mockResolvedValue(summary)
    jest.spyOn(service as any, 'findSummaries').mockResolvedValue([summary])
  })

  // Spies on shared prototypes (Logger) must not leak into other tests.
  afterEach(() => jest.restoreAllMocks())

  // --- Who may manage an account's invitations ---------------------------

  describe('who may manage an account’s invitations', () => {
    it('answers 404 for an account that does not exist', async () => {
      db.query.users.findFirst.mockResolvedValue(undefined)
      await expect(service.listForUser(999, admin)).rejects.toThrow(
        new NotFoundException('User 999 not found'),
      )
    })

    it('lets an admin, without asking about any care team', async () => {
      await expect(service.listForUser(42, admin)).resolves.toEqual([summary])
      expect(careTeamService.isOnCareTeam).not.toHaveBeenCalled()
    })

    it("lets a practitioner on the account's care team", async () => {
      careTeamService.isOnCareTeam.mockResolvedValue(true)
      await expect(service.listForUser(42, practitioner)).resolves.toEqual([
        summary,
      ])
      // Asked the right question: THIS practitioner, THIS account.
      expect(careTeamService.isOnCareTeam).toHaveBeenCalledWith(7, 42)
    })

    it('refuses a practitioner who is not on the care team', async () => {
      await expect(service.listForUser(42, practitioner)).rejects.toThrow(
        new ForbiddenException(
          "Only an admin, or a member of this patient's care team, can manage this account's invitations",
        ),
      )
    })

    // RolesGuard already keeps patients out of these routes; the service
    // refuses them on its own too, without consulting the care team.
    it('refuses a patient, even for their own account', async () => {
      await expect(
        service.listForUser(42, { id: 42, activeRole: UserRole.PATIENT }),
      ).rejects.toThrow(ForbiddenException)
      expect(careTeamService.isOnCareTeam).not.toHaveBeenCalled()
    })
  })

  // --- send -------------------------------------------------------------

  describe('send', () => {
    it('refuses a deactivated account, before writing anything', async () => {
      db.query.users.findFirst.mockResolvedValue({
        ...account,
        isActive: false,
      })
      await expect(service.send(42, admin)).rejects.toThrow(
        new ConflictException(
          'This account is deactivated. Reactivate it before sending an invitation.',
        ),
      )
      expect(db.transaction).not.toHaveBeenCalled()
    })

    it('refuses an account that already has a password, before writing anything', async () => {
      db.query.users.findFirst.mockResolvedValue({
        ...account,
        passwordHash: 'a-bcrypt-hash',
      })
      await expect(service.send(42, admin)).rejects.toThrow(
        new ConflictException(
          'This account is already set up: its owner has chosen a password.',
        ),
      )
      expect(db.transaction).not.toHaveBeenCalled()
    })

    it('reports a first invitation as sent, and returns whether the email went out', async () => {
      fakeTransaction([])
      jest.spyOn(service, 'deliver').mockResolvedValue(true)

      await expect(service.send(42, admin)).resolves.toEqual({
        ...summary,
        emailSent: true,
      })
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'INVITATION_SENT',
          targetUserId: 42,
          details: { emailSent: true },
        }),
      )
    })

    // The UPDATE closed an open invitation: this was a resend.
    it('reports a replacement as resent', async () => {
      fakeTransaction([{ id: 99 }])
      jest.spyOn(service, 'deliver').mockResolvedValue(true)

      await service.send(42, admin)
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'INVITATION_RESENT' }),
      )
    })

    // The invitation is saved either way; the person who sent it learns
    // the email didn't go out, and can send it again.
    it('still succeeds when the email fails, saying so', async () => {
      fakeTransaction([])
      jest.spyOn(service, 'deliver').mockResolvedValue(false)

      await expect(service.send(42, admin)).resolves.toMatchObject({
        emailSent: false,
      })
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ details: { emailSent: false } }),
      )
    })

    // The partial unique index's verdict when two sends race (the error
    // as drizzle delivers it: the pg error as its cause).
    it('turns the one-open-invitation violation into a 409', async () => {
      db.transaction.mockRejectedValue({
        cause: { code: '23505', constraint: 'invitations_one_open_per_user' },
      })
      await expect(service.send(42, admin)).rejects.toThrow(
        new ConflictException(
          'Another invitation for this account was sent at the same moment. Refresh to see it.',
        ),
      )
    })

    // Only THAT constraint means "a race": any other database error is a
    // real failure and must not be disguised as a friendly 409.
    it('lets any other database error through unchanged', async () => {
      const other = { cause: { code: '23505', constraint: 'something_else' } }
      db.transaction.mockRejectedValue(other)
      await expect(service.send(42, admin)).rejects.toBe(other)
    })
  })

  // --- deliver ------------------------------------------------------------

  describe('deliver', () => {
    // db.select() is used twice: the inviter's name, then the clinic names
    // (select → from → [innerJoin →] where → [orderBy]). One chainable stub
    // answers both, in call order.
    function fakeSelects(...results: unknown[][]) {
      for (const result of results) {
        const chain: Record<string, unknown> = {}
        for (const step of ['from', 'innerJoin', 'where', 'orderBy']) {
          chain[step] = jest.fn().mockReturnValue(chain)
        }
        // A "thenable": awaiting the chain at any step yields the result,
        // the way awaiting a real Drizzle query runs it.
        chain.then = (resolve: (value: unknown) => unknown) => resolve(result)
        db.select.mockReturnValueOnce(chain)
      }
    }

    it('emails the invitation with the inviter, the clinics and the validity', async () => {
      fakeSelects(
        [{ firstName: 'Alice', lastName: 'Martin' }],
        [{ name: 'Clinique Sud' }],
      )
      fakeTransaction([])

      await expect(service.deliver(100, account, 'tok', admin)).resolves.toBe(
        true,
      )
      expect(emailService.sendInvitationEmail).toHaveBeenCalledWith({
        to: 'jane@example.com',
        rawToken: 'tok',
        firstName: 'Jane',
        invitedByName: 'Alice Martin',
        clinicNames: ['Clinique Sud'],
        validForDays: 7,
      })
    })

    it('resolves false instead of throwing when the email fails', async () => {
      fakeSelects([{ firstName: 'Alice', lastName: 'Martin' }], [])
      emailService.sendInvitationEmail.mockRejectedValue(new Error('down'))
      // Keeps the expected error log out of the test output — and lets the
      // test read what was logged.
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined)

      await expect(service.deliver(100, account, 'tok', admin)).resolves.toBe(
        false,
      )
      // The reason is part of the logged TEXT, as the only argument: a
      // second argument would be dropped by the logger (errorMessage()).
      expect(errorLog).toHaveBeenCalledWith(
        'Failed to send the invitation email to jane@example.com: down',
      )
      // Nothing recorded: email_sent_at stays NULL, which is what tells
      // the account's page the email never left.
      expect(db.transaction).not.toHaveBeenCalled()
    })

    // What the column is for. (That the right ROW gets the time — and
    // that the policies let the actor write it — is checked against the
    // real database in test/invitations.e2e-spec.ts.)
    it("records that the email was sent, under the actor's RLS context", async () => {
      fakeSelects([{ firstName: 'Alice', lastName: 'Martin' }], [])
      const tx = fakeTransaction([])

      await service.deliver(100, account, 'tok', admin)

      // withRlsContext's two set_config calls ran first.
      expect(tx.execute).toHaveBeenCalledTimes(2)
      expect(tx.update).toHaveBeenCalledWith(invitations)
      // update() returned the { set } stub; what reached set() is the
      // column list. Typed explicitly: jest's mock records are `any`.
      const { set } = tx.update.mock.results[0].value as { set: jest.Mock }
      const [values] = set.mock.calls[0] as [Record<string, unknown>]
      expect(Object.keys(values)).toEqual(['emailSentAt'])
    })

    // The email has gone; failing to RECORD it must not turn into "the
    // email failed" (false), nor into an error for the caller.
    it('still resolves true, and logs why, when recording the time fails', async () => {
      fakeSelects([{ firstName: 'Alice', lastName: 'Martin' }], [])
      db.transaction.mockRejectedValue(new Error('connection terminated'))
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined)

      await expect(service.deliver(100, account, 'tok', admin)).resolves.toBe(
        true,
      )
      expect(errorLog).toHaveBeenCalledWith(
        'The invitation email to jane@example.com was sent, but recording that failed: connection terminated',
      )
    })
  })

  // --- revoke -------------------------------------------------------------

  describe('revoke', () => {
    it('answers 404 when there is no open invitation to revoke', async () => {
      fakeTransaction([])
      await expect(service.revoke(42, admin)).rejects.toThrow(
        new NotFoundException('This account has no open invitation to revoke'),
      )
      expect(auditService.log).not.toHaveBeenCalled()
    })

    it('revokes the open invitation and records who did it', async () => {
      fakeTransaction([{ id: 99 }])
      await expect(service.revoke(42, admin)).resolves.toEqual(summary)
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          performedBy: 1,
          action: 'INVITATION_REVOKED',
          entityId: 99,
        }),
      )
    })
  })
})
