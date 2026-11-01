#!/bin/bash
set -euo pipefail

# Waits until RustFS (storage, :9000) and Mailpit (:8025) answer HTTP — used
# by the CI jobs before anything talks to them (decisions §38).
#
# Why a script: GitHub starts a job's service containers before its first
# step, and waits for a container's HEALTHCHECK when it has one — Postgres
# gets one in the workflow (`pg_isready`), but these two images are used as
# published and declare none, so "started" can come before "listening". Any
# HTTP answer counts as up (RustFS answers an unsigned request with 403 —
# that's fine: it is listening); only "no connection" (curl's 000) means
# wait. 60 tries, one a second, then a clear failure instead of a test
# failing later with ECONNREFUSED.

wait_for() {
  local name="$1" url="$2"
  for _ in $(seq 1 60); do
    code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$url" || true)
    if [ "$code" != "000" ]; then
      echo "wait-for-services: ${name} is up (HTTP ${code})."
      return 0
    fi
    sleep 1
  done
  echo "wait-for-services: ${name} did not answer at ${url} within 60 s." >&2
  return 1
}

wait_for "RustFS" "http://localhost:9000/"
wait_for "Mailpit" "http://localhost:8025/api/v1/info"
