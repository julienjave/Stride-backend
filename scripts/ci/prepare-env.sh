#!/bin/bash
set -euo pipefail

# Writes the backend's .env for a CI run (decisions §38) — used by this
# repo's API e2e job AND by the frontend repo's browser job, which checks
# this repo out beside its own: one copy of the rule, in the repo it
# configures.
#
# What it does: copies .env.example (every setting already points at
# localhost — exactly where a CI job's service containers are published) and
# replaces the three values validateEnv() refuses as placeholders with fresh
# random ones. A CI database lives for one job and holds only seed data, so
# nothing here protects anything real — but generating them per run means no
# secret-looking value is ever written in the repository, and the run proves
# the app boots with ANY valid secret, not one remembered value.
#
# Run from anywhere: `bash scripts/ci/prepare-env.sh` (it finds the backend
# folder from its own location). Refuses to overwrite an existing .env — on a
# developer's machine that file holds the real local settings.

cd "$(dirname "$0")/../.."

if [ -e .env ]; then
  echo "prepare-env: .env already exists here — refusing to overwrite it." >&2
  exit 1
fi

cp .env.example .env

# set_value NAME VALUE — replaces the whole "NAME=…" line (its trailing
# "# Generate: …" comment included). `|` as sed's separator: hex values never
# contain it.
set_value() {
  local name="$1" value="$2"
  grep -q "^${name}=" .env || { echo "prepare-env: no ${name}= line in .env.example" >&2; exit 1; }
  sed -i "s|^${name}=.*|${name}=${value}|" .env
  # On GitHub Actions, ::add-mask:: replaces the value with *** in every log
  # line that follows — the habit to keep for any generated secret.
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::add-mask::${value}"
  fi
}

set_value POSTGRES_APP_PASSWORD "$(openssl rand -hex 24)"
set_value SESSION_SECRET "$(openssl rand -hex 32)"
set_value MFA_ENCRYPTION_KEY "$(openssl rand -hex 32)" # exactly 64 hex characters

echo "prepare-env: .env written from .env.example with fresh secrets."
