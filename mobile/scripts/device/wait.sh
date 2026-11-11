#!/usr/bin/env bash
# device:wait — block until the device:build build finishes, fails, or the
# time budget runs out (default 540 s, under the Bash tool's 10-minute cap).
#
#   npm run device:wait [-- <seconds>]
#
# Exit 0: built — prints the APK path on stdout.
# Exit 1: failed (or no build) — prints the tail of the log.
# Exit 2: still running when the budget ran out — just run it again.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BUDGET="${1:-540}"
case "$BUDGET" in -h|--help) sed -n '2,10p' "$0"; exit 0 ;; esac
[[ "$BUDGET" =~ ^[0-9]+$ ]] || die "Budget must be a number of seconds, got: $BUDGET"

STATUS="$STATE_DIR/build.status"
LOG="$STATE_DIR/build.log"
[ -f "$STATUS" ] || die "No build has been started in this checkout. Start one: npm run device:build"

field() { grep "^$1=" "$STATUS" | cut -d= -f2-; }

show_failure() {
  info "----- last 40 lines of $LOG -----"
  tail -n 40 "$LOG" >&2 || true
  info "----- first error lines -----"
  grep -n -m 8 -E 'FAILURE:|error:|What went wrong|!!! ' "$LOG" >&2 || true
}

deadline=$(( $(date +%s) + BUDGET ))
last_note=0
while :; do
  state="$(field state)"; pid="$(field pid)"
  case "$state" in
    succeeded)
      [ -s "$DEBUG_APK" ] || die "The status says succeeded but $DEBUG_APK is missing — was android/ cleaned since? Rebuild: npm run device:build"
      ok "Build succeeded (git $(field git), Expo SDK $(field sdk), finished $(field finished))."
      info "Install it: npm run device:install"
      printf '%s\n' "$DEBUG_APK"
      exit 0 ;;
    failed)
      info "Build FAILED with exit $(field exit_code) (git $(field git), finished $(field finished))."
      show_failure
      info "Full log: $LOG"
      exit 1 ;;
    running)
      if [ -n "$pid" ] && ! pid_alive "$pid"; then
        info "The build process (pid $pid) is gone without recording a result — killed (OOM? reboot?)."
        show_failure
        sed -i 's/^state=running/state=failed/' "$STATUS"
        exit 1
      fi ;;
    *) die "Unreadable status file $STATUS (state=$state). Start a new build: npm run device:build" ;;
  esac
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    info "Still building after ${BUDGET}s. Last log line:"
    tail -n 1 "$LOG" >&2 || true
    info "Run \`npm run device:wait\` again to keep waiting."
    exit 2
  fi
  if [ $(( now - last_note )) -ge 60 ]; then
    info "[$(date +%T)] building… $(tail -n 1 "$LOG" 2>/dev/null | cut -c1-120)"
    last_note=$now
  fi
  sleep 5
done
