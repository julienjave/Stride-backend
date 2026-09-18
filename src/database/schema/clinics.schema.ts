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

import { pgTable, serial, varchar, boolean } from 'drizzle-orm/pg-core'

export const clinics = pgTable('clinics', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }),
  // Address is optional as a WHOLE unit (every column here stays
  // nullable), but the moment any of the core fields (line1, city,
  // postal code, country) is provided, the DTO layer requires all four
  // together — a half-an-address is worse than no address at all. That
  // rule lives in the DTO's validation, not here: these columns can't
  // express "required only when a sibling column is set."
  addressLine1: varchar('address_line1', { length: 255 }),
  // Apartment/suite/unit — genuinely optional even when the rest of the
  // address is filled in, unlike line1.
  addressLine2: varchar('address_line2', { length: 255 }),
  addressCity: varchar('address_city', { length: 100 }),
  // Not every country has a state/province concept, and the frontend
  // falls back to a free-text input for countries with no subdivision
  // list — so this stores whatever string was actually selected or
  // typed, not a rigid code the free-text path couldn't produce anyway.
  addressState: varchar('address_state', { length: 100 }),
  addressPostalCode: varchar('address_postal_code', { length: 20 }),
  // ISO 3166-1 alpha-2 (e.g. 'US', 'CA') — the country dropdown's value,
  // not a display name, so it stays stable regardless of what language
  // the frontend ever renders it in.
  addressCountry: varchar('address_country', { length: 2 }),
  website: varchar('website', { length: 255 }),
  logoPath: varchar('logo_path', { length: 500 }),
  isActive: boolean('is_active').notNull().default(true),
})