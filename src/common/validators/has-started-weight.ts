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
// Uses `!== undefined`, not `!!`, specifically because weight is a
// NUMBER — `!!weight` would incorrectly treat a genuine (if unusual)
// weight of 0 as "not started," when it's actually a real provided
// value that should still require a unit alongside it.
export function hasStartedWeight(dto: {
  weight?: number;
  weightUnit?: string;
}): boolean {
  return dto.weight !== undefined || dto.weightUnit !== undefined;
}