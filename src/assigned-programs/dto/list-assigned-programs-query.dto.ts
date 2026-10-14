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

import { Type } from 'class-transformer'
import { IsInt, IsOptional, Min } from 'class-validator'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// GET /assigned-programs?patientId=… — narrows the list to one patient's
// programs (the practitioner's patient page). Omitted → the role-scoped
// list as before.
//
// A query string value is always a string ("6", not 6): @Type(() => Number)
// converts it before @IsInt() runs — the same pair as PaginationQueryDto,
// relying on the global ValidationPipe's `transform: true`. "abc" becomes
// NaN, which @IsInt() refuses with a 400, rather than reaching the database.
export class ListAssignedProgramsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  patientId?: number
}
