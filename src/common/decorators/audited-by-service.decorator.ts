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
// For changes to clinical and account data, an audit trail must let someone
// reconstruct what a record was before and after (HIPAA's audit controls
// and integrity rules). Only the service knows that, so the service writes
// the entry — inside the same transaction as the change, so the two commit
// or roll back together (AuditService.logInTransaction).
//
// The tag itself writes nothing: it states, at the route, that the route is
// covered. Every route with a mutating HTTP method carries it — or
// @NotAudited(reason) for one that changes nothing — and
// src/audit/audit-tags.spec.ts fails for a route with neither. (Until the
// audit review's slice 1c, a global interceptor wrote a generic
// "METHOD /url" entry for untagged routes, and this tag told it to stay
// out; the interceptor is gone, every route now being covered.)
//
// Same mechanism as @Roles(): SetMetadata tags the handler, and a reader
// (here the test) gets the tag back with Nest's Reflector.
export const AUDITED_BY_SERVICE_KEY = 'auditedByService'
export const AuditedByService = () => SetMetadata(AUDITED_BY_SERVICE_KEY, true)
