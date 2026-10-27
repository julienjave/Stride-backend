import { Test } from '@nestjs/testing'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { DrizzleQueryError, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  CareTeamService,
  containsPattern,
  CREATED_PATIENT_REASON,
  DIRECTORY_RESULT_LIMIT,
  type Actor,
  type CareTeamEntry,
  type PatientCareTeamEntry,
} from './care-team.service'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { AuditService } from '../audit/audit.service'
import { StorageService } from '../storage/storage.service'
import { UserRole } from '../users/dto/create-user.dto'
import {
  CARE_TEAM_NO_OVERLAP,
  PG_EXCLUSION_VIOLATION,
} from '../database/pg-errors'

// What these unit tests cover — and what they deliberately don't.
//
// CareTeamService makes two kinds of decisions:
//   1. WHO may do WHAT, and what happens then (which error, what gets
//      inserted, what gets audited, in which order). That's plain
//      TypeScript, tested here.
//   2. The care-team RULE itself, written as SQL (active period, shared
//      clinic). A mocked database can't tell whether SQL is right — it
//      returns whatever the test says. That half is tested against a real
//      Postgres in test/care-team.e2e-spec.ts, including a parity test with
//      the SQL function the RLS policies use.
//
// So here, the helpers that run those SQL queries (sharesClinic,
// hasActiveRole, findEntries…) are replaced with jest.spyOn, and each test
// states their answers directly: "this caller shares a clinic with the
// patient", "this user is not a practitioner", and so on.

const practitioner: Actor = { id: 4, activeRole: UserRole.PRACTITIONER }
const colleague = 5
const admin: Actor = { id: 1, activeRole: UserRole.ADMIN }
const PATIENT_ID = 10
// When a link began, as the database returns it (pinned far from today).
const STARTED = new Date('2031-03-01T09:00:00Z')

// Turns a Drizzle `sql` object into what Postgres would actually receive:
// the SQL text (with $1, $2… placeholders) and the parameter values. It's
// Drizzle's own renderer, so nested fragments and column names come out
// exactly as in a real query.
const dialect = new PgDialect()
function render(query: unknown) {
  return dialect.sqlToQuery(query as SQL)
}

// A reason is set (not null) so the tests can tell "removed for the
// patient" from "there was none".
function entry(id: number): CareTeamEntry {
  return {
    id,
    patientId: PATIENT_ID,
    practitioner: {
      id: 4,
      firstName: 'Pat',
      lastName: 'Rac',
      avatarUrl: null,
      specialties: ['Knee'],
      bio: null,
    },
    sharedClinics: [{ id: 3, name: 'North' }],
    startedAt: new Date('2026-09-01T00:00:00Z'),
    endsAt: null,
    isActive: true,
    reason: 'Holiday cover',
    createdBy: null,
    endedBy: null,
  }
}

// The same entry as the patient receives it: every key but `reason`.
function patientEntry(id: number): PatientCareTeamEntry {
  const { reason: _removed, ...rest } = entry(id)
  return rest
}

function exclusionError() {
  return new DrizzleQueryError(
    'insert into "care_team_members" ...',
    [],
    Object.assign(
      new Error('conflicting key value violates exclusion constraint'),
      {
        code: PG_EXCLUSION_VIOLATION,
        constraint: CARE_TEAM_NO_OVERLAP,
      },
    ),
  )
}

describe('CareTeamService', () => {
  let service: CareTeamService
  // Since the audit review, every write's entry goes through
  // logInTransaction (inside the write's transaction); `auditLog` is the
  // old after-commit log(), kept to assert it is NOT used.
  let auditLog: jest.Mock
  let auditInTx: jest.Mock<Promise<void>, [unknown, Record<string, unknown>]>
  let presign: jest.Mock
  // A fake Drizzle client. withRlsContext() calls db.transaction(fn) and,
  // inside, tx.execute() twice to set the session context; here tx === db,
  // so the query-builder mocks each test sets up on `db` serve both.
  let db: {
    transaction: jest.Mock
    execute: jest.Mock
    select: jest.Mock
    selectDistinct: jest.Mock
    insert: jest.Mock
    update: jest.Mock
  }

  beforeEach(async () => {
    db = {
      transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(db)),
      execute: jest.fn().mockResolvedValue(undefined),
      select: jest.fn(),
      selectDistinct: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        CareTeamService,
        { provide: DRIZZLE, useValue: db },
        {
          provide: StorageService,
          useValue: {
            getPresignedUrlOrNull: jest.fn((key: string | null) =>
              Promise.resolve(key ? `https://signed/${key}` : null),
            ),
          },
        },
        {
          provide: AuditService,
          useValue: {
            log: jest.fn().mockResolvedValue(undefined),
            logInTransaction: jest
              .fn<Promise<void>, [unknown, Record<string, unknown>]>()
              .mockResolvedValue(undefined),
          },
        },
      ],
    }).compile()
    service = moduleRef.get(CareTeamService)
    auditLog = moduleRef.get<{ log: jest.Mock }>(AuditService).log
    auditInTx = moduleRef.get<{ logInTransaction: typeof auditInTx }>(
      AuditService,
    ).logInTransaction
    presign = moduleRef.get<{ getPresignedUrlOrNull: jest.Mock }>(
      StorageService,
    ).getPresignedUrlOrNull
  })

  // The two set_config() calls withRlsContext() made — i.e. whose point of
  // view a query ran from — as [setting, value] pairs.
  function rlsContextSet() {
    return (db.execute.mock.calls as unknown[][]).map((call) => {
      const { sql, params } = render(call[0])
      return [sql.match(/'(app\.[a-z_]+)'/)?.[1], params[0]]
    })
  }

  // --- The data helpers, replaced (see the note at the top) ---------------

  // `patient`: does the id hold the patient role (else the 404);
  // `patientActive`: is that account active (a deactivated patient keeps
  // their care team — decisions §21). `practitioner`: is the practitioner
  // named an ACTIVE one.
  function givenRoles(roles: {
    patient?: boolean
    patientActive?: boolean
    practitioner?: boolean
  }) {
    jest
      .spyOn(service as any, 'findPatientAccount')
      .mockResolvedValue(
        (roles.patient ?? true)
          ? { isActive: roles.patientActive ?? true }
          : null,
      )
    return jest
      .spyOn(service as any, 'hasActiveRole')
      .mockImplementation((_id: unknown, role: unknown) =>
        Promise.resolve(
          role === UserRole.PRACTITIONER ? (roles.practitioner ?? true) : false,
        ),
      )
  }

  // sharesClinic(a, b) answers from a list of pairs that DO share a clinic.
  function givenSharedClinics(pairs: [number, number][]) {
    return jest
      .spyOn(service, 'sharesClinic')
      .mockImplementation((a, b) =>
        Promise.resolve(
          pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a)),
        ),
      )
  }

  function givenEntries(entries: CareTeamEntry[] = [entry(77)]) {
    return jest.spyOn(service as any, 'findEntries').mockResolvedValue(entries)
  }

  function mockInsertReturning(result: unknown) {
    const values = jest.fn().mockReturnValue({
      returning:
        result instanceof Error
          ? jest.fn().mockRejectedValue(result)
          : jest.fn().mockResolvedValue(result),
    })
    db.insert.mockReturnValue({ values })
    return values
  }

  function mockUpdateReturning(rows: unknown[]) {
    const set = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(rows),
      }),
    })
    db.update.mockReturnValue({ set })
    return set
  }

  // === The two access levels ==============================================

  describe('isOnCareTeam', () => {
    function mockLinkRows(rows: unknown[]) {
      db.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      })
    }

    it('is true when a matching link is found, false otherwise', async () => {
      mockLinkRows([{ id: 1 }])
      await expect(service.isOnCareTeam(4, PATIENT_ID)).resolves.toBe(true)
      mockLinkRows([])
      await expect(service.isOnCareTeam(4, PATIENT_ID)).resolves.toBe(false)
    })

    // care_team_members has FORCE ROW LEVEL SECURITY: without a session
    // context the query would see no rows at all, and every answer would
    // be "no". It must run as the practitioner being checked.
    it("runs from the checked practitioner's own point of view", async () => {
      mockLinkRows([])
      await service.isOnCareTeam(4, PATIENT_ID)

      expect(db.transaction).toHaveBeenCalled()
      expect(rlsContextSet()).toEqual([
        ['app.current_user_id', '4'],
        ['app.current_role', UserRole.PRACTITIONER],
      ])
    })
  })

  describe('sharesClinic', () => {
    it.each([
      [[{ shared: true }], true],
      [[{ shared: false }], false],
      [[], false],
    ])('reads the EXISTS answer (%j → %s)', async (rows, expected) => {
      db.execute.mockResolvedValue({ rows })
      await expect(service.sharesClinic(4, PATIENT_ID)).resolves.toBe(expected)
    })

    it('asks about the two given users, through user_clinics', async () => {
      db.execute.mockResolvedValue({ rows: [{ shared: true }] })
      await service.sharesClinic(4, PATIENT_ID)

      const { sql, params } = render(
        (db.execute.mock.calls as unknown[][])[0][0],
      )
      expect(sql).toContain('"user_clinics"')
      // The two ids travel as query parameters ($1, $2), never pasted into
      // the SQL text itself.
      expect(params).toEqual([4, PATIENT_ID])
    })
  })

  describe('findPatientIdsForPractitioner', () => {
    it('returns the patient ids, queried as that practitioner', async () => {
      db.selectDistinct.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest
            .fn()
            .mockResolvedValue([{ patientId: 10 }, { patientId: 12 }]),
        }),
      })

      await expect(service.findPatientIdsForPractitioner(4)).resolves.toEqual([
        10, 12,
      ])
      expect(rlsContextSet()).toEqual([
        ['app.current_user_id', '4'],
        ['app.current_role', UserRole.PRACTITIONER],
      ])
    })
  })

  // === GET /users/:id/care-team ==========================================

  describe('listForPatient', () => {
    it('404s when the id is not a patient', async () => {
      givenRoles({ patient: false })
      const findEntries = givenEntries()

      await expect(
        service.listForPatient(PATIENT_ID, admin, false),
      ).rejects.toThrow(
        new NotFoundException(`Patient ${PATIENT_ID} not found`),
      )
      expect(findEntries).not.toHaveBeenCalled()
    })

    // Decisions §18 / §21: a deactivated patient keeps their care team, and
    // whoever could read it still can (it was a 404 for everyone).
    it.each<[string, Actor, [number, number][]]>([
      ['an admin', admin, []],
      ['a practitioner sharing a clinic', practitioner, [[4, PATIENT_ID]]],
    ])(
      "lets %s see a DEACTIVATED patient's team",
      async (_who, actor, shared) => {
        givenRoles({ patientActive: false })
        givenSharedClinics(shared)
        givenEntries()

        await expect(
          service.listForPatient(PATIENT_ID, actor, true),
        ).resolves.toStrictEqual([entry(77)])
      },
    )

    // toStrictEqual: the patient's answer must not have a `reason` key at
    // all (toEqual treats a missing key and an undefined one alike).
    it.each<[string, Actor, [number, number][], object[]]>([
      ['an admin', admin, [], [entry(77)]],
      [
        'the patient themselves — without the staff-only reason',
        { id: PATIENT_ID, activeRole: UserRole.PATIENT },
        [],
        [patientEntry(77)],
      ],
      [
        'a practitioner sharing a clinic (directory level)',
        practitioner,
        [[4, PATIENT_ID]],
        [entry(77)],
      ],
    ])('lets %s see the team', async (_who, actor, shared, expected) => {
      givenRoles({})
      givenSharedClinics(shared)
      const findEntries = givenEntries()

      await expect(
        service.listForPatient(PATIENT_ID, actor, false),
      ).resolves.toStrictEqual(expected)
      expect(findEntries).toHaveBeenCalledWith(actor, {
        patientId: PATIENT_ID,
        activeOnly: true,
      })
    })

    it.each<[string, Actor]>([
      ['a practitioner sharing no clinic', practitioner],
      ['another patient', { id: 99, activeRole: UserRole.PATIENT }],
      // Same person, but acting as a practitioner: being the patient only
      // counts while acting as the patient.
      [
        'the patient, acting in another role',
        { id: PATIENT_ID, activeRole: UserRole.PRACTITIONER },
      ],
    ])('refuses %s', async (_who, actor) => {
      givenRoles({})
      givenSharedClinics([])
      const findEntries = givenEntries()

      await expect(
        service.listForPatient(PATIENT_ID, actor, false),
      ).rejects.toThrow(ForbiddenException)
      expect(findEntries).not.toHaveBeenCalled()
    })

    it('includes ended links when asked — for the patient too (their own history)', async () => {
      givenRoles({})
      const patient: Actor = { id: PATIENT_ID, activeRole: UserRole.PATIENT }
      const findEntries = givenEntries()

      // The history is the patient's too, so it loses the reason as well.
      await expect(
        service.listForPatient(PATIENT_ID, patient, true),
      ).resolves.toStrictEqual([patientEntry(77)])

      expect(findEntries).toHaveBeenCalledWith(patient, {
        patientId: PATIENT_ID,
        activeOnly: false,
      })
    })
  })

  // === POST /users/:id/care-team =========================================

  describe('addMember', () => {
    function givenAllowed() {
      givenRoles({})
      givenSharedClinics([
        [4, PATIENT_ID],
        [colleague, PATIENT_ID],
      ])
      givenEntries([entry(55)])
    }

    // The link and its entry in ONE transaction (tx === db in this mock):
    // the entry follows the insert inside it, so a link can't exist without
    // its trail — the accountability this route rests on.
    it('with an empty body, the practitioner joins: inserted, audited in the same transaction, and returned', async () => {
      givenAllowed()
      const values = mockInsertReturning([
        {
          id: 55,
          practitionerId: 4,
          startedAt: STARTED,
          endsAt: null,
          reason: null,
        },
      ])

      await expect(
        service.addMember(PATIENT_ID, {}, practitioner),
      ).resolves.toEqual(entry(55))

      expect(values).toHaveBeenCalledWith({
        patientId: PATIENT_ID,
        practitionerId: 4,
        endsAt: null,
        createdBy: 4,
        reason: null,
      })
      expect(auditInTx).toHaveBeenCalledTimes(1)
      const [entryTx, logged] = auditInTx.mock.calls[0]
      expect(entryTx).toBe(db)
      expect(logged).toStrictEqual({
        performedBy: 4,
        action: 'CARE_TEAM_JOINED',
        targetUserId: PATIENT_ID,
        entityType: 'care_team_members',
        entityId: 55,
        details: {
          practitionerId: 4,
          startedAt: STARTED,
          endsAt: null,
          reason: null,
        },
      })
      expect(auditInTx.mock.invocationCallOrder[0]).toBeGreaterThan(
        values.mock.invocationCallOrder[0],
      )
      expect(auditLog).not.toHaveBeenCalled()
    })

    it('adds a colleague, with a planned end and a reason, audited as MEMBER_ADDED', async () => {
      givenAllowed()
      const endsAt = new Date(Date.now() + 7 * 24 * 3600 * 1000)
      const values = mockInsertReturning([
        {
          id: 56,
          practitionerId: colleague,
          startedAt: STARTED,
          endsAt,
          reason: 'Holiday cover',
        },
      ])

      await service.addMember(
        PATIENT_ID,
        {
          practitionerId: colleague,
          endsAt: endsAt.toISOString(),
          reason: 'Holiday cover',
        },
        practitioner,
      )

      expect(values).toHaveBeenCalledWith({
        patientId: PATIENT_ID,
        practitionerId: colleague,
        endsAt,
        createdBy: 4,
        reason: 'Holiday cover',
      })
      const [, logged] = auditInTx.mock.calls[0]
      expect(logged).toStrictEqual({
        performedBy: 4,
        action: 'CARE_TEAM_MEMBER_ADDED',
        targetUserId: PATIENT_ID,
        entityType: 'care_team_members',
        entityId: 56,
        details: {
          practitionerId: colleague,
          startedAt: STARTED,
          endsAt,
          reason: 'Holiday cover',
        },
      })
    })

    // Every 400 below asserts its exact message, not only "some
    // BadRequestException": several different checks answer 400, and a
    // mutation check found two tests passing because a LATER check failed
    // instead of the one being tested.
    it('requires an admin to say whom to add', async () => {
      givenAllowed()
      await expect(service.addMember(PATIENT_ID, {}, admin)).rejects.toThrow(
        new BadRequestException(
          'practitionerId is required when an admin adds someone to a care team',
        ),
      )
      expect(db.insert).not.toHaveBeenCalled()
    })

    it("lets an admin add a practitioner of the patient's clinic without sharing it themselves", async () => {
      givenAllowed()
      const values = mockInsertReturning([
        { id: 57, practitionerId: 4, endsAt: null, reason: null },
      ])

      await service.addMember(PATIENT_ID, { practitionerId: 4 }, admin)

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ practitionerId: 4, createdBy: admin.id }),
      )
    })

    it('refuses to put a patient on their own care team', async () => {
      givenAllowed()
      await expect(
        service.addMember(PATIENT_ID, { practitionerId: PATIENT_ID }, admin),
      ).rejects.toThrow(
        new BadRequestException('A patient cannot be on their own care team'),
      )
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('404s for an id that is not a patient', async () => {
      givenAllowed()
      givenRoles({ patient: false })
      await expect(
        service.addMember(PATIENT_ID, {}, practitioner),
      ).rejects.toThrow(
        new NotFoundException(`Patient ${PATIENT_ID} not found`),
      )
      expect(db.insert).not.toHaveBeenCalled()
    })

    // Decisions §21: nobody new on a deactivated patient's team — reactivate
    // first. Both ways in: a practitioner joining, an admin adding.
    it.each<[string, Actor, { practitionerId?: number }]>([
      ['a practitioner joining', practitioner, {}],
      ['an admin adding a practitioner', admin, { practitionerId: colleague }],
    ])(
      "refuses %s to a DEACTIVATED patient's team (409), inserting nothing",
      async (_who, actor, dto) => {
        givenAllowed()
        givenRoles({ patientActive: false })
        await expect(service.addMember(PATIENT_ID, dto, actor)).rejects.toThrow(
          new ConflictException(
            "This patient's account is deactivated. Reactivate it to add someone to their care team.",
          ),
        )
        expect(db.insert).not.toHaveBeenCalled()
      },
    )

    // The 409 comes after the access check: someone who may not act on this
    // patient gets the 403 they'd get anyway, not news of the account.
    it('answers a practitioner of another clinic with the 403, deactivated or not', async () => {
      givenAllowed()
      givenRoles({ patientActive: false })
      givenSharedClinics([[colleague, PATIENT_ID]])
      await expect(
        service.addMember(PATIENT_ID, {}, practitioner),
      ).rejects.toThrow(
        new ForbiddenException(
          'You can only join the care team of a patient in one of your clinics',
        ),
      )
    })

    it('refuses to add someone who is not an active practitioner', async () => {
      givenAllowed()
      givenRoles({ practitioner: false })
      await expect(
        service.addMember(
          PATIENT_ID,
          { practitionerId: colleague },
          practitioner,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          `User ${colleague} is not an active practitioner`,
        ),
      )
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('403s a practitioner who shares no clinic with the patient', async () => {
      givenAllowed()
      givenSharedClinics([[colleague, PATIENT_ID]])
      await expect(
        service.addMember(
          PATIENT_ID,
          { practitionerId: colleague },
          practitioner,
        ),
      ).rejects.toThrow(ForbiddenException)
      expect(db.insert).not.toHaveBeenCalled()
    })

    it("refuses to add a colleague who doesn't work at any of the patient's clinics", async () => {
      givenAllowed()
      givenSharedClinics([[4, PATIENT_ID]])
      await expect(
        service.addMember(
          PATIENT_ID,
          { practitionerId: colleague },
          practitioner,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          "This practitioner does not work at any of this patient's clinics",
        ),
      )
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('refuses a planned end that is not in the future', async () => {
      givenAllowed()
      await expect(
        service.addMember(
          PATIENT_ID,
          { endsAt: new Date(Date.now() - 1000).toISOString() },
          practitioner,
        ),
      ).rejects.toThrow(new BadRequestException('endsAt must be in the future'))
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('turns the overlap constraint into a 409, and audits nothing', async () => {
      givenAllowed()
      mockInsertReturning(exclusionError())

      await expect(
        service.addMember(PATIENT_ID, {}, practitioner),
      ).rejects.toThrow(ConflictException)
      expect(auditInTx).not.toHaveBeenCalled()
      expect(auditLog).not.toHaveBeenCalled()
    })

    it('lets any OTHER database error through unchanged', async () => {
      givenAllowed()
      const boom = new Error('connection lost')
      mockInsertReturning(boom)

      await expect(
        service.addMember(PATIENT_ID, {}, practitioner),
      ).rejects.toBe(boom)
    })

    it('inserts with the caller as the RLS context', async () => {
      givenAllowed()
      mockInsertReturning([
        { id: 55, practitionerId: 4, endsAt: null, reason: null },
      ])

      await service.addMember(PATIENT_ID, {}, practitioner)

      expect(rlsContextSet()).toEqual([
        ['app.current_user_id', '4'],
        ['app.current_role', UserRole.PRACTITIONER],
      ])
    })
  })

  // === POST /users/:id/care-team/:practitionerId/end ======================

  describe('endMembership', () => {
    it("403s a practitioner ending someone else's membership, before touching anything", async () => {
      await expect(
        service.endMembership(PATIENT_ID, colleague, practitioner),
      ).rejects.toThrow(ForbiddenException)
      expect(db.update).not.toHaveBeenCalled()
    })

    it.each<[string, Actor]>([
      ['the practitioner themselves', practitioner],
      ['an admin', admin],
    ])(
      'lets %s end it: end date + ended_by set, audited, returned',
      async (_who, actor) => {
        givenEntries([entry(60)])
        const endedAt = new Date('2031-03-04T10:00:00Z')
        const set = mockUpdateReturning([
          { id: 60, startedAt: STARTED, endsAt: endedAt },
        ])

        await expect(
          service.endMembership(PATIENT_ID, 4, actor),
        ).resolves.toEqual(entry(60))

        const changes = (
          set.mock.calls as [{ endsAt: SQL; endedBy: number }][]
        )[0][0]
        expect(changes.endedBy).toBe(actor.id)
        // ends_at = the DATABASE's now(), not the app server's clock.
        expect(render(changes.endsAt).sql).toBe('now()')
        // In the same transaction, with the period the link covered — who
        // could read this patient's file, from when to when.
        const [entryTx, logged] = auditInTx.mock.calls[0]
        expect(entryTx).toBe(db)
        expect(logged).toStrictEqual({
          performedBy: actor.id,
          action: 'CARE_TEAM_ENDED',
          targetUserId: PATIENT_ID,
          entityType: 'care_team_members',
          entityId: 60,
          details: { practitionerId: 4, startedAt: STARTED, endsAt: endedAt },
        })
        expect(auditLog).not.toHaveBeenCalled()
      },
    )

    it('404s when there is no active membership to end, and audits nothing', async () => {
      mockUpdateReturning([])

      await expect(
        service.endMembership(PATIENT_ID, 4, practitioner),
      ).rejects.toThrow(NotFoundException)
      expect(auditInTx).not.toHaveBeenCalled()
      expect(auditLog).not.toHaveBeenCalled()
    })
  })

  // === GET /directory/patients ===========================================

  describe('searchDirectory', () => {
    function mockMyClinics(clinicIds: number[]) {
      db.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest
            .fn()
            .mockResolvedValue(clinicIds.map((clinicId) => ({ clinicId }))),
        }),
      })
    }

    it('returns nothing, without searching, for a practitioner in no clinic', async () => {
      mockMyClinics([])

      await expect(service.searchDirectory(4, 'mar')).resolves.toEqual([])
      expect(db.selectDistinct).not.toHaveBeenCalled()
    })

    it("returns directory data only: shared clinics per patient, photo, and whether they're mine", async () => {
      mockMyClinics([3, 8])
      const limit = jest.fn().mockResolvedValue([
        {
          id: 10,
          firstName: 'Marie',
          lastName: 'Martin',
          avatarPath: 'avatars/10/a.jpg',
          dateOfBirth: '1990-01-01',
        },
        {
          id: 11,
          firstName: 'Mark',
          lastName: 'Moss',
          avatarPath: null,
          dateOfBirth: null,
        },
      ])
      db.selectDistinct.mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              leftJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  orderBy: jest.fn().mockReturnValue({ limit }),
                }),
              }),
            }),
          }),
        }),
      })
      // The shared clinics of the whole page of results, in one query.
      db.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              { userId: 10, id: 3, name: 'North' },
              { userId: 10, id: 8, name: 'South' },
              { userId: 11, id: 8, name: 'South' },
            ]),
          }),
        }),
      })
      const mine = jest
        .spyOn(service, 'findPatientIdsForPractitioner')
        .mockResolvedValue([11])

      const result = await service.searchDirectory(4, 'ma')

      expect(result).toEqual([
        {
          id: 10,
          firstName: 'Marie',
          lastName: 'Martin',
          avatarUrl: 'https://signed/avatars/10/a.jpg',
          dateOfBirth: '1990-01-01',
          sharedClinics: [
            { id: 3, name: 'North' },
            { id: 8, name: 'South' },
          ],
          onMyCareTeam: false,
        },
        {
          id: 11,
          firstName: 'Mark',
          lastName: 'Moss',
          avatarUrl: null,
          dateOfBirth: null,
          sharedClinics: [{ id: 8, name: 'South' }],
          onMyCareTeam: true,
        },
      ])
      expect(limit).toHaveBeenCalledWith(DIRECTORY_RESULT_LIMIT)
      // "Mine" is the care-team rule, for THIS practitioner.
      expect(mine).toHaveBeenCalledWith(4)
      expect(presign).toHaveBeenCalledWith(
        'avatars/10/a.jpg',
        expect.any(Number),
      )
    })
  })

  describe('listCandidates', () => {
    // The first select(): the patient's clinic ids.
    function mockPatientClinics(clinicIds: number[]) {
      db.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest
            .fn()
            .mockResolvedValue(clinicIds.map((clinicId) => ({ clinicId }))),
        }),
      })
    }

    it('404s for someone who is not a patient', async () => {
      givenRoles({ patient: false })
      await expect(
        service.listCandidates(9, { id: 1, activeRole: UserRole.ADMIN }),
      ).rejects.toThrow(new NotFoundException('Patient 9 not found'))
    })

    it('refuses a practitioner of another clinic, and the patient themselves (403)', async () => {
      givenRoles({})
      givenSharedClinics([])
      for (const actor of [
        { id: 4, activeRole: UserRole.PRACTITIONER },
        { id: 9, activeRole: UserRole.PATIENT },
      ]) {
        await expect(service.listCandidates(9, actor)).rejects.toThrow(
          new ForbiddenException(
            "You can't add anyone to this patient's care team",
          ),
        )
      }
      expect(db.select).not.toHaveBeenCalled()
    })

    // Decisions §21: the candidates exist only to be added.
    it('refuses the candidates of a DEACTIVATED patient (409) — after the 403', async () => {
      givenRoles({ patientActive: false })
      givenSharedClinics([[4, 9]])
      for (const actor of [
        { id: 1, activeRole: UserRole.ADMIN },
        { id: 4, activeRole: UserRole.PRACTITIONER },
      ]) {
        await expect(service.listCandidates(9, actor)).rejects.toThrow(
          new ConflictException(
            "This patient's account is deactivated. Reactivate it to add someone to their care team.",
          ),
        )
      }
      await expect(
        service.listCandidates(9, { id: 5, activeRole: UserRole.PRACTITIONER }),
      ).rejects.toThrow(ForbiddenException)
      expect(db.select).not.toHaveBeenCalled()
    })

    it('returns nothing, without searching, for a patient in no clinic', async () => {
      givenRoles({})
      mockPatientClinics([])
      await expect(
        service.listCandidates(9, { id: 1, activeRole: UserRole.ADMIN }),
      ).resolves.toEqual([])
      expect(db.selectDistinct).not.toHaveBeenCalled()
    })

    it("lists the practitioners of the patient's clinics: specialties, shared clinics, already on the team or not", async () => {
      givenRoles({})
      givenSharedClinics([[4, 9]])
      mockPatientClinics([3, 8])
      db.selectDistinct.mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              leftJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  orderBy: jest.fn().mockResolvedValue([
                    {
                      id: 4,
                      firstName: 'Sam',
                      lastName: 'Okafor',
                      avatarPath: 'avatars/4/a.jpg',
                      specialties: ['Sports'],
                    },
                    {
                      id: 5,
                      firstName: 'Blake',
                      lastName: 'Martin',
                      avatarPath: null,
                      // A missing profile (LEFT JOIN) still lists the person.
                      specialties: null,
                    },
                  ]),
                }),
              }),
            }),
          }),
        }),
      })
      // The shared clinics of all candidates, in one query.
      db.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([
                { userId: 4, id: 3, name: 'North' },
                { userId: 5, id: 8, name: 'South' },
              ]),
            }),
          }),
        }),
      })
      // Who is on the team now (read under the caller's RLS context).
      db.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ practitionerId: 4 }]),
        }),
      })

      const result = await service.listCandidates(9, {
        id: 4,
        activeRole: UserRole.PRACTITIONER,
      })

      expect(result).toStrictEqual([
        {
          id: 4,
          firstName: 'Sam',
          lastName: 'Okafor',
          avatarUrl: 'https://signed/avatars/4/a.jpg',
          specialties: ['Sports'],
          sharedClinics: [{ id: 3, name: 'North' }],
          onCareTeam: true,
        },
        {
          id: 5,
          firstName: 'Blake',
          lastName: 'Martin',
          avatarUrl: null,
          specialties: [],
          sharedClinics: [{ id: 8, name: 'South' }],
          onCareTeam: false,
        },
      ])
      // The team was read as the caller, under RLS.
      expect(rlsContextSet()).toContainEqual(['app.current_user_id', '4'])
    })
  })

  describe('containsPattern', () => {
    it('matches the text anywhere', () => {
      expect(containsPattern('mar')).toBe('%mar%')
    })

    // % and _ are LIKE wildcards: someone searching "50%" must find "50%",
    // not "50 anything".
    it('escapes LIKE wildcards and the escape character itself', () => {
      expect(containsPattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%')
    })
  })

  // === Used inside other services' transactions ===========================

  describe('linkCreator', () => {
    it("inserts the creator's link on the given transaction, with the fixed reason", async () => {
      const values = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 900 }]),
      })
      const tx = { insert: jest.fn().mockReturnValue({ values }) }

      await expect(
        service.linkCreator(tx as unknown as DrizzleDb, PATIENT_ID, 4),
      ).resolves.toEqual({ id: 900 })
      expect(values).toHaveBeenCalledWith({
        patientId: PATIENT_ID,
        practitionerId: 4,
        createdBy: 4,
        reason: CREATED_PATIENT_REASON,
      })
      // On the caller's transaction — never on its own connection.
      expect(db.insert).not.toHaveBeenCalled()
    })
  })

  describe('endLinksWithoutSharedClinic', () => {
    it('ends the matching links on the given transaction, as the given person', async () => {
      const where = jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: 31, patientId: 10, practitionerId: 4 }]),
      })
      const set = jest.fn().mockReturnValue({ where })
      const tx = { update: jest.fn().mockReturnValue({ set }) }

      await expect(
        service.endLinksWithoutSharedClinic(
          tx as unknown as DrizzleDb,
          10,
          admin.id,
        ),
      ).resolves.toEqual([{ id: 31, patientId: 10, practitionerId: 4 }])

      const changes = (
        set.mock.calls as [{ endsAt: SQL; endedBy: number }][]
      )[0][0]
      expect(changes.endedBy).toBe(admin.id)
      expect(render(changes.endsAt).sql).toBe('now()')
      // The condition: this user's links (as patient OR practitioner) that
      // have NO clinic left in common.
      const { sql, params } = render((where.mock.calls as unknown[][])[0][0])
      expect(sql).toContain('"care_team_members"."patient_id" = $1')
      expect(sql).toContain('"care_team_members"."practitioner_id" = $2')
      expect(sql).toContain('NOT EXISTS')
      expect(params).toEqual([10, 10])
      expect(db.update).not.toHaveBeenCalled()
    })
  })

  describe('endLinksOfDeactivatedPractitioner', () => {
    it("ends the practitioner's current links on the given transaction, as the given person", async () => {
      const ended = [{ id: 41, patientId: 6, practitionerId: 4 }]
      const where = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(ended),
      })
      const set = jest.fn().mockReturnValue({ where })
      const tx = { update: jest.fn().mockReturnValue({ set }) }

      await expect(
        service.endLinksOfDeactivatedPractitioner(
          tx as unknown as DrizzleDb,
          4,
          admin.id,
        ),
      ).resolves.toEqual(ended)

      const changes = (
        set.mock.calls as [{ endsAt: SQL; endedBy: number }][]
      )[0][0]
      expect(changes.endedBy).toBe(admin.id)
      expect(render(changes.endsAt).sql).toBe('now()')
      // The condition: the links where this account is the PRACTITIONER
      // (never the patient side — a deactivated patient keeps theirs), and
      // only current ones (an ended link keeps its real end).
      const { sql, params } = render((where.mock.calls as unknown[][])[0][0])
      expect(sql).toContain('"care_team_members"."practitioner_id" = $1')
      expect(sql).not.toContain('"care_team_members"."patient_id"')
      expect(sql).toContain('"care_team_members"."started_at" <= now()')
      expect(sql).toContain(
        '"care_team_members"."ends_at" IS NULL OR "care_team_members"."ends_at" > now()',
      )
      expect(params).toEqual([4])
      expect(db.update).not.toHaveBeenCalled()
    })
  })

  describe('recordEndedLinks', () => {
    const started = new Date('2031-01-05T09:00:00Z')
    const ended = new Date('2031-02-01T10:00:00Z')
    const link = (id: number, patientId: number) => ({
      id,
      patientId,
      practitionerId: 4,
      startedAt: started,
      endsAt: ended,
    })

    it('writes one CARE_TEAM_ENDED per link, about its patient, in the given transaction', async () => {
      const tx = {} as DrizzleDb

      await service.recordEndedLinks(
        tx,
        [link(41, 6), link(42, 9)],
        admin.id,
        'Some reason',
      )

      const entry = (id: number, patientId: number) => [
        tx,
        {
          performedBy: admin.id,
          action: 'CARE_TEAM_ENDED',
          targetUserId: patientId,
          entityType: 'care_team_members',
          entityId: id,
          // No context given: nothing but the period and the reason.
          details: {
            practitionerId: 4,
            startedAt: started,
            endsAt: ended,
            reason: 'Some reason',
          },
        },
      ]
      expect(auditInTx.mock.calls).toStrictEqual([entry(41, 6), entry(42, 9)])
      expect(auditLog).not.toHaveBeenCalled()
    })

    it("adds the change's context to each entry's details", async () => {
      await service.recordEndedLinks({} as DrizzleDb, [link(41, 6)], 2, 'R', {
        clinicId: 3,
      })

      expect(auditInTx.mock.calls[0][1].details).toStrictEqual({
        practitionerId: 4,
        startedAt: started,
        endsAt: ended,
        reason: 'R',
        clinicId: 3,
      })
    })

    it('writes nothing when no link ended', async () => {
      await service.recordEndedLinks({} as DrizzleDb, [], admin.id, 'R')

      expect(auditInTx).not.toHaveBeenCalled()
    })
  })
})
