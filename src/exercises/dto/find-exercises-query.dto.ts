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

import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator'
import { Transform } from 'class-transformer'
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// Extends, rather than duplicating, page/limit — and critically, bundles
// "search" and "mine" into the SAME class as pagination, so a single
// @Query() binding captures the whole query string at once. See the note
// in ExercisesModule's improvements writeup for why splitting this across
// multiple @Query() decorators would break under ValidationPipe's
// whitelist option.
export class FindExercisesQueryDto extends PaginationQueryDto {
  // Matches against the exercise's name AND its primary/secondary muscles
  // (see ExercisesService.findAll) — a practitioner searching for
  // "quad", say, should find exercises even if none of them literally
  // have "quad" in their name, since custom exercises are named however
  // the practitioner who created them chose to.
  @IsOptional()
  @IsString()
  @MaxLength(200) // a search TERM has no reason to be longer than a name itself would be
  search?: string

  // "Show only exercises I created" — @Transform, not class-transformer's
  // usual @Type(() => Boolean), for the exact same reason
  // UsersController.findAll's includeInactive param avoids it: Boolean(
  // 'false') evaluates to true in plain JavaScript (any non-empty string
  // is truthy), so @Type(() => Boolean) would silently treat
  // ?mine=false the same as ?mine=true. This DTO can't use that
  // endpoint's own fix directly (a raw @Query('mine') string, compared
  // by hand) because search/mine/page/limit all have to live on ONE
  // combined DTO — see this class's own comment above. @Transform lets
  // the same "compare the raw string to the one value that means true"
  // logic apply to a field inside a validated DTO instead.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true')
  @IsBoolean()
  mine?: boolean
}
