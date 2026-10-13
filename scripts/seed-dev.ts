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

// npm run seed:dev [-- --reset]
//
// Fills the DEVELOPMENT database with the demo data in scripts/seed/
// dataset.ts — clinics, an account per role and per invitation state, a
// few exercises, templates and an assigned program — so a reviewer can log
// in as anyone and explore. The accounts are described for reviewers in
// docs/dev-test-accounts.md.
//
// Everything goes through the app's REAL services, as the person who would
// do it: Alex creating a patient really puts Alex on the care team, under
// the same validation, row-level security and audit log as a request. Only
// what the app can't produce on demand is written directly (an invitation
// that expired a while ago).
//
// The exercise library is a separate command (npm run seed:exercises — it
// downloads hundreds of exercises and images); `npm run seed` runs both.

// --- IMPORTS -----------------------------------------------------------------------------------------------

// First: loads .env into process.env before anything reads it.
import 'dotenv/config'
import { ValidationPipe, type Type } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Pool } from 'pg'
import { AppModule } from '../src/app.module'
import { getDatabaseUrl } from '../src/config/database-url'
import { EMAIL_TRANSPORT } from '../src/email/email-transport'
import { createEmailTransport } from '../src/email/email-transport.config'
import { AuthService } from '../src/auth/auth.service'
import { RegisterClinicDto } from '../src/auth/dto/register-clinic.dto'
import { ClinicsService } from '../src/clinics/clinics.service'
import { CreateClinicDto } from '../src/clinics/dto/create-clinic.dto'
import { UsersService } from '../src/users/users.service'
import { CreateUserDto, UserRole } from '../src/users/dto/create-user.dto'
import { GrantRoleDto } from '../src/users/dto/grant-role.dto'
import { InvitationsService } from '../src/invitations/invitations.service'
import { CareTeamService } from '../src/care-team/care-team.service'
import { AddCareTeamMemberDto } from '../src/care-team/dto/add-care-team-member.dto'
import { ExercisesService } from '../src/exercises/exercises.service'
import { CreateExerciseDto } from '../src/exercises/dto/create-exercise.dto'
import { ProgramsService } from '../src/programs/programs.service'
import { CreateTemplateDto } from '../src/programs/dto/create-template.dto'
import { AddTemplateExerciseDto } from '../src/programs/dto/add-template-exercise.dto'
import { AddWorkoutDto } from '../src/programs/dto/add-workout.dto'
import { RenameWorkoutDto } from '../src/programs/dto/rename-workout.dto'
import { AssignedProgramsService } from '../src/assigned-programs/assigned-programs.service'
import { addDays, utcToday } from '../src/common/calendar-date'
import { seedSessionDays, seedSessionWorkouts } from './seed/session-history'
import { CreateAssignedProgramDto } from '../src/assigned-programs/dto/create-assigned-program.dto'
import type { CurrentUser } from '../src/common/decorators/current-user.decorator'
import {
  ACCOUNTS,
  ASSIGNED_PROGRAMS,
  CLINICS,
  CUSTOM_EXERCISES,
  DEMO_PASSWORD,
  TEMPLATES,
  type AccountKey,
  type ClinicKey,
  type SeedAccount,
} from './seed/dataset'
import { refuseSeed } from './seed/safety'
import { resetDatabase } from './seed/reset'
import {
  SeedEmailTransport,
  type SeedEmailMode,
} from './seed/seed-email-transport'

// --- HELPERS -----------------------------------------------------------------------------------------------

// The same ValidationPipe, with the same options, that main.ts installs
// for every request. Services don't validate (the pipe runs BEFORE them,
// at the HTTP layer), so calling them directly would skip it — this puts
// it back: every DTO the seed builds is checked exactly like a request
// body, and a typo in the dataset fails loudly here instead of becoming
// data the API itself would have refused.
const validationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
})

async function validated<T>(dtoClass: Type<T>, plain: object): Promise<T> {
  return (await validationPipe.transform(plain, {
    type: 'body',
    metatype: dtoClass,
  })) as T
}

function invitationMode(account: SeedAccount): SeedEmailMode {
  if (account.kind !== 'patient') return 'capture'
  if (account.invitation === 'pending') return 'deliver'
  if (account.invitation === 'email-failed') return 'fail'
  return 'capture'
}

// --- SEED --------------------------------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = process.argv.slice(2)
  const unknown = args.filter((arg) => arg !== '--reset')
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(' ')}. Usage: npm run seed:dev [-- --reset]`,
    )
  }
  const reset = args.includes('--reset')

  // The configured transport (Mailpit with EMAIL_TRANSPORT=smtp), wrapped
  // so the seed decides, account by account, what really gets sent.
  const email = new SeedEmailTransport(createEmailTransport())

  // The whole app, without an HTTP server. Nest's TESTING module rather
  // than NestFactory, for one feature: overrideProvider — swapping what's
  // injected under EMAIL_TRANSPORT before anything is built (the same
  // mechanism the e2e suites use). Nothing about it is tied to Jest.
  const app = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_TRANSPORT)
    .useValue(email)
    .compile()
  await app.init()

  // The OWNER connection (not the app's restricted one): the safety check
  // and the reset read and delete across every table, which row-level
  // security would hide from the app's role. Same pattern as
  // scripts/seed-exercises.ts.
  const owner = new Pool({ connectionString: getDatabaseUrl() })

  try {
    // --- 1. May we? ---
    const database = (
      await owner.query<{ db: string }>('SELECT current_database() AS db')
    ).rows[0].db
    const existingUsers = Number(
      (await owner.query<{ n: string }>('SELECT count(*) AS n FROM users'))
        .rows[0].n,
    )
    const refusal = refuseSeed({
      nodeEnv: process.env.NODE_ENV,
      database,
      existingUsers,
      reset,
    })
    if (refusal) {
      console.error(refusal)
      process.exitCode = 1
      return
    }
    console.log(`Seeding "${database}"…`)

    // --- 2. Reset (only with --reset) ---
    if (reset) {
      const report = await resetDatabase(owner)
      const emptied = report.filter((r) => r.deleted > 0)
      console.log(
        `Reset: deleted ${emptied.map((r) => `${r.deleted} ${r.table}`).join(', ') || 'nothing'} ` +
          '(library exercises kept; stored photos and logos are not deleted from storage).',
      )
    }

    const auth = app.get(AuthService)
    const clinicsService = app.get(ClinicsService)
    const users = app.get(UsersService)
    const invitations = app.get(InvitationsService)
    const careTeam = app.get(CareTeamService)
    const exercisesService = app.get(ExercisesService)
    const programs = app.get(ProgramsService)
    const assignedPrograms = app.get(AssignedProgramsService)

    const clinicIds = new Map<ClinicKey, number>()
    const accountIds = new Map<AccountKey, number>()
    const idOf = (key: AccountKey) => {
      const id = accountIds.get(key)
      if (id === undefined)
        throw new Error(`Seed: account "${key}" isn't created yet`)
      return id
    }

    // Acting AS someone: exactly what the session gives a signed-in request
    // (SessionSerializer.deserializeUser): the user, plus the active role.
    const as = async (
      key: AccountKey,
      activeRole: UserRole,
    ): Promise<CurrentUser> => ({
      ...(await users.findOne(idOf(key))),
      activeRole,
    })

    // --- 3. The founding admin and the first clinic (one-time setup) ---
    const founder = ACCOUNTS[0]
    if (founder.kind !== 'founder')
      throw new Error('Seed: the first account must be the founder')
    const [firstClinic, ...otherClinics] = CLINICS
    const setup = await auth.registerClinic(
      await validated(RegisterClinicDto, {
        clinicName: firstClinic.name,
        clinicEmail: firstClinic.email,
        clinicPhone: firstClinic.phone,
        clinicAddressLine1: firstClinic.addressLine1,
        clinicAddressCity: firstClinic.addressCity,
        clinicAddressPostalCode: firstClinic.addressPostalCode,
        clinicAddressCountry: firstClinic.addressCountry,
        email: founder.email,
        password: DEMO_PASSWORD,
        firstName: founder.firstName,
        lastName: founder.lastName,
        position: founder.position,
      }),
    )
    clinicIds.set(firstClinic.key, setup.clinicId)
    accountIds.set(founder.key, setup.id)
    const admin = await as('admin', UserRole.ADMIN)

    for (const clinic of otherClinics) {
      const { key, name, email: clinicEmail, ...address } = clinic
      const created = await clinicsService.create(
        admin,
        await validated(CreateClinicDto, {
          name,
          email: clinicEmail,
          ...address,
        }),
      )
      clinicIds.set(key, created.id)
    }
    const clinicId = (key: ClinicKey) => {
      const id = clinicIds.get(key)
      if (id === undefined) throw new Error(`Seed: unknown clinic "${key}"`)
      return id
    }
    for (const key of founder.clinics.slice(1)) {
      await clinicsService.addMember(clinicId(key), setup.id, admin)
    }

    // --- 4. Everyone else, invited the real way ---
    for (const account of ACCOUNTS.slice(1)) {
      if (account.kind === 'founder')
        throw new Error('Seed: only the first account is a founder')

      // Staff are created by the admin; a patient by the practitioner
      // named in the dataset, who thereby joins the care team.
      const creator =
        account.kind === 'patient'
          ? await as(account.createdBy, UserRole.PRACTITIONER)
          : admin
      const profile =
        account.kind === 'practitioner'
          ? {
              licenseNumber: account.licenseNumber,
              specialties: account.specialties,
            }
          : { dateOfBirth: account.dateOfBirth }

      email.mode = invitationMode(account)
      if (email.mode === 'fail') {
        // The app logs a failed invitation email as an ERROR — correctly,
        // in real use. Here it's the point, so say so before it appears.
        console.log(
          `  (${account.email}: its invitation email fails on purpose — the error logged next is expected.)`,
        )
      }
      const created = await users.create(
        await validated(CreateUserDto, {
          email: account.email,
          role:
            account.kind === 'practitioner'
              ? UserRole.PRACTITIONER
              : UserRole.PATIENT,
          firstName: account.firstName,
          lastName: account.lastName,
          clinicId: clinicId(account.clinics[0]),
          ...profile,
        }),
        creator,
      )
      email.mode = 'capture'
      accountIds.set(account.key, created.id)

      for (const key of account.clinics.slice(1)) {
        await clinicsService.addMember(clinicId(key), created.id, admin)
      }

      if (account.invitation === 'accepted') {
        // As the person would: the token from the invitation email's link.
        await invitations.accept(
          email.invitationTokenFor(account.email),
          DEMO_PASSWORD,
        )
      }
      if (account.invitation === 'expired') {
        // The one state the app can't make on demand (it would take 7
        // days): the invitation is moved into the past. Created 10 days
        // ago, expired 3 days ago — expires_at stays after created_at,
        // as the table's CHECK requires.
        await owner.query(
          `UPDATE invitations
              SET created_at = now() - interval '10 days',
                  email_sent_at = now() - interval '10 days',
                  expires_at = now() - interval '3 days'
            WHERE user_id = $1`,
          [created.id],
        )
      }

      if (account.kind === 'practitioner' && account.alsoAdmin) {
        await users.grantRole(
          created.id,
          await validated(GrantRoleDto, {
            role: UserRole.ADMIN,
            position: account.alsoAdmin.position,
          }),
          admin,
        )
      }
      if (account.kind === 'patient') {
        // "Join care team", by each practitioner themselves.
        for (const joiner of account.alsoOnCareTeam ?? []) {
          await careTeam.addMember(
            created.id,
            await validated(AddCareTeamMemberDto, {}),
            await as(joiner, UserRole.PRACTITIONER),
          )
        }
      }
    }

    // --- 5. Content: exercises, templates, an assigned program ---
    const alex = await as('alex', UserRole.PRACTITIONER)
    const customIds = new Map<string, number>()
    for (const exercise of CUSTOM_EXERCISES) {
      const created = await exercisesService.create(
        alex,
        await validated(CreateExerciseDto, exercise),
      )
      customIds.set(exercise.name, created.id)
    }

    // The library, by name — present only if `npm run seed:exercises` ran.
    const libraryNames = TEMPLATES.flatMap((t) => t.workouts)
      .flatMap((w) => w.lines)
      .map((line) =>
        'library' in line.exercise ? line.exercise.library : null,
      )
      .filter((name): name is string => name !== null)
    const libraryIds = new Map(
      (
        await owner.query<{ id: number; name: string }>(
          `SELECT id, name FROM exercises WHERE source = 'api' AND name = ANY($1)`,
          [libraryNames],
        )
      ).rows.map((row) => [row.name, row.id]),
    )
    const missingLibrary = libraryNames.filter((name) => !libraryIds.has(name))

    const templateIds = new Map<string, number>()
    // Templates with a workout left EMPTY — when the library isn't imported,
    // its exercises are skipped below. Assigning refuses such a template (a
    // patient can't be given an empty workout), so their assignments are
    // skipped and reported at the end.
    const incompleteTemplates = new Set<string>()
    for (const template of TEMPLATES) {
      const created = await programs.create(
        alex,
        await validated(CreateTemplateDto, {
          title: template.title,
          description: template.description,
        }),
      )
      templateIds.set(template.title, created.id)
      // A new template has one unnamed workout (A). The dataset's first
      // workout IS that one — named if the dataset names it; every further
      // one is added after it. Through the real routes' service methods, as
      // Alex, like everything else here.
      let workoutIds = (await programs.findOne(created.id)).workouts.map(
        (w) => w.id,
      )
      for (const [index, workout] of template.workouts.entries()) {
        if (index === 0) {
          if (workout.name !== undefined) {
            await programs.renameWorkout(
              created.id,
              workoutIds[0],
              alex,
              await validated(RenameWorkoutDto, { name: workout.name }),
            )
          }
        } else {
          const updated = await programs.addWorkout(
            created.id,
            alex,
            await validated(AddWorkoutDto, { name: workout.name }),
          )
          workoutIds = updated.workouts.map((w) => w.id)
        }

        let sortOrder = 0
        for (const { exercise, ...prescription } of workout.lines) {
          const exerciseId =
            'custom' in exercise
              ? customIds.get(exercise.custom)
              : libraryIds.get(exercise.library)
          if (exerciseId === undefined) continue // library not imported: skipped, reported below
          await programs.addExercise(
            created.id,
            alex,
            await validated(AddTemplateExerciseDto, {
              exerciseId,
              workoutId: workoutIds[index],
              sortOrder,
              ...prescription,
            }),
          )
          sortOrder += 1
        }
        if (sortOrder === 0) incompleteTemplates.add(template.title)
      }
    }

    // UTC's today: the seed has no user, hence no time zone to prefer.
    const today = utcToday()
    // A template with an EMPTY workout (all of its exercises come from the
    // library, which isn't imported) can't be assigned: the service refuses
    // it (400). Skip it and say so at the end, like the skipped library
    // exercises, instead of failing the whole seed.
    const skippedAssignments: string[] = []
    for (const assignment of ASSIGNED_PROGRAMS) {
      if (incompleteTemplates.has(assignment.template)) {
        skippedAssignments.push(assignment.title)
        continue
      }
      const startDate = addDays(today, -assignment.startsDaysAgo)
      const program = await assignedPrograms.create(
        await as(assignment.by, UserRole.PRACTITIONER),
        await validated(CreateAssignedProgramDto, {
          patientId: idOf(assignment.patient),
          basedOnTemplateId: templateIds.get(assignment.template),
          title: assignment.title,
          startDate,
          schedule: assignment.schedule,
        }),
      )

      // A history of completed sessions on past days. Written directly, as
      // the database owner: the API only records a session dated TODAY
      // (POST /sessions refuses any other local date), and these are in the
      // past — the same reason the expired invitation is written by hand.
      // Each session did one workout — the one the schedule, as create()
      // stored it, asks for (seedSessionWorkouts) — and gets that workout's
      // checklist like a real one (every exercise, completed), so opening
      // it shows something. 18:00 UTC on that day as the moment; the local
      // date is what the schedule judges.
      const sessions = seedSessionDays(
        startDate,
        today,
        assignment.schedule,
        assignment.history,
      )
      const workoutIds = seedSessionWorkouts(
        startDate,
        program.schedules[0],
        sessions,
      )
      for (const [index, { day, countsFor }] of sessions.entries()) {
        const workout = program.workouts.find(
          (w) => w.id === workoutIds[index],
        )!
        // counts_for: set only for a session done early or half of a swap
        // (the day it fulfils).
        const {
          rows: [session],
        } = await owner.query<{ id: number }>(
          `INSERT INTO sessions
             (assigned_program_id, workout_id, patient_id, scheduled_date, local_date,
              counts_for, started_at, completed_at, total_duration_in_seconds, status)
           VALUES ($1, $2, $3, $4::date + time '17:30' AT TIME ZONE 'UTC', $4, $5,
                   $4::date + time '17:30' AT TIME ZONE 'UTC',
                   $4::date + time '18:00' AT TIME ZONE 'UTC', 1800, 'completed')
           RETURNING id`,
          [program.id, workout.id, program.patientId, day, countsFor],
        )
        for (const exercise of program.exercises.filter(
          (e) => e.workoutId === workout.id,
        )) {
          // The checklist row keeps a copy of the exercise's name and
          // prescription, like a real session's (SessionsService.create's
          // prescriptionSnapshot, step 3b-0) — copied by the database itself
          // from the program exercise row: INSERT … SELECT.
          await owner.query(
            `INSERT INTO session_exercises
               (session_id, assigned_program_exercise_id, name, sets, reps,
                duration_in_seconds, weight, weight_unit, notes, completed,
                sort_order)
             SELECT $1, pe.id, pe.name, pe.sets, pe.reps,
                    pe.duration_in_seconds, pe.weight, pe.weight_unit, pe.notes,
                    true, pe.sort_order
             FROM assigned_program_exercises pe
             WHERE pe.id = $2`,
            [session.id, exercise.id],
          )
        }
      }

      // Closing and continuing (step 2b-iii), through the real service and
      // as the same practitioner — the end date (yesterday), the read-only
      // rule and the audit entries are the app's own.
      if (assignment.close) {
        await assignedPrograms.close(
          program.id,
          await as(assignment.by, UserRole.PRACTITIONER),
          assignment.close,
          today,
        )
      }
      if (assignment.assignAgain) {
        await assignedPrograms.create(
          await as(assignment.by, UserRole.PRACTITIONER),
          await validated(CreateAssignedProgramDto, {
            patientId: idOf(assignment.patient),
            basedOnProgramId: program.id,
            title: assignment.assignAgain.title,
            startDate: today,
            schedule: assignment.assignAgain.schedule,
          }),
        )
      }
    }

    // --- 6. Deactivations, last (a deactivated account can't be acted on) ---
    for (const account of ACCOUNTS) {
      if (account.kind === 'patient' && account.deactivated) {
        await users.softDelete(idOf(account.key), admin)
      }
    }

    // --- 7. What was made ---
    console.log(
      `\nDone. Every account with a password uses: ${DEMO_PASSWORD}\n`,
    )
    for (const account of ACCOUNTS) {
      const state =
        account.kind === 'founder'
          ? 'password set'
          : account.kind === 'patient' && account.deactivated
            ? 'deactivated'
            : account.invitation === 'accepted'
              ? 'password set'
              : `invitation ${account.invitation}`
      console.log(
        `  ${account.email.padEnd(28)} ${state.padEnd(28)} ${account.shows}`,
      )
    }
    console.log(
      '\nInvitation emails sent for real: open Mailpit at http://localhost:8025.',
    )
    if (missingLibrary.length > 0) {
      console.log(
        `\nNote: the exercise library isn't imported, so the templates skip: ${missingLibrary.join(', ')}.` +
          (skippedAssignments.length > 0
            ? `\nThese programs weren't assigned (their template has an empty workout): ${skippedAssignments.join(', ')}.`
            : '') +
          '\nRun `npm run seed:exercises`, then `npm run seed:dev -- --reset` (or `npm run seed -- --reset`).',
      )
    }
  } finally {
    await owner.end()
    await app.close()
  }
}

run().catch((error) => {
  console.error('Seed failed:', error)
  process.exit(1)
})