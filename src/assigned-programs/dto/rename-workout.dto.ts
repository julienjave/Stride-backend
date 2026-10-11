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

import { IsString, MaxLength, ValidateIf } from 'class-validator'
import { WORKOUT_NAME_MAX_LENGTH } from '../../common/workout-rules'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// PATCH …/workouts/:workoutId — rename a workout, or remove its name.
//
// `name` is REQUIRED as a key, but may be null: renaming is this route's only
// job, so a body without `name` is a client bug worth a 400, while
// `{ "name": null }` (or a blank string) deliberately clears the name. That's
// why @ValidateIf, not @IsOptional: @IsOptional would skip the checks for an
// ABSENT key too; this skips them only for null, so a missing key still
// reaches @IsString and is refused.
export class RenameWorkoutDto {
  @ValidateIf((dto: RenameWorkoutDto) => dto.name !== null)
  @IsString()
  @MaxLength(WORKOUT_NAME_MAX_LENGTH)
  name!: string | null
}