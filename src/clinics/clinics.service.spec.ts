import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ClinicsService } from './clinics.service';
import { StorageService } from '../storage/storage.service';
import { DRIZZLE } from '../database/drizzle.provider';

describe('ClinicsService.addMember', () => {
  let clinicsService: ClinicsService;
  let db: {
    query: {
      clinics: { findFirst: jest.Mock };
      users: { findFirst: jest.Mock };
      userClinics: { findFirst: jest.Mock };
    };
    insert: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      query: {
        clinics: { findFirst: jest.fn() },
        users: { findFirst: jest.fn() },
        userClinics: { findFirst: jest.fn() },
      },
      insert: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    clinicsService = moduleRef.get(ClinicsService);
  });

  it('throws NotFoundException when the clinic does not exist', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined);

    await expect(clinicsService.addMember(999, 1)).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the user does not exist', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' });
    db.query.users.findFirst.mockResolvedValue(undefined);

    await expect(clinicsService.addMember(1, 999)).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when the user already belongs to the clinic', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' });
    db.query.users.findFirst.mockResolvedValue({ id: 10, email: 'member@example.com' });
    db.query.userClinics.findFirst.mockResolvedValue({ id: 5, clinicId: 1, userId: 10 });

    await expect(clinicsService.addMember(1, 10)).rejects.toThrow(ConflictException);
  });

  it('creates the membership when the clinic and user exist and are not already linked', async () => {
    db.query.clinics.findFirst.mockResolvedValue({ id: 1, name: 'Acme Clinic' });
    db.query.users.findFirst.mockResolvedValue({ id: 10, email: 'member@example.com' });
    db.query.userClinics.findFirst.mockResolvedValue(undefined);
    db.insert.mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 50, clinicId: 1, userId: 10 }]),
      }),
    });

    const result = await clinicsService.addMember(1, 10);

    expect(result).toEqual({ id: 50, clinicId: 1, userId: 10 });
  });
});

describe('ClinicsService.findOne', () => {
  let clinicsService: ClinicsService;
  let db: { query: { clinics: { findFirst: jest.Mock } } };

  beforeEach(async () => {
    db = { query: { clinics: { findFirst: jest.fn() } } };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClinicsService,
        { provide: DRIZZLE, useValue: db },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    clinicsService = moduleRef.get(ClinicsService);
  });

  it('throws NotFoundException when the clinic does not exist', async () => {
    db.query.clinics.findFirst.mockResolvedValue(undefined);

    await expect(clinicsService.findOne(999)).rejects.toThrow(NotFoundException);
  });
});
