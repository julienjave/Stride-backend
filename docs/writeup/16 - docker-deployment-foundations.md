# Docker deployment foundations, and a sandbox reset survived cleanly

This document covers the first concrete deployment artifact — the
`Dockerfile` — the chain of real, non-obvious bugs building it surfaced, and
an infrastructure interruption on the assistant side that turned into a
genuine test of the project's own reference-integrity discipline.

## A mid-session reference reset, and the recovery it required

Partway through this phase, the assistant's own working environment reset
entirely, losing its whole tracked reference copy of the project built up
over the session. Rather than attempt a silent reconstruction from memory —
given how many times, even *with* a live reference copy, small drift had
already been caught and corrected earlier in the project — the deliberate
choice was to be explicit about the loss and re-establish a genuine
reference from a fresh codebase export, then re-run the full battery of
specific pattern checks accumulated across the whole project (not just
recent ones) rather than assume anything was still true. Every check came
back clean. This is worth recording as validation of the sync-check
practice itself: a tool built to catch small, incremental drift proved
equally capable of confirming full integrity after a much larger
disruption, with the same one mechanism.

## The `Dockerfile`: real decisions, not defaults

A multi-stage build — a `builder` stage installing every dependency
(including `devDependencies`, needed for `nest build`) and compiling
`dist/`, and a separate, clean `runtime` stage installing only production
dependencies (`npm ci --omit=dev`) and copying in just the compiled output.
This is what actually delivers the "exclude devDependencies from what
ships" intention flagged as a placeholder much earlier in the project — not
achievable with a single-stage build at all.

Base image chosen deliberately: `node:24-slim`, not `alpine`. `bcrypt` is a
genuine native addon (compiles C++ via `node-gyp`), and Alpine's `musl` libc
has real, documented friction with native Node modules — solvable with the
right build tooling, but a category of risk this project's consistent
preference for the reliable, well-understood choice (the same reasoning
behind Caddy over Traefik) argued against taking on for a modest size
tradeoff. The specific major version (`24`, not a vaguer tag) was chosen
from direct evidence already in the project — `@types/node@24.13.3`,
confirmed installed during an earlier `tsconfig` investigation — rather
than assumed, avoiding a "works locally, breaks in Docker" version gap.

A non-root `USER node` in the final image (Node's official images ship this
built in specifically for production use), and a `HEALTHCHECK` using the
real `/health` endpoint already built via Terminus — a small inline Node
script rather than installing `curl` just for this one purpose.
`.dockerignore` excludes more than just `node_modules`/`dist` — critically,
`.env` itself, since without it a locally-present `.env` file would be
copied straight into the build context and could end up baked into an
image. `*.txt`/`*.md` were added afterward for build-context hygiene
(cookie jars, the codebase-snapshot export, README) — worth being precise
that this was never actually closing a security gap given the multi-stage
build already means only `dist/` reaches the final image regardless; it was
purely about not sending irrelevant bytes to the Docker daemon on every
build. `.env.example` was deliberately left out of that exclusion list — it
contains no real secrets at all, and excluding it would have implied a risk
that doesn't exist.

## Three real, chained bugs surfaced by actually building it

**`dist/src/main.js` instead of `dist/main.js`.** TypeScript computes an
implicit `rootDir` as the common ancestor of every file it compiles; with
no explicit `rootDir` set, two files living outside `src/`
(`scripts/seed-exercises.ts`, and later `drizzle.config.ts`, discovered in a
second iteration once the first fix surfaced the next one) were both being
pulled into the same compilation via `tsconfig.build.json`'s default
`**/*` include pattern, widening that ancestor to the project root and
shifting the whole output structure to mirror it. Fixed with an explicit
`rootDir: "./src"` in `tsconfig.build.json` specifically — not the shared
root `tsconfig.json`, since that file is also used by `ts-node`
(`scripts/seed-exercises.ts`) and Jest (`test/*.e2e-spec.ts`), both of which
genuinely need to reference files outside `src/`, and would have broken
under a shared `rootDir` restriction.

**A stale `.tsbuildinfo` incremental-compile cache — found twice, in two
different invocation paths.** The first time, `nest build`'s cache masked
the `rootDir` fix from taking effect. The second time, after the fix was
confirmed working via a direct build, `npm run start:dev` (`nest start
--watch`) failed with the exact same symptom via a *separate* cache file
(`tsconfig.build.tsbuildinfo` at the project root) that hadn't been cleared
by the first fix — diagnosed precisely by noticing which folders *did* get
emitted (only the three areas most recently edited) versus which didn't
(everything else, including `main.js` itself), the exact signature of an
incremental compiler trusting a cache that predates the config change.
Both required a full `rm -rf dist` plus deleting the cache file, not a
partial fix — added to `.gitignore` afterward to prevent recurrence for
anyone else building the project fresh.

**`drizzle-orm` missing from `dependencies` entirely.** Invisible in local
development (which installs every dependency, dev and prod together),
surfacing only once `npm ci --omit=dev` respected that distinction for the
first time — a `MODULE_NOT_FOUND` for a real npm package, not a local file,
correctly pointing at a `package.json` classification issue rather than a
build problem. Resolved with a clean uninstall/reinstall using `--save`,
rather than attempting to manually patch whichever inconsistent state the
file was already in.

## Production-specific config, isolated from local dev by environment alone

`trust proxy` moved from a hardcoded `1` to `Number(process.env.TRUST_PROXY_HOPS ?? 1)`
— locally, no proxy sits in front of the app at all; in production, the
chain is Cloudflare then Caddy, genuinely two hops, not one. The session
cookie's `secure` and `sameSite` were fixed together, deliberately, as one
decision rather than two independent ones: hosting the frontend on
Cloudflare Pages (a separate domain from the API) makes every request
cross-site, and browsers block a cross-site cookie by default unless
`sameSite: 'none'` is set explicitly — which browsers in turn refuse to
honor unless `secure: true` is also set. Missing either half wouldn't
partially work; it would silently fail for the real deployed frontend while
looking completely fine in local curl testing, exactly the kind of gap that
survives until the worst possible moment to discover it. Both conditioned
on `NODE_ENV === 'production'`, so local dev's plain-HTTP behavior is
unaffected.
