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
} from 'drizzle-orm/pg-core'
import { clinics } from './clinics.schema'

// --- SCHEMA ------------------------------------------------------------------------------------------------

// pgEnum defines a native Postgres ENUM type. The first argument is the SQL type's
// name; the array is the fixed set of allowed values, enforced by the database itself
// (an insert with any other string fails at the DB layer, not just in application code).
export const roleEnum = pgEnum('role', ['admin', 'practitioner', 'patient'])

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
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
  passwordResetTokenHash: varchar('password_reset_token_hash', { length: 255 }),
  passwordResetTokenExpiresAt: timestamp('password_reset_token_expires_at', {
    withTimezone: true,
  }),
  // Nullable — only present once MFA setup has been initiated. isEnabled
  // gates whether login actually requires it; a generated-but-unconfirmed
  // secret sitting here is harmless, since it has no effect until enabled.
  // Worth being explicit about a real, deliberate scope limitation: this is
  // stored in plain text, not encrypted at rest — unlike passwordHash
  // (one-way, useless even with full database read access), a TOTP secret
  // must remain genuinely readable to verify codes, so anyone with raw
  // database access could compute valid codes for any account with MFA
  // enabled. Production would need application-level encryption of this
  // column with a key held separately from the database itself (e.g. a KMS).
  mfaSecret: varchar('mfa_secret', { length: 255 }),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
})

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