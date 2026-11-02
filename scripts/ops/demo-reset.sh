#!/bin/sh
# The reviewers' demo: reset its data (decisions §46, pass 2).
# Run nightly by stride-demo-reset.timer, and once after each deploy:
#   sh scripts/ops/demo-reset.sh
#
# Why the app is STOPPED around the reset, rather than resetting under it:
#   - the reset deletes every account; a browser's live messaging socket was
#     authenticated once, at its handshake, so it would stay open on an
#     account that no longer exists. Stopping the app closes them all; on
#     restart the browsers reconnect, find no session, and go to sign-in.
#   - the app's new-message sweep runs every minute; with the app stopped it
#     can't meet the reset's transaction halfway (no lock needed).
# The trap starts the app again WHATEVER happens: a failed reset rolls its
# transaction back, so the app comes back on yesterday's data, not on none.
#
# `set -eu`: stop at the first failing command (-e) and at any unset
# variable (-u) — a script that deletes data must never carry on blind.
set -eu

# The repository's root (this file is in scripts/ops/), wherever it is run
# from — systemd starts it from /.
cd "$(dirname "$0")/../.."
compose() { docker compose -f docker-compose.prod.yml "$@"; }

# Refuse unless this deployment says it is the demo, before stopping
# anything. (seed-dev.ts refuses too — this saves a stop and a restart.)
# The line may end with a comment, and dotenv accepts quotes around the value.
if ! grep -Eq "^DEMO_MODE=[\"']?on[\"']?([[:space:]]|\$)" .env; then
  echo "demo-reset: .env has no DEMO_MODE=on line — this is not the demo deployment. Nothing done." >&2
  exit 1
fi

echo "demo-reset: $(date -u +%Y-%m-%dT%H:%M:%SZ) stopping the app"
compose stop app
trap 'echo "demo-reset: starting the app"; compose start app' EXIT

compose run --rm demo-reset
echo "demo-reset: $(date -u +%Y-%m-%dT%H:%M:%SZ) done"
