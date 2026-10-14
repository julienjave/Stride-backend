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

// Every DTO with address fields (CreateClinicDto, UpdateClinicDto,
// CreateUserDto, UpdateUserDto, RegisterDto, RegisterClinicDto) shares
// the same rule: an address is optional as a whole unit, but the moment
// ANY of the four "core" fields (line1, city, postal code, country) is
// provided, all four become required together — a half-filled address
// (a city with no country, say) isn't a usable one. Each of those four
// fields gets `@ValidateIf(hasStartedAddress)` — class-validator calls
// this with the whole DTO instance, so it can check the OTHER core
// fields too, not just the one being validated.
//
// Defined once here rather than as an identical inline arrow function
// repeated in six DTOs, so the rule can't quietly drift between them —
// the same "one source of truth per validation rule" principle already
// used for the frontend's field schemas.
export function hasStartedAddress(dto: {
  addressLine1?: string
  addressLine2?: string
  addressCity?: string
  addressState?: string
  addressPostalCode?: string
  addressCountry?: string
}): boolean {
  return (
    !!dto.addressLine1 ||
    !!dto.addressCity ||
    !!dto.addressPostalCode ||
    !!dto.addressCountry
  )
}
