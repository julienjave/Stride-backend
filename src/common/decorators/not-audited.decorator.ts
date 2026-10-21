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

// "This route is a POST (or PATCH / PUT / DELETE) that changes no data, so it
// writes no audit entry." The counterpart of @AuditedByService(): every
// route with a mutating HTTP method must carry ONE of the two (the audit
// review, Phase 6 — decisions §10), so "nobody thought about this route" is
// never the reason a change goes unrecorded.
//
// Why a route would use a POST without changing anything: the body hides a
// secret the URL would expose in logs (a reset or invitation token checked
// before it is used — POST /auth/reset-password/check).
//
// The REASON is required and kept in the metadata, so a reader (and a test
// listing every route) sees why at the decorator itself.
export const NOT_AUDITED_KEY = 'notAudited'
export const NotAudited = (reason: string) =>
  SetMetadata(NOT_AUDITED_KEY, reason)
