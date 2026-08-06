# Standing up the deployment: provisioning through backups

This document covers Phases 1 through 4 of the deployment roadmap — the
Droplet, the domain and Cloudflare architecture, Docker actually reaching
production for the first time, and a genuinely tested backup strategy.

## Provisioning, verified rather than assumed

Ubuntu 24.04 LTS was confirmed as the correct current choice specifically by
checking what DigitalOcean's own Droplet images actually offer — Ubuntu
26.04 LTS had already been released upstream by this point, but multiple
current sources confirmed DigitalOcean hadn't rolled it out to Droplet
images yet. A real, concrete example of why "newer exists" and "newer is
selectable in this specific dashboard" are different questions worth
checking separately.

Hardening followed DigitalOcean's own documented recommended pattern
(independently confirmed via search, not just assumed correct): SSH
key-only auth for a non-root sudo user, root login and password auth both
disabled at the `sshd_config` level, a Cloud Firewall restricting inbound
traffic. A genuine SSH host-key mismatch warning during first connection
was correctly diagnosed as IP address reuse (DigitalOcean recycling a
previously-assigned address) rather than a security concern — the key
judgment articulated explicitly: this kind of warning deserves real
suspicion when it appears for a server you've connected to many times
before with no reason for anything to have changed, not for a genuinely
fresh resource on an address you just watched get assigned.

## A deliberate provisioning strategy, given the actual free-credit situation

The DigitalOcean account predated this project, meaning the standard
$200/60-day credit (confirmed, via direct verification, to start counting
from account creation rather than first resource use) had already expired.
Combined with a separate, real finding — a *stopped* Droplet bills
identically to a running one, since DigitalOcean reserves the underlying
disk and IP regardless of power state — the resulting strategy was:
provision and fully validate the deployment now, while there's no deadline
pressure, then destroy the Droplet and recreate it later once the frontend
is actually ready. A dedicated recreation runbook was written specifically
to make that later recreation fast and low-risk, distilled from actually
walking through provisioning once rather than reconstructed from the more
general roadmap.

## The domain: a real requirement for the backend specifically, not a general one

A genuine misunderstanding surfaced and was corrected directly: Cloudflare
Pages needs no custom domain at all (a free `*.pages.dev` subdomain is
fully functional), but the Droplet side of this deployment genuinely does
— for two structural reasons, neither a preference. Public certificate
authorities like Let's Encrypt only issue certificates for domain names,
never raw IPs, and Cloudflare's proxy mechanism is fundamentally
DNS-based, requiring authoritative control over an actual domain to
function at all. `stridecare.app` was purchased directly through
Cloudflare (avoiding a separate nameserver handoff step entirely, since a
domain registered there is already using Cloudflare's nameservers from
the moment of purchase) — with the API on `api.stridecare.app` and the
apex domain deliberately reserved for the eventual frontend, mirroring the
same split real products like Stripe use between their marketing site and
API subdomain.

Cloudflare's SSL/TLS mode was set to Full (strict) specifically, with the
distinction from plain "Full" understood precisely: both encrypt the
Cloudflare-to-origin leg, but only "strict" verifies the origin's
certificate is genuinely valid rather than accepting anything — the
difference between defense against a compromised network path and merely
encrypting to whoever happens to answer.

## Docker reaching real production for the first time — one real, previously invisible bug surfaced immediately

The first live deployment attempt failed with a database error tracing
directly back to migrations never having been run against the fresh,
empty production database — expected, and resolved by running them the
first time via an ad hoc container built from the Dockerfile's `builder`
stage (the lean runtime image deliberately lacks `drizzle-kit` and the
migrations folder). That ad hoc approach was immediately recognized as a
real gap for anyone else deploying this project and replaced with a
proper, self-documenting solution: a dedicated `migrate` service inside
`docker-compose.prod.yml` itself, gated with Compose's `profiles` feature
so it never runs automatically with a plain `up`, discoverable by anyone
reading the one file everyone already looks at rather than requiring
separate, easy-to-lose instructions.

## The backup script: two real bugs found by actually running it, not by review

`source .env` — the initial approach for pulling RustFS credentials into
the backup script — broke immediately, and for a genuinely instructive
reason: a `.env` file is only guaranteed to be safe, simple key-value text
for tools with their own lightweight parser (Node's `dotenv`, Docker
Compose's `env_file:`). Bash's `source` genuinely *executes* the file as a
script, where unquoted spaces and characters like `<`/`>` carry real shell
meaning — and `EMAIL_FROM`'s value (`Stride Care <noreply@...>`) broke
exactly this way. The fix extracted only the specific values actually
needed via `grep`/`cut`, avoiding the whole class of problem rather than
trying to make `.env` "safe for bash" in a way that could behave
inconsistently across its other consumers. A second, related bug was
caught in the same pass: the extracted RustFS credentials were never
actually exported under the names the AWS CLI itself expects
(`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), meaning every `aws s3` call
would have failed on authentication regardless of the first fix.

A separate, cross-platform friction point emerged getting the fix onto the
Droplet: git blocking a pull over a mode-only change (the executable bit,
set via `chmod +x` on the Droplet but never committed, conflicting with
incoming content from a Windows-based commit). Resolved properly rather
than patched per-occurrence — `git config core.fileMode false` stops git
from tracking that bit as a meaningful change at all, closing the whole
class of recurring conflict rather than repeatedly working around single
instances of it.

## A backup that's actually been restored, not just assumed to work

The real test deliberately mirrored a genuine disaster-recovery path —
pulling the backup back down from RustFS rather than reading a file still
conveniently sitting on local disk — restored into a throwaway database,
and verified with real row counts rather than merely "no errors occurred
during restore": `1` user, `873` exercises, matching the actual seeded
library exactly. The specific principle this was built around: a backup
that has never been restored is really just an assumption, and the
counted verification is what actually converts that assumption into
tested fact.
