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

import { PartialType, OmitType } from '@nestjs/mapped-types'
import { AddTemplateExerciseDto } from './add-template-exercise.dto'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// OmitType strips exerciseId before PartialType makes everything else
// optional — changing WHICH exercise a slot points to isn't really an
// "update," it's closer to removing this slot and adding a different one.
// Combining the two mapped-type helpers avoids hand-writing a near-duplicate
// of AddTemplateExerciseDto just to drop one field.
export class UpdateTemplateExerciseDto extends PartialType(
  OmitType(AddTemplateExerciseDto, ['exerciseId'] as const),
) {}
