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
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// Extends, rather than duplicating, page/limit — and critically, bundles
// "search" into the SAME class as pagination, so a single @Query() binding
// captures the whole query string at once. See the note in ExercisesModule's
// improvements writeup for why splitting this across two @Query() decorators
// would break under ValidationPipe's whitelist option.
export class FindExercisesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200) // a search TERM has no reason to be longer than a name itself would be
  search?: string
}
