# Verifying it for real: production checks and observability

This document covers Phases 5 and 6 — proving the deployed system actually
behaves correctly under real conditions, rather than assuming configuration
correctness implies runtime correctness, plus the observability tooling
built on top of it.

## The Cloudflare IP-restriction firewall: a real diagnostic chain, not a single fix

Restricting the Droplet's firewall to Cloudflare's published IP ranges
(closing the direct-IP bypass deliberately deferred until Caddy existed)
appeared to fail — a direct request to the Droplet's raw IP still
succeeded, even after every dashboard-level check came back correct: exact
range list verified character-for-character, no leftover permissive
rules, no second firewall applied, correct Droplet. Rather than continue
guessing at configuration, the investigation moved to DigitalOcean's own
documented diagnostic technique — a `tcpdump` capture on the Droplet
itself, since Cloud Firewalls filter at the hypervisor level and blocked
traffic simply never appears in a capture taken on the box. The capture
showed only legitimate, already-proxied Cloudflare-range traffic — direct,
authoritative proof the firewall was correct all along. The actual
explanation for the misleading test result turned out to be local: NordVPN
altering how the test itself reached the network stack, confirmed by
disconnecting it and rerunning the exact same test with the expected
result. The greater value here was the diagnostic discipline itself —
testing each hypothesis against real evidence in sequence (DNS confusion,
leftover default rules, a second firewall, a typo, finally the VPN) rather
than accepting any single explanation without verifying it directly.

## The real finding of this phase: `X-Forwarded-For` doesn't behave as documented, in this specific chain

Verifying that rate limiting and audit logging see genuine visitor IPs
(rather than Cloudflare's own edge IP) started as a routine check and
surfaced a genuine, previously invisible bug. Generic documentation states
Cloudflare preserves the original client IP as the first entry in
`X-Forwarded-For`. Direct evidence from this project's own captured
production logs showed otherwise: `X-Forwarded-For` arriving at the origin
containing *only* a single Cloudflare edge IP, with the real visitor's
address entirely absent — while `CF-Connecting-IP`, Cloudflare's own
dedicated header, correctly carried it every time. Given this specific,
observed discrepancy in the app's own real chain, the `TRUST_PROXY_HOPS`
configuration alone was not actually resolving to real visitor IPs in
production, meaning rate limiting had been vulnerable to unrelated
visitors sharing the same bucket. The fix — middleware overwriting
`X-Forwarded-For` with `CF-Connecting-IP`'s value before anything
downstream reads `req.ip` — was verified the same way the bug was found:
direct evidence from a subsequent real request showing both headers now
matching exactly, not just trusting the fix should work.

## WebSocket and the full smoke test: real infrastructure, real authorization rules doing their job

A standalone `socket.io-client` script (curl cannot exercise a WebSocket
upgrade) confirmed real-time connections survive the complete chain —
Cloudflare, Caddy, and session-cookie authentication over the handshake —
using a genuine session cookie obtained through the real deployed login
flow. The subsequent full smoke test produced two `403` responses that
were initially worth investigating and turned out to be the *correct*,
intended result rather than bugs: an admin account attempting to create an
exercise (a role deliberately restricted to practitioners only, verified
directly against the controller's actual `@Roles` decorator rather than
assumed), and a practitioner attempting to message a patient with no
shared clinic relationship (the clinic-scoped access model working exactly
as designed once real setup data existed). Both were resolved by
completing the missing realistic setup step (adding both accounts to a
shared clinic) rather than by changing any actual authorization code — a
genuinely stronger smoke test outcome than everything succeeding on the
first attempt, since it directly proved production RBAC enforcement works
correctly under real conditions, not just in the local test suite.

## Observability: choosing and fitting tools to this project's actual constraints

UptimeRobot and Better Stack were compared directly rather than defaulting
to the more famous option — a real, current finding shifted the
recommendation: UptimeRobot's free tier has been restricted to
non-commercial, personal use only since December 2024, while Better Stack
carries no equivalent restriction and additionally bundles log management
alongside uptime monitoring, meaning one account could close two separate
Phase 6 gaps rather than standing up two disconnected tools.

Better Stack's full eBPF-based collector — offered as the default
onboarding path — failed outright on the Droplet's single vCPU, with
Docker refusing a CPU allocation the collector's own bundled config
requested. Rather than patch around the failure by shrinking a resource
limit in a downloaded config file, the mismatch was read as a genuine
signal that the tool itself was oversized for this project's deliberately
lean infrastructure choice, not a value to tune. The resolution switched
to a meaningfully lighter, purpose-built alternative — a standalone Vector
agent doing exactly one job, Docker log collection, with real, verified
documentation behind it, rather than the full multi-feature observability
platform. Once installed, it failed silently at its actual job (reading
zero container logs despite reporting a healthy running service) for a
reason directly traceable to a pattern already encountered earlier this
same evening: a dedicated, restricted system user (`vector`, sensible as a
security default) lacking permission to reach the Docker socket — the same
underlying shape of problem as RustFS's console access needing loopback
binding, recognized and fixed the same way, by adding the user to the
`docker` group.

Graceful shutdown was the final verification, deliberately sequenced after
log shipping was already confirmed working, so the same test served two
purposes at once: `docker stop` completing in a fraction of a second
(rather than the full 10-second grace period before a forced `SIGKILL`)
proved `enableShutdownHooks()` genuinely works, while the container's very
last log lines appearing correctly in Better Stack's Live Tail afterward
proved log shipping captures a service's output right up to the moment it
actually exits — a stronger combined check than either verification could
have been in isolation.
