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

import { IsString, MaxLength, IsOptional } from 'class-validator'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// Exported so ProgramsService.duplicate() can trim a copy's generated
// title ("Copy of ...") to exactly the same limit this DTO enforces on
// every title a person types — one number, one place. If it were
// hard-coded separately in both files, raising it here someday would
// quietly leave duplicates trimming to the OLD limit.
export const TEMPLATE_TITLE_MAX_LENGTH = 200

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class CreateTemplateDto {
  @IsString()
  @MaxLength(TEMPLATE_TITLE_MAX_LENGTH)
  title!: string

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string
}