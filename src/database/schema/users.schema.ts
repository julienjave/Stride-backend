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

// --- IMPORTS -----------------------------------------------------------------------------------------------

import {
  pgTable,
  serial,
  integer,
  varchar,
  boolean,
  timestamp,
  date,
  text,
  pgEnum,
  unique,
  index,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { clinics } from './clinics.schema'
import { weightUnitEnum } from './weight-unit.schema'

// --- SCHEMA ------------------------------------------------------------------------------------------------

// pgEnum defines a native Postgres ENUM type. The first argument is the SQL type's
// name; the array is the fixed set of allowed values, enforced by the database itself
// (an insert with any other string fails at the DB layer, not just in application code).
export const roleEnum = pgEnum('role', ['admin', 'practitioner', 'patient'])

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    // Stored in ONE spelling — trimmed, A–Z lowercased (common/email-address.ts,
    // normalizeEmail) — since the "Change email" item (Phase 6, decided with
    // the person 2026-10-22): emails are case-insensitive. So this UNIQUE
    // (users_email_unique) means "unique ignoring case", and every lookup is a
    // plain equality. The CHECK below makes the database refuse any other
    // spelling.
    email: varchar('email', { length: 255 }).notNull().unique(),
    // NULL = the person hasn't chosen a password yet: the account was created
    // by invitation (decisions §3) and the invitation hasn't been accepted.
    // Such an account can't log in, and can't get in through forgot/reset
    // password either — accepting the invitation is its only way in (see
    // AuthService.validateUser / forgotPassword / resetPassword). A NULL rather
    // than a fake "unusable" hash, so "has this person set a password?" is a
    // fact the code and the database can ask directly.
    passwordHash: varchar('password_hash', { length: 255 }),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    avatarPath: varchar('avatar_path', { length: 500 }),
    phone: varchar('phone', { length: 50 }),
    // Same address model as clinics.schema.ts — see that file's comments
    // for the full reasoning (optional as a unit, core-fields-required-
    // together enforced at the DTO layer, country as ISO 3166-1 alpha-2,
    // state as free text since not every country has a fixed list).
    addressLine1: varchar('address_line1', { length: 255 }),
    addressLine2: varchar('address_line2', { length: 255 }),
    addressCity: varchar('address_city', { length: 100 }),
    addressState: varchar('address_state', { length: 100 }),
    addressPostalCode: varchar('address_postal_code', { length: 20 }),
    addressCountry: varchar('address_country', { length: 2 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    passwordResetTokenHash: varchar('password_reset_token_hash', {
      length: 255,
    }),
    passwordResetTokenExpiresAt: timestamp('password_reset_token_expires_at', {
      withTimezone: true,
    }),
    // Nullable — only present once MFA setup has been started.
    // mfaEnabled gates whether sign-in asks for a code; a set-up secret not
    // yet confirmed has no effect until enable confirms a code from it.
    // ENCRYPTED at rest (AES-256-GCM, auth/mfa-secret-crypto.ts, with
    // MFA_ENCRYPTION_KEY — a key kept outside the database): unlike
    // passwordHash, which is one-way, a TOTP secret must stay readable to
    // check codes, so a copy of the database alone must not be enough to
    // compute anyone's codes. (In production the key would live in a key
    // management service.)
    mfaSecret: varchar('mfa_secret', { length: 255 }),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    // The time step (floor(unix seconds / 30)) of the last two-factor code
    // this account ACCEPTED — a code is good only if its step is later
    // (no code works twice: RFC 6238 §5.2; mfa/totp.ts). Null = no code used
    // since MFA was last set up. An integer is enough: today's step is about
    // 59 million, and the column overflows in the year 4011.
    mfaLastUsedStep: integer('mfa_last_used_step'),
    // How many step-ups in a row this account has FAILED (a wrong password,
    // or a wrong / used two-factor code, where a change asks them again —
    // mfa/step-up.service.ts; decisions §16). Back to 0 on a step-up that
    // passes; at 5 the session that failed is signed out and it starts over.
    // On the account rather than the session: one atomic UPDATE counts
    // failures from several tabs at once, where a counter kept in the
    // session's JSON could lose increments between parallel requests.
    // Server-internal: UsersService.toPublic() strips it.
    stepUpFailures: integer('step_up_failures').notNull().default(0),
    // The unit this person thinks in. It's used in two places: it's the unit
    // pre-selected when they type a new weight (a practitioner building a
    // program), and the unit every weight is DISPLAYED in for them
    // (converted on screen when a weight was saved in the other unit).
    // Stored weights are never converted — each keeps the unit it was
    // prescribed in (see weight-unit.schema.ts).
    //
    // NOT NULL with a DEFAULT: every user always has a preference, so no
    // code anywhere has to handle "no preference yet". The default also
    // fills the column in for every EXISTING row when the migration adds
    // it — Postgres can't add a NOT NULL column to a table that already has
    // rows unless it knows what to put in them.
    preferredWeightUnit: weightUnitEnum('preferred_weight_unit')
      .notNull()
      .default('kg'),
  },
  (table) => ({
    // The database's half of normalizeEmail(): the stored email equals
    // itself trimmed and with A–Z lowercased. COLLATE "C" pins lower() to
    // A–Z whatever the server's locale — the app's rule exactly (see
    // normalizeEmail on why the two must agree). btrim() removes spaces at
    // both ends. Whatever writes an email — the app, the seed, a query typed
    // by hand — can't store 'Jane@x.com' next to 'jane@x.com'. Added by
    // migration 0052, which normalised the existing rows first (after
    // refusing to run if two of them would collide).
    emailNormalized: check(
      'users_email_normalized',
      sql`${table.email} = btrim(lower(${table.email} COLLATE "C"))`,
    ),
    // MFA can't be ON without a secret to check codes against. The app never
    // writes that (disable clears both at once), but a sign-in that found
    // mfa_enabled with no secret would have nothing to verify: this makes the
    // state impossible rather than handled. (mfa/totp.ts and the step-up still
    // refuse it — fail closed — since TypeScript can't see a CHECK.)
    mfaEnabledHasSecret: check(
      'users_mfa_enabled_has_secret',
      sql`NOT ${table.mfaEnabled} OR ${table.mfaSecret} IS NOT NULL`,
    ),
    // A count can't be negative — a slip in the code that resets it (a
    // decrement instead of a reset) fails loudly instead of storing nonsense.
    stepUpFailuresNotNegative: check(
      'users_step_up_failures_not_negative',
      sql`${table.stepUpFailures} >= 0`,
    ),
  }),
)

// One person can hold several roles (e.g. a clinic owner who is both admin
// AND a treating practitioner) — this is why it's its own table with a
// generated id, rather than userId-as-primary-key the way the profile
// tables below work (those are strictly 1:1; this is 1:many).
export const userRoles = pgTable(
  'user_roles',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
  },
  (table) => ({
    // Prevents granting the same role to the same user twice.
    userRoleUnique: unique('user_roles_user_role_unique').on(
      table.userId,
      table.role,
    ),
    userIdIdx: index('user_roles_user_id_idx').on(table.userId),
  }),
)

// A join table: no independent meaning of its own, just links two other tables.
export const userClinics = pgTable(
  'user_clinics',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    clinicId: integer('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    // Prevents the same user/clinic pairing from being inserted twice.
    userClinicUnique: unique('user_clinics_user_clinic_unique').on(
      table.userId,
      table.clinicId,
    ),
    userIdIdx: index('user_clinics_user_id_idx').on(table.userId),
    clinicIdIdx: index('user_clinics_clinic_id_idx').on(table.clinicId),
  }),
)

// One row per practitioner user. userId is BOTH the primary key AND the foreign key —
// this is what makes the 1:1 relationship structurally enforced, not just conventional.
export const practitionerProfiles = pgTable('practitioner_profiles', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  licenseNumber: varchar('license_number', { length: 100 }).notNull().unique(),
  specialties: text('specialties').array().notNull().default([]),
  bio: text('bio'),
})

export const patientProfiles = pgTable('patient_profiles', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  dateOfBirth: date('date_of_birth').notNull(),
})

export const adminProfiles = pgTable('admin_profiles', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  position: varchar('position', { length: 100 }),
})
