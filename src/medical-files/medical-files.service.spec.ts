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
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import {
  MedicalFilesService,
  translateInsertError,
} from './medical-files.service'
import { UsersService } from '../users/users.service'
import { AuditService } from '../audit/audit.service'
import { DRIZZLE } from '../database/drizzle.provider'
import { UserRole } from '../users/dto/create-user.dto'

// The service's own decisions, with the database mocked: whose file a list
// is for, what the audit entry says, the answer's shape, and how each
// database refusal is translated. WHETHER the database refuses — the
// policies, the constraints, the trigger — is test/medical-files.e2e-spec.ts.

// --- FIXTURES ----------------------------------------------------------------------------------------------

const practitioner = { id: 7, activeRole: UserRole.PRACTITIONER }
const patient = { id: 20, activeRole: UserRole.PATIENT }
const createdAt = new Date('2031-03-04T10:00:00.000Z')

// A row as the select in loadMedicalFileEntries returns it (entry +
// author + the amendment's id).
function selected(
  id: number,
  overrides: Record<string, unknown> = {},
  amendedById: number | null = null,
) {
  return {
    entry: {
      id,
      patientId: 20,
      createdBy: 7,
      createdAt,
      entryType: 'progress_note',
      subjective: 'Knee better',
      objective: null,
      assessment: null,
      plan: 'Keep going',
      amendsId: null,
      amendmentReason: null,
      ...overrides,
    },
    author: { id: 7, firstName: 'Alex', lastName: 'Chen' },
    amendedById,
  }
}

// The same entry as the API answers it.
function answered(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    patientId: 20,
    entryType: 'progress_note',
    subjective: 'Knee better',
    objective: null,
    assessment: null,
    plan: 'Keep going',
    createdAt,
    author: { id: 7, firstName: 'Alex', lastName: 'Chen' },
    amendsId: null,
    amendmentReason: null,
    amendedById: null,
    ...overrides,
  }
}

// A Postgres error as drizzle throws it: the driver's error in `cause`.
function pgError(code: string, constraint?: string) {
  return Object.assign(new Error('Failed query'), {
    cause: { code, constraint },
  })
}

// --- HARNESS -----------------------------------------------------------------------------------------------

function setUp() {
  const selectResults: unknown[][] = []
  const insertValues = jest.fn()
  const returning = jest.fn()
  const tx = {
    execute: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn(() => ({
      values: (values: unknown) => {
        insertValues(values)
        return { returning }
      },
    })),
    // select().from().innerJoin().leftJoin().where().orderBy() — the last
    // call answers the next queued result.
    select: jest.fn(() => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => Promise.resolve(selectResults.shift() ?? []),
      }
      return chain
    }),
  }
  const db = {
    transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  }
  const usersService = { isPatientManagedBy: jest.fn() }
  const auditService = {
    logInTransaction: jest.fn().mockResolvedValue(undefined),
    log: jest.fn(),
  }
  return {
    tx,
    db,
    usersService,
    auditService,
    selectResults,
    insertValues,
    returning,
  }
}

async function build(harness: ReturnType<typeof setUp>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      MedicalFilesService,
      { provide: DRIZZLE, useValue: harness.db },
      { provide: UsersService, useValue: harness.usersService },
      { provide: AuditService, useValue: harness.auditService },
    ],
  }).compile()
  return moduleRef.get(MedicalFilesService)
}

// --- TESTS -------------------------------------------------------------------------------------------------

describe('MedicalFilesService.create', () => {
  it('inserts the entry, audits it in the same transaction and answers it', async () => {
    const h = setUp()
    const service = await build(h)
    h.returning.mockResolvedValue([selected(3).entry])
    h.selectResults.push([selected(3)])

    const result = await service.create(practitioner, {
      patientId: 20,
      entryType: 'progress_note',
      subjective: 'Knee better',
      plan: 'Keep going',
    })

    expect(result).toStrictEqual(answered(3))
    // Absent sections and amendment fields go in as NULL, explicitly;
    // created_by is the caller, whatever the body says.
    expect(h.insertValues).toHaveBeenCalledWith({
      patientId: 20,
      createdBy: 7,
      entryType: 'progress_note',
      subjective: 'Knee better',
      objective: null,
      assessment: null,
      plan: 'Keep going',
      amendsId: null,
      amendmentReason: null,
    })
    expect(h.auditService.logInTransaction).toHaveBeenCalledTimes(1)
    expect(h.auditService.logInTransaction).toHaveBeenCalledWith(h.tx, {
      performedBy: 7,
      action: 'MEDICAL_FILE_ENTRY_CREATED',
      targetUserId: 20,
      entityType: 'medical_files',
      entityId: 3,
      details: { entryType: 'progress_note', createdAt },
    })
    expect(h.auditService.log).not.toHaveBeenCalled()
  })

  it('audits an amendment as MEDICAL_FILE_ENTRY_AMENDED, naming what it amends', async () => {
    const h = setUp()
    const service = await build(h)
    const amendment = { amendsId: 2, amendmentReason: 'Wrong knee' }
    h.returning.mockResolvedValue([selected(3, amendment).entry])
    h.selectResults.push([selected(3, amendment)])

    const result = await service.create(practitioner, {
      patientId: 20,
      entryType: 'progress_note',
      plan: 'Keep going',
      ...amendment,
    })

    expect(result).toStrictEqual(answered(3, amendment))
    expect(h.insertValues).toHaveBeenCalledWith(
      expect.objectContaining(amendment),
    )
    expect(h.auditService.logInTransaction).toHaveBeenCalledWith(h.tx, {
      performedBy: 7,
      action: 'MEDICAL_FILE_ENTRY_AMENDED',
      targetUserId: 20,
      entityType: 'medical_files',
      entityId: 3,
      details: { entryType: 'progress_note', createdAt, amendsId: 2 },
    })
  })

  it("translates the database's refusal and writes no audit entry", async () => {
    const h = setUp()
    const service = await build(h)
    h.returning.mockRejectedValue(pgError('42501'))

    await expect(
      service.create(practitioner, {
        patientId: 20,
        entryType: 'progress_note',
        plan: 'P',
      }),
    ).rejects.toThrow(
      new ForbiddenException(
        'You can only add entries to the medical file of a patient on your care team',
      ),
    )
    expect(h.auditService.logInTransaction).not.toHaveBeenCalled()
  })
})

describe('translateInsertError', () => {
  it.each([
    [
      'the INSERT policy (42501)',
      pgError('42501'),
      ForbiddenException,
      'You can only add entries to the medical file of a patient on your care team',
    ],
    [
      'no section (the has-content CHECK)',
      pgError('23514', 'medical_files_has_content'),
      BadRequestException,
      'An entry needs at least one section: Subjective, Objective, Assessment or Plan',
    ],
    [
      "another patient's or a missing entry (the composite foreign key)",
      pgError('23503', 'medical_files_amends_same_patient_fk'),
      BadRequestException,
      "The entry to amend isn't in this patient's medical file",
    ],
    [
      'its own id (the not-self CHECK)',
      pgError('23514', 'medical_files_not_self_amending'),
      BadRequestException,
      "The entry to amend isn't in this patient's medical file",
    ],
    [
      'an entry amended already (the unique index)',
      pgError('23505', 'medical_files_one_amendment_per_entry'),
      ConflictException,
      'This entry has already been amended — amend its latest version instead',
    ],
  ])('turns %s into its answer', (_name, error, type, message) => {
    const translated = translateInsertError(error)
    expect(translated).toBeInstanceOf(type)
    expect((translated as Error).message).toBe(message)
  })

  // Each translation is tied to its constraint: the same SQLSTATE on
  // another constraint (or none) is a real failure, passed on unchanged.
  it.each([
    ['another CHECK', pgError('23514', 'medical_files_sections_valid')],
    [
      'another foreign key',
      pgError('23503', 'medical_files_created_by_users_id_fk'),
    ],
    [
      'another unique constraint',
      pgError('23505', 'medical_files_id_patient_unique'),
    ],
    ['a plain error', new Error('connection lost')],
  ])('passes %s on unchanged', (_name, error) => {
    expect(translateInsertError(error)).toBe(error)
  })
})

describe('MedicalFilesService.findAll', () => {
  it("answers a patient's own file, newest first, and audits which entries were shown", async () => {
    const h = setUp()
    const service = await build(h)
    h.selectResults.push([selected(5), selected(2)])

    const result = await service.findAll(patient)

    expect(result).toStrictEqual([answered(5), answered(2)])
    expect(h.usersService.isPatientManagedBy).not.toHaveBeenCalled()
    expect(h.auditService.logInTransaction).toHaveBeenCalledTimes(1)
    expect(h.auditService.logInTransaction).toHaveBeenCalledWith(h.tx, {
      performedBy: 20,
      action: 'MEDICAL_FILE_VIEWED',
      targetUserId: 20,
      entityType: 'medical_files',
      details: { entryIds: [5, 2] },
    })
  })

  it('audits an empty file too — the look is what is recorded', async () => {
    const h = setUp()
    const service = await build(h)

    expect(await service.findAll(patient, 20)).toEqual([])
    expect(h.auditService.logInTransaction).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ details: { entryIds: [] } }),
    )
  })

  it("refuses a patient asking for someone else's file, before any read", async () => {
    const h = setUp()
    const service = await build(h)

    await expect(service.findAll(patient, 21)).rejects.toThrow(
      new ForbiddenException('You can only view your own medical file'),
    )
    expect(h.db.transaction).not.toHaveBeenCalled()
    expect(h.auditService.logInTransaction).not.toHaveBeenCalled()
  })

  it('needs a patientId from a practitioner', async () => {
    const h = setUp()
    const service = await build(h)

    await expect(service.findAll(practitioner)).rejects.toThrow(
      new BadRequestException('patientId is required'),
    )
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it("refuses a practitioner off the patient's care team, before any read", async () => {
    const h = setUp()
    const service = await build(h)
    h.usersService.isPatientManagedBy.mockResolvedValue(false)

    await expect(service.findAll(practitioner, 20)).rejects.toThrow(
      new ForbiddenException(
        "You do not have permission to view this patient's medical file",
      ),
    )
    expect(h.usersService.isPatientManagedBy).toHaveBeenCalledWith(20, 7)
    expect(h.db.transaction).not.toHaveBeenCalled()
  })

  it('answers a practitioner on the care team, audited as theirs', async () => {
    const h = setUp()
    const service = await build(h)
    h.usersService.isPatientManagedBy.mockResolvedValue(true)
    h.selectResults.push([selected(5)])

    expect(await service.findAll(practitioner, 20)).toStrictEqual([answered(5)])
    expect(h.auditService.logInTransaction).toHaveBeenCalledWith(h.tx, {
      performedBy: 7,
      action: 'MEDICAL_FILE_VIEWED',
      targetUserId: 20,
      entityType: 'medical_files',
      details: { entryIds: [5] },
    })
  })
})

describe('MedicalFilesService.findOne', () => {
  it('answers the entry and audits the view', async () => {
    const h = setUp()
    const service = await build(h)
    // An entry amended since: the self-join found entry 9 pointing at it.
    h.selectResults.push([selected(4, {}, 9)])

    expect(await service.findOne(4, patient)).toStrictEqual(
      answered(4, { amendedById: 9 }),
    )
    expect(h.auditService.logInTransaction).toHaveBeenCalledWith(h.tx, {
      performedBy: 20,
      action: 'MEDICAL_FILE_ENTRY_VIEWED',
      targetUserId: 20,
      entityType: 'medical_files',
      entityId: 4,
    })
  })

  it('answers 404 for an entry row security hides, and audits nothing', async () => {
    const h = setUp()
    const service = await build(h)

    await expect(service.findOne(4, practitioner)).rejects.toThrow(
      new NotFoundException('Medical file entry 4 not found'),
    )
    expect(h.auditService.logInTransaction).not.toHaveBeenCalled()
  })
})
