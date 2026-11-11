#!/usr/bin/env bash
# Probe the deployed comments API: /health, plus one route from each migration
# that added routes. `/health` answers even while a new route 404s (a deploy
# that never happened, or one from the wrong branch), so each route is checked
# for the status it gives once deployed.
#
# Usage: scripts/probe-comments-api.sh [base-url]
#   The base URL is the argument, else $COMMENTS_API_BASE_URL, else production
#   (https://api.tracknotes.info). Staging:
#   scripts/probe-comments-api.sh https://tracknotes-comments-staging.<subdomain>.workers.dev
#
# Run by the Deploy comments API workflow after every deploy, and by hand as
# step 1 of "Full release" in docs/mobile-test-build.md. When a migration adds
# routes, add a line to PROBES below.
#
# Retries for a minute, so a probe right after `wrangler deploy` does not fail
# on a version still rolling out.

set -uo pipefail

BASE="${1:-${COMMENTS_API_BASE_URL:-https://api.tracknotes.info}}"
BASE="${BASE%/}"
echo "Probing $BASE"

# "<expected status> <path> <why>"
PROBES=(
  "200 /health worker up"
  "200 /v1/community/routes community routes, migrations 0005/0006"
  "200 /v1/trails/heysen/waypoints shared waypoints, migration 0007"
  "401 /v1/me/comments personal export, needs a token"
  "401 /v1/admin/community/routes/c_AAAAAAAAAAAAAAAA/trail admin route map #310, needs a token"
)

ATTEMPTS=6
DELAY=10

failed=0
for probe in "${PROBES[@]}"; do
  read -r want path why <<<"$probe"
  got=""
  for ((i = 1; i <= ATTEMPTS; i++)); do
    got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE$path")
    [ "$got" = "$want" ] && break
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$DELAY"
  done
  if [ "$got" = "$want" ]; then
    echo "ok   $got $path ($why)"
  else
    echo "FAIL $got $path, expected $want ($why)"
    failed=1
  fi
done

exit "$failed"
