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
  MaxLength,
  IsArray,
  ArrayMaxSize,
  IsDateString,
} from 'class-validator'

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
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string

  // --- Practitioner-profile fields (target must hold the practitioner role) ---
  @IsOptional()
  @IsString()
  @MaxLength(100)
  licenseNumber?: string

  // A full replacement of the array, not a merge/append — same semantics
  // CreateUserDto's specialties already has at creation time.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  specialties?: string[]

  // --- Patient-profile field (target must hold the patient role) ---
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string

  // --- Admin-profile field (target must hold the admin role) ---
  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string
}
