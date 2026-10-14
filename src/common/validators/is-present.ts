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

// --- VALIDATOR HELPER --------------------------------------------------------------------------------------

// "Validate this field only if the request actually sent it."
//
// For PATCH DTOs, used INSTEAD of @IsOptional() on fields whose database
// column is NOT NULL (a user's names, a clinic's name and email, …).
// The two look alike but differ on exactly one value, null:
//   - @IsOptional() skips every other validator when the value is
//     undefined OR null. So `{ name: null }` sailed through, reached
//     `.set({ name: null })`, and Postgres rejected it with a NOT NULL
//     violation — a 500 instead of a 400.
//   - `@ValidateIf(isPresent)` skips only when the value is undefined
//     (the field was not sent). An explicit null now reaches @IsString()/
//     @IsEmail()/…, which reject it with a proper 400.
// Nullable columns (phone, bio, address fields, …) keep @IsOptional(),
// because for them null is a real, meaningful value: "clear this field".
//
// Shared (first written inside UpdateUserDto, moved here when
// UpdateClinicDto needed the same rule) so the two DTOs can't drift apart.
export const isPresent = (_dto: object, value: unknown) => value !== undefined
