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
import { IsTitle } from '../../common/validators/title'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// A description may be long (a few paragraphs about who the template is for)
// but not unbounded. Exported for UpdateTemplateDto: one number, one place.
export const TEMPLATE_DESCRIPTION_MAX_LENGTH = 2000

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

export class CreateTemplateDto {
  // A string of at most 200 characters, not blank — the rule every title
  // follows, templates' and programs' (common/validators/title.ts). Until
  // 2026-10-14 this was @IsString() + @MaxLength() only, so '' and '   '
  // were stored. The limit (TITLE_MAX_LENGTH) lives there too, and
  // ProgramsService.duplicate() trims its "Copy of …" title to it.
  @IsTitle('template')
  title!: string

  // Nullable column: "no description" is a real value, so @IsOptional() is
  // right here (it skips the checks for undefined AND null).
  @IsOptional()
  @IsString()
  @MaxLength(TEMPLATE_DESCRIPTION_MAX_LENGTH)
  description?: string
}