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
  MaxLength,
  Min,
} from 'class-validator'
import { Type } from 'class-transformer'
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto'
import { IsInstant } from '../../common/validators/is-instant'
import { AUDIT_KINDS, type AuditKind } from '../audit-vocabulary'

// --- DATA TRANSFER OBJECT ----------------------------------------------------------------------------------

// GET /audit-logs — every filter optional, all of them combined with AND.
// The audit log viewer (decided with the person 2026-10-21) added `kind`,
// `targetUserId`, `from` and `before`.
export class FindAuditLogsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100) // matches audit_logs.action's own varchar(100)
  action?: string

  @IsOptional()
  @IsString()
  @MaxLength(100) // matches audit_logs.entity_type's own varchar(100)
  entityType?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  performedBy?: number

  // The person the entry is ABOUT (audit_logs.target_user_id) — "everything
  // about Pat". Served by the (target_user_id, created_at) index (0051).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetUserId?: number

  // change / view / sign_in — see audit-vocabulary.ts. Absent = every kind.
  @IsOptional()
  @IsIn(AUDIT_KINDS, {
    message: `kind must be one of: ${AUDIT_KINDS.join(', ')}`,
  })
  kind?: AuditKind

  // A time range, as two MOMENTS (see is-instant.ts for why not days):
  // entries at or after `from`, and strictly before `before`. Half-open on
  // purpose — the browser sends midnight of the first day and midnight
  // AFTER the last one, so "21 October" is [21 Oct 00:00, 22 Oct 00:00) and
  // two neighbouring ranges never count the same entry twice. The service
  // refuses `from` at or after `before` (an empty range is a mistake).
  @IsOptional()
  @IsInstant()
  from?: string

  @IsOptional()
  @IsInstant()
  before?: string
}
