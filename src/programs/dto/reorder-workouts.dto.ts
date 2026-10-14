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

import { IsArray, ArrayMinSize, ArrayMaxSize, IsInt } from 'class-validator'
import { MAX_WORKOUTS } from '../../common/workout-rules'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// PATCH …/workouts — the complete new order of the template's workouts, as
// workout ids (first = A). The service checks it lists exactly the template's
// workouts, each once (isPermutationOf); this only checks the shape.
export class ReorderWorkoutsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WORKOUTS)
  @IsInt({ each: true })
  order!: number[]
}
