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
  unique 
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
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  passwordResetTokenHash: varchar('password_reset_token_hash', { length: 255 }),
  passwordResetTokenExpiresAt: timestamp('password_reset_token_expires_at', { withTimezone: true }),
})

// One person can hold several roles (e.g. a clinic owner who is both admin
// AND a treating practitioner) — this is why it's its own table with a
// generated id, rather than userId-as-primary-key the way the profile
// tables below work (those are strictly 1:1; this is 1:many).
export const userRoles = pgTable('user_roles', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: roleEnum('role').notNull(),
}, (table) => ({
  // Prevents granting the same role to the same user twice.
  userRoleUnique: unique('user_roles_user_role_unique').on(table.userId, table.role),
}))

// A join table: no independent meaning of its own, just links two other tables.
export const userClinics = pgTable('user_clinics', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  clinicId: integer('clinic_id')
    .notNull()
    .references(() => clinics.id, { onDelete: 'cascade' }),
}, (table) => ({
  // Prevents the same user/clinic pairing from being inserted twice.
  userClinicUnique: unique('user_clinics_user_clinic_unique').on(table.userId, table.clinicId),
}))

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
  phone: varchar('phone', { length: 50 }),
  address: varchar('address', { length: 500 }),
  dateOfBirth: date('date_of_birth').notNull(),
})

export const adminProfiles = pgTable('admin_profiles', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  position: varchar('position', { length: 100 }),
})