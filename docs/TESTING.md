# Testing the backend

What the test suites are, how to run them, what each one proves, the
techniques they rely on, and what they don't cover. The *why* behind several
techniques is told in the [journal](journal/README.md); this page is the
working guide.

| Suite | Where | What it runs against | Size (2026-11-03) |
|---|---|---|---|
| **Unit** | `src/**/*.spec.ts`, `scripts/**/*.spec.ts` | nothing outside the process (fakes, a local socket or two) | 114 files, 2,593 tests |
| **API end-to-end** | `test/*.e2e-spec.ts` | the real app, a real Postgres (`stride_test`), S3-compatible storage | 50 files, 1,346 tests |
| **Browser** | the frontend repository's `e2e/` (TODO-LINK) | this backend built and started on port 3100, its own database (`stride_e2e`), Chromium | 15 tests |

The browser suite belongs to the frontend, but it starts *this* backend, so
the two scripts it needs live here (below).

---

## Running them

### Unit tests

```sh
npm test                 # every unit spec, a few minutes
npx jest src/audit       # one folder (or a file path)
npm run test:cov         # with a coverage report in coverage/
```

They need no database, no storage and no `.env` values beyond what a spec
sets for itself. A few specs open a small local HTTP server to test
behaviour that only exists on a socket (the storage client's headers and
timeouts, CORS answers).

### API end-to-end tests

They need what the app needs: Postgres, S3-compatible storage on port 9000
(RustFS from `docker-compose.yml`, or any S3 stand-in), and a `.env` (copy
`.env.example`; set `POSTGRES_APP_PASSWORD`, `SESSION_SECRET` and
`MFA_ENCRYPTION_KEY` to fresh random values).

```sh
docker compose up -d db storage      # Postgres and RustFS
npm run db:migrate:all               # migrates stride AND stride_test
npm run db:create-app-role:test      # the stride_app role, for stride_test
npm run test:e2e:fresh               # every e2e file against stride_test
```

- **Always `stride_test`.** The suites empty tables (`TRUNCATE`), so 47 of
  the 50 files refuse to run unless `current_database()` is `stride_test`.
  `test:e2e:fresh` sets `POSTGRES_DB=stride_test`. Plain `test:e2e` uses
  your `.env`'s database (normally `stride`), and the guard stops it.
- **Migrate the test database after every pull.** `test:e2e:fresh` doesn't
  migrate. A new migration not applied to `stride_test` shows up as
  `relation "…" does not exist` in a whole suite.
- **One file at a time** (`--runInBand`, `maxWorkers: 1`): the files share
  one database.
- **One file:** `npx cross-env POSTGRES_DB=stride_test jest --config
  ./test/jest-e2e.json --runInBand test/sessions.e2e-spec.ts`.
- **Settings forced for every file** (`test/support/e2e-env.ts`, loaded
  before each file's own imports): `RATE_LIMITS=off` and `DEMO_MODE=off`,
  whatever your `.env` says. Two files switch one back on for themselves:
  `rate-limits.e2e-spec.ts` proves the limits work, and
  `demo-mode.e2e-spec.ts` covers the reviewers' card and locks.
- **Email** never leaves the process: every suite replaces the transport
  with an in-memory outbox (`test/support/in-memory-email-transport.ts`),
  and tests read the links out of the emails it holds.

### For the browser suite

The frontend's `npm run test:e2e` runs two scripts of this repository:

```sh
# create stride_e2e if missing, migrate it, create its app role, seed --reset
npm run db:prepare:e2e
# the built API on :3100: rate limits off, no error reporting
npm run build && npm run start:e2e
```

`stride_e2e` is reseeded on every run, so the browser tests start from the
same accounts every time.

---

## What each layer proves

A rule is tested at the layer that owns it, and an important rule at more
than one:

| Layer | How it is tested | Example |
|---|---|---|
| Pure rules | unit tests with plain values; clocks passed in, pinned in 2031 | `summarizeSchedule()`'s tables on a fixed calendar |
| DTO validation | unit tests running the real class-validator engine, often `describe.each` over every DTO that shares a rule | blank titles, `null` refused for required columns |
| Services | unit tests with the database replaced by a fake transaction | the audit entry is written with the *same* transaction object |
| Routes | e2e through HTTP (supertest), the audit trail read back | one entry per write, none for a refusal |
| Row-level security | e2e, as the **app's role** with an actor's context, in a transaction that always rolls back | an admin sees 0 sessions where the care team sees 1 |
| CHECKs and constraints | e2e, as the **tables' owner** (`asOwner`), always rolled back | each CHECK refuses with its own name |
| Triggers | e2e as the app's role; for the newer guards, each refusal is also proven to *succeed* with the trigger disabled, so only the trigger can be what refused it | a care-team link can only be ended, now |
| Races | e2e with a held lock (`whileHolding`, below) | two Finish taps, a tick racing a Finish |
| Conventions | a spec reading the whole codebase | every write route declares its audit behaviour |

---

## Techniques

**Proving a race, not hoping for one.** Two requests sent "at once" rarely
overlap, so a test that sends two proves nothing. `whileHolding` starts a
conflicting write on another connection *without committing*, sends the
request, checks it is still unanswered after 300 ms (so a lock or a
constraint is involved), then commits and checks the answer. Choose the
held lock with care: inserting a child row takes `FOR KEY SHARE` on its
parent, so holding `FOR UPDATE` blocks the request even when the service's
own lock is missing. Hold `FOR NO KEY UPDATE` instead. (`whileHolding` is
written into each of the nine files that use it, adapted to the actor each
one needs.)

**Proving "in the same transaction".** Plant a trigger, as the owner, that
refuses the audit row the request should write, then send the request. The
request must fail *and* leave its change undone. A version that wrote the
entry separately would make the change and lose only the entry. Planted
triggers are dropped in `finally`.

**Testing an exact boundary.** Real requests never land on the exact
microsecond, so `>` against `>=` survives ordinary tests. Build the edge
inside one transaction, where `now()` is a single instant: as the owner, set
the value to exactly the boundary, then `SET LOCAL ROLE` to the app's role,
and run the statement under test. This was used for the 15-minute delete
window and the moment an invitation expires.

**Fixtures where the rules disagree.** A test only proves a rule if its
data would give a different answer without it: equal names that the id must
order, records whose creation order differs from their display order, ids
starting at 100,000 so a user id can't be mistaken for another table's.
"Write the case the naive version gets wrong" is the rule.

**Clocks.** Pure rules take "now" as a parameter, and their tests pin it in
2031, far from the real date, so a rule that reads the real clock fails
rather than passes by luck. Lifetimes are computed from their start
(`invitationExpiry(from)`), so they can be tested next to a clock change
under `SET LOCAL timezone = 'Europe/Paris'`.

**Helpers** (`test/support/`):

| File | Gives |
|---|---|
| `accounts.ts` | `activateAccount()` — an account made through the real `POST /users`, then given the end state of an accepted invitation, signed in with `TEST_PASSWORD` |
| `as-owner.ts` | `asOwner()` — one statement as the tables' owner, always rolled back; `BLANK_VALUES` for "not blank" tests |
| `in-memory-email-transport.ts` | the outbox, `failNext()` for a failed send, `findLink()` |
| `pdf-text.ts` | reads a generated PDF back: text per page with positions and colours, filled rectangles, images (no PDF library) |
| `e2e-env.ts` | the settings forced for every file (above) |

**Convention tests**, which read the whole codebase rather than one unit:

| Spec | Fails when |
|---|---|
| `src/audit/audit-tags.spec.ts` | a write route is tagged neither `@AuditedByService()` nor `@NotAudited(reason)` |
| `src/observability/logging-convention.spec.ts` | a log call or an error message interpolates an email address or a raw URL |
| `scripts/docs/endpoints.spec.ts` | [`api/06-endpoints.md`](api/06-endpoints.md) differs from the routes in the code |
| `scripts/storage/sweep.spec.ts` | a schema column holding storage keys isn't on the sweeper's list (its files would be deleted) |

Each one also proves it checks something: a convention test that matches no
file passes vacuously.

---

## Mutation testing

Every pass of the frontend era was mutation-checked by hand: deliberate bugs
put into the new code, one at a time, and the tests run against each. Typical
mutations remove a condition, move a boundary (`<` → `<=`), drop a lock or
an `await`, swap two arguments, weaken a row-security policy, or turn a
trigger from `AFTER` into `BEFORE`. SQL mutations are applied to
`stride_test` with `CREATE OR REPLACE FUNCTION` / `ALTER POLICY` and
restored afterwards.

A mutant that survives means one of two things, and which one is proven
before acting:
- **a missing test** — then the test is written, and the mutant must fail it;
- **code that can't matter** — then the code is removed, or, when it is
  defence in depth that another layer makes unobservable, a comment says
  why. An example is a policy branch that the `SELECT` policy already hides.

The runner scripts are throwaway tools in the working sandbox, not part of
this repository. Before mutating, each test command is run on the unchanged
code: a filtered run that fails on the original code would report every
mutant as "killed".

---

## Rules learned the hard way

- **The `session` table outlives each suite.** Suites `TRUNCATE` users and
  restart ids, but nothing empties `session`, so earlier suites' sessions
  carry reused user ids. A test about sessions compares with the sessions
  read just before, never a fixed count.
- **Never compare a database-sorted list with a JavaScript-sorted one.**
  `ORDER BY` follows the database's collation, and `.sort()` compares code
  units. They agree under `C.UTF-8` and disagree under `en_US.utf8`. Sort on
  one side, or compare as sets.
- **Two clocks.** Postgres's `now()` and Node's `Date.now()` can differ (WSL2
  drifted 2.4 s). Take a test's bounds from the clock that wrote the value.
- **Calendar arithmetic moves with the clocks.** `interval '14 days'` on a
  `timestamptz` is computed in the session's time zone; a fixture meant as a
  duration is written in hours.
- **`bigint` comes back as a string** from raw `pg` queries (`bigserial`
  ids, `count(*)`): cast with `::int` in the query or `Number()` after.
- **`INSERT … RETURNING` is also checked by the `SELECT` policy**, so a
  refusal test that uses `RETURNING` may be refused by the wrong policy.
  Refusal tests insert without it.
- **Defence in depth hides which layer works.** When the DTO and a CHECK both
  refuse a blank title with the same `400`, removing either leaves the tests
  green. Test an input only one layer catches (a tab-only title: the DTO's
  `\S` refuses it, `btrim` didn't).
- **Time-windowed codes:** a TOTP code made in the last second of its window
  can expire before the server checks it. The two-factor tests wait for a
  fresh window when little time is left.

---

## What the suites don't cover

- **Load, concurrency at scale, or several API instances.** The races are
  tested between two requests, not two hundred, and the app is
  single-instance by design.
- **Real external services.** Resend, real RustFS behaviour beyond the S3
  API (it was checked by hand, with Caddy in front, for signed URLs), and
  GlitchTip (a local server stands in for it in the monitoring tests). The
  deployment itself is verified by running it ([`DEPLOYMENT.md`](DEPLOYMENT.md)),
  not by a test.
- **Browsers other than Chromium**, and an automated accessibility scan —
  both deferred in the frontend's browser suite.
- **Real phone photos** (orientation through the avatar crop), to be checked
  by hand once deployed.
- **The pagination tests on very slow machines**: they create probes one
  after another for that reason; a machine that can't open connections fast
  enough may still see `ECONNRESET` there.

---

## CI

A GitHub Actions setup exists and was rehearsed from fresh clones (backend
checks, the API e2e suite against Postgres, RustFS and Mailpit service
containers, the browser suite). It is **parked** until the repositories are
public: `.github/` is listed in `.gitignore`, so the workflow files are never
committed, no Actions minutes are spent and no token is held while it is
private. Going public means removing that line and committing them. The two
scripts it uses are here: `scripts/ci/prepare-env.sh` writes a `.env` from
`.env.example` with fresh secrets (masked in the logs on GitHub), and
`scripts/ci/wait-for-services.sh` waits for storage and Mailpit to answer.
