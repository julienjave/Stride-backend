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

// --- HELPER ------------------------------------------------------------------------------------------------

// An imported exercise's instruction steps, cleaned the way the app's own
// rule reads them (IsExerciseList — common/validators/exercise-description.ts):
// each step trimmed, and a step with nothing visible in it DROPPED. The
// upstream library has a few empty steps ("Barbell Squat To A Bench" and
// "Clean" had a blank step 2, found 2026-10-14): stored as they came, they
// showed as an empty numbered item, and editing that exercise's
// instructions was refused until the practitioner removed the blank step.
//
// Pure (no database, no network), so seed-exercises.ts calls it and the
// spec tests it with plain arrays. `\S` = any non-whitespace character —
// the same test as the DTOs' `Matches(/\S/)`, so a tab-only step goes too.
// The ORDER of the remaining steps is kept: they're numbered as they come.
export function cleanInstructions(steps: string[]): string[] {
  return steps.map((step) => step.trim()).filter((step) => /\S/.test(step))
}