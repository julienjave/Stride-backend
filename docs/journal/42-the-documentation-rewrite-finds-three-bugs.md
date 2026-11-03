# Rewriting the documentation against the code, and the three bugs it found

This entry covers the first two stages of the documentation rewrite
(2026-11-03): the API reference (`docs/api/`) and `ARCHITECTURE.md`, both
rewritten "as it stands" after a month in which the code had moved far
ahead of them. The API reference documented about ten resources; the code
had 31 controllers and a WebSocket gateway. The rule for the rewrite was
that every claim is traced to a controller, a migration or an e2e test
before it is written. That rule did what it did in entries 20 and 27:
writing down what the code does found places where what it does is wrong.

## A reference that can't drift: the endpoint table is generated

The most-stale part of the old reference was its list of routes. Rather than
write a new list that would start drifting the day after, `06-endpoints.md`
is **generated** (`npm run docs:endpoints`) from each controller's decorator
metadata, read the way Nest itself reads it — the same technique as the
audit-tags test in entry 39. The metadata gives the verb and path, the
guards, the roles, the status code, the rate limit, the demo lock and the
audit tag. The table sits between two marker comments, and a unit test fails
whenever the document and the code disagree. The other API documents were
rewritten by hand, and `05-getting-started.md` was *run* end to end on a
fresh backend, with its outputs copied from the real answers.

## Bug 1: signing in had a stopwatch side channel

Writing the authentication document's sentence "an unknown email and a wrong
password get the same answer" prompted a measurement, because entry 28 had
found exactly this shape of leak in forgot-password. The bodies were the
same, but the timings weren't. An unknown email, or an invited account with
no password yet, answered **without running bcrypt**: a median of **6 ms**,
against **75 ms** for a real account with a wrong password, over 25 tries
each. Anyone could tell which addresses have accounts with a stopwatch.

The fix is in one file, `src/common/password-hashing.ts`. `passwordMatches()`
always performs exactly one real bcrypt comparison: against the account's
hash when there is one, otherwise against a fixed `DUMMY_PASSWORD_HASH` of
the same cost (a test checks its cost matches `PASSWORD_HASH_COST`, so the
two can't drift apart). After the fix the medians were **70 ms vs 72 ms**.
The 2 ms left is the awaited `LOGIN_FAILURE` audit write, which only a real
account gets, and the authentication document says so rather than claiming
a perfect match. The four `bcrypt.hash(x, 10)` calls also became one
`hashPassword()`, so the cost is written once.

## Bug 2: a deactivated account could still reset its password

The same document's table of password routes prompted a second question:
what does forgot-password do for a **deactivated** account? It sent a reset
link. Signing in was refused for a deactivated account, but a link sent
before the deactivation kept working afterwards. `forgotPassword` now skips
an inactive account (the same silent `204`, no token, no email, no audit
entry), and the token lookup refuses a deactivated account with the same
"invalid or has expired" answer, so an old link dies with the deactivation.
Reactivating restores both. An e2e test walks the whole sequence: the link
works, deactivate, the link is refused, forgot-password sends nothing,
reactivate, it works again.

## Bug 3: every photo URL was signed for an address only Docker can resolve

Describing the file path for ARCHITECTURE's §8 meant writing down *where* a
presigned URL points. In production, `STORAGE_ENDPOINT` is `storage`, the
Compose service name, so every presigned URL — avatars, logos, exercise
photos, a program's photos — said `http://storage:9000/…`. That name means
something only inside the Docker network. A browser can't resolve it, so in
production no photo would have loaded at all. Nothing had noticed, because
in local development the internal and the public address are the same
`localhost`. The bug exists only where the two differ, which is production,
and nothing built since entry 35 had been deployed.

The host can't simply be rewritten afterwards. An S3 signature covers the
`Host` header, so a URL signed for one host and edited to another is
refused. The fix signs for the public address in the first place:

- `STORAGE_PUBLIC_URL` (`src/config/storage-urls.ts`): when unset, the
  internal address is used, so local development is unchanged. It is
  **required** in production, must be `https://` there, and may only be an
  origin (no path, query or credentials). `validateEnv()` refuses to boot
  without it.
- `StorageService` keeps one client for uploads and deletes (the internal
  address, inside the Docker network) and adds a second, a **signing
  client** on the public address, used only to sign download URLs. It is
  the same RustFS and the same credentials; a client is just an in-memory
  object.
- The `Caddyfile` gained a second site, `files.stridecare.app`. It forwards
  `GET` requests under `/stride/*` to storage, keeping the original `Host`
  so the signature matches, adds `Cache-Control: private` where storage set
  none, and answers everything else `404`.

It was verified live, not only in tests: the RustFS release binary and
Caddy 2.10 ran the repo's Caddyfile on port 443, in front of the real
`StorageService` with `NODE_ENV=production`. A signed `GET` answered `200`
with the bytes. `HEAD`, `PUT`, `DELETE` and `GET /` got `404` from Caddy; an
unsigned request got `403`; one changed character got `403`; a URL signed for
another host got `403`; and `storage:9000` didn't resolve from outside. The
deployment needs two things before this code goes out: the `.env` line and
a proxied `files` DNS record at Cloudflare. Without the line the app now
refuses to start, which is the point — a silent fallback is what hid the
bug.

A smaller finding came the same day, from the person's own full e2e run: six
failures in `auth.e2e-spec.ts`, all expecting `demo: null`. Their `.env` had
`DEMO_MODE=on` from checking the reviewers' card, and dotenv never replaces
a variable already set, but nothing set it for the tests. The e2e set-up now
sets `DEMO_MODE=off` unconditionally, as it does `RATE_LIMITS`, and the demo
suite turns it on itself.

## Current status

Stages 1 and 2 are complete; this entry and the journal README's update are
stage 3. The API reference is [`docs/api/`](../api/README.md), and the
architecture document is [`ARCHITECTURE.md`](../ARCHITECTURE.md), whose
[§12](../ARCHITECTURE.md#12-open-items-before-the-deployment) lists what must
be done before the next deployment, the `files` DNS record among it. The documents still to come (`PROJECT.md`, a `TESTING.md`, the
deployment guide, the README) are described in the journal README's open
items.
