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

// --- AMBIENT MODULE DECLARATION ----------------------------------------------------------------------------
// connect-pg-simple (the session store: express-session's sessions kept in
// Postgres's "session" table) ships plain JavaScript and no types. With
// `noImplicitAny: false` the compiler accepts the import anyway — as an
// unresolved type: every call through it is unchecked (lint's
// no-unsafe-call / no-unsafe-assignment in main.ts and every e2e set-up).
//
// `declare module '<name>' { … }` describes a package from the outside:
// what it exports, with which types. Unlike express-session.d.ts beside it
// (which ADDS to a package's existing types — "module augmentation"), this
// file is the package's only description. TypeScript reads it because it
// sits under src/, which every tsconfig here includes; a `.d.ts` holds
// types only and compiles to nothing.
//
// Written from the library's own JSDoc (index.js, `PGStoreOptions`) for
// version 10. The alternative, the community's @types/connect-pg-simple,
// would be one more package to keep in step; this describes exactly the
// version installed — re-check it when connect-pg-simple's major changes.
declare module 'connect-pg-simple' {
  // Imports INSIDE the block: a top-level import would turn this file into
  // a module, and `declare module` would then mean "augment" (as in
  // express-session.d.ts) instead of "declare".
  import type session from 'express-session'
  import type { Pool, PoolConfig } from 'pg'

  interface PGStoreOptions {
    // The connection: our own pg Pool (what Stride passes), or a string /
    // config the store turns into a pool of its own.
    pool?: Pool
    conString?: string
    conObject?: PoolConfig
    // Where the sessions live (default: the "session" table, the search
    // path's schema), and whether to create it on first use.
    schemaName?: string
    tableName?: string
    createTableIfMissing?: boolean
    // Lifetime in seconds when the cookie has no maxAge (Stride's has).
    ttl?: number
    // true: a request doesn't extend the session's expiry.
    disableTouch?: boolean
    // Where errors go (default console.error).
    errorLog?: (...args: unknown[]) => void
    // Expired sessions are deleted every N seconds (default 15 minutes), or
    // never with `false`; the randomizer spreads the deletions out.
    pruneSessionInterval?: false | number
    pruneSessionRandomizedInterval?: false | ((delay: number) => number)
  }

  // The store class the factory builds: an express-session Store, plus the
  // two methods of its own an app may call.
  interface PGStore extends session.Store {
    // Stops the pruning timer and, when the store made its own pool, ends
    // it (a pool passed in stays the caller's to end).
    close(): Promise<void>
    pruneSessions(callback?: (error: Error | null) => void): void
  }

  // The package's one export (CommonJS `module.exports = function …`): it
  // takes express-session — to extend ITS Store class — and returns the
  // store's constructor. Hence the two steps in main.ts:
  // `const PgSessionStore = connectPgSimple(session)`, then
  // `new PgSessionStore({ pool })`.
  function connectPgSimple(
    sessionModule: typeof session,
  ): new (options?: PGStoreOptions) => PGStore

  // `export =` is TypeScript's form for a CommonJS `module.exports = …`;
  // with `esModuleInterop` (tsconfig.json) the app imports it as a default
  // export: `import connectPgSimple from 'connect-pg-simple'`.
  export = connectPgSimple
}
