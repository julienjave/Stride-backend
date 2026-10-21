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
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Observable } from 'rxjs'
import { tap } from 'rxjs/operators'
import { AuditService } from '../../audit/audit.service'
import { AuthenticatedRequest } from '../decorators/current-user.decorator'
import { AUDITED_BY_SERVICE_KEY } from '../decorators/audited-by-service.decorator'
import { NOT_AUDITED_KEY } from '../decorators/not-audited.decorator'
import { errorMessage } from '../error-message'

// --- INTERCEPTOR -------------------------------------------------------------------------------------------

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name)

  // Reflector reads the metadata decorators attach to routes — here,
  // @AuditedByService(). Nest provides it to any provider that asks.
  constructor(
    private readonly auditService: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const { method, originalUrl, params, user } = request

    // Only mutating methods are worth auditing here — GET requests are
    // reads, and logging every single one would make this table enormous
    // for very little signal.
    const isMutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)
    //
    // Routes tagged @AuditedByService() are skipped too: their service writes
    // a complete entry (what changed, before and after) in the change's own
    // transaction, and a generic one beside it would only be a vague
    // duplicate. So are routes tagged @NotAudited(reason): a POST that
    // changes nothing has nothing to record. getAllAndOverride looks at the
    // handler first, then its controller class, so a whole controller could
    // be tagged at once. (The older URL-prefix exception for /auth is gone
    // since the audit review's slice 1b: every /auth route carries a tag.)
    const targets = [context.getHandler(), context.getClass()]
    const isExplicitlyAudited =
      this.reflector.getAllAndOverride<boolean | undefined>(
        AUDITED_BY_SERVICE_KEY,
        targets,
      ) === true ||
      this.reflector.getAllAndOverride<string | undefined>(
        NOT_AUDITED_KEY,
        targets,
      ) !== undefined

    if (!isMutating || isExplicitlyAudited || !user) {
      return next.handle()
    }

    return next.handle().pipe(
      tap((response: { id?: number } | null | undefined) => {
        // A generic, always-available heuristic: the URL's first path
        // segment as entityType ("exercises", "users", "clinics", ...),
        // and the affected row's id — read from the response body if
        // present (every mutating route in this app returns the full
        // affected row, a direct payoff of the earlier 204->200 decision),
        // falling back to the URL's own :id param otherwise.
        const entityType = originalUrl.split('/')[1]?.split('?')[0] ?? 'unknown'
        const entityId =
          response?.id ?? (params?.id ? Number(params.id) : undefined)

        // Fire-and-forget, deliberately — awaiting this would add latency
        // to every single mutating request for the sake of a secondary
        // concern. A failure here is logged but never allowed to turn into
        // a user-facing error; this is a real, accepted tradeoff (eventual
        // consistency for the audit trail, not strict transactional
        // coupling to the action itself), not an oversight.
        this.auditService
          .log({
            performedBy: user.id,
            action: `${method} ${originalUrl}`,
            entityType,
            entityId,
          })
          // The reason in the text, not as a second argument (which the
          // logger would drop — see errorMessage()).
          .catch((err) =>
            this.logger.error(
              `Failed to write audit log for ${method} ${originalUrl}: ${errorMessage(err)}`,
            ),
          )
      }),
    )
  }
}
