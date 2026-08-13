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

**If you're recreating an existing deployment rather than deploying for
the first time**, note first what does *not* need to be redone — it lives
independently of the Droplet:
- The domain and its Cloudflare DNS/SSL configuration — only the `A`
  record's IP needs updating once the new Droplet exists (Phase 2/8).
- Any external observability account (Better Stack's uptime monitor and
  log source) — only the Vector *agent* running on the Droplet itself
  needs reinstalling (Phase 10).

```bash
ssh-keygen -t ed25519 -C "stride-droplet"   # skip if reusing an existing key
```

### Phase 1 — Provision and harden the Droplet

1. Create a Droplet — Ubuntu 24.04 LTS (confirm this is still the current
   image DigitalOcean offers when you do this — check the dashboard
   directly, don't assume; see doc 18 for why this specific check matters),
   Basic/Regular, 2GB/1vCPU, SSH-key auth only (never set a root password),
   IPv6 enabled, monitoring left on.
2. Note the new IPv4 address. If it was previously assigned to a Droplet
   you've connected to before, clear the stale host key first:
   ```bash
   ssh-keygen -R <droplet-ip>
   ```
3. Connect as root, create a non-root sudo user, and copy your key over:
   ```bash
   ssh root@<droplet-ip>
   adduser stride
   usermod -aG sudo stride
   rsync --archive --chown=stride:stride ~/.ssh /home/stride
   ```
4. Disable root and password SSH login entirely:
   ```bash
   sudo nano /etc/ssh/sshd_config
   #   PermitRootLogin no
   #   PasswordAuthentication no
   sudo systemctl restart ssh
   ```
   **In a new terminal**, confirm `ssh stride@<droplet-ip>` works before
   closing the original root session — losing access here means starting
   over from a fresh Droplet.
5. Create a DigitalOcean Cloud Firewall. **Leave 80/443 open to everyone
   for now** — restricting it to Cloudflare's IP ranges happens later, in
   Phase 8, only after Caddy is confirmed working. Doing it now would risk
   locking out the very first Let's Encrypt certificate request.
6. Add swap — a 1vCPU Droplet benefits from it, and this project has
   already hit single-vCPU resource limits once (Better Stack's eBPF
   collector, doc 19):
   ```bash
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
   sudo sysctl -p
   ```
7. Install Docker + the Compose plugin (Ubuntu 24.04's official method —
   there's no shortcut here worth taking):
   ```bash
   sudo apt-get update
   sudo apt-get install -y ca-certificates curl
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   sudo chmod a+r /etc/apt/keyrings/docker.asc
   echo \
     "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
     $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
     sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   sudo apt-get update
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   sudo usermod -aG docker stride
   ```
   **Log out and back in** before continuing — group membership needs a
   fresh login to take effect.
8. Install the AWS CLI — needed for the backup script, and Ubuntu 24.04
   dropped the `awscli` apt package, so use the official installer:
   ```bash
   sudo apt install -y curl unzip
   curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
   unzip awscliv2.zip
   sudo ./aws/install
   rm -rf awscliv2.zip aws/
   ```
9. Avoid the cross-platform file-mode conflict doc 18 hit directly (a
   commit's executable bit disagreeing across OSes):
   ```bash
   git config --global core.fileMode false
   ```

**Verify**: you can SSH in as `stride` with your key, root/password login
both fail, `docker ps` runs without `sudo`, and `aws --version` prints a
real version.

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

Clone via a **read-only deploy key**, not a personal credential sitting on
the Droplet:

```bash
ssh stride@your-droplet-ip
ssh-keygen -t ed25519 -C "stride-droplet-deploy-key" -f ~/.ssh/stride_deploy_key
cat ~/.ssh/stride_deploy_key.pub
# add this as a read-only Deploy key on the repo: Settings → Deploy keys
git -c core.sshCommand="ssh -i ~/.ssh/stride_deploy_key" clone git@github.com:<you>/Stride-backend.git
cd Stride-backend
chmod +x scripts/backup-database.sh
cp .env.example .env
```

Edit `.env` for production values:

- **`POSTGRES_HOST=db` and `STORAGE_ENDPOINT=storage`, not `localhost`** —
  the single easiest mistake to make here. Local dev uses `localhost`
  because the app runs on the host; in production the app itself is a
  container reaching `db`/`storage` by their Compose service names.
- Generate fresh, real secrets — **do not reuse local-dev values**, and
  generate each one separately (running `openssl rand -hex N` twice
  produces two *different* values — don't copy one output into multiple
  fields):
  ```bash
  openssl rand -hex 32   # SESSION_SECRET
  openssl rand -hex 32   # MFA_ENCRYPTION_KEY — exactly 64 hex chars
  openssl rand -hex 24   # POSTGRES_PASSWORD
  openssl rand -hex 24   # RUSTFS_SECRET_KEY
  openssl rand -hex 24   # POSTGRES_APP_PASSWORD
  openssl rand -hex 8    # RUSTFS_ACCESS_KEY — see note below
  ```
  **`RUSTFS_ACCESS_KEY` needs a shorter value than the other secrets.**
  `.env.example`'s own comment currently suggests `openssl rand -hex 16`
  (32 hex characters) — this has been observed to cause RustFS console
  login failures. `openssl rand -hex 8` (16 characters) has worked in
  practice. *(I couldn't independently confirm RustFS's exact accepted
  key-length range in their official docs — treating this as your own
  verified finding from actually hitting the failure, not something I
  verified myself. Worth fixing `.env.example`'s own comment to match,
  since as written it currently points anyone following it toward the
  same failure.)*
- `NODE_ENV=production` — required exactly as that string; it's what flips
  session cookies to `secure: true`/`sameSite: 'none'` and pino to raw JSON.
- `TRUST_PROXY_HOPS=2` — Cloudflare, then Caddy.
- `FRONTEND_URL`/`FRONTEND_URLS` — your real deployed frontend origin(s).
- `RESEND_API_KEY` — a real key if email delivery should actually work at
  this deploy; note Resend's sandbox mode only delivers to the account's
  own signup address until a sending domain is verified (see doc 17).
- `EMAIL_FROM` — confirm the real sending subdomain before deploying;
  double-check this against whatever you actually verified in Resend
  rather than an old value copied from a previous `.env`.

```bash
chmod 600 .env
```

Also copy `Caddyfile` to the Droplet if it isn't already tracked in the
repo, and confirm it points at your real domain.

**A gap not covered by any existing script, worth doing now**: the backup
script (Phase 9) uploads to an S3 bucket named `backups` — this is a
*different* bucket from `stride` (which `StorageService` creates
automatically on first app boot). Nothing currently auto-creates `backups`.
Create it once, after `storage` is up in Phase 4, either via an SSH tunnel
to the RustFS console:

```bash
ssh -L 9101:localhost:9001 stride@<droplet-ip>
# then browse to http://localhost:9101 locally
```

or non-interactively:

```bash
aws --endpoint-url http://localhost:9000 s3 mb s3://backups
```
make_bucket failed: s3://backups Unable to locate credentials !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

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

**If you also need to seed the exercise library**: `docker-compose.prod.yml`
has no dedicated `seed` service (unlike `migrate`/`create-app-role`), so
run it against the already-built `migrate` image directly on the compose
network — the network name follows Compose's default
`<project-name>_default` pattern, `stride_default` here (from `name:
stride` at the top of the compose file):

```bash
docker run --rm --network stride_default --env-file .env \
  stride-migrate npx ts-node scripts/seed-exercises.ts
```

Worth considering adding a proper `seed` service mirroring `migrate`'s
shape at some point, for the same reason `migrate` itself got promoted
from an ad hoc command to a real Compose service (doc 18) — this works,
but it's the one remaining one-off operation still done by hand.

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
confirm was actually correct).

- [ ] `curl https://<your-domain>/health` → `200`
- [ ] Register/login through the real deployed API; confirm `Set-Cookie`
      includes `Secure` and `SameSite=None`
- [ ] `node scripts/test-websocket-production.js "connect.sid=..."` — a
      real connection over the full Cloudflare + Caddy + session-auth chain
- [ ] A real request's logged `x-forwarded-for` matches `cf-connecting-ip`
      exactly — confirms the IP-resolution fix in `main.ts` is actually
      active in this specific deployment, not just correct in theory
- [ ] Exercise at least one real authorization boundary end-to-end (e.g. a
      role-restricted action correctly returning `403`) — production RBAC
      enforcement under real conditions is a different claim than the local
      test suite passing.

### Phase 8 — Lock down the firewall

Only now, once Phase 6/7 have confirmed Caddy genuinely has a working
certificate: restrict the DigitalOcean Cloud Firewall's inbound 80/443
rules to Cloudflare's published IP ranges — **re-fetch the current list
from `https://www.cloudflare.com/ips/` rather than reuse an old copy**,
since it does change periodically — instead of "everyone."

**Verify properly, not just by re-testing through Cloudflare** (a VPN or
other network quirk can produce a false pass or false fail — see doc 19):
run a direct `curl` against the Droplet's raw IP and confirm it's refused,
and — if anything looks wrong — capture directly on the box
(`sudo tcpdump -i eth0 port 80 or port 443`) rather than trust a
dashboard's claimed rule set alone.

### Phase 9 — Backups

The `backups` bucket should already exist from Phase 3. Confirm it does,
then:

```bash
./scripts/backup-database.sh   # run once by hand first — confirm it works
crontab -e
# add: 0 3 * * * /home/stride/Stride-backend/scripts/backup-database.sh >> /home/stride/backup.log 2>&1
```

**Don't stop at "the script exited cleanly"** — pull the backup it just
produced back down and restore it into a throwaway database, verifying
real row counts. A backup that's never been restored is an assumption, not
a tested fact. *(rationale: doc 18)*

### Phase 10 — Observability

**Uptime monitor**: point at `https://<your-domain>/health`, HTTP, expect
`200`. If this is a redeploy and the monitor already targets the domain
(not the Droplet's IP directly), it may not need touching at all.

**Log shipping**: install Better Stack's Docker-specific Vector agent (not
the full eBPF collector — it's failed outright on a 1vCPU Droplet before,
see doc 19):

```bash
curl -sSL https://telemetry.betterstack.com/setup-vector/docker/YOUR_SOURCE_TOKEN \
  -o /tmp/setup-vector.sh && bash /tmp/setup-vector.sh
```

Then fix the Docker socket permission immediately — Vector runs as a
restricted `vector` user by default and can't reach the socket without
this:

```bash
sudo usermod -aG docker vector
sudo systemctl restart vector
```

Verify log shipping is genuinely working (Live Tail actually showing
output from all four containers) before trusting it, and confirm graceful
shutdown works as expected:

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
| `POSTGRES_HOST` | Yes | `localhost` locally; `db` (the Compose service name) in production — **not** `localhost` there |
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
