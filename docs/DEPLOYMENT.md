# Stride — Installation & Deployment Guide

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
nano .env
```

(Any editor works — `code .env` if you have VS Code's CLI set up, or
whatever you're used to. `nano` is just the one guaranteed to exist with
no setup, the same reason it's used throughout this guide.) Everything
with a `# Generate: openssl rand -hex N` comment needs a real generated
value — `validateEnv()` refuses to boot on a missing or placeholder value
for `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, and `POSTGRES_APP_PASSWORD`
specifically:

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

On Windows/WSL2, a known cause of intermittent, otherwise-inexplicable
failures in timing-sensitive e2e tests (e.g. an assertion comparing a
database timestamp against `Date.now()`) is the Docker Desktop WSL2 VM
clock drifting several seconds ahead of the host — `wsl --shutdown`
resyncs it.

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
cat ~/.ssh/id_ed25519.pub
```

Copy the full output of that second command — one line, starting with
`ssh-ed25519 AAAA...`, ending with the comment you gave it. That's what
gets pasted into DigitalOcean, either under Settings → Security → SSH Keys
ahead of time, or directly in the "Add SSH Key" step during Droplet
creation (Phase 1). **Never paste the contents of `id_ed25519`** (no
`.pub` extension) anywhere — that's the private key, and it should never
leave your machine.

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
5. Create a DigitalOcean Cloud Firewall with two inbound rules —
   DigitalOcean's own named presets, not just raw port numbers: **HTTP**
   (port `80`) and **HTTPS** (port `443`), both left open to all
   IPv4/IPv6 **for now** — restricting them to Cloudflare's IP ranges
   happens later, in Phase 8, only after Caddy is confirmed working. Doing
   it now would risk locking out the very first Let's Encrypt certificate
   request.
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
   fresh login to take effect:
   ```bash
   exit
   ssh stride@<droplet-ip>
   ```
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

**Verify**, with real commands, not just a description of what should be
true:
```bash
ssh stride@<droplet-ip>          # should succeed
ssh root@<droplet-ip>            # should be refused
docker ps                        # should run with no error, no sudo needed
aws --version                    # should print a real version string
```

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
chmod 600 ~/.ssh/stride_deploy_key
cat ~/.ssh/stride_deploy_key.pub
# add this as a read-only Deploy key on the repo: Settings → Deploy keys
```
Then:
```bash
git -c core.sshCommand="ssh -i ~/.ssh/stride_deploy_key" clone git@github.com:<you>/Stride-backend.git
cd Stride-backend
git config core.sshCommand "ssh -i ~/.ssh/stride_deploy_key"
```
The `git config` line matters and is easy to skip: `-c` on the `clone`
command only applies to that one invocation, not to the repo going
forward. Without persisting it, the next plain `git pull` here falls back
to SSH's default key discovery, finds nothing, and fails with `Permission
denied (publickey)` — worth confirming right after cloning
(`git pull` should succeed with no error) rather than assuming it carried
over.
```bash
cp .env.example .env
nano .env
```

Edit for production values (`nano` since you're already in an SSH
session — no GUI editor is going to be available here):

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
  session cookies to `secure: true` (`sameSite` is `'lax'` in every
  environment) and pino to raw JSON.
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

`Caddyfile` came along with the clone — confirm it points at your real
domain.

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
already existed.

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

**If you also need to seed the exercise library**, a dedicated `seed`
service mirrors `migrate`'s shape (`profiles: ["tools"]`, only ever run
explicitly):

```bash
docker compose -f docker-compose.prod.yml build seed
docker compose -f docker-compose.prod.yml run --rm seed
```

Idempotent — safe to re-run; skips any exercise whose `external_id`
already exists. Always `build` before `run --rm` for any `profiles: ["tools"]`
service after a `git pull` — Compose only auto-builds an image the first
time it doesn't exist, and silently reuses a stale one otherwise (see
Part 3's redeploy note for the general version of this rule).

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
confirm was actually correct). No frontend needed for any of this — every
route is exercised directly.

**Run the `curl` and WebSocket steps below from your own machine, not the
Droplet.** They're all testing the public domain as any external client
would — running them from your laptop is actually the *more* correct test,
since it exercises the real "outside the internet → Cloudflare → origin"
path a real user takes, rather than a Droplet-to-itself round trip. It also
means you don't need Node installed on the Droplet at all — production
deliberately has nothing but Docker on the host (Part 1's local setup is
the only place this project expects a bare Node install). Only the final
log-checking step genuinely needs to run **on** the Droplet, since Docker's
logs only exist there — that one's called out explicitly below.

Set your real domain once:

```bash
DOMAIN=<api.yourdomain.com>
```

- [ ] **Health check**
  ```bash
  curl -I https://$DOMAIN/health
  ```
  → `200`.

- [ ] **Register, and confirm the cookie itself, not just success** —
  `-c cookies.txt` saves the session cookie for every following step, and
  `-i` shows the raw response headers so you can see `Set-Cookie` directly
  rather than trust `curl` swallowed it silently:
  ```bash
  curl -i -c cookies.txt -X POST https://$DOMAIN/auth/register \
    -H "Content-Type: application/json" \
    -d '{
      "email": "verify-deploy@example.com",
      "password": "SomeStrongPassw0rd!",
      "firstName": "Deploy",
      "lastName": "Verify",
      "dateOfBirth": "1990-01-01"
    }'
  ```
  Check the `Set-Cookie` line in the output directly: it must include
  `Secure` and `SameSite=Lax` — if `Secure` is missing, `NODE_ENV` isn't
  actually resolving to `production` in the running container (§ Phase 3).
  Also check the response body includes a nested `"patientProfile":
  { "dateOfBirth": "1990-01-01" }`.

- [ ] **Confirm the session is real**, using the saved cookie:
  ```bash
  curl -i -b cookies.txt https://$DOMAIN/auth/me
  ```
  → `200` with your account's data, `passwordHash`/`mfaSecret`/reset-token
  fields genuinely absent from the body (doc 22), `patientProfile` present
  the same as the register response.

- [ ] **`404`, not `403`, for an out-of-scope RLS-protected resource** —
  confirms the RLS rollout's actual current behavior is live, not the
  pre-rollout assumption: `medical_files`, `assigned_programs`, `sessions`,
  and `conversations` all return `404` for a resource this account has no
  relationship to, since RLS filters the row out before the ownership
  check ever runs (doc 27). A genuinely nonexistent id is the simplest
  live check (a real, existing-but-not-yours id would need a second test
  account, already covered by the local e2e suite — this is a lighter
  smoke check, not a full re-verification):
  ```bash
  curl -i -b cookies.txt https://$DOMAIN/medical-files/999999
  ```
  → `404`, `"Medical file entry 999999 not found"` — not a `403`.

- [ ] **WebSocket, over the full real chain** (Cloudflare + Caddy +
  session auth) — extract the raw cookie value first, then run the
  existing test script:
  ```bash
  COOKIE=$(grep connect.sid cookies.txt | awk '{print $6"="$7}')
  node scripts/test-websocket-production.js "$COOKIE"
  ```

- [ ] **`CF-Connecting-IP` vs `X-Forwarded-For`, checked directly against
  real evidence** — this was doc 19's most important finding, and it's
  worth re-confirming on every fresh deployment, not assumed to still
  hold. **This is the one step that genuinely needs to run on the
  Droplet itself** (SSH in), since Docker's logs live only there — fire
  the request from anywhere (or reuse `cookies.txt` if you copy it over),
  then check what Caddy actually received and what the app actually
  resolved for the *same* request, matched by timestamp:
  ```bash
  curl -s -b cookies.txt https://$DOMAIN/auth/me >/dev/null   # can run from anywhere with the cookie
  # then, on the Droplet:
  docker compose -f docker-compose.prod.yml logs --since 30s caddy \
    | grep -o '"Cf-Connecting-Ip":\["[^"]*"\].*"X-Forwarded-For":\["[^"]*"\]'
  docker compose -f docker-compose.prod.yml logs --since 30s app | tail -20
  ```
  The IP in the app's own log line for that request should match
  `Cf-Connecting-Ip` above — and should be a real, non-Cloudflare address
  (not something in Cloudflare's own published ranges), confirming the
  `main.ts` middleware fix from doc 19 is genuinely active in *this*
  deployment, not just correct in theory.

- [ ] **A real authorization boundary, not just an authenticated
  request** — a freshly registered account has no clinic and no elevated
  role, so a practitioner-only action should be refused:
  ```bash
  curl -i -b cookies.txt -X POST https://$DOMAIN/exercises \
    -H "Content-Type: application/json" \
    -d '{"name": "Should be rejected", "primaryMuscles": ["abdominals"]}'
  ```
  → `403`. Production RBAC enforcement under real conditions is a
  different claim than the local test suite passing.

- [ ] **Don't try to clean up the verification account individually** —
  there's no real way to. The app has no hard-delete route for `users`,
  and the schema's own `RESTRICT` foreign keys correctly refuse a direct
  SQL delete once an audit log entry references the account (confirmed
  directly — this is the schema working as designed, not a bug to work
  around). Leave it as known, intentional test data for now; **Phase 11**
  is where it actually gets removed, as part of a full reset, once you're
  done verifying everything else.

### Phase 8 — Lock down the firewall

Only now, once Phase 6/7 have confirmed Caddy genuinely has a working
certificate: restrict the DigitalOcean Cloud Firewall's inbound 80/443
rules to Cloudflare's published IP ranges — **re-fetch the current list
from `https://www.cloudflare.com/ips/` rather than reuse an old copy**,
since it does change periodically — instead of "everyone."

**Verify properly, not just by re-testing through Cloudflare** (a VPN or
other network quirk can produce a false pass or false fail — see doc 19).
Run these from your own machine, not the Droplet — you're testing whether
the outside world can reach the Droplet's raw IP directly, which is a
question about the network path *into* the Droplet, not something the
Droplet can meaningfully test against itself:

```bash
DROPLET_IP=<your-droplet-s-real-IP>
curl -m 5 -I http://$DROPLET_IP/health
curl -m 5 -I -k https://$DROPLET_IP/health
```

Both should **fail to connect** (a timeout or connection-refused, not any
kind of HTTP response) — `-m 5` caps the wait at 5 seconds so a correctly
blocked request doesn't just hang. Compare that against the domain, which
should still work fine, since Cloudflare's own IPs remain allowed:

```bash
curl -I https://$DOMAIN/health   # should still succeed normally
```

If the direct-IP requests unexpectedly succeed, don't trust the dashboard's
claimed rule set — capture directly on the box instead, from an SSH session
on the Droplet itself:

```bash
sudo tcpdump -i eth0 port 80 or port 443
```

then repeat the `curl` commands above from your machine and watch what
actually arrives. Cloud Firewalls filter at the hypervisor level, so
blocked traffic never reaches a capture taken on the box at all — seeing
*nothing* in the capture while a request is in flight is itself
confirmation the block is working; seeing the request arrive means the
firewall rule isn't actually applied the way the dashboard claims.

### Phase 9 — Backups

The `backups` bucket is created automatically by the script itself on
first run — nothing to confirm ahead of time. Worth knowing the RustFS
console is also reachable via an SSH tunnel if you ever want to browse
buckets directly, now that `storage` is actually up:

```bash
ssh -L 9101:localhost:9001 stride@<droplet-ip>
# then browse to http://localhost:9101 locally
```

Run the backup script for real, **on the Droplet**:

```bash
chmod +x scripts/backup-database.sh
./scripts/backup-database.sh   # run once by hand first — confirm it works
```

Then schedule it. Run:

```bash
crontab -e
```

That opens an editor — add this line inside it (don't paste it into your
shell directly; it only means anything inside the crontab file):

```
0 3 * * * /home/stride/Stride-backend/scripts/backup-database.sh >> /home/stride/backup.log 2>&1
```

**Don't stop at "the script exited cleanly"** — actually pull the backup
it just produced back down and restore it, verifying real row counts. A
backup that's never been restored is an assumption, not a tested fact.
*(rationale: doc 18)* Still on the Droplet:

```bash
# Same credential-extraction the backup script itself uses (a shared
# env_var() helper stripping trailing inline comments — .env.example's
# own documented "KEY=value # Generate: ..." format broke a naive
# grep|cut extraction here and in the script both; see its own comments
# for why `source .env` is deliberately avoided instead of just fixing
# that a different way):
env_var() {
  grep -E "^$1=" .env | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'
}
RUSTFS_ACCESS_KEY=$(env_var RUSTFS_ACCESS_KEY)
RUSTFS_SECRET_KEY=$(env_var RUSTFS_SECRET_KEY)
STORAGE_PORT=$(env_var STORAGE_PORT)
export AWS_ACCESS_KEY_ID="$RUSTFS_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$RUSTFS_SECRET_KEY"

# Find the file the manual run above actually produced:
aws --endpoint-url "http://localhost:${STORAGE_PORT}" s3 ls s3://backups/
```

Pull the most recent one down and restore it into a genuinely separate,
throwaway database — never directly into `stride`, even to "just check":

```bash
BACKUP_FILE=<the filename from the ls output above>
aws --endpoint-url "http://localhost:${STORAGE_PORT}" s3 cp \
  "s3://backups/${BACKUP_FILE}" "/tmp/${BACKUP_FILE}"

docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -c "CREATE DATABASE restore_verify;"
gunzip -c "/tmp/${BACKUP_FILE}" | docker compose -f docker-compose.prod.yml \
  exec -T db psql -U postgres -d restore_verify

# The real check — an actual count, not "no errors occurred":
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -d restore_verify -c "SELECT count(*) FROM exercises;"
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -d restore_verify -c "SELECT count(*) FROM users;"
```

Compare those counts against what you actually expect (873 exercises if
seeded, plus however many real accounts exist) — a mismatch here is the
one thing a clean-looking backup run can't tell you on its own. Clean up
once confirmed:

```bash
rm "/tmp/${BACKUP_FILE}"
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -c "DROP DATABASE restore_verify;"
```

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

**`stop` only stops the container — it does not come back on its own.**
Bring it back up before treating this check as done, or you'll leave the
app genuinely down:
```bash
docker compose -f docker-compose.prod.yml start app
```
(`start`, not `up -d` — nothing changed, so this just resumes the existing
container rather than re-evaluating whether to recreate it.)

**Live Tail can lag behind real time by a noticeable amount** — the
shutdown and restart log lines may not appear immediately. Don't read a
few seconds of apparent silence as log shipping having failed; give it a
moment and check again before assuming Vector needs troubleshooting.

### Phase 11 — Final clean reset, once everything's verified (optional)

Phase 7's verification steps leave real artifacts behind: at least one
test account, and its `REGISTER`/`LOGIN_SUCCESS` rows in `audit_logs`.
There's no clean way to remove just that — the app has no hard-delete
route for `users` at all, and the schema's own `RESTRICT` foreign keys
correctly refuse a direct SQL delete once an audit log entry references
the account (this is the schema working as designed, not a bug to work
around). Once Phases 4–10 have all been confirmed working, it's worth one
full reset to leave the deployment genuinely clean before treating it as
ready for real use, rather than carrying test data forward indefinitely:

```bash
docker compose -f docker-compose.prod.yml down -v
```

This is deliberately destructive — safe specifically because there's no
real data yet, the same reasoning behind this project's established
pre-launch reset pattern (doc 04). Know exactly what it does and doesn't
touch before running it:

**Destroyed** — the four named volumes, nothing else:
- `pgdata` — the entire database, **including the `stride_app` role
  itself** (Postgres roles live inside the data directory, not outside it)
- `rustfs_data` — every bucket, including `stride` (exercise images) and
  the `backups` bucket (self-created by the backup script on next run)
- `caddy_data`/`caddy_config` — the TLS certificate

**Untouched** — everything outside those volumes: the Droplet itself
(Phase 1), DNS/Cloudflare (Phase 2), the cloned repo and `.env` (Phase 3),
the firewall restriction (Phase 8), the cron entry (Phase 9 — crontab is
host state, not a volume), and Vector (a host-level systemd service,
Phase 10).

**To bring it back**: restart from **Phase 4 through Phase 6** — `db`/
`storage` up, `migrate`, `create-app-role`, `seed` if you need the
exercise library again, `app`/`caddy`. **Deliberately don't re-run Phase
7's verification steps** — registering a fresh test account would
immediately recreate the exact kind of artifact this reset just removed,
defeating the point. A single, non-mutating confirmation is enough to
know the redeploy actually worked:
```bash
curl -I https://<your-domain>/health
```
**Backups are worth re-verifying too, but only partially.** The cron entry
itself survived the reset — it's host state, already listed as untouched
above — so there's no need to touch `crontab -e` again. What's actually
worth redoing is a single manual run plus the restore-and-row-count check,
since that data really did live in the wiped volume:
```bash
./scripts/backup-database.sh
```
then the restore verification from earlier in Phase 9. The `backups`
bucket recreates itself automatically on that run — nothing manual needed
there either. **Phase 8 and Phase 10 don't need repeating**; nothing they
configured lived in a wiped volume.

---

## Part 3 — Common operations

**Redeploying after a code change:**
```bash
git pull   # requires core.sshCommand set once per Phase 3 — see there if this fails with "Permission denied (publickey)"
docker compose -f docker-compose.prod.yml build migrate   # or: run --build --rm migrate
docker compose -f docker-compose.prod.yml run --rm migrate   # if migrations changed
docker compose -f docker-compose.prod.yml up -d --build app
```
**Rebuild before you rely on it, every time, for every service whose
source actually changed — not just the one you're about to restart.**
`docker compose run`/`up` only auto-build an image the *first* time it
doesn't exist yet; once built, both silently reuse that image forever,
staleness included, unless `--build` is passed explicitly. `app`'s line
above already had `--build`; `migrate`'s didn't, and it should have —
this exact gap (a `stride-migrate` image built before a fix landed,
silently reused after) cost real debugging time during this project's own
redeploy. If in doubt, `docker compose -f docker-compose.prod.yml build`
with no service name rebuilds everything that has a `build:` block in one
pass.

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
redeploy. See Phase 11 for exactly what survives this and what needs
redoing afterward — a genuine fresh Droplet needs the whole Part 2 runbook
from Phase 1; an existing Droplet after `down -v` only needs Phase 4 onward.

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
