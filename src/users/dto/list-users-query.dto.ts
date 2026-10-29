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

import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'
import { Transform, Type } from 'class-transformer'
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto'
import {
  ATTENTION_KINDS,
  type AttentionKind,
} from '../../admin-metrics/attention-rules'
import { UserRole } from './create-user.dto'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// Who the list shows by their ACCOUNT's state. 'active' is the default — the
// list an admin works with every day; deactivated accounts are asked for.
export const USER_LIST_STATUSES = ['active', 'deactivated', 'all'] as const
export type UserListStatus = (typeof USER_LIST_STATUSES)[number]

// 25 a page (decided with the person 2026-10-29) — the audit log's 20 is for
// sentence rows; a users row is shorter.
export const USER_LIST_PAGE_SIZE = 25

const ROLES = Object.values(UserRole)

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// GET /admin/users — the Users page (Phase 6.5, decided 2026-10-29). Every
// filter optional, all combined with AND; page / limit from the shared
// pagination base.
export class ListUsersQueryDto extends PaginationQueryDto {
  // The base class says 20; redeclared (same rules) for this list's own size.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = USER_LIST_PAGE_SIZE

  // Part of a name or an email address. Trimmed first; nothing left (or
  // only spaces) means "no search" — an empty box is not a search for "".
  // 100 characters: longer than any name or address worth typing.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  })
  @IsString()
  @MaxLength(100)
  search?: string

  // One of the account's roles: a practitioner + admin account matches both.
  @IsOptional()
  @IsIn(ROLES, { message: `role must be one of: ${ROLES.join(', ')}` })
  role?: UserRole

  // A clinic's id, or `none` — accounts belonging to no clinic at all. A
  // string, not a number: one parameter carries both meanings, and the
  // pattern refuses anything else (`0`, `-1`, `abc`, `1.5`).
  @IsOptional()
  @IsString()
  @Matches(/^(none|[1-9]\d{0,8})$/, {
    message: 'clinic must be a clinic id or none',
  })
  clinic?: string

  @IsOptional()
  @IsIn(USER_LIST_STATUSES, {
    message: `status must be one of: ${USER_LIST_STATUSES.join(', ')}`,
  })
  status?: UserListStatus = 'active'

  // One of the admin home's "needs attention" groups (attention-rules.ts) —
  // the SAME rule its numbers count with. Moved here from GET /users.
  @IsOptional()
  @IsIn(ATTENTION_KINDS, {
    message: `attention must be one of: ${ATTENTION_KINDS.join(', ')}`,
  })
  attention?: AttentionKind
}
