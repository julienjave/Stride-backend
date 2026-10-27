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

import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface'
import { getAllowedOrigins } from './allowed-origins'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// Response headers the frontend's JavaScript may READ, beyond the few every
// browser allows (Cache-Control, Content-Language, Content-Length,
// Content-Type, Expires, Last-Modified, Pragma — the "CORS-safelisted"
// ones). The app (:5173, or its own domain) calls this API on another
// origin, so for any other header the browser receives it but hides it from
// the page — `response.headers.get(…)` answers null — unless the server
// names it in Access-Control-Expose-Headers.
//   - Content-Disposition: the records export's file name
//     (`attachment; filename="stride-health-record-2026-10-27.pdf"`),
//     which the page saves the download under (decisions §20, pass 3);
//   - Retry-After: how long a 429 asks to wait (the throttler sets it);
//     the frontend's client reads it into `retryAfterSeconds` — which,
//     until this was added, always came out undefined in the browser.
export const EXPOSED_HEADERS = ['Content-Disposition', 'Retry-After']

// --- FUNCTION ----------------------------------------------------------------------------------------------

// The HTTP API's CORS settings, for main.ts's app.enableCors — a function
// of its own so a spec can run them in a real app (cors-options.spec.ts):
// the e2e suites build their apps without main.ts, so nothing else would
// notice a header dropped from this list.
//   - origin: only the configured frontends (allowed-origins.ts, shared
//     with the messaging socket);
//   - credentials: the session cookie travels with every request — the
//     frontend sends `credentials: 'include'`, and the browser refuses the
//     answer unless the server allows it.
export function corsOptions(): CorsOptions {
  return {
    origin: getAllowedOrigins(),
    credentials: true,
    exposedHeaders: EXPOSED_HEADERS,
  }
}
