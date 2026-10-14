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

// Both AddTemplateExerciseDto and AssignedExerciseInputDto share this
// rule: weight and weightUnit are each optional independently, but the
// moment EITHER is provided, both become required together — a weight
// with no unit is genuinely ambiguous (50 of what?), and a unit with no
// weight is meaningless clutter. Each field gets
// `@ValidateIf(hasStartedWeight)` — class-validator calls this with the
// whole DTO instance, so it can check the OTHER field too, not just the
// one being validated. Same "one source of truth per validation rule"
// reasoning as hasStartedAddress, just for a simpler two-field,
// symmetric case rather than address's four-of-six-fields shape.
//
// Uses `!= null`, not `!!`, specifically because weight is a NUMBER —
// `!!weight` would incorrectly treat a genuine (if unusual) weight of 0
// as "not started," when it's actually a real provided value that should
// still require a unit alongside it.
//
// `!= null` (loose inequality) rather than `!== undefined` (strict): the
// loose form is true for anything EXCEPT null and undefined, so both
// count as "not provided." That's what makes clearing possible — a PATCH
// of { weight: null, weightUnit: null } means "remove the weight," and
// has to pass validation (and reach .set() as SQL NULLs). With the old
// `!== undefined`, null counted as "started," so @IsNumber() then
// rejected it and a weight could never be cleared. (undefined can't be
// used for clearing instead: JSON has no undefined, so a key set to it
// is simply dropped from the request body before it's ever sent.)
//
// Half-cleared payloads stay rejected, as they should: in
// { weight: null, weightUnit: "kg" } the unit alone counts as started,
// so weight must then be a real number — and null isn't one.
export function hasStartedWeight(dto: {
  weight?: number | null
  weightUnit?: string | null
}): boolean {
  return dto.weight != null || dto.weightUnit != null
}
