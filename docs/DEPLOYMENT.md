# Stride backend — installation and deployment

> **Status, 2026-11-03: run end to end.** The whole system was deployed
> by following this guide from start to finish, each "Verify" included: a
> public repository (no deploy key), storage's public address
> `files.stridecare.app`, GlitchTip, the frontend on Cloudflare Pages, and
> the reviewers' demo, live at `https://stridecare.app`. The backend-only
> deployment this guide grew from had been run twice on a real Droplet
> before: first built
> ([journal 18](journal/18-deployment-provisioning-through-backups.md),
> [19](journal/19-deployment-verification-and-observability.md)), then
> destroyed and rebuilt from this file
> ([26](journal/26-redeploying-for-real.md)). The day after, 2026-11-04,
> the images were pinned by digest (Part 4) and log rotation was confirmed on
> every running container.

This is the backend's half. The frontend is static files on Cloudflare Pages,
with its own guide: the frontend repository's
[`docs/DEPLOYMENT.md`](https://github.com/julienjave/Stride-frontend/blob/main/docs/DEPLOYMENT.md).
Both are needed for a working site, and the two meet in a few settings,
named in both guides.

### In this guide:

- [**Part 1** — local development](#part-1--local-development)
- [**Part 2** — production](#part-2--production-on-a-fresh-droplet), on a fresh Droplet, phase by phase
- [**Part 3** — the reviewers' demo](#part-3--the-reviewers-demo-demo_modeon) (`DEMO_MODE=on`)
- [**Part 4** — common operations](#part-4--common-operations)
- [**Appendix** — every environment variable](#appendix--environment-variables)

`journal NN` below links the build journal's entry where a step's reason
(usually a real failure) is told.

---

## What runs where

```
browser ── https://stridecare.app ────────► Cloudflare Pages: the frontend's static files
browser ── https://api.stridecare.app ────► Cloudflare ─► Caddy ─► app:3000   (HTTP and socket.io)
browser ── https://files.stridecare.app ──► Cloudflare ─► Caddy ─► storage:9000 (signed GETs only)

app ─► db:5432 · storage:9000 · glitchtip:8000   (the Compose network, never the internet)
app ─► Resend's API (email)          Better Stack ◄─ Vector (logs) · uptime checks from outside
```

| Where | What |
|---|---|
| Cloudflare | DNS for `stridecare.app`; the proxy and the visitor-facing TLS for `api.` and `files.`; Pages for the frontend |
| The Droplet (DigitalOcean, Ubuntu 24.04, 2 GB / 1 vCPU) | [`docker-compose.prod.yml`](../docker-compose.prod.yml): `caddy` (the only public ports, 80 and 443), `app`, `db`, `storage`, `glitchtip`, `glitchtip-db`; the one-off jobs `migrate`, `create-app-role`, `seed`, `demo-reset` |
| The Droplet's host, outside Docker | the backup's cron line, the demo's systemd timer, Better Stack's Vector agent, the AWS CLI |
| Elsewhere | Resend (email delivery), Better Stack (uptime, logs) |

Each service, its image and who can reach it: ARCHITECTURE
[§11](ARCHITECTURE.md#11-deployment-topology).

---

## Part 1 — Local development

**Prerequisites:** Node.js 24, Docker with Compose, `npm`.

Locally only the services run in Docker: `db`, `storage` and `mailpit` (and
GlitchTip, if asked for). The app runs on the host, with `npm run start:dev`.
That's why [`docker-compose.yml`](../docker-compose.yml) has no `app` and no
one-off jobs.

### 1. Clone and install

```bash
git clone https://github.com/julienjave/Stride-backend.git backend
cd backend
npm ci
```

The frontend's browser suite looks for the backend beside it: at
`../backend` (the name used here, as in CI), then `../Stride-backend` (a
plain `git clone`). Clone the frontend into the same parent folder.

### 2. Start Postgres, RustFS and Mailpit

```bash
docker compose up -d
```

- `db`: Postgres 16 on `localhost:5432`;
- `storage`: RustFS on `localhost:9000` (S3) and `9001` (its console);
- `mailpit`: catches every email the app sends. Its inbox is at
  http://localhost:8025, with the links clickable. Nothing reaches anyone.

GlitchTip (error tracking) only starts when asked: `docker compose --profile
errors up -d`, then http://localhost:8000. Leave the two `SENTRY_…` DSNs empty
and nothing is reported (the default).

### 3. `.env`

```bash
cp .env.example .env
```

Three values must be real, or the app refuses to start
([`validate-env.ts`](../src/config/validate-env.ts)):

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # MFA_ENCRYPTION_KEY: exactly 64 hex characters
openssl rand -hex 24   # POSTGRES_APP_PASSWORD
```

The rest of `.env.example` works as it is: `EMAIL_TRANSPORT=smtp` to Mailpit,
storage on `localhost`, the frontend on `http://localhost:5173`.

### 4. Migrate, then create the app's database role

```bash
npx drizzle-kit migrate
npm run db:create-app-role
```

The migrations run as the owner (`POSTGRES_USER`), which has the rights to
create tables. The app's own queries run as `stride_app`, a role with no
right to bypass Row-Level Security, so the policies apply to it
([journal 23](journal/23-row-level-security-step-zero.md)). The script creates
that role, or syncs its password if it exists; it's safe to re-run.

### 5. Seed

```bash
npm run seed
```

The exercise library (873 exercises with photos, downloaded from the
`free-exercise-db` project on GitHub), then the demo world: clinics,
practitioners, patients, programs, messages. The accounts and their password
are in [`demo-accounts.md`](demo-accounts.md). `npm run seed --
--reset` deletes everything but the exercise library and creates the demo
world again.

### 6. Start the API

```bash
npm run start:dev
```

It listens on `:3000` and restarts on every change. First checks:
http://localhost:3000/health and Swagger at http://localhost:3000/api-docs.
The frontend's own setup is in its
[`docs/DEPLOYMENT.md`](https://github.com/julienjave/Stride-frontend/blob/main/docs/DEPLOYMENT.md#1-running-it-locally).

### 7. Tests

The suites, their databases and how to run them: [`TESTING.md`](TESTING.md).

---

## Part 2 — Production, on a fresh Droplet

The order below avoids the chicken-and-egg problems met the first time (each
one is explained where it comes up). Each phase ends with a way to check it
worked before the next one builds on it.

Two kinds of deployment use this part: **a real clinic's**, and **the
reviewers' demo**. They differ only in Part 3, applied after Phase 12.

### Phase 0 — Before you start

Accounts: DigitalOcean; Cloudflare, with `stridecare.app` on it; Resend
(email); Better Stack (uptime and logs). The code is in public repositories,
so the Droplet needs no GitHub credentials.

**Recreating an existing deployment?** What lives outside the Droplet doesn't
need redoing: the domain and its Cloudflare settings (only the `A` records'
IP changes, Phase 2), Resend's verified domain, the Cloudflare Pages project,
Better Stack's monitors and log source (only the Vector agent on the Droplet
is reinstalled, Phase 12). GlitchTip's account and projects lived on the old
Droplet: their DSNs will be new (Phase 10).

An SSH key for the Droplet, on your machine:

```bash
ssh-keygen -t ed25519 -C "stride-droplet"   # skip if you have one
cat ~/.ssh/id_ed25519.pub
```

The second command prints one line, `ssh-ed25519 AAAA… stride-droplet`: the
**public** key, which DigitalOcean asks for. Never paste `id_ed25519` (no
`.pub`) anywhere: that's the private key, and it stays on your machine.

### Phase 1 — Create and harden the Droplet

1. **Create the Droplet**: Ubuntu 24.04 LTS (check in the dashboard that it's
   still the current LTS image; don't assume, [journal
   18](journal/18-deployment-provisioning-through-backups.md)),
   Basic/Regular, 2 GB / 1 vCPU, SSH-key authentication only (no root
   password), IPv6 on, monitoring on.
2. **Note its IPv4 address.** If you've connected to that address before
   (a recreated Droplet often gets it back), forget the old host key:
   ```bash
   ssh-keygen -R <droplet-ip>
   ```
3. **A non-root user with sudo**, with your key:
   ```bash
   ssh root@<droplet-ip>
   adduser stride
   usermod -aG sudo stride
   rsync --archive --chown=stride:stride ~/.ssh /home/stride
   ```
4. **No root login, no password login:**
   ```bash
   sudo nano /etc/ssh/sshd_config
   #   PermitRootLogin no
   #   PasswordAuthentication no
   sudo systemctl restart ssh
   ```
   **In a second terminal**, check `ssh stride@<droplet-ip>` works before
   closing the root session. Locked out here means starting again from a new
   Droplet.
5. **A DigitalOcean Cloud Firewall** with two inbound rules, DigitalOcean's
   **HTTP** (80) and **HTTPS** (443) presets, open to everyone **for now**.
   Phase 8 restricts them to Cloudflare's addresses, once the certificates
   exist; restricting now risks blocking their first request.
6. **Swap.** GlitchTip alone needs about 0.5 GB (decisions §32), and a 1 vCPU
   Droplet has run out once already ([journal
   19](journal/19-deployment-verification-and-observability.md)):
   ```bash
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
   sudo sysctl -p
   ```
7. **Docker and the Compose plugin**, Docker's own method for Ubuntu:
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
   exit
   ssh stride@<droplet-ip>
   ```
   The `exit` and new login matter: a new group membership only applies to
   a new session.
8. **The AWS CLI**, which the backup script uses to talk to RustFS (Ubuntu
   24.04 has no `awscli` package any more):
   ```bash
   sudo apt-get install -y unzip
   curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
   unzip awscliv2.zip
   sudo ./aws/install
   rm -rf awscliv2.zip aws/
   ```
9. **Ignore file modes in Git.** A commit from Windows can't carry the
   executable bit, and Git on Linux then reports every script as changed
   ([journal 18](journal/18-deployment-provisioning-through-backups.md)):
   ```bash
   git config --global core.fileMode false
   ```

**Verify:**

```bash
ssh stride@<droplet-ip>   # works
ssh root@<droplet-ip>     # refused
docker ps                 # works, without sudo
aws --version             # prints a version
swapon --show             # /swapfile, 2G
```

### Phase 2 — DNS and TLS on Cloudflare

1. **Two `A` records**, both pointing at the Droplet's IPv4 and both
   **proxied** (orange cloud): Cloudflare answers visitors itself, with its
   own certificate, and hides the Droplet's address.

   | Name | Type | Content | Proxy | Serves |
   |---|---|---|---|---|
   | `api` | A | `<droplet-ip>` | Proxied | the API and its socket |
   | `files` | A | `<droplet-ip>` | Proxied | photo downloads through signed links |

   The apex, `stridecare.app`, is the frontend: Cloudflare Pages creates its
   record when the custom domain is added (the frontend's guide). Email's
   records come in Phase 9.
2. **SSL/TLS mode: Full (strict).** Cloudflare then connects to Caddy over
   HTTPS and checks Caddy's certificate is real; plain "Full" accepts any
   certificate. Until Phase 6 gives Caddy one, requests fail with `526`, which
   is expected.

Why `files` is a host of its own, not a path on `api.`: a signed link's
signature covers its host and its path, so the link has to be signed for the
exact address the browser will use, and a proxy that rewrote the path would
break every signature
([`storage-urls.ts`](../src/config/storage-urls.ts) says it in full).

`.app` is on browsers' HSTS preload list as a whole: browsers only ever
connect to `stridecare.app` and its subdomains over HTTPS.

### Phase 3 — The code and `.env`

```bash
git clone https://github.com/julienjave/Stride-backend.git /home/stride/Stride-backend
cd /home/stride/Stride-backend
```

The repository is public: cloning over HTTPS needs no key and no credential
on the Droplet, and every later `git pull` works the same way. The target
folder is written out
because [`scripts/backup-database.sh`](../scripts/backup-database.sh) changes
into exactly `/home/stride/Stride-backend`.

**Write `.env`** with every secret generated on the spot:

```bash
cat > .env <<EOF
# --- Database: the Compose service's name, never localhost
POSTGRES_HOST=db
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=stride
POSTGRES_APP_USER=stride_app
POSTGRES_APP_PASSWORD=$(openssl rand -hex 24)

# --- Storage: the internal address, and the public one links are signed for
STORAGE_ENDPOINT=storage
STORAGE_PORT=9000
STORAGE_PUBLIC_URL=https://files.stridecare.app
RUSTFS_ACCESS_KEY=$(openssl rand -hex 8)
RUSTFS_SECRET_KEY=$(openssl rand -hex 24)

# --- Sessions and two-factor secrets
SESSION_SECRET=$(openssl rand -hex 32)
MFA_ENCRYPTION_KEY=$(openssl rand -hex 32)

# --- The frontend: links in emails, and the CORS allow-list
FRONTEND_URL=https://stridecare.app
FRONTEND_URLS=https://stridecare.app

# --- Behind two proxies: Cloudflare, then Caddy
NODE_ENV=production
TRUST_PROXY_HOPS=2

# --- Email: Phase 9 replaces the key
EMAIL_TRANSPORT=resend
RESEND_API_KEY=re_REPLACE_ME
EMAIL_FROM=Stride <noreply@stridecare.app>

# --- Error tracking: the two DSNs come in Phase 10, GlitchTip's secrets now
SENTRY_DSN=
SENTRY_BROWSER_DSN=
GLITCHTIP_SECRET_KEY=$(openssl rand -hex 32)
GLITCHTIP_DB_PASSWORD=$(openssl rand -hex 24)
EOF
chmod 600 .env
```

How it works: `<<EOF … EOF` (a *here-document*) feeds the lines between the
markers to `cat`, which writes them into `.env`. Because `EOF` isn't quoted,
the shell first replaces each `$(openssl rand -hex N)` with that command's
output, so every secret is generated once, separately, and never typed or
copied (copying one output into two fields was a real risk with the old
hand-edited version). `chmod 600`: only `stride` can read the file.

What each group is for:

- **`db` and `storage`, not `localhost`.** In production the app is a
  container too, and reaches the others by their Compose service names. The
  easiest mistake in this whole guide.
- **`STORAGE_PUBLIC_URL`** is required in production: without it every photo
  link would name `storage:9000`, which no browser can reach, so the app
  refuses to start.
- **`RUSTFS_ACCESS_KEY`: 16 characters** (`-hex 8`). A 32-character key broke
  the RustFS console's sign-in on the first deployment; 16 worked. (Observed,
  not found in RustFS's documentation.)
- **`NODE_ENV=production`**, exactly. It makes the session cookie `Secure`,
  turns the logs into raw JSON, and switches on the production-only refusals
  (`EMAIL_TRANSPORT=log`, `RATE_LIMITS=off`).
- **`TRUST_PROXY_HOPS=2`**: Cloudflare, then Caddy. Express needs it to see
  that the visitor's request was HTTPS, and the app trusts Cloudflare's
  `CF-Connecting-IP` for the visitor's address
  ([journal 19](journal/19-deployment-verification-and-observability.md)).
- **`GLITCHTIP_SECRET_KEY` and `GLITCHTIP_DB_PASSWORD` now**, though GlitchTip
  starts in Phase 10: Compose checks every required variable in the file for
  every command, so without them even `docker compose … up -d db` stops with
  `required variable GLITCHTIP_SECRET_KEY is missing a value`.
- **`EMAIL_FROM`**: an address on the domain Resend verifies in Phase 9.

Using another domain than `stridecare.app`: change it here, in the
[`Caddyfile`](../Caddyfile)'s two site names, and in
[`scripts/test-websocket-production.js`](../scripts/test-websocket-production.js)
(Phase 7).

### Phase 4 — Postgres and RustFS

```bash
docker compose -f docker-compose.prod.yml up -d db storage
```

**Verify:** `docker compose -f docker-compose.prod.yml ps` shows both
running, and `docker compose -f docker-compose.prod.yml logs storage` shows
RustFS started without errors.

### Phase 5 — Migrations, the app's role, the exercise library

```bash
docker compose -f docker-compose.prod.yml build migrate create-app-role seed
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml run --rm create-app-role
docker compose -f docker-compose.prod.yml run --rm seed
```

- **These are one-off jobs** (`profiles: ["tools"]`): `up` never starts them.
  They're built from the image's `builder` stage, which has `drizzle-kit` and
  `ts-node`; the runtime image has neither.
- **`build` first, always.** `run` builds an image only the first time; after
  that it silently reuses the old one, so after a `git pull` it would run
  yesterday's code ([journal 26](journal/26-redeploying-for-real.md)).
- **Migrations before the role.** `create-app-role` grants `stride_app`
  access to every table that exists when it runs, and sets default
  privileges for tables created later. Running it after the migrations means
  the explicit grants cover every table at once.
- **`seed`** imports the exercise library (873 exercises and their photos,
  from GitHub). It skips exercises it already has, so it's safe to re-run. A
  real clinic may skip it; **the demo needs it** before its first reset
  (Part 3), or the seeded templates that use library exercises are left out.

**Verify** that the app's role can't bypass the policies:

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -d stride -Atc \
  "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'stride_app'"
```

→ `stride_app|f|f`: not a superuser, and no `BYPASSRLS`. Either `t` would
switch Row-Level Security off for every query the app makes.

### Phase 6 — The app and Caddy

```bash
docker compose -f docker-compose.prod.yml up -d --build app caddy
```

Caddy asks Let's Encrypt for two certificates, `api.stridecare.app` and
`files.stridecare.app`, as soon as it starts. That needs Phase 2's records
live and port 80 reachable, which it is: the firewall is still open.

**Verify**, from your own machine:

```bash
curl -sI https://api.stridecare.app/health | head -1     # HTTP/2 200
curl -sI https://files.stridecare.app/ | head -1         # HTTP/2 404
```

The `404` is Caddy's: `files.` only passes `GET`s inside the `stride` bucket,
and answers everything else itself. A `526` from either means Caddy has no
certificate yet: `docker compose -f docker-compose.prod.yml logs caddy` shows
the ACME attempt (a failed challenge is the likeliest first-deploy problem).

### Phase 7 — Verify the whole chain, not just that it's up

A green health check says the app started. These checks say the chain
(Cloudflare, Caddy, the app's proxy settings, the cookie, the database
roles) behaves as designed. Running them is how the first deployment found
its most important bugs ([journal
19](journal/19-deployment-verification-and-observability.md)).

**Run them from your own machine**, as any visitor would, unless a step says
"on the Droplet". (The Droplet has no Node and needs none: production has
nothing but Docker on the host.)

```bash
API=https://api.stridecare.app
J='Content-Type: application/json'
```

- [ ] **Stride isn't set up yet:**
  ```bash
  curl -s $API/auth/setup-status
  ```
  → `{"setupComplete":false,"demo":null}`: no admin exists, so the one-time
  setup route is open.

- [ ] **Register the clinic and its first admin — and read the cookie.**
  There is no sign-up in Stride: this route creates the one account everyone
  else is invited by.
  ```bash
  curl -si -c admin.txt -X POST $API/auth/register-clinic -H "$J" -d '{
    "clinicName": "Riverside Physiotherapy",
    "clinicEmail": "hello@riverside.example",
    "email": "admin@riverside.example",
    "password": "correct-horse-battery",
    "firstName": "Ada",
    "lastName": "Admin"
  }' | grep -iE '^HTTP|^set-cookie'
  ```
  - **For a real clinic, this is its real admin**: use the clinic's names,
    an address that receives email (Phase 9 sends a reset link to it) and a
    real password. Nothing here needs undoing afterwards.
  - **For the demo**, any values: Part 3's reset deletes this account.

  → `201`, and a cookie line ending `HttpOnly; Secure; SameSite=Lax`. No
  `Set-Cookie` line at all means the app didn't see the request as HTTPS, so
  it wouldn't set a `Secure` cookie: check `TRUST_PROXY_HOPS=2` and
  `NODE_ENV=production`. (Why `Lax` is enough: the frontend and the API are
  one *site*, `stridecare.app`; see
  [`session-cookie.ts`](../src/config/session-cookie.ts).)

- [ ] **The setup route is closed now:**
  ```bash
  curl -s $API/auth/setup-status
  curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/auth/register-clinic -H "$J" -d '{
    "clinicName": "X", "clinicEmail": "x@x.example", "email": "y@x.example",
    "password": "correct-horse-battery", "firstName": "A", "lastName": "B" }'
  ```
  → `{"setupComplete":true,…}`, then `403` ("An administrator account already
  exists…").

- [ ] **The session works:**
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -b admin.txt $API/auth/me
  ```
  → `200`.

- [ ] **Roles are enforced, not just sign-in.** Creating an exercise is a
  practitioner's action; the admin is refused:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -b admin.txt -X POST $API/exercises \
    -H "$J" -d '{"name": "Should be refused", "primaryMuscles": ["abdominals"]}'
  ```
  → `403`.

- [ ] **CORS trusts the frontend, and only it:**
  ```bash
  curl -s -o /dev/null -D - -H "Origin: https://stridecare.app" $API/health | grep -i '^access-control-allow'
  curl -s -o /dev/null -D - -H "Origin: https://stride.pages.dev" $API/health | grep -i '^access-control-allow-origin'
  ```
  → `Access-Control-Allow-Origin: https://stridecare.app` and
  `Access-Control-Allow-Credentials: true` for the first; **nothing** for the
  second: a browser on any other origin can't read the API's answers.

- [ ] **The app queries as `stride_app`.** On the Droplet, straight after a
  request (pg closes an idle connection after 10 seconds):
  ```bash
  curl -s https://api.stridecare.app/health > /dev/null && \
  docker compose -f docker-compose.prod.yml exec -T db psql -U postgres -d stride -Atc \
    "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = 'stride' AND usename IS NOT NULL ORDER BY 1"
  docker compose -f docker-compose.prod.yml exec -T db psql -U postgres -d stride -Atc \
    "SELECT count(*) FROM pg_policies"
  ```
  → `postgres` (the session store's pool, and this `psql`) and `stride_app`
  (every query of the app); then the number of policies, 113 on the schema of
  2026-11-03. Zero would mean the migrations didn't run.

- [ ] **The messaging socket, through the real chain** (Cloudflare, Caddy,
  the session cookie). From a local clone of this repository with `npm ci`
  done (the script uses `socket.io-client`):
  ```bash
  COOKIE=$(grep connect.sid admin.txt | awk '{print $6"="$7}')
  node scripts/test-websocket-production.js "$COOKIE"
  ```
  → `PASSED: WebSocket connected through the real chain`.

- [ ] **The app sees the visitor's real address.** It matters for the rate
  limits, which count per address: if the app saw Cloudflare's or Caddy's
  address instead, every visitor would share one counter. The app's logs
  can't show it (since Phase 7 they hold no IP address, [journal
  41](journal/41-observability-without-patient-data.md)), so check the two
  ends:
  1. **Cloudflare sends it.** On the Droplet, after any request from your
     machine:
     ```bash
     docker compose -f docker-compose.prod.yml logs --since 1m caddy \
       | grep -o '"Cf-Connecting-Ip":\["[^"]*"\]' | tail -1
     ```
     → your own public address (Cloudflare's
     `https://www.cloudflare.com/cdn-cgi/trace` shows it as `ip=`).
  2. **The app counts per visitor.** Six failed sign-ins in a row from your
     machine, then one from the Droplet:
     ```bash
     for i in 1 2 3 4 5 6; do
       curl -s -o /dev/null -w '%{http_code} ' -X POST $API/auth/login -H "$J" \
         -d '{"email": "nobody@example.com", "password": "wrong-password"}'
     done; echo
     ```
     → `401 401 401 401 401 429`: sign-in allows 5 attempts a minute per
     address. Then, within that minute, the same request **on the Droplet**
     (its own address, through Cloudflare) → `401`, not `429`.

- [ ] **Nothing to clean up.** The real clinic keeps its admin. The demo's
  reset (Part 3) deletes every account, this one included.

### Phase 8 — Close the firewall around Cloudflare

Now that Caddy has its certificates: restrict the Cloud Firewall's inbound
80 and 443 rules to Cloudflare's published ranges, fetched fresh from
https://www.cloudflare.com/ips/ (the list changes from time to time). The
certificates still renew: Let's Encrypt's checks reach the Droplet through
Cloudflare, like any request to the two names.

**Verify from your own machine**, against the Droplet's own address:

```bash
DROPLET_IP=<droplet-ip>
curl -m 5 -I http://$DROPLET_IP/health
curl -m 5 -I -k https://$DROPLET_IP/health
curl -sI https://api.stridecare.app/health | head -1
```

The first two must **fail to connect** (a timeout, not any HTTP answer;
`-m 5` stops waiting after 5 seconds). The third still answers `200`,
through Cloudflare.

If the direct requests get an answer, don't trust the dashboard: watch what
reaches the Droplet, then repeat them.

```bash
sudo tcpdump -i eth0 port 80 or port 443   # on the Droplet
```

Cloud Firewalls filter before the Droplet, so a blocked request never shows
up in the capture. Seeing it arrive means the rule isn't applied. (A VPN on
your side can fake either answer: [journal
19](journal/19-deployment-verification-and-observability.md).)

### Phase 9 — Email through Resend

Invitations and password resets are real emails. Resend's shared sender
(`onboarding@resend.dev`) only delivers to the Resend account's own address,
so the app needs a domain of its own ([journal
17](journal/17-real-email-and-mfa-encryption.md)).

1. **Resend → Domains → Add domain** (`stridecare.app`), then add the DNS
   records Resend lists (SPF and DKIM; DMARC recommended) in Cloudflare, as
   **DNS only** (grey cloud): they're for mail servers, not visitors. Wait
   for "Verified".
2. **Resend → API Keys**: a key with sending access. On the Droplet, replace
   `re_REPLACE_ME` in `.env` (`nano .env`), and check `EMAIL_FROM` is an
   address on the verified domain.
3. Restart the app with the new values:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --force-recreate app
   ```

**Verify:** ask for a password reset for Phase 7's admin (a real clinic's;
the demo's `@riverside.example` address can't receive mail):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/auth/forgot-password \
  -H "$J" -d '{"email": "<the admin address>"}'
```

→ `204`, and an email arrives with a link to
`https://stridecare.app/reset-password?token=…`. The answer is `204` for any
address, known or not, so only the email proves delivery.

Addresses that can never exist are never sent to: `@stride.test` (the seed's),
`@example.com` and the other names reserved by RFC 2606 are refused before
Resend is asked ([`reserved-domains.ts`](../src/email/reserved-domains.ts)).
They would only bounce, and bounces lower the domain's reputation.

### Phase 10 — Error tracking (GlitchTip)

GlitchTip receives the backend's error reports and, through the API's
`POST /monitoring`, the browser's (decisions §32). Nothing of it is on the
internet: the app reaches it as `glitchtip:8000`, and its web interface is
bound to the Droplet's `127.0.0.1:8000`.

1. **Start it** (its Postgres is a server of its own, so Stride's database
   shares nothing with it):
   ```bash
   docker compose -f docker-compose.prod.yml up -d glitchtip-db glitchtip
   ```
2. **An account.** Nobody can sign up (`ENABLE_USER_REGISTRATION=False`):
   ```bash
   docker compose -f docker-compose.prod.yml exec glitchtip ./manage.py createsuperuser
   ```
3. **Its interface, over an SSH tunnel**, from your machine:
   ```bash
   ssh -L 8000:127.0.0.1:8000 stride@<droplet-ip>
   ```
   then http://localhost:8000. Sign in, create an organization, then two
   projects: **`stride-api`** (the backend) and **`stride-web`** (the
   frontend).
4. **The two DSNs**, from each project's settings, "Client Keys". GlitchTip
   writes them with the host it knows itself by, `localhost:8000`; replace it
   with **`glitchtip:8000`**, the name on the Compose network, then set in
   `.env`:
   ```dotenv
   SENTRY_DSN=http://<stride-api's key>@glitchtip:8000/<its id>
   SENTRY_BROWSER_DSN=http://<stride-web's key>@glitchtip:8000/<its id>
   ```
   ```bash
   docker compose -f docker-compose.prod.yml up -d --force-recreate app
   ```
5. **The frontend's build gets the browser DSN too**, as `VITE_SENTRY_DSN`,
   character for character the same string, host included: the API forwards
   only envelopes for exactly that DSN
   ([the frontend's guide](https://github.com/julienjave/Stride-frontend/blob/main/docs/DEPLOYMENT.md#2-the-build-and-its-settings)).
   The browser never contacts `glitchtip:8000`; it sends to `/monitoring`.

Optional: `SENTRY_RELEASE` (the deployed commit, `git rev-parse --short
HEAD`) labels each report with its code. GlitchTip's alert emails go to its
log until `GLITCHTIP_EMAIL_URL` is set to an SMTP URL.

**Verify** that the browser's route is on:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/monitoring
```

→ `415` ("The body must be a Sentry envelope"): the route exists and checks
what it's given. `404` ("Error reporting is not set up on this server")
means `SENTRY_BROWSER_DSN` didn't reach the app. A real report: the
frontend's guide raises one from the browser.

### Phase 11 — Backups

[`scripts/backup-database.sh`](../scripts/backup-database.sh) dumps the
database, compresses it, uploads it to RustFS's `backups` bucket (creating it
on the first run) and keeps the last 14. RustFS is on the same Droplet: this
protects against mistakes (a bad migration, a wrong command), not against
losing the Droplet.

Run it once by hand, on the Droplet:

```bash
chmod +x scripts/backup-database.sh
./scripts/backup-database.sh
```

Then schedule it (`crontab -e`, and this line in the editor, not in the
shell):

```
0 3 * * * /home/stride/Stride-backend/scripts/backup-database.sh >> /home/stride/backup.log 2>&1
```

(03:00 on the Droplet's clock, which is UTC.)

**Verify by restoring**, not by a clean exit: a backup never restored is an
assumption ([journal 18](journal/18-deployment-provisioning-through-backups.md)).

```bash
# The script's own way of reading .env: grep the line, cut the value, strip a
# trailing "# comment". Not `source .env`: that would run the file as shell
# code, and EMAIL_FROM's "<…>" breaks it (journal 35).
env_var() {
  grep -E "^$1=" .env | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'
}
export AWS_ACCESS_KEY_ID="$(env_var RUSTFS_ACCESS_KEY)"
export AWS_SECRET_ACCESS_KEY="$(env_var RUSTFS_SECRET_KEY)"
STORAGE_PORT=$(env_var STORAGE_PORT)

aws --endpoint-url "http://localhost:${STORAGE_PORT}" s3 ls s3://backups/
```

([journal 35](journal/35-backup-bucket-and-credential-parsing.md) is the bug
behind that `env_var`.) Restore the newest file into a separate, throwaway
database, never into `stride`:

```bash
BACKUP_FILE=<a file name from the list>
aws --endpoint-url "http://localhost:${STORAGE_PORT}" s3 cp \
  "s3://backups/${BACKUP_FILE}" "/tmp/${BACKUP_FILE}"

docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -c "CREATE DATABASE restore_verify;"
gunzip -c "/tmp/${BACKUP_FILE}" | docker compose -f docker-compose.prod.yml \
  exec -T db psql -U postgres -d restore_verify

docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -d restore_verify -c "SELECT count(*) FROM exercises;"
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -d restore_verify -c "SELECT count(*) FROM users;"
```

The counts must be the ones you expect (873 exercises when seeded; the
accounts that exist). Then clean up:

```bash
rm "/tmp/${BACKUP_FILE}"
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U postgres -c "DROP DATABASE restore_verify;"
```

The RustFS console, to browse the buckets: `ssh -L 9101:localhost:9001
stride@<droplet-ip>`, then http://localhost:9101.

### Phase 12 — Uptime and logs (Better Stack)

**Uptime monitors**, watching from outside (the only place that sees the
Droplet down): `https://api.stridecare.app/health`, expecting `200`, and
`https://stridecare.app/`. Monitors that target the names, not the IP,
survive a recreated Droplet unchanged.

**Logs**: Better Stack's Docker-specific Vector agent. Not the full eBPF
collector, which failed outright on a 1 vCPU Droplet ([journal
19](journal/19-deployment-verification-and-observability.md)):

```bash
curl -sSL https://telemetry.betterstack.com/setup-vector/docker/<your source token> \
  -o /tmp/setup-vector.sh && bash /tmp/setup-vector.sh
sudo usermod -aG docker vector     # Vector's own user must reach Docker's socket
sudo systemctl restart vector
```

**Verify:** Live Tail shows lines from the running containers (`caddy`,
`app`, `db`, `storage`, `glitchtip`, `glitchtip-db`). Live Tail can lag by
some seconds; wait before concluding it's broken. What the lines may contain
is decided in the app: no email address, no IP address, no query string
([journal 41](journal/41-observability-without-patient-data.md)).

**Graceful shutdown:**

```bash
time docker compose -f docker-compose.prod.yml stop app
docker compose -f docker-compose.prod.yml start app
```

The `stop` should finish well under Docker's 10-second limit; taking the full
10 seconds means the app ignored the signal (`enableShutdownHooks()`).
`start` brings it back: `stop` alone leaves the site down.

### Phase 13 — A clean start (optional, a real clinic only)

If the checks left data you don't want (accounts or records created while
trying the site), the only clean way out is to start the data again. No
route deletes a user for good (`DELETE /users/:id` deactivates), and the
audit log's `RESTRICT` keys refuse an SQL delete of an account it mentions,
by design.

```bash
docker compose -f docker-compose.prod.yml down -v
```

**Deleted:** the six named volumes: `pgdata` (the database, and the
`stride_app` role, which lives inside it), `rustfs_data` (photos and
backups), `caddy_data` and `caddy_config` (the certificates),
`glitchtip_pgdata` and `glitchtip_uploads` (GlitchTip's account, projects and
reports, so its DSNs will be new). **Kept:** the Droplet, DNS, the clone and
`.env`, the firewall, the crontab, Vector.

To bring it back: Phases 4 to 7 and 10 again, with the real admin this time,
then one backup by hand and its restore check (Phase 11). The demo doesn't need this:
its reset deletes everything but the exercise library every night.

---

## Part 3 — The reviewers' demo (`DEMO_MODE=on`)

How the deployed demo differs from a real clinic's, and how to run it
(decisions §46). Everything hangs on one setting, `DEMO_MODE=on`. A real
clinic leaves it out: no card, no locks, and the seed refuses to run in
production.

### What demo mode does

- **The sign-in page shows a "For reviewers" card**: four shared accounts
  (`admin@`, `alex@`, `pat@`, `casey@stride.test`), their password, Casey's
  two-factor key, when the data is reset, and a link to the accounts guide
  ([`demo-accounts.md`](demo-accounts.md)).
- **Those four accounts are locked** against the changes that would lock
  other reviewers out: their password, email address and two-factor sign-in
  can't be changed, and they can't be deactivated or merged away (`403`,
  with a sentence saying why). Everything else works. Reviewers who want to
  try the locked features invite themselves as a new user.
- **The data is reset every night**, and after each deploy: every account
  and everything they did. The exercise library is kept.

### Settings

Added to Phase 3's `.env` (Phase 9's email is needed too: "invite yourself"
sends a real invitation):

```dotenv
DEMO_MODE=on
DEMO_RESET_TIME=04:00
DEMO_RESET_TIME_ZONE=America/Toronto
DEMO_GUIDE_URL=https://github.com/julienjave/Stride-backend/blob/main/docs/demo-accounts.md
```

- **`DEMO_RESET_TIME` / `DEMO_RESET_TIME_ZONE`** tell the card when the reset
  runs; it shows that moment in each reviewer's own time ("every night at
  1:00 AM your time"). Both or neither. They must match the timer
  (`OnCalendar=*-*-* 04:00:00 America/Toronto`): the card only reports, the
  timer decides.
- **`DEMO_GUIDE_URL`**: the accounts guide on GitHub, the address above. It
  must start with `https://`, or the app refuses to start. It needs the
  backend repository to be public (it is): on a private one, the card's link
  would lead reviewers to GitHub's 404 page.
- `DEMO_MODE` accepts `on` or `off` only: a typo (`true`, `yes`) stops the
  app rather than meaning either.

Then `docker compose -f docker-compose.prod.yml up -d --force-recreate app`.

### The first reset

After Phase 5's `seed` (the exercise library first: the demo's templates use
it):

```bash
sh scripts/ops/demo-reset.sh
```

[`scripts/ops/demo-reset.sh`](../scripts/ops/demo-reset.sh) checks `.env`
says `DEMO_MODE=on`, **stops the app**, runs the `demo-reset` job, and
**starts the app again, always**, even if the reset failed (a shell `trap`).
The job:

1. **`seed-dev.ts --reset`**: deletes every row except the exercise library,
   in **one transaction** (if anything fails, nothing is deleted and the app
   comes back on yesterday's data), then creates the demo world again. Every
   signed-in reviewer is signed out: sessions are rows too.
2. **`storage-sweep.ts --delete`**: deletes the stored files no row uses any
   more (the deleted accounts' avatars and photos). Files younger than 24
   hours are left alone, so a day's files go the night after.

Why the app is stopped rather than reset under it: a browser's live
messaging connection was authenticated once, when it opened, and would stay
open on an account that no longer exists; and the app's new-message sweep
(every minute) could meet the reset halfway. Stopped, neither can happen.
The site answers an error for the minute or so it takes.

Through `sh`, so the script needs no executable bit, which a commit from
Windows can't carry. [`.gitattributes`](../.gitattributes) keeps it and the
systemd units in LF line endings: with CRLF, Linux's shell refuses the
script.

**Verify:**

```bash
curl -s $API/auth/setup-status | jq '{accounts: [.demo.accounts[].email], reset: .demo.reset}'
```

→ the four `@stride.test` accounts and `{"time": "04:00", "timeZone":
"America/Toronto"}`. Phase 7's admin can no longer sign in. Signed in as
`admin@stride.test`, `POST /auth/password` answers `403` ("This is one of the
demo's shared accounts, so its password can't be changed…").

### The nightly timer

```bash
sed 's#/opt/stride#/home/stride/Stride-backend#' scripts/ops/stride-demo-reset.service \
  | sudo tee /etc/systemd/system/stride-demo-reset.service > /dev/null
sudo cp scripts/ops/stride-demo-reset.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now stride-demo-reset.timer
systemctl list-timers stride-demo-reset.timer   # the next run
journalctl -u stride-demo-reset.service         # what the last runs printed
```

The unit in the repository runs `/opt/stride/scripts/ops/demo-reset.sh`; the
`sed` writes the installed copy with this guide's folder instead, and leaves
the repository's file untouched (so `git pull` stays clean).

- **A systemd timer, not a crontab line:** the Droplet's clock is UTC, and
  Ubuntu's cron has no time zone per line, so "04:00 Eastern" would move by
  an hour twice a year. `OnCalendar=… America/Toronto` follows Eastern time's
  clock changes. `Persistent=true` runs a missed night once the Droplet is
  back.
- **Why 04:00 Eastern:** the reviewers are in North America, and the reset
  signs everyone out and deletes what they did. 4 a.m. Eastern is the
  quietest hour across the continent: 1 a.m. in Vancouver, 5:30 a.m. in
  St. John's (10:00 in Paris). The backup (03:00 UTC: 22:00 or 23:00 in
  Toronto) never meets it.
- **Accounts reviewers create are deleted too.** An account a reviewer
  invited themselves to is gone the next morning (they invite themselves
  again). On purpose: those addresses are real people's, and the demo keeps
  them less than a day; and their data is woven into the seeded accounts'
  (Pat's care team, Alex's messages), so keeping some accounts while
  recreating others would leave broken links. The card says so.

### After each deploy

```bash
sh scripts/ops/demo-reset.sh
```

after Part 4's redeploy steps. A deploy can change what the seed creates;
resetting straight after means the demo always shows the data of the version
that runs.

### Known limits

- **Casey's recovery codes are single-use.** Reviewers who sign in with them
  use them up until the next reset; the key on the card, added to an
  authenticator app, always works.
- **A two-factor code works once.** Two reviewers signing in as Casey within
  the same 30 seconds: the second waits for the next code.
- **Reviewers see each other's data.** The card says not to enter real
  personal information; the nightly reset removes whatever was typed.

---

## Part 4 — Common operations

**Redeploying after a code change:**

```bash
cd /home/stride/Stride-backend
git pull
docker compose -f docker-compose.prod.yml --profile tools build
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d app
sh scripts/ops/demo-reset.sh        # the demo only
```

`--profile tools build` rebuilds all five images from the pulled code: `app`
and the four one-off jobs. **Without `--profile tools`, `build` builds `app`
only**: a service behind a profile is left out unless its profile is active
or it's named (checked with `--dry-run`, Compose 5.6). Never skip the build:
`run` and `up` reuse an existing image, however old, which is how a stale
`migrate` image cost a day in [journal
26](journal/26-redeploying-for-real.md). `migrate` is harmless when there's
no new migration.

**Changing `.env`:** `docker compose -f docker-compose.prod.yml up -d
--force-recreate app` (or the service the value belongs to). Rotating
`POSTGRES_APP_PASSWORD`: run `create-app-role` first, which sets the role's
new password, then recreate the app; the other way round, the app can't sign
in to Postgres.

**Restoring a backup:** as in Phase 11's check, always into a throwaway
database first. Restoring over `stride` itself is a decision of its own: stop
the app, then restore.

**Pinned images, and updating one.** `caddy:2`, `postgres:16`,
`postgres:18` and `glitchtip/glitchtip:6` are tags their owners move, so
`docker-compose.prod.yml` names each as `name:tag@sha256:…`, like RustFS
(since 2026-11-04): Docker pulls by the digest, so what runs is exactly what
was tested, and the tag only tells a reader the version. To move one to a
newer release, pull it, read its digest, and write it in the file, in a
commit:

```bash
docker pull caddy:2
docker image inspect --format '{{index .RepoDigests 0}}' caddy:2
```

Then `git pull` on the Droplet and `docker compose -f docker-compose.prod.yml
up -d`. **Changing an `image:` line recreates that container**, even when the
digest is the one already running: Compose compares each service's whole
configuration, not only its image. When the pins were committed, `db`,
`glitchtip-db`, `glitchtip` and `caddy` restarted, a few seconds each; a
restart of `db` drops the app's connections, and its pool opens new ones.

**Starting the data again:** Phase 13.

**The repositories are public**, so `DEMO_GUIDE_URL` is set (Part 3), this
guide's GitHub links open for everyone, and CI runs on GitHub
([`PROJECT.md`](PROJECT.md#deployment-infrastructure)): `.github/` was
listed in `.gitignore` while they were private, and was committed when they
went public (decisions §38).

---

## Appendix — Environment variables

Read by the app (and its scripts) unless marked *Compose*: those are read by
`docker compose` itself. "Refused" means the app stops at start with a
message naming the variable.

| Variable | Production | Rules (from the code) |
|---|---|---|
| `NODE_ENV` | `production` | Exactly that string: `Secure` cookie, JSON logs, the production-only refusals below |
| `PORT` | unset | The app's port; default `3000` (Caddy proxies to `app:3000`) |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `db` / `5432` | Defaults `localhost` / `5432` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `postgres` / generated / `stride` | Required. The owner: migrations, the session store, `create-app-role`. *Compose* requires `POSTGRES_PASSWORD` too |
| `POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD` | `stride_app` / generated | Required (refused if missing). The role every query of the app uses |
| `DATABASE_POOL_MAX` / `SESSION_POOL_MAX` | unset | Pool sizes; defaults 10 and 5 |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | unset | Wait for a free connection; default 5000 |
| `STORAGE_ENDPOINT` / `STORAGE_PORT` | `storage` / `9000` | The internal S3 address; defaults `localhost` / `9000` |
| `STORAGE_PUBLIC_URL` | `https://files.stridecare.app` | The address links are signed for. Required in production (refused if missing); an origin only (no path, query or credentials); `https://` in production |
| `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` | generated (`-hex 8` / `-hex 24`) | The app's and the backup's S3 credentials. *Compose* requires both (RustFS's own) |
| `SESSION_SECRET` | generated (`-hex 32`) | Required; the `.env.example` placeholder is refused |
| `MFA_ENCRYPTION_KEY` | generated (`-hex 32`) | Required; exactly 64 hex characters (AES-256) |
| `FRONTEND_URL` | `https://stridecare.app` | The base of the links in emails (reset, invitation, email change) |
| `FRONTEND_URLS` | `https://stridecare.app` | Comma-separated: the origins CORS and the socket accept; default `http://localhost:5173` |
| `TRUST_PROXY_HOPS` | `2` | Proxies in front of the app; default 1 |
| `RATE_LIMITS` | unset (`on`) | `on` or `off`; `off` (the e2e tests') refused in production |
| `EMAIL_TRANSPORT` | `resend` | Required: `resend`, `smtp` or `log`; `log` refused in production (its output holds live links) |
| `RESEND_API_KEY` | Resend's key | Required when the transport is `resend` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | unset | The `smtp` transport only (Mailpit locally); host and port required there, user and password together or neither |
| `EMAIL_FROM` | `Stride <noreply@stridecare.app>` | The sender; on the verified domain |
| `SENTRY_DSN` | `stride-api`'s DSN, host `glitchtip:8000` | Unset or empty = no backend reports; a malformed DSN is refused |
| `SENTRY_BROWSER_DSN` | `stride-web`'s DSN, host `glitchtip:8000` | Unset = `POST /monitoring` answers 404; must equal the frontend's `VITE_SENTRY_DSN` |
| `SENTRY_ENVIRONMENT` | unset | A label on each report; defaults to `NODE_ENV` |
| `SENTRY_RELEASE` | optional | The deployed commit, shown on each report |
| `DEMO_MODE` | `on` for the demo only | `on` or `off` (default); anything else refused |
| `DEMO_RESET_TIME` / `DEMO_RESET_TIME_ZONE` | `04:00` / `America/Toronto` | Both or neither; `HH:MM` and an IANA zone; must match the timer |
| `DEMO_GUIDE_URL` | Part 3's address | `https://` only, refused otherwise |
| `GLITCHTIP_SECRET_KEY` / `GLITCHTIP_DB_PASSWORD` | generated | *Compose*, required for every command |
| `GLITCHTIP_EMAIL_URL` / `GLITCHTIP_FROM_EMAIL` | optional | *Compose*: GlitchTip's alert emails (unset: its log) |
