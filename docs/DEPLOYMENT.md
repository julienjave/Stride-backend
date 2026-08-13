# Stride — Installation & Deployment Guide

Two audiences, two paths through this document: **Part 1** gets a developer
running the app locally. **Part 2** is a full, ordered runbook for deploying
to a fresh production host. Both are built directly from the real
`docker-compose.yml`/`docker-compose.prod.yml`, `.env.example`,
`package.json`, and `scripts/backup-database.sh` — not reconstructed from
memory — plus the reasoning behind each step, which lives in the numbered
journal series (`00-README.md`) and is linked inline rather than repeated.

Like `ARCHITECTURE.md`, this is a **living document** — update it in place
whenever the real process changes, rather than leaving it to drift.

---

## Part 1 — Local development setup

**Prerequisites**: Node.js 24.x, Docker + Docker Compose, `npm`.

Local dev deliberately does **not** containerize the app itself — only `db`
and `storage` run in Docker; the app runs directly on the host. This is why
`docker-compose.yml` has no `app`/`migrate`/`create-app-role` services at
all, unlike the production compose file.

### 1. Clone and install

```bash
git clone <repo-url> stride-backend
cd stride-backend
npm ci
```

### 2. Start the database and object storage

```bash
docker compose up -d
```

This brings up `db` (Postgres 16, published on `localhost:5432`) and
`storage` (RustFS, published on `localhost:9000`/`9001`) with default
credentials suitable for local dev only.

### 3. Configure environment variables

```bash
cp .env.example .env
```

Then edit `.env`. Everything with a `# Generate: openssl rand -hex N`
comment needs a real generated value — `validateEnv()` refuses to boot on a
missing or placeholder value for `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, and
`POSTGRES_APP_PASSWORD` specifically:

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # MFA_ENCRYPTION_KEY — must be exactly 64 hex chars
openssl rand -hex 24   # POSTGRES_APP_PASSWORD
```

`RESEND_API_KEY` can stay as the placeholder locally — `EmailService`
degrades to logging reset links to the console rather than sending real
email (see doc 12/17), which is fine for local testing.

### 4. Create the restricted application database role

```bash
npm run db:create-app-role
```

This has to succeed **before the app can connect to Postgres at all** —
`drizzle.provider.ts` connects as `stride_app`, not the Postgres superuser,
and that role doesn't exist until this script creates it. Idempotent and
safe to re-run any time (syncs the password if the role already exists).
*(rationale: doc 23)*

### 5. Run migrations

```bash
npx drizzle-kit migrate
```

Runs on the *owner* connection (real DDL rights), not `stride_app` —
migrations and the app's runtime queries deliberately use different roles.

### 6. (Optional) Seed the exercise library

```bash
npm run seed:exercises
```

Idempotent — safe to re-run; skips any exercise whose `external_id` already
exists.

### 7. Start the app

```bash
npm run start:dev
```

Watches for changes. The API listens on `:3000` by default; `GET /health`
and `/api-docs` (Swagger) are good first checks that everything's actually
up.

### 8. Run the test suite

```bash
npm run test              # unit tests
npm run test:e2e:fresh    # e2e tests, against a dedicated stride_test database
```

**Always use `test:e2e:fresh`, never plain `test:e2e`**, unless
`POSTGRES_DB` is already pointed at `stride_test` some other way — the e2e
suite truncates its own tables on every run, and running it against your
real dev database will destroy real dev data. Every e2e spec also verifies
`current_database()` itself before truncating anything, as a second,
structural safeguard against exactly this mistake. *(rationale: doc 06, 13)*

`stride_test` needs to exist and be migrated once, separately from the main
dev database:

```bash
docker compose exec db psql -U postgres -c "CREATE DATABASE stride_test;"
POSTGRES_DB=stride_test npx drizzle-kit migrate
POSTGRES_DB=stride_test npm run db:create-app-role
```

---

## Part 2 — Production deployment (fresh host, start to finish)

This assumes a fresh DigitalOcean Droplet and mirrors the actual sequence
used to deploy Stride, in the order that avoids known chicken-and-egg
problems (documented as they come up below). Each phase ends with a
concrete way to verify it actually worked before moving to the next one.

### Phase 0 — Before you start

You need: a DigitalOcean account, a domain registered through (or
transferable to) Cloudflare, and SSH access set up locally.

### Phase 1 — Provision and harden the Droplet

1. Create a Droplet: Ubuntu 24.04 LTS (confirm this is still the current
   image DigitalOcean offers when you do this — check the dashboard
   directly, don't assume; see doc 18 for why this specific check matters).
2. Add your SSH key during creation — don't use password auth at all.
3. Once booted, create a non-root sudo user and disable root/password SSH
   login entirely:

   ```bash
   adduser stride
   usermod -aG sudo stride
   # then, in /etc/ssh/sshd_config:
   #   PermitRootLogin no
   #   PasswordAuthentication no
   sudo systemctl restart sshd
   ```

4. Create a DigitalOcean Cloud Firewall. **Leave it open on 80/443 to
   everyone for now** — restricting it to Cloudflare's IP ranges happens
   later, in Phase 8, only after Caddy is confirmed working. Doing it now
   would risk locking out the very first Let's Encrypt certificate request.
5. Install Docker + Docker Compose plugin on the Droplet.

**Verify**: you can SSH in as `stride` with your key, root/password login
both fail, and `docker ps` runs without `sudo` (add `stride` to the
`docker` group if not).

### Phase 2 — Domain and Cloudflare

1. If the domain isn't already on Cloudflare, add it there — registering
   directly through Cloudflare (rather than a separate registrar) skips a
   nameserver handoff step entirely.
2. Add an `A` record for your API subdomain (e.g. `api.yourdomain.com`)
   pointing at the Droplet's IP, **proxied** (orange cloud on) — this is
   what makes Cloudflare terminate TLS at the edge and hide the origin IP.
3. Set SSL/TLS mode to **Full (strict)** specifically, not plain "Full" —
   this is what makes Cloudflare actually verify the origin's certificate
   rather than accept anything. It won't fully work until Caddy has a real
   certificate (Phase 6), which is expected at this point.

### Phase 3 — Get the code and configure secrets onto the Droplet

```bash
ssh stride@your-droplet-ip
git clone <repo-url> Stride-backend
cd Stride-backend
cp .env.example .env
```

Edit `.env` for production values:

- Generate fresh, real secrets — **do not reuse local-dev values.**
  `SESSION_SECRET`, `MFA_ENCRYPTION_KEY` (exactly 64 hex chars),
  `POSTGRES_APP_PASSWORD`, `POSTGRES_PASSWORD`, `RUSTFS_ACCESS_KEY`,
  `RUSTFS_SECRET_KEY` all need `openssl rand -hex N` values.
- `NODE_ENV=production` — required exactly as that string; it's what flips
  session cookies to `secure: true`/`sameSite: 'none'` and pino to raw JSON.
- `TRUST_PROXY_HOPS=2` — Cloudflare, then Caddy.
- `FRONTEND_URL`/`FRONTEND_URLS` — your real deployed frontend origin(s).
- `RESEND_API_KEY` — a real key if email delivery should actually work at
  this deploy; note Resend's sandbox mode only delivers to the account's
  own signup address until a sending domain is verified (see doc 17).

Also copy `Caddyfile` to the Droplet if it isn't already tracked in the
repo, and confirm it points at your real domain.

**A gap not covered by any existing script, worth doing now**: the backup
script (Phase 9) uploads to an S3 bucket named `backups` — this is a
*different* bucket from `stride` (which `StorageService` creates
automatically on first app boot). Nothing currently auto-creates `backups`.
Create it once, after `storage` is up in Phase 4, via the RustFS console or:

```bash
aws --endpoint-url http://localhost:9000 s3 mb s3://backups
```

### Phase 4 — Bring up the database and storage layer

```bash
docker compose -f docker-compose.prod.yml up -d db storage
```

**Verify**: `docker compose -f docker-compose.prod.yml ps` shows both
healthy; `docker compose -f docker-compose.prod.yml logs storage` shows
RustFS started cleanly.

### Phase 5 — Migrations and the restricted app role

```bash
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml run --rm create-app-role
```

**Run migrations before `create-app-role`, not after.** `create-app-role`
does two things: an explicit grant sweep over every table that exists *at
the moment it runs*, and an `ALTER DEFAULT PRIVILEGES` rule so any table a
*future* migration creates is automatically granted too. Running migrations
first means the explicit sweep immediately covers every real table, rather
than relying solely on the default-privilege mechanism for tables that
already existed. *(This ordering is this document's own inference from how
the mechanism is described in doc 23, not something the journal states
outright as a rule — worth confirming directly during your test deploy,
since you're about to have a clean opportunity to.)*

**Verify**: no errors from either command; `create-app-role`'s output
confirms the role was created or its password synced.

### Phase 6 — Bring up the app and Caddy

```bash
docker compose -f docker-compose.prod.yml up -d --build app caddy
```

Caddy will attempt to request a Let's Encrypt certificate automatically the
moment it sees real traffic on your domain — this requires the DNS record
from Phase 2 to already be live and port 80 reachable (which it is, since
the firewall is still open at this point).

**Verify**:
```bash
curl -I https://api.yourdomain.com/health
```
should return a real, valid-certificate HTTPS response with `200`. Check
`docker compose -f docker-compose.prod.yml logs caddy` if not — a failed
ACME challenge is the most likely first-deploy issue here.

### Phase 7 — Verify end-to-end, not just that it's up

Don't stop at a green health check — this is the point where doc 19 found
its most important real bugs (an `X-Forwarded-For` chain that didn't behave
as documented, and firewall behavior that only a `tcpdump` capture could
confirm was actually correct). At minimum:

1. Register an account through the real deployed API and confirm a session
   cookie is actually set (`Set-Cookie` in the response headers).
2. Confirm the visitor IP the app sees is correct, not Cloudflare's edge IP
   — check an audit log entry or rate-limit behavior against a known IP.
3. Test a WebSocket connection against the real deployed URL (a standalone
   `socket.io-client` script, since `curl` can't do a WS handshake) to
   confirm Cloudflare + Caddy + session auth all cooperate over the
   real chain, not just plain HTTP.
4. Exercise at least one real authorization boundary end-to-end (e.g. a
   role-restricted action correctly returning `403`) — production RBAC
   enforcement under real conditions is a different claim than the local
   test suite passing.

### Phase 8 — Lock down the firewall

Only now, once Phase 6/7 have confirmed Caddy genuinely has a working
certificate: restrict the DigitalOcean Cloud Firewall's inbound 80/443
rules to Cloudflare's published IP ranges
(`https://www.cloudflare.com/ips/`) instead of "everyone."

**Verify properly, not just by re-testing through Cloudflare** (a VPN or
other network quirk can produce a false pass or false fail — see doc 19):
run a direct `curl` against the Droplet's raw IP and confirm it's refused,
and — if anything looks wrong — capture directly on the box
(`sudo tcpdump -i eth0 port 80 or port 443`) rather than trust a
dashboard's claimed rule set alone.

### Phase 9 — Backups

```bash
chmod +x scripts/backup-database.sh
crontab -e
# add: 0 3 * * * /home/stride/Stride-backend/scripts/backup-database.sh >> /home/stride/backup.log 2>&1
```

**Don't just install the cron job — run it once by hand immediately**, and
then actually restore what it produces:

```bash
./scripts/backup-database.sh
# then, separately, pull the backup back down and restore into a throwaway
# database, verifying real row counts — not just "no errors occurred"
```

A backup that's never been restored is an assumption, not a tested fact.
*(rationale: doc 18)*

### Phase 10 — Observability

Set up uptime monitoring and log shipping (Better Stack + a standalone
Vector agent, per doc 19) pointed at this Droplet. Verify log shipping is
genuinely working (Live Tail actually showing container output) before
trusting it, and confirm graceful shutdown works as expected:

```bash
time docker compose -f docker-compose.prod.yml stop app
```

Should complete in well under the default 10-second grace period — if it
takes the full 10 seconds and gets killed, `enableShutdownHooks()` isn't
actually taking effect.

---

## Part 3 — Common operations

**Redeploying after a code change:**
```bash
git pull
docker compose -f docker-compose.prod.yml run --rm migrate   # if migrations changed
docker compose -f docker-compose.prod.yml up -d --build app
```
Note: `logging:` config (§ below) only applies at container *creation* —
a plain `up -d --build` on a service that already exists won't retroactively
apply a **new** compose-level change like that; use `--force-recreate` if
you've changed something structural (env var additions requiring restart
aside, which `up -d` does pick up).

**Rotating a secret**: update `.env`, then recreate only the affected
service(s) — `docker compose -f docker-compose.prod.yml up -d
--force-recreate app` for most app-level secrets. `POSTGRES_APP_PASSWORD`
specifically needs `create-app-role` re-run first (it syncs the password
via `ALTER ROLE`) before the app is restarted with the new value, or the
app will fail to authenticate.

**Restoring from backup**: pull the relevant `.sql.gz` from the `backups`
bucket, `gunzip`, and `psql` it into a target database — always a
throwaway/test target first if you're validating the backup itself, never
directly into production without a reason to believe you need to.

**Full teardown and redeploy from scratch**: `docker compose -f
docker-compose.prod.yml down -v` destroys named volumes (`pgdata`,
`rustfs_data`, `caddy_data`, `caddy_config`) — this is genuinely
destructive and appropriate only for a true from-scratch test, not a normal
redeploy. Re-running this whole Part 2 runbook end-to-end after a `down -v`
(or a fresh Droplet entirely) is exactly the scenario it's written for.

---

## Appendix: required environment variables

| Variable | Required? | Notes |
|---|---|---|
| `POSTGRES_USER`/`PASSWORD`/`DB` | Yes | Owner/superuser connection — migrations, session store, `create-app-role` itself |
| `POSTGRES_APP_USER`/`APP_PASSWORD` | Yes | The app's own restricted runtime role — see Phase 5 |
| `STORAGE_ENDPOINT`/`PORT` | Yes | `localhost` locally; RustFS's service name in prod |
| `RUSTFS_ACCESS_KEY`/`SECRET_KEY` | Yes | |
| `SESSION_SECRET` | Yes — boot fails without it | `openssl rand -hex 32` |
| `MFA_ENCRYPTION_KEY` | Yes — boot fails without it | Exactly 64 hex chars |
| `FRONTEND_URL` | Yes | Singular — used to build password-reset links |
| `FRONTEND_URLS` | Yes | Plural, comma-separated — CORS allow-list |
| `TRUST_PROXY_HOPS` | Prod only | `2` behind Cloudflare + Caddy |
| `NODE_ENV` | Prod only | Must be exactly `production` |
| `RESEND_API_KEY` | Yes — boot fails without it | Placeholder OK locally |
| `EMAIL_FROM` | No | Defaults to a Resend sandbox address |
| `DATABASE_POOL_MAX` / `SESSION_POOL_MAX` / `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | No | Safe defaults if omitted |
