import { Test } from '@nestjs/testing'
import { SessionSerializer } from './session.serializer'
import { UsersService } from '../../users/users.service'
import { UserRole } from '../../users/dto/create-user.dto'

describe('SessionSerializer.deserializeUser', () => {
  let serializer: SessionSerializer
  let usersService: { findOne: jest.Mock }

  beforeEach(async () => {
    usersService = { findOne: jest.fn() }
    const moduleRef = await Test.createTestingModule({
      providers: [
        SessionSerializer,
        { provide: UsersService, useValue: usersService },
      ],
    }).compile()
    serializer = moduleRef.get(SessionSerializer)
  })

  // Promisifying done() rather than calling deserializeUser directly with
  // a spy callback — this is how Passport actually calls it (a
  // (err, user) => void callback, not a returned Promise), so testing it
  // this way exercises the exact same shape a real request would.
  function deserialize(sessionData: { id: number; activeRole: UserRole }) {
    return new Promise<unknown>((resolve, reject) => {
      serializer.deserializeUser(sessionData, (err, user) => {
        if (err) reject(err)
        else resolve(user)
      })
    })
  }

  it('rejects deserialization for a deactivated account', async () => {
    usersService.findOne.mockResolvedValue({
      id: 1,
      isActive: false,
      roles: [UserRole.PATIENT],
    })

    const result = await deserialize({ id: 1, activeRole: UserRole.PATIENT })

    // done(null, false) — Passport treats this as "not authenticated,"
    // the same outcome as a role that's no longer held.
    expect(result).toBe(false)
  })

  // Regression coverage for behavior that predates this session's
  // change but had no test at all until now: a role revoked mid-session
  // (still isActive, just no longer holding the role stored in THIS
  // session) should be rejected the same way.
  it("rejects deserialization when the session's stored role is no longer held", async () => {
    usersService.findOne.mockResolvedValue({
      id: 1,
      isActive: true,
      roles: [UserRole.PATIENT],
    })

    const result = await deserialize({
      id: 1,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(result).toBe(false)
  })

  it('succeeds for an active account that still holds the stored role', async () => {
    usersService.findOne.mockResolvedValue({
      id: 1,
      email: 'jane@example.com',
      isActive: true,
      roles: [UserRole.PATIENT, UserRole.PRACTITIONER],
    })

    const result = await deserialize({
      id: 1,
      activeRole: UserRole.PRACTITIONER,
    })

    expect(result).toEqual({
      id: 1,
      email: 'jane@example.com',
      isActive: true,
      roles: [UserRole.PATIENT, UserRole.PRACTITIONER],
      activeRole: UserRole.PRACTITIONER,
    })
  })

  it('propagates a real error from findOne as an error, not a rejection', async () => {
    usersService.findOne.mockRejectedValue(new Error('DB unreachable'))

    await expect(
      deserialize({ id: 1, activeRole: UserRole.PATIENT }),
    ).rejects.toThrow('DB unreachable')
  })
})
