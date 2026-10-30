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
  IsOptional,
  IsString,
  IsNotEmpty,
  MaxLength,
  Length,
  IsArray,
  ArrayMaxSize,
  IsDateString,
  IsBoolean,
  IsIn,
  ValidateIf,
} from 'class-validator'
import { hasStartedAddress } from '../../common/validators/has-started-address'
import { isPresent } from '../../common/validators/is-present'
import {
  WEIGHT_UNITS,
  type WeightUnit,
} from '../../database/schema/weight-unit.schema'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// Deliberately narrow for now: only the fields it's actually safe to self-edit
// here. Email, role, and password changes are left out on purpose — those
// belong behind separate, more carefully guarded flows (email change often
// wants re-verification; password change belongs in AuthService, not here).
//
// avatarPath is deliberately absent too, for a reason worth being explicit
// about — same principle CreateClinicDto's logoPath already followed:
// a file-backed field should only ever be settable
// through the flow that actually verifies a real object was uploaded
// (POST /users/:id/avatar, via StorageService). Allowing it here as a plain
// string would let a client set it to ANY value — a URL that was never
// uploaded, a nonexistent key, or a probe attempting to guess/enumerate
// real object keys in storage — entirely bypassing the point of having a
// dedicated, verified upload endpoint at all.
//
// licenseNumber/specialties/dateOfBirth/position are the same
// per-role profile fields CreateUserDto/GrantRoleDto already validate at
// creation/grant time — flat here too, matching that module-wide
// convention, rather than nesting them under a practitionerProfile/
// patientProfile/adminProfile sub-object (no precedent for that shape
// anywhere in this codebase; the only @ValidateNested() usage validates an
// ARRAY of sub-items, not a single nested object). Unlike CreateUserDto,
// none of these carry @ValidateIf(role === ...): PATCH has no `role` field
// to condition on, since the target's role was fixed at creation. Instead,
// UsersService.update() checks each field against the TARGET's actual
// held roles (not the caller's) before writing — see the comment there.
export class UpdateUserDto {
  // Required columns: may be omitted, but never cleared — see isPresent.
  // @IsNotEmpty() additionally rejects '' (an empty name is not a name).
  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string

  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string

  // --- Common fields (every role) ---
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string

  // Address core-fields-required-together (see has-started-address.ts)
  // needs BOTH @ValidateIf and @IsOptional here, unlike CreateUserDto's
  // equivalent fields — this DTO is hand-written, not PartialType-
  // derived, so it doesn't get PartialType's automatic @IsOptional on
  // every field for free. Without it explicitly here, a legitimate
  // single-field patch (e.g. just updating addressCity) would
  // incorrectly demand the other three core fields too: @ValidateIf
  // alone would gate them IN once addressCity is seen, and @IsString()
  // rejects undefined just as readily as it rejects a genuinely missing
  // value. @IsOptional() is what lets an OMITTED field pass through
  // untouched while a malformed EXPLICIT one (e.g. addressCountry: '')
  // still correctly fails length/type checks.
  @ValidateIf(hasStartedAddress)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine1?: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressLine2?: string

  @ValidateIf(hasStartedAddress)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  addressCity?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  addressState?: string

  @ValidateIf(hasStartedAddress)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  addressPostalCode?: string

  @ValidateIf(hasStartedAddress)
  @IsOptional()
  @IsString()
  @Length(2, 2)
  addressCountry?: string

  // --- Practitioner-profile fields (target must hold the practitioner role) ---
  // Admin-only to CHANGE (decisions §4) — enforced in UsersService.update(),
  // not here: a DTO validates the shape of a request, and cannot know who
  // sent it.
  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  licenseNumber?: string

  // A full replacement of the array, not a merge/append — same semantics
  // CreateUserDto's specialties already has at creation time. Clearing
  // every specialty is `[]`, never null (the column is NOT NULL, default
  // empty array).
  @ValidateIf(isPresent)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  specialties?: string[]

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string

  // --- Patient-profile field (target must hold the patient role) ---
  @ValidateIf(isPresent)
  @IsDateString()
  dateOfBirth?: string

  // --- Admin-profile field (target must hold the admin role) ---
  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string

  // --- Preference (every role; only the user themselves may change it) ---
  // A NOT NULL column like the names, so the same pairing: may be
  // omitted, never cleared. @IsIn checks the value against the SAME list
  // the Postgres enum is built from — an unknown unit ('stone') is a clear
  // 400 here, instead of reaching the database and failing as a 500.
  // Self-only is enforced in UsersService.update(): who is asking is not
  // something a DTO can know.
  @ValidateIf(isPresent)
  @IsIn(WEIGHT_UNITS)
  preferredWeightUnit?: WeightUnit

  // "Email me about new messages" (roadmap Phase 6.5). NOT NULL too, so the
  // same pairing (null is refused, not "cleared"); self-only, like the
  // weight unit — UsersService.update() checks who is asking.
  @ValidateIf(isPresent)
  @IsBoolean()
  messageEmailNotices?: boolean
}
