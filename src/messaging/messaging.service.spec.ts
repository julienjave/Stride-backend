import { Test } from '@nestjs/testing'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { MessagingService } from './messaging.service'
import { UsersService } from '../users/users.service'
import { DRIZZLE } from '../database/drizzle.provider'

describe('MessagingService.createConversation', () => {
  let service: MessagingService
  let usersService: { isPatientManagedBy: jest.Mock }
  let db: {
    query: { conversations: { findFirst: jest.Mock } }
    insert: jest.Mock
  }

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() }
    db = {
      query: { conversations: { findFirst: jest.fn() } },
      insert: jest.fn(),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile()

    service = moduleRef.get(MessagingService)
  })

  it('rejects an admin starting a conversation — only practitioners and patients may', async () => {
    await expect(
      service.createConversation(
        { id: 1, activeRole: 'admin' },
        { userId: 20 },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects starting a conversation with someone outside a clinical relationship', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false)

    await expect(
      service.createConversation(
        { id: 7, activeRole: 'practitioner' },
        { userId: 20 },
      ),
    ).rejects.toThrow(ForbiddenException)
  })

  it('returns the existing conversation instead of creating a duplicate', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.conversations.findFirst.mockResolvedValue({
      id: 900,
      practitionerId: 7,
      patientId: 20,
    })

    const result = await service.createConversation(
      { id: 7, activeRole: 'practitioner' },
      { userId: 20 },
    )

    expect(result).toEqual({ id: 900, practitionerId: 7, patientId: 20 })
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('creates a new conversation when none exists yet, resolving practitionerId/patientId from the caller role', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true)
    db.query.conversations.findFirst.mockResolvedValue(undefined)
    db.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 901, practitionerId: 7, patientId: 20 }]),
      }),
    })

    const result = await service.createConversation(
      { id: 7, activeRole: 'practitioner' },
      { userId: 20 },
    )

    expect(result).toEqual({ id: 901, practitionerId: 7, patientId: 20 })
  })
})

describe('MessagingService.archiveConversation / unarchiveConversation', () => {
  let service: MessagingService
  let db: {
    query: { conversations: { findFirst: jest.Mock } }
    update: jest.Mock
  }
  let setArgs: any

  beforeEach(async () => {
    setArgs = undefined
    db = {
      query: {
        conversations: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 900, practitionerId: 7, patientId: 20 }),
        },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockImplementation((values: any) => {
          setArgs = values
          return {
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 900 }]),
            }),
          }
        }),
      }),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: {} },
      ],
    }).compile()

    service = moduleRef.get(MessagingService)
  })

  it("only ever writes the archiving PRACTITIONER's own column, never the patient's", async () => {
    await service.archiveConversation(900, {
      id: 7,
      activeRole: 'practitioner',
    })

    expect(setArgs).toHaveProperty('practitionerArchivedAt')
    expect(setArgs).not.toHaveProperty('patientArchivedAt')
  })

  it("only ever writes the archiving PATIENT's own column, never the practitioner's", async () => {
    await service.archiveConversation(900, { id: 20, activeRole: 'patient' })

    expect(setArgs).toHaveProperty('patientArchivedAt')
    expect(setArgs).not.toHaveProperty('practitionerArchivedAt')
  })

  it('rejects a non-participant from archiving the conversation at all', async () => {
    await expect(
      service.archiveConversation(900, { id: 999, activeRole: 'practitioner' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it("clears only the calling role's own archived-at column on unarchive", async () => {
    await service.unarchiveConversation(900, {
      id: 7,
      activeRole: 'practitioner',
    })

    expect(setArgs).toEqual({ practitionerArchivedAt: null })
  })

  // assertParticipant() itself lets an admin through (admins bypass the
  // "not a participant" check everywhere else), so this is a DIFFERENT
  // rejection path than the "non-participant" test above — the explicit
  // admin check inside archiveConversation/unarchiveConversation, added
  // because archiving is deliberately a participant-only inbox concern that
  // admin oversight should not touch.
  it('rejects an admin from archiving a conversation, even though they pass the participant check', async () => {
    await expect(
      service.archiveConversation(900, { id: 1, activeRole: 'admin' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects an admin from unarchiving a conversation, even though they pass the participant check', async () => {
    await expect(
      service.unarchiveConversation(900, { id: 1, activeRole: 'admin' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('allows the actual patient participant to unarchive the conversation', async () => {
    await service.unarchiveConversation(900, { id: 20, activeRole: 'patient' })

    expect(setArgs).toEqual({ patientArchivedAt: null })
  })
})

describe('MessagingService.deleteMessage', () => {
  let service: MessagingService
  let db: {
    query: {
      conversations: { findFirst: jest.Mock }
      messages: { findFirst: jest.Mock }
    }
    update: jest.Mock
  }

  beforeEach(async () => {
    db = {
      query: {
        conversations: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 900, practitionerId: 7, patientId: 20 }),
        },
        messages: { findFirst: jest.fn() },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest
              .fn()
              .mockResolvedValue([
                { id: 50, deletedAt: new Date(), messageBody: 'hi' },
              ]),
          }),
        }),
      }),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: {} },
      ],
    }).compile()

    service = moduleRef.get(MessagingService)
  })

  it('rejects deleting a message sent by someone else', async () => {
    db.query.messages.findFirst.mockResolvedValue({
      id: 50,
      senderId: 999,
      readAt: null,
      sentAt: new Date(),
    })

    await expect(
      service.deleteMessage(900, 50, { id: 7, activeRole: 'practitioner' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects deleting a message that has already been read', async () => {
    db.query.messages.findFirst.mockResolvedValue({
      id: 50,
      senderId: 7,
      readAt: new Date(),
      sentAt: new Date(),
    })

    await expect(
      service.deleteMessage(900, 50, { id: 7, activeRole: 'practitioner' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects deleting a message outside the 15 minute window, even if still unread', async () => {
    db.query.messages.findFirst.mockResolvedValue({
      id: 50,
      senderId: 7,
      readAt: null,
      sentAt: new Date(Date.now() - 16 * 60 * 1000),
    })

    await expect(
      service.deleteMessage(900, 50, { id: 7, activeRole: 'practitioner' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('deletes an unread message from the sender within the window', async () => {
    db.query.messages.findFirst.mockResolvedValue({
      id: 50,
      senderId: 7,
      readAt: null,
      sentAt: new Date(),
    })

    const result = await service.deleteMessage(900, 50, {
      id: 7,
      activeRole: 'practitioner',
    })

    // toPublicMessage() replaces the body with a tombstone for everyone,
    // sender included, once deletedAt is set.
    expect(result.messageBody).toBe('[message deleted]')
  })

  it('throws NotFoundException for a message id that does not belong to this conversation', async () => {
    db.query.messages.findFirst.mockResolvedValue(undefined)

    await expect(
      service.deleteMessage(900, 999, { id: 7, activeRole: 'practitioner' }),
    ).rejects.toThrow(NotFoundException)
  })
})

describe('MessagingService.assertParticipant (via getMessages)', () => {
  let service: MessagingService
  let db: {
    query: {
      conversations: { findFirst: jest.Mock }
      messages: { findMany: jest.Mock }
    }
  }

  beforeEach(async () => {
    db = {
      query: {
        conversations: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 900, practitionerId: 7, patientId: 20 }),
        },
        messages: { findMany: jest.fn().mockResolvedValue([]) },
      },
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: {} },
      ],
    }).compile()

    service = moduleRef.get(MessagingService)
  })

  it('allows the practitioner participant to read messages', async () => {
    await expect(
      service.getMessages(900, { id: 7, activeRole: 'practitioner' }),
    ).resolves.toEqual([])
  })

  it('allows the patient participant to read messages', async () => {
    await expect(
      service.getMessages(900, { id: 20, activeRole: 'patient' }),
    ).resolves.toEqual([])
  })

  it('allows an admin to read any conversation', async () => {
    await expect(
      service.getMessages(900, { id: 1, activeRole: 'admin' }),
    ).resolves.toEqual([])
  })

  it('rejects a practitioner who is not part of this conversation', async () => {
    await expect(
      service.getMessages(900, { id: 999, activeRole: 'practitioner' }),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects a patient who is not part of this conversation', async () => {
    await expect(
      service.getMessages(900, { id: 999, activeRole: 'patient' }),
    ).rejects.toThrow(ForbiddenException)
  })
})
