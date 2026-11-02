# The reviewers' demo deployment

How the deployed demo differs from a real clinic's deployment, and how to run
it (decisions §46). Everything here hangs on ONE setting, `DEMO_MODE=on`. A
real clinic leaves it unset: no card, no locks, and the seed refuses to run.

## What demo mode does

- **The sign-in page shows a "For reviewers" card**: four shared accounts
  (`admin@`, `alex@`, `pat@`, `casey@stride.test`), their password, Casey's
  two-factor key, when the data is reset, and a link to
  [`dev-test-accounts.md`](dev-test-accounts.md).
- **Those four accounts are locked** against the changes that would lock other
  reviewers out: their password, email address and two-factor sign-in can't be
  changed, and they can't be deactivated or merged away (403, with a sentence
  saying why). Everything else works — reviewers who want to try those
  features invite themselves as a new user.
- **The data is reset every night** (and after each deploy) — every account and
  everything they did; the exercise library is kept.

## `.env` (on the droplet)

```dotenv
NODE_ENV=production
DEMO_MODE=on
DEMO_RESET_TIME=04:00
DEMO_RESET_TIME_ZONE=America/Toronto
DEMO_GUIDE_URL=https://github.com/<owner>/stride-backend/blob/main/docs/dev-test-accounts.md
EMAIL_TRANSPORT=resend
RESEND_API_KEY=re_…
EMAIL_FROM=Stride <noreply@your-verified-domain>
```

`DEMO_RESET_TIME` / `DEMO_RESET_TIME_ZONE` tell the card when the reset runs —
it shows that moment in each reviewer's own time ("every night at 1:00 AM your
time"). They must match the timer below (`OnCalendar=… 04:00:00
America/Toronto`): the card only reports, the timer decides. `DEMO_GUIDE_URL` must start with `https://` (the app refuses to
start otherwise); leave it out until the repositories are public.

## Email: a verified domain on Resend

Resend's sandbox sender (`onboarding@resend.dev`) delivers only to the Resend
account's own address, so "invite yourself" needs a domain of your own:
Resend → Domains → Add domain, then add the DNS records it lists (SPF and
DKIM; DMARC recommended) at your domain's registrar, wait for "Verified", and
set `EMAIL_FROM` to an address on that domain.

**Addresses that can never exist are never sent to.** The seeded accounts are
all `@stride.test`, and reviewers may type `@example.com`: those domains are
reserved (RFC 2606) and would only come back as bounces, which lower the
domain's reputation. The app's Resend transport refuses them before asking
Resend (`src/email/reserved-domains.ts`): an invitation to such an address
shows "couldn't be sent"; a notice to a seeded account is skipped (logged).
The reset itself sends nothing.

## First install

After the usual steps (`migrate`, `create-app-role`, `seed` for the exercise
library), create the demo data once:

```sh
sh scripts/ops/demo-reset.sh
```

## The nightly reset

(Run it as `sh scripts/ops/demo-reset.sh` — through `sh`, so it needs no
executable bit, which a commit from Windows can't carry. `.gitattributes`
keeps it, and the systemd units, in LF line endings: with CRLF, Linux's
shell refuses the script.)

`scripts/ops/demo-reset.sh` checks `.env` says `DEMO_MODE=on`, **stops the
app**, runs the `demo-reset` compose job, and **starts the app again — always,
even if the reset failed**. The job:

1. `seed-dev.ts --reset` — deletes every row except the exercise library, in
   ONE transaction (if anything fails, nothing is deleted and the app comes
   back on yesterday's data), then creates the demo world again. Every signed-in
   reviewer is signed out (their sessions are rows too).
2. `storage-sweep.ts --delete` — deletes the stored files no row uses any more
   (avatars and photos of the deleted accounts). Files younger than 24 hours
   are left, so a day's files go the night after.

Why the app is stopped rather than reset under it: a browser's live messaging
connection was authenticated once, when it opened — it would stay open on an
account that no longer exists; and the app's new-message sweep (every minute)
could meet the reset halfway. Stopped, neither can happen. The site answers
an error for the minute or so it takes.

**Install the timer** (once; change `/opt/stride` in the `.service` file to
where the repository is):

```sh
sudo cp scripts/ops/stride-demo-reset.service scripts/ops/stride-demo-reset.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now stride-demo-reset.timer
systemctl list-timers stride-demo-reset.timer     # the next run
journalctl -u stride-demo-reset.service           # what the last runs printed
```

A systemd timer, not a crontab line: the droplet's clock is UTC, and Ubuntu's
cron has no time zone per line — "04:00 Eastern" would move by an hour twice a
year. `OnCalendar=*-*-* 04:00:00 America/Toronto` follows Eastern time's clock
changes; `Persistent=true` runs a missed night once the droplet is back.

**Why 04:00 Eastern:** the reviewers are in North America, and the reset signs
everyone out and deletes what they did. 4 a.m. Eastern is the quietest hour
across the continent — 1–2 a.m. in Vancouver, 5:30 a.m. in St. John's (10:00
in Paris).

**Accounts reviewers create are deleted too.** The reset keeps only the
exercise library: an account a reviewer invited themselves to is gone the next
morning (they invite themselves again). On purpose — those addresses are real
people's, and the demo keeps them less than a day; and their data is woven into
the seeded accounts' (Pat's care team, Alex's messages), so keeping some
accounts while recreating the others would leave broken links. The card says
so.

## After each deploy

```sh
docker compose -f docker-compose.prod.yml run --rm migrate
sh scripts/ops/demo-reset.sh
```

A deploy can change what the seed creates; resetting right after it means the
demo always shows the data of the version that is running.

## Known limits

- **Casey's recovery codes are single-use.** Reviewers who sign in with them use
  them up until the next reset; the key on the card (added to an authenticator
  app) always works.
- **A two-factor code works once.** Two reviewers signing in as Casey within the
  same 30 seconds: the second waits for the next code.
- **Reviewers see each other's data.** The card says not to enter real personal
  information; the nightly reset removes whatever was typed.
