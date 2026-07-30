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

import { IsOptional, IsInt, Min, Max } from 'class-validator'
import { Type } from 'class-transformer'


// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// Shared base for every paginated list endpoint — extend this, never
// duplicate page/limit by hand in each module's own query DTO.
export class PaginationQueryDto {
  // Query string values always arrive as strings ("1", not 1) — @Type(() =>
  // Number), from class-transformer, is what actually converts it to a real
  // number before @IsInt() ever runs, working together with the global
  // ValidationPipe's transform: true. Different mechanism from ParseIntPipe,
  // which only ever applies to a single @Param(), not a whole DTO.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100) // a hard ceiling — never let a client request an unbounded page size
  limit?: number = 20
}