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

import { PartialType } from '@nestjs/mapped-types'
import { CreateExerciseDto } from './create-exercise.dto'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// PartialType generates a new DTO with every field from CreateExerciseDto
// marked optional, while KEEPING each field's original validators (still a
// string, still an array of strings) whenever it IS provided.
export class UpdateExerciseDto extends PartialType(CreateExerciseDto) {}
