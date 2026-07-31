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

import { IsInt, IsObject } from 'class-validator'
import { MaxJsonSize } from '../../common/validators/max-json-size.decorator'


// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class CreateMedicalFileDto {
  @IsInt()
  patientId!: number

  // Deliberately loose — @IsObject() only, not a rigid nested DTO. This
  // mirrors the schema's own intent: clinicalData is meant to hold
  // unstructured intake notes, history, and custom diagnostic fields that
  // vary entry to entry, not a fixed shape every note must conform to.
  // But loose on shape doesn't mean unbounded on SIZE — 50KB is generous
  // for genuinely detailed structured clinical notes, while still refusing
  // a runaway payload with no reasonable clinical justification for existing.
  @IsObject()
  @MaxJsonSize(50 * 1024)
  clinicalData!: Record<string, unknown>
}