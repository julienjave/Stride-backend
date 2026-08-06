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

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// The complete new ordering, as template_exercises row ids — analogous to
// ReorderImagesDto, but template exercises track order via an explicit
// sortOrder column rather than array position, since they're real rows
// with their own id, not plain strings in an array.
export class ReorderTemplateExercisesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200) // no realistic template needs more exercise slots than this
  @IsInt({ each: true })
  order!: number[]
}
