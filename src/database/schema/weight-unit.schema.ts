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

import { pgEnum } from 'drizzle-orm/pg-core'

// --- ENUM --------------------------------------------------------------------------------------------------

// The allowed weight units, written ONCE and shared by everything that
// needs them: the Postgres enum below, and the DTOs that validate a unit
// sent by a client (UpdateUserDto's preferredWeightUnit).
//
// `as const` makes TypeScript keep the exact strings: the type is the
// read-only tuple ['kg', 'lbs'], not the much looser string[]. Both
// pgEnum() and the WeightUnit type below depend on that.
export const WEIGHT_UNITS = ['kg', 'lbs'] as const

// 'kg' | 'lbs', derived from the list above rather than typed a second
// time: `(typeof WEIGHT_UNITS)[number]` means "the type of any element of
// this tuple". Adding a unit to the list updates the type automatically.
export type WeightUnit = (typeof WEIGHT_UNITS)[number]

// A weight value with no unit is genuinely ambiguous in a clinical
// context — "50" could mean 50kg or 50lbs, and mixing those up is a
// real safety concern, not just a display nitpick. Storing the unit
// explicitly alongside every weight value (rather than assuming one
// fixed unit app-wide, or a per-clinic/per-user setting looked up
// elsewhere) removes that ambiguity at the row level, where it's read.
//
// Used by two tables in two files: the exercise weights in
// programs.schema.ts, and each user's preferred unit in users.schema.ts.
// It lives in its OWN file because programs.schema.ts already imports
// users.schema.ts (for the practitioner foreign key). If users.schema.ts
// imported the enum back from programs.schema.ts, the two files would
// import each other — a circular import — and whichever file loaded
// second would see the other half-finished, with `weightUnitEnum` still
// undefined at the moment it's called. A third file that imports neither
// breaks the cycle.
//
// Moving the definition between files changes nothing in the database:
// Postgres knows the type by its NAME ('weight_unit'), and drizzle-kit
// compares names, so no migration comes out of the move itself.
export const weightUnitEnum = pgEnum('weight_unit', WEIGHT_UNITS)
