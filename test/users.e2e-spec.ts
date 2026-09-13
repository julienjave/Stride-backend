// Same reason this exists in main.ts and scripts/seed-exercises.ts — Jest,
// like ts-node, never auto-loads .env. AppModule's DrizzleModule needs
// POSTGRES_* in process.env the moment Test.createTestingModule() below
// tries to construct it, so this has to be the very first thing that runs.
import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import session from 'express-session';
import passport from 'passport';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { getDatabaseUrl } from '../src/config/database-url';
import { DRIZZLE, DrizzleDb } from '../src/database/drizzle.provider';

// Runs against a REAL Postgres + RustFS (same as npm run start:dev would),
// not mocks — this is deliberately testing the whole real pipeline: guards,
// pipes, session persistence, the actual database. Requires
// `docker compose up -d db storage` running, and must be pointed at the
// DEDICATED stride_test database (via POSTGRES_DB=stride_test), never the
// real dev database — see test:e2e:fresh in package.json.
describe('Users (e2e)', () => {
  let app: INestApplication;
  let sessionPool: Pool;

  const adminAgent = () => request.agent(app.getHttpServer());
  const practitionerAAgent = () => request.agent(app.getHttpServer());
  const practitionerBAgent = () => request.agent(app.getHttpServer());
  const patient1Agent = () => request.agent(app.getHttpServer());
  const patient2Agent = () => request.agent(app.getHttpServer());

  let admin: ReturnType<typeof adminAgent>;
  let practitionerA: ReturnType<typeof practitionerAAgent>;
  let practitionerB: ReturnType<typeof practitionerBAgent>;
  let patient1: ReturnType<typeof patient1Agent>;
  let patient2: ReturnType<typeof patient2Agent>;
  let clinicXId: number;
  let clinicYId: number;
  let patient1Id: number;
  let patient2Id: number;
  let patient2Email: string;
  let practitionerAId: number;
  let practitionerAEmail: string;
  let practitionerAProfile: {
    licenseNumber: string;
    specialties: string[];
    bio: string | null;
  };
  let practitionerBId: number;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    // Same session setup as main.ts — an e2e test needs the REAL middleware
    // stack, not just the DI-wired providers, since guards/sessions live in
    // middleware that main.ts sets up manually, outside AppModule itself.
    sessionPool = new Pool({ connectionString: getDatabaseUrl() });
    const PgSessionStore = connectPgSimple(session);
    app.use(
      session({
        store: new PgSessionStore({ pool: sessionPool, createTableIfMissing: true }),
        secret: 'e2e-test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 },
      }),
    );
    app.use(passport.initialize());
    app.use(passport.session());

    await app.init();

    // A hard safety check, not just a naming convention to remember —
    // refuses to proceed at all unless genuinely connected to the
    // dedicated test database. Without this, accidentally running e2e
    // tests via the wrong npm script (plain `test:e2e` instead of
    // `test:e2e:fresh`) would TRUNCATE the real dev database with no
    // warning, since nothing else in this file would notice the difference.
    const db = app.get<DrizzleDb>(DRIZZLE);
    const { rows } = await db.execute<{ current_database: string }>(
      sql`SELECT current_database()`,
    );
    const currentDatabase = rows[0].current_database;
    if (currentDatabase !== 'stride_test') {
      throw new Error(
        `Refusing to run e2e tests against database "${currentDatabase}" — expected "stride_test". ` +
          'Did you run this via `npm run test:e2e:fresh` (not plain `test:e2e`)?',
      );
    }

    // Resets this test's starting state, so this file can run any number of
    // times in a row and always begin from a genuinely empty database.
    // Uses sessionPool (the owner connection), not db (the restricted
    // stride_app connection) — TRUNCATE needs a privilege this app role is
    // deliberately never granted, since real app traffic never truncates
    // tables. This is test cleanup infrastructure only.
    await sessionPool.query('TRUNCATE TABLE users, clinics RESTART IDENTITY CASCADE');

    // --- Shared scaffolding for every test below ---
    admin = adminAgent();
    practitionerA = practitionerAAgent();
    practitionerB = practitionerBAgent();
    patient1 = patient1Agent();
    patient2 = patient2Agent();

    const stamp = Date.now();

    const clinicXRes = await admin.post('/auth/register-clinic').send({
      clinicName: 'Users E2E Clinic X',
      clinicEmail: `clinicx-${stamp}@example.com`,
      email: `admin-${stamp}@example.com`,
      password: 'password123',
      firstName: 'Users',
      lastName: 'Admin',
    });
    if (clinicXRes.status !== 201) {
      throw new Error(`Failed to bootstrap the founding admin: ${JSON.stringify(clinicXRes.body)}`);
    }
    clinicXId = clinicXRes.body.clinicId;

    const clinicYRes = await admin.post('/clinics').send({
      name: 'Users E2E Clinic Y',
      email: `clinicy-${stamp}@example.com`,
    });
    expect(clinicYRes.status).toBe(201);
    clinicYId = clinicYRes.body.id;

    const practitionerARes = await admin.post('/users').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'A',
      licenseNumber: `PT-A-${stamp}`,
      specialties: ['sports rehab'],
      bio: 'Specializes in post-op rehab.',
      phone: '555-0200',
      address: '1 Practitioner Ave',
      clinicId: clinicXId,
    });
    expect(practitionerARes.status).toBe(201);
    // Regression coverage for the gap this fix closes: practitioner_profiles
    // is written by UsersService.create() but was never attached to its own
    // response — not even here, on the account's own creation. bio was a
    // completely dead column (no DTO field, never read back) until now.
    expect(practitionerARes.body.practitionerProfile).toEqual({
      licenseNumber: `PT-A-${stamp}`,
      specialties: ['sports rehab'],
      bio: 'Specializes in post-op rehab.',
    });
    // phone/address moved from patient_profiles onto users itself — now
    // common to every role, including a practitioner.
    expect(practitionerARes.body.phone).toBe('555-0200');
    expect(practitionerARes.body.address).toBe('1 Practitioner Ave');
    practitionerAId = practitionerARes.body.id;
    practitionerAEmail = `practitioner-a-${stamp}@example.com`;
    practitionerAProfile = practitionerARes.body.practitionerProfile;
    await practitionerA.post('/auth/login').send({
      email: `practitioner-a-${stamp}@example.com`,
      password: 'password123',
    });

    const practitionerBRes = await admin.post('/users').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Practitioner',
      lastName: 'B',
      licenseNumber: `PT-B-${stamp}`,
      clinicId: clinicYId,
    });
    expect(practitionerBRes.status).toBe(201);
    practitionerBId = practitionerBRes.body.id;
    await practitionerB.post('/auth/login').send({
      email: `practitioner-b-${stamp}@example.com`,
      password: 'password123',
    });

    const patient1Res = await admin.post('/users').send({
      email: `patient1-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Patient',
      lastName: 'One',
      dateOfBirth: '1990-01-01',
      phone: '555-0300',
      address: '1 Patient One Street',
      clinicId: clinicXId,
    });
    expect(patient1Res.status).toBe(201);
    patient1Id = patient1Res.body.id;
    expect(patient1Res.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' });
    expect(patient1Res.body).not.toHaveProperty('practitionerProfile');
    expect(patient1Res.body).not.toHaveProperty('adminProfile');
    // phone/address are common to every role now — a patient gets them too,
    // read straight off `users` rather than the old patient_profiles columns.
    expect(patient1Res.body.phone).toBe('555-0300');
    expect(patient1Res.body.address).toBe('1 Patient One Street');
    await patient1.post('/auth/login').send({
      email: `patient1-${stamp}@example.com`,
      password: 'password123',
    });

    patient2Email = `patient2-${stamp}@example.com`;
    const patient2Res = await admin.post('/users').send({
      email: patient2Email,
      password: 'password123',
      role: 'patient',
      firstName: 'Patient',
      lastName: 'Two',
      dateOfBirth: '1990-01-01',
      clinicId: clinicYId,
    });
    expect(patient2Res.status).toBe(201);
    patient2Id = patient2Res.body.id;
    await patient2.post('/auth/login').send({
      email: patient2Email,
      password: 'password123',
    });
  });

  afterAll(async () => {
    await app.close();
    // app.close() only closes what Nest's own DI container manages.
    // sessionPool was created manually, outside that container, so it needs
    // to be closed explicitly too.
    await sessionPool.end();
  });

  it('lets a patient view and update their own profile', async () => {
    const viewRes = await patient1.get(`/users/${patient1Id}`);
    expect(viewRes.status).toBe(200);

    const updateRes = await patient1.patch(`/users/${patient1Id}`).send({ firstName: 'Updated' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.firstName).toBe('Updated');
    // Regression coverage: PATCH /users/:id goes through the same
    // toPublic()+roles+attachProfile() pattern as GET — profile data
    // (unaffected by this edit, which only touches firstName) should still
    // be present in the response.
    expect(updateRes.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' });

    // phone/address are plain `users` columns now (moved off
    // patient_profiles), so they fall through UpdateUserDto's own
    // `rest`/`userFields` destructuring with no role-gating at all — every
    // role can update them the same way.
    const contactUpdateRes = await patient1
      .patch(`/users/${patient1Id}`)
      .send({ phone: '555-9999', address: '99 Updated Ave' });
    expect(contactUpdateRes.status).toBe(200);
    expect(contactUpdateRes.body.phone).toBe('555-9999');
    expect(contactUpdateRes.body.address).toBe('99 Updated Ave');
  });

  it('lets an admin update anyone', async () => {
    const res = await admin.patch(`/users/${patient1Id}`).send({ firstName: 'AdminEdited' });
    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('AdminEdited');
  });

  it('lets a managing practitioner (sharing a clinic) update the patient', async () => {
    const res = await practitionerA.patch(`/users/${patient1Id}`).send({ firstName: 'PractitionerEdited' });
    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('PractitionerEdited');
  });

  it('rejects a non-managing practitioner (no shared clinic) from updating the patient', async () => {
    const res = await practitionerB.patch(`/users/${patient1Id}`).send({ firstName: 'ShouldNotWork' });
    expect(res.status).toBe(403);
  });

  it('rejects one patient viewing or updating a profile that is not theirs', async () => {
    const viewRes = await patient2.get(`/users/${patient1Id}`);
    expect(viewRes.status).toBe(403);

    const updateRes = await patient2.patch(`/users/${patient1Id}`).send({ firstName: 'Hijacked' });
    expect(updateRes.status).toBe(403);
  });

  it('scopes GET /users to only clinic-shared patients for a practitioner, and to everyone for an admin — and attaches roles + profile data to both branches', async () => {
    const forPractitionerA = await practitionerA.get('/users');
    expect(forPractitionerA.status).toBe(200);
    const idsForA = forPractitionerA.body.map((u: any) => u.id);
    expect(idsForA).toContain(patient1Id);
    expect(idsForA).not.toContain(patient2Id);
    // Regression coverage: findPatientsForPractitioner() (this branch of
    // GET /users) previously attached neither roles nor profile data at
    // all, unlike every single-user fetch.
    const patient1InList = forPractitionerA.body.find((u: any) => u.id === patient1Id);
    expect(patient1InList.roles).toEqual(['patient']);
    expect(patient1InList.patientProfile).toEqual({ dateOfBirth: '1990-01-01' });

    const forAdmin = await admin.get('/users');
    expect(forAdmin.status).toBe(200);
    const idsForAdmin = forAdmin.body.map((u: any) => u.id);
    expect(idsForAdmin).toEqual(expect.arrayContaining([patient1Id, patient2Id]));
    // Same regression coverage, findAll() branch — plus a practitioner in
    // the same list, to prove role-appropriate nesting (not just patients).
    const patient1InAdminList = forAdmin.body.find((u: any) => u.id === patient1Id);
    expect(patient1InAdminList.roles).toEqual(['patient']);
    expect(patient1InAdminList.patientProfile).toEqual({ dateOfBirth: '1990-01-01' });
    const practitionerAInAdminList = forAdmin.body.find(
      (u: any) => u.email === practitionerAEmail,
    );
    expect(practitionerAInAdminList.roles).toEqual(['practitioner']);
    expect(practitionerAInAdminList.practitionerProfile).toEqual(
      practitionerAProfile,
    );
  });

  it('rejects a plain patient from listing users at all', async () => {
    const res = await patient1.get('/users');
    expect(res.status).toBe(403);
  });

  it('lets a user deactivate their own account (self soft-delete)', async () => {
    const stamp = Date.now();
    const selfCreate = await admin.post('/users').send({
      email: `self-delete-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Self',
      lastName: 'Delete',
      dateOfBirth: '1990-01-01',
    });
    expect(selfCreate.status).toBe(201);
    const selfAgent = request.agent(app.getHttpServer());
    await selfAgent.post('/auth/login').send({
      email: `self-delete-${stamp}@example.com`,
      password: 'password123',
    });

    const deleteRes = await selfAgent.delete(`/users/${selfCreate.body.id}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.isActive).toBe(false);
    // Regression coverage: DELETE /users/:id (soft-delete) goes through the
    // same attachProfile() pattern as GET/PATCH.
    expect(deleteRes.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' });
  });

  it('lets a managing practitioner deactivate one of their own patients', async () => {
    const stamp = Date.now();
    const create = await admin.post('/users').send({
      email: `managed-delete-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Managed',
      lastName: 'Delete',
      dateOfBirth: '1990-01-01',
      clinicId: clinicXId,
    });
    expect(create.status).toBe(201);

    const deleteRes = await practitionerA.delete(`/users/${create.body.id}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.isActive).toBe(false);
  });

  it('rejects a non-managing practitioner from deactivating a patient they do not manage', async () => {
    const stamp = Date.now();
    const create = await admin.post('/users').send({
      email: `unmanaged-delete-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Unmanaged',
      lastName: 'Delete',
      dateOfBirth: '1990-01-01',
      clinicId: clinicXId,
    });
    expect(create.status).toBe(201);

    const deleteRes = await practitionerB.delete(`/users/${create.body.id}`);
    expect(deleteRes.status).toBe(403);
  });

  it('rejects a practitioner creating anything other than a patient account', async () => {
    const stamp = Date.now();
    const res = await practitionerA.post('/users').send({
      email: `should-not-be-created-${stamp}@example.com`,
      password: 'password123',
      role: 'practitioner',
      firstName: 'Should',
      lastName: 'NotWork',
      licenseNumber: `PT-X-${stamp}`,
    });
    expect(res.status).toBe(403);
  });

  it('rejects a practitioner creating a patient in a clinic they do not belong to', async () => {
    const stamp = Date.now();
    const res = await practitionerA.post('/users').send({
      email: `cross-clinic-patient-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Cross',
      lastName: 'Clinic',
      dateOfBirth: '1990-01-01',
      clinicId: clinicYId,
    });
    expect(res.status).toBe(403);
  });

  it('lets a practitioner create a patient in their own clinic', async () => {
    const stamp = Date.now();
    const res = await practitionerA.post('/users').send({
      email: `own-clinic-patient-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Own',
      lastName: 'Clinic',
      dateOfBirth: '1990-01-01',
      clinicId: clinicXId,
    });
    expect(res.status).toBe(201);
  });

  it('lets an admin create a patient in any clinic, exempt from the clinic-ownership check', async () => {
    const stamp = Date.now();
    const res = await admin.post('/users').send({
      email: `admin-cross-clinic-patient-${stamp}@example.com`,
      password: 'password123',
      role: 'patient',
      firstName: 'Admin',
      lastName: 'CrossClinic',
      dateOfBirth: '1990-01-01',
      clinicId: clinicYId,
    });
    expect(res.status).toBe(201);
  });

  it('scopes GET /users/:id: rejects an unrelated practitioner, allows the managing practitioner, self, and admin — all three see the same profile data', async () => {
    const unrelated = await practitionerB.get(`/users/${patient1Id}`);
    expect(unrelated.status).toBe(403);

    // Regression coverage for the actual gap this fix closes: whoever
    // already passes the existing self/admin/managing-practitioner check
    // gets the same profile fields — no new, finer-grained rule.
    const managing = await practitionerA.get(`/users/${patient1Id}`);
    expect(managing.status).toBe(200);
    expect(managing.body.id).toBe(patient1Id);
    expect(managing.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' });

    const self = await patient1.get(`/users/${patient1Id}`);
    expect(self.status).toBe(200);
    expect(self.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' });

    const adminView = await admin.get(`/users/${patient1Id}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.patientProfile).toEqual({ dateOfBirth: '1990-01-01' });

    // A practitioner viewing themself sees their own practitionerProfile,
    // never a patientProfile they don't have.
    const practitionerSelf = await practitionerA.get(`/users/${practitionerAId}`);
    expect(practitionerSelf.status).toBe(200);
    expect(practitionerSelf.body.practitionerProfile).toEqual(practitionerAProfile);
    expect(practitionerSelf.body).not.toHaveProperty('patientProfile');
  });

  // No route to POST /users/:id/roles was exercised anywhere in this suite
  // before — real gap, closed here specifically because grantRole()'s own
  // userRoles INSERT changed as part of the user_roles RLS pass (routed
  // through withRlsContext with the acting admin's real session now, not a
  // plain db.transaction() with no RLS context at all — see the migration
  // comment on user_roles_insert for why the old shape would have failed
  // outright under FORCE ROW LEVEL SECURITY).
  it('lets an admin grant an additional role, rejects a non-admin attempting the same, and the granted role is real (not just echoed)', async () => {
    const stamp = Date.now();

    const forbidden = await practitionerA
      .post(`/users/${patient2Id}/roles`)
      .send({ role: 'practitioner', licenseNumber: `PT-GRANT-${stamp}` });
    expect(forbidden.status).toBe(403);

    const granted = await admin
      .post(`/users/${patient2Id}/roles`)
      .send({ role: 'practitioner', licenseNumber: `PT-GRANT-${stamp}` });
    expect(granted.status).toBe(201);
    expect(granted.body).toEqual(
      expect.arrayContaining(['patient', 'practitioner']),
    );

    // Proves the INSERT genuinely committed under user_roles' real RLS
    // policy, not just that the HTTP response looked right — patient2's
    // ALREADY-authenticated session (no fresh login, deliberately: /auth/
    // login is throttled to 5/60s and this file's beforeAll already spends
    // most of that budget) can now switch to the newly-granted role.
    // switchRole() only allows switching to a role deserializeUser()'s own
    // fresh reload (UsersService.findOne() -> getRolesForUser(), a genuinely
    // separate connection from grantRole()'s own transaction) actually
    // finds — this exercises exactly the read-after-commit path the
    // getRolesForUser(userId, tx) fix above was about, from the other side.
    const switched = await patient2
      .post('/auth/switch-role')
      .send({ role: 'practitioner' });
    expect(switched.status).toBe(201);
    expect(switched.body.activeRole).toBe('practitioner');

    const duplicate = await admin
      .post(`/users/${patient2Id}/roles`)
      .send({ role: 'practitioner', licenseNumber: `PT-GRANT-DUP-${stamp}` });
    expect(duplicate.status).toBe(409);
  });

  // Real gap this fix closes: licenseNumber/specialties, dateOfBirth, and
  // position were writable at account creation (create(), grantRole()) but
  // had no update path at all — UpdateUserDto only ever had firstName/
  // lastName. Reuses the identical isSelf||isAdmin||isManagingPractitioner
  // check already covered above; the coverage below is specifically about
  // the profile-field extension itself, plus the extra constraint that
  // field applicability is scoped to the TARGET's actual held role(s), not
  // the caller's. Placed last in the file deliberately: several of these
  // mutate patient1Id's dateOfBirth and practitionerAId's specialties, both
  // asserted as their ORIGINAL values by several earlier tests above.
  describe('profile-field updates (licenseNumber/specialties, dateOfBirth, position)', () => {
    // Set by the licenseNumber self-update test below, then read by the bio
    // self-update test right after it — both mutate practitionerAId's row in
    // sequence, so the bio test needs the license value as it stands AFTER
    // that update, not practitionerAProfile's original creation-time value.
    let practitionerACurrentLicense: string;

    it('lets a patient self-update their own dateOfBirth', async () => {
      const res = await patient1.patch(`/users/${patient1Id}`).send({ dateOfBirth: '1991-02-02' });
      expect(res.status).toBe(200);
      expect(res.body.patientProfile).toEqual({ dateOfBirth: '1991-02-02' });
    });

    it("lets an admin update any user's profile field — a practitioner's specialties here", async () => {
      const res = await admin
        .patch(`/users/${practitionerAId}`)
        .send({ specialties: ['sports rehab', 'geriatrics'] });
      expect(res.status).toBe(200);
      expect(res.body.practitionerProfile).toEqual({
        licenseNumber: practitionerAProfile.licenseNumber,
        specialties: ['sports rehab', 'geriatrics'],
        bio: practitionerAProfile.bio,
      });
    });

    it('lets a practitioner self-update their own practitionerProfile fields, licenseNumber included (self-editable by design — see docs)', async () => {
      const stamp = Date.now();
      const newLicense = `PT-A-UPDATED-${stamp}`;
      const res = await practitionerA
        .patch(`/users/${practitionerAId}`)
        .send({ licenseNumber: newLicense, specialties: ['sports rehab'] });
      expect(res.status).toBe(200);
      expect(res.body.practitionerProfile).toEqual({
        licenseNumber: newLicense,
        specialties: ['sports rehab'],
        bio: practitionerAProfile.bio,
      });
      practitionerACurrentLicense = newLicense;
    });

    // bio was a completely dead column before this fix: a real column on
    // practitioner_profiles with no DTO field anywhere and never attached to
    // any response. This proves it now round-trips through PATCH the same
    // way licenseNumber/specialties already did.
    it("lets a practitioner self-update their own bio, and reads it back", async () => {
      const res = await practitionerA
        .patch(`/users/${practitionerAId}`)
        .send({ bio: 'Updated bio after a PATCH.' });
      expect(res.status).toBe(200);
      expect(res.body.practitionerProfile).toEqual({
        licenseNumber: practitionerACurrentLicense,
        specialties: ['sports rehab'],
        bio: 'Updated bio after a PATCH.',
      });
    });

    it("lets a managing practitioner update a managed patient's patientProfile field", async () => {
      const res = await practitionerA.patch(`/users/${patient1Id}`).send({ dateOfBirth: '1992-03-03' });
      expect(res.status).toBe(200);
      expect(res.body.patientProfile).toEqual({ dateOfBirth: '1992-03-03' });
    });

    it('rejects one patient updating a profile field on a user that is not theirs', async () => {
      const res = await patient2.patch(`/users/${patient1Id}`).send({ dateOfBirth: '2000-01-01' });
      expect(res.status).toBe(403);
    });

    it('rejects a non-managing practitioner from updating a profile field on a patient they do not manage', async () => {
      const res = await practitionerB.patch(`/users/${patient1Id}`).send({ dateOfBirth: '2000-01-01' });
      expect(res.status).toBe(403);
    });

    it("rejects a practitioner from updating another practitioner's profile", async () => {
      const res = await practitionerA.patch(`/users/${practitionerBId}`).send({ specialties: ['hijacked'] });
      expect(res.status).toBe(403);
    });

    // The top-level isSelf||isAdmin||isManagingPractitioner check is not the
    // only gate: which profile fields even apply depends on the TARGET's
    // actual held role(s). An admin passes the check above unconditionally,
    // but still can't write a field the target has no profile for.
    it('rejects a profile field that does not apply to the target — even for an admin caller', async () => {
      const licenseOnPatient = await admin
        .patch(`/users/${patient1Id}`)
        .send({ licenseNumber: 'PT-SHOULD-FAIL' });
      expect(licenseOnPatient.status).toBe(400);

      // bio is gated the same way as licenseNumber/specialties — a
      // practitioner-profile field, rejected for a target with no
      // practitioner role at all, even for an admin caller.
      const bioOnPatient = await admin
        .patch(`/users/${patient1Id}`)
        .send({ bio: 'Should Fail' });
      expect(bioOnPatient.status).toBe(400);

      const positionOnPractitioner = await admin
        .patch(`/users/${practitionerAId}`)
        .send({ position: 'Should Fail' });
      expect(positionOnPractitioner.status).toBe(400);

      const dateOfBirthOnPractitioner = await practitionerA
        .patch(`/users/${practitionerAId}`)
        .send({ dateOfBirth: '1990-01-01' });
      expect(dateOfBirthOnPractitioner.status).toBe(400);
    });
  });
});
