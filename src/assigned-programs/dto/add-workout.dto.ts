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

import { IsOptional, IsString, MaxLength } from 'class-validator'
import { WORKOUT_NAME_MAX_LENGTH } from '../../common/workout-rules'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// POST …/workouts — a new workout, added after the last one. The name is
// optional: "B" alone is a valid workout. Blank or whitespace-only counts as
// no name (normalizeWorkoutName); `null` is accepted too, for a client that
// always sends the key.
export class AddWorkoutDto {
  @IsOptional()
  @IsString()
  @MaxLength(WORKOUT_NAME_MAX_LENGTH)
  name?: string | null
}