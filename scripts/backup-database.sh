#!/bin/bash
set -euo pipefail

# Run via cron on the Droplet — see the crontab line in this script's own
# comments below for the actual schedule. Dumps production Postgres,
# compresses it, and uploads to RustFS (the same object storage already
# running as part of this stack) — genuinely protects against the most
# realistic risk at this project's current stage: human error, a bad
# migration, accidental data loss during testing.
#
# The real, honest limitation, stated explicitly rather than glossed over:
# this does NOT protect against losing the Droplet itself — RustFS lives on
# the SAME machine as Postgres, so a genuine whole-Droplet failure takes
# both down together. Real production would want an off-Droplet destination
# (DigitalOcean's own Droplet backup feature, or Spaces) — a deliberate
# scope decision for now, not an oversight.

cd /home/stride/Stride-backend
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="stride-backup-${TIMESTAMP}.sql.gz"

docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U postgres stride | gzip > "/tmp/${BACKUP_FILE}"

# Deliberately NOT `source .env` — a .env file is only guaranteed to be
# simple KEY=VALUE text, safe for tools with their own lightweight parser
# (Node's dotenv, Docker Compose's env_file:). It is NOT guaranteed to be
# valid bash syntax — `source` genuinely EXECUTES the file as a script,
# where unquoted spaces and characters like < > have real shell meaning.
# EMAIL_FROM's value ("Stride Care <noreply@...>") breaks exactly this way.
# Extracting only the specific lines actually needed, as plain text via
# grep+cut, avoids this entire class of problem — nothing else in .env is
# ever interpreted as code, regardless of what it contains.
RUSTFS_ACCESS_KEY=$(grep -E "^RUSTFS_ACCESS_KEY=" .env | cut -d= -f2-)
RUSTFS_SECRET_KEY=$(grep -E "^RUSTFS_SECRET_KEY=" .env | cut -d= -f2-)
STORAGE_PORT=$(grep -E "^STORAGE_PORT=" .env | cut -d= -f2-)

# The AWS CLI only ever reads ITS OWN standard variable names — it has no
# concept of "RUSTFS_ACCESS_KEY" at all. Without this export, every `aws`
# call below would fail on authentication, silently unrelated to the actual
# credential values being correct.
export AWS_ACCESS_KEY_ID="$RUSTFS_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$RUSTFS_SECRET_KEY"

aws --endpoint-url "http://localhost:${STORAGE_PORT}" s3 cp \
  "/tmp/${BACKUP_FILE}" "s3://backups/${BACKUP_FILE}"

rm "/tmp/${BACKUP_FILE}"

# Keeps the last 14 daily backups, deletes anything older — otherwise the
# bucket grows forever.
aws --endpoint-url "http://localhost:${STORAGE_PORT}" s3 ls "s3://backups/" \
  | awk '{print $4}' | sort | head -n -14 | while read -r old_file; do
    [ -n "$old_file" ] && aws --endpoint-url "http://localhost:${STORAGE_PORT}" \
      s3 rm "s3://backups/${old_file}"
done

echo "Backup complete: ${BACKUP_FILE}"

# --- Crontab entry (run `crontab -e` and add this line) ---
# Daily at 3 AM: 0 3 * * * /home/stride/Stride-backend/scripts/backup-database.sh >> /home/stride/backup.log 2>&1