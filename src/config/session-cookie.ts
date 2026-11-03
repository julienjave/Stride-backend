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

import type session from 'express-session'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// A session lasts 7 days from sign-in. No `rolling` option: activity doesn't
// extend it, so a stolen cookie stops working at a fixed moment.
export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7

// --- FUNCTION ----------------------------------------------------------------------------------------------

// The session cookie's attributes, for main.ts's express-session — a
// function of its own so a spec can run them through the real middleware
// (session-cookie.spec.ts): the e2e suites build their apps without
// main.ts, so nothing else would notice an attribute changed here.
//   - httpOnly: the page's JavaScript can never read the cookie, so a script
//     injected into the page can't carry the session away;
//   - secure (production only): sent over HTTPS only. Development runs on
//     plain http://localhost, where a Secure cookie would never be sent;
//   - sameSite 'lax', in every environment: the browser sends the cookie on
//     requests made FROM the same site, and on top-level navigations from
//     another site — never on another site's background requests (a form it
//     posts, a fetch it makes), which is the classic cross-site request
//     forgery. "Site" is the registrable domain, not the origin:
//     stridecare.app (the frontend) and api.stridecare.app (this API) are
//     two origins but ONE site, so the frontend's fetch carries the cookie.
//     (CORS still decides whether the page may READ the answer.)
//     Production used 'none' until 2026-11-03, chosen when the frontend was
//     expected on another domain, where 'lax' would have blocked every call
//     (journal 16). Development was already 'lax': localhost:5173 and
//     localhost:3000 are one site too — the port isn't part of a site.
//     The cost: a frontend served from ANOTHER site, such as Cloudflare
//     Pages' preview addresses (*.pages.dev), can't keep a session with
//     this API.
// `env` is a parameter, like the other config readers, so a test passes
// its own instead of changing process.env for the whole process.
export function sessionCookieOptions(
  env: NodeJS.ProcessEnv = process.env,
): session.CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
  }
}
