import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MedicalFilesService } from './medical-files.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { DRIZZLE } from '../database/drizzle.provider';

describe('MedicalFilesService.create', () => {
  let service: MedicalFilesService;
  let usersService: { isPatientManagedBy: jest.Mock };
  let auditService: { log: jest.Mock };
  let db: { insert: jest.Mock };

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    db = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 1, patientId: 20, clinicalData: {} }]),
        }),
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MedicalFilesService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(MedicalFilesService);
  });

  it('refuses to create an entry for a patient the practitioner does not manage', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false);

    await expect(
      service.create({ id: 7, activeRole: 'practitioner' }, { patientId: 20, clinicalData: {} }),
    ).rejects.toThrow(ForbiddenException);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('creates the entry and audit-logs it once ownership checks out', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);

    await service.create({ id: 7, activeRole: 'practitioner' }, { patientId: 20, clinicalData: { note: 'x' } });

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CREATE_MEDICAL_FILE', targetUserId: 20 }),
    );
  });
});

describe('MedicalFilesService.findAll', () => {
  let service: MedicalFilesService;
  let usersService: { isPatientManagedBy: jest.Mock };
  let auditService: { log: jest.Mock };
  let db: { query: { medicalFiles: { findMany: jest.Mock } } };

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    db = { query: { medicalFiles: { findMany: jest.fn().mockResolvedValue([]) } } };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MedicalFilesService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(MedicalFilesService);
  });

  it("defaults to the caller's own id for a patient, no query param required", async () => {
    await service.findAll({ id: 20, activeRole: 'patient' });

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ACCESS_MEDICAL_FILE_LIST', targetUserId: 20 }),
    );
  });

  it('requires an explicit patientId for a practitioner', async () => {
    await expect(service.findAll({ id: 7, activeRole: 'practitioner' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a practitioner requesting a patient they do not manage', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(false);

    await expect(service.findAll({ id: 7, activeRole: 'practitioner' }, 20)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows a managing practitioner to list a managed patient\'s files', async () => {
    usersService.isPatientManagedBy.mockResolvedValue(true);

    await service.findAll({ id: 7, activeRole: 'practitioner' }, 20);

    expect(db.query.medicalFiles.findMany).toHaveBeenCalled();
  });

  it("audits every list access, even the patient viewing their own records", async () => {
    await service.findAll({ id: 20, activeRole: 'patient' });

    expect(auditService.log).toHaveBeenCalledTimes(1);
  });
});

describe('MedicalFilesService.findOne', () => {
  let service: MedicalFilesService;
  let usersService: { isPatientManagedBy: jest.Mock };
  let auditService: { log: jest.Mock };
  let db: { query: { medicalFiles: { findFirst: jest.Mock } } };

  beforeEach(async () => {
    usersService = { isPatientManagedBy: jest.fn() };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    db = { query: { medicalFiles: { findFirst: jest.fn() } } };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MedicalFilesService,
        { provide: DRIZZLE, useValue: db },
        { provide: UsersService, useValue: usersService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();

    service = moduleRef.get(MedicalFilesService);
  });

  it('throws NotFoundException for an entry that does not exist', async () => {
    db.query.medicalFiles.findFirst.mockResolvedValue(undefined);

    await expect(service.findOne(999, { id: 20, activeRole: 'patient' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('allows the owning patient to view their own entry', async () => {
    db.query.medicalFiles.findFirst.mockResolvedValue({ id: 1, patientId: 20 });

    await expect(service.findOne(1, { id: 20, activeRole: 'patient' })).resolves.toBeDefined();
    expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ACCESS_MEDICAL_FILE' }));
  });

  it('rejects a different patient viewing an entry that is not theirs', async () => {
    db.query.medicalFiles.findFirst.mockResolvedValue({ id: 1, patientId: 20 });

    await expect(service.findOne(1, { id: 999, activeRole: 'patient' })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows an admin to view any entry', async () => {
    db.query.medicalFiles.findFirst.mockResolvedValue({ id: 1, patientId: 20 });

    await expect(service.findOne(1, { id: 1, activeRole: 'admin' })).resolves.toBeDefined();
  });

  it('allows a managing practitioner to view the entry', async () => {
    db.query.medicalFiles.findFirst.mockResolvedValue({ id: 1, patientId: 20 });
    usersService.isPatientManagedBy.mockResolvedValue(true);

    await expect(service.findOne(1, { id: 7, activeRole: 'practitioner' })).resolves.toBeDefined();
  });

  it('rejects a non-managing practitioner from viewing the entry', async () => {
    db.query.medicalFiles.findFirst.mockResolvedValue({ id: 1, patientId: 20 });
    usersService.isPatientManagedBy.mockResolvedValue(false);

    await expect(service.findOne(1, { id: 7, activeRole: 'practitioner' })).rejects.toThrow(
      ForbiddenException,
    );
  });
});
