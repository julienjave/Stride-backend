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

import { SetMetadata } from '@nestjs/common'

// --- DECORATOR ---------------------------------------------------------------------------------------------

// "This route's service writes its own, detailed audit entry."
//
// The global AuditLogInterceptor records every mutating request generically:
// who, when, the method + URL, the entity's id — but never WHAT changed (it
// only sees the request from the outside). For changes to clinical data
// that isn't enough: an audit trail must let someone reconstruct what a
// record was before and after (HIPAA's audit controls and integrity rules).
// Only the service knows that, so the service writes the entry — inside the
// same transaction as the change, so the two commit or roll back together.
//
// This decorator tells the interceptor to stay out of it for such routes,
// so each change has ONE complete entry instead of a complete one plus a
// vague duplicate. Same mechanism as @Roles(): SetMetadata tags the route,
// and the interceptor reads the tag back with Nest's Reflector.
//
// Convention (decided 2026-10-10): every NEW route that changes clinical
// data uses this, with an entry written by its service via
// AuditService.logInTransaction(). Older routes are covered by the generic
// entry until the audit review (deferred-improvements.md, "Audit review").
export const AUDITED_BY_SERVICE_KEY = 'auditedByService'
export const AuditedByService = () => SetMetadata(AUDITED_BY_SERVICE_KEY, true)
