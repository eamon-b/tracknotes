#!/usr/bin/env bash
# device:metro — serve this checkout to the dev client on the device.
#
#   npm run device:metro [-- --port 8082] [-- --api] [-- --no-open] [-- --skip-sdk-check]
#
# Starts Metro detached (CI=1, survives the Bash tool's 10-minute cap), waits for
# it, warms the Android bundle with curl (a cold bundle makes the app ANR), runs
# `adb reverse` for the port, then opens the dev client deep link. Re-running it
# reuses a healthy Metro and just re-reverses and re-opens (e.g. after an
# emulator restart, which drops every adb reverse).
#   --port N          Metro port (default $TRACKNOTES_METRO_PORT or 8081)
#   --api             also `adb reverse tcp:8787` for a local `wrangler dev`
#                     (EXPO_PUBLIC_API_BASE_URL=http://localhost:8787 in .env.local)
#   --watch           serve without CI=1, so Metro watches files and Fast Refresh
#                     works (with CI=1 Metro does not see edits: restart it)
#   --no-open         don't launch the app
#   --skip-sdk-check  open even if the installed dev client is on another SDK
# Log: mobile/.device/metro.log. Stop with: npm run device:stop
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PORT="${TRACKNOTES_METRO_PORT:-8081}"; API=0; OPEN=1; SDK_CHECK=1; WATCH=0
START_TIMEOUT="${TRACKNOTES_METRO_START_TIMEOUT:-300}"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift ;;
    --port=*) PORT="${1#--port=}" ;;
    --api) API=1 ;;
    --watch) WATCH=1 ;;
    --no-open) OPEN=0 ;;
    --skip-sdk-check) SDK_CHECK=0 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port needs a number, got: $PORT"

LOG="$STATE_DIR/metro.log"
PIDF="$STATE_DIR/metro.pid"
PORTF="$STATE_DIR/metro.port"
BASE="http://localhost:$PORT"

[ -d "$MOBILE_DIR/node_modules/expo" ] ||
  die "No node_modules in $MOBILE_DIR. Run \`npm ci --legacy-peer-deps\` in this checkout's mobile/."
command -v curl >/dev/null || die "curl is required."
require_device

# /status can take many seconds to answer while Metro crawls the tree on a loaded host.
metro_up() { curl -sf --max-time 15 "$BASE/status" 2>/dev/null | grep -q 'packager-status:running'; }
port_owner() { ss -ltnpH "sport = :$1" 2>/dev/null | head -1; }

old_pid="$(cat "$PIDF" 2>/dev/null || true)"
old_port="$(cat "$PORTF" 2>/dev/null || true)"
if pid_alive "$old_pid" && [ "$old_port" != "$PORT" ]; then
  die "Metro from this checkout is already running on port $old_port (pid $old_pid).
Use it (--port $old_port) or stop it first: npm run device:stop"
fi

if pid_alive "$old_pid" && metro_up; then
  ok "Metro from this checkout is already up on port $PORT (pid $old_pid) — reusing it."
else
  if pid_alive "$old_pid"; then
    info "Metro (pid $old_pid) is running but not answering on $BASE — restarting it."
    kill_session "$old_pid" Metro
  fi
  owner="$(port_owner "$PORT")"
  if [ -n "$owner" ] || metro_up; then
    die "Port $PORT is already in use by another process, probably another checkout's Metro:
  ${owner:-(owner not visible from this shell)}
Pick another port (npm run device:metro -- --port 8082), or stop that process."
  fi
  info "Starting Metro for $MOBILE_DIR on port $PORT…"
  # stdin is /dev/null either way, so Expo never prompts; CI=1 also turns off file watching.
  # (Expo rejects an empty CI, so --watch unsets it rather than blanking it.)
  ci_env=(CI=1); [ "$WATCH" = 1 ] && ci_env=(-u CI)
  pid="$(cd "$MOBILE_DIR" && detach "$LOG" env "${ci_env[@]}" npx expo start --dev-client --port "$PORT")"
  echo "$pid" >"$PIDF"; echo "$PORT" >"$PORTF"
  deadline=$(( $(date +%s) + START_TIMEOUT ))
  until metro_up; do
    pid_alive "$pid" || { tail -n 30 "$LOG" >&2; rm -f "$PIDF"; die "Metro exited during startup (log tail above; full log $LOG)."; }
    [ "$(date +%s)" -lt "$deadline" ] ||
      { tail -n 30 "$LOG" >&2; die "Metro did not answer on $BASE/status within ${START_TIMEOUT}s (log tail above). Host overloaded? Stop it: npm run device:stop"; }
    sleep 2
  done
  ok "Metro is up (pid $pid)."
fi

# Warm the exact bundle the dev client will ask for (its URL is in the manifest),
# falling back to the plain entry bundle.
bundle_url="$(curl -sf --max-time 20 -H 'expo-platform: android' -H 'accept: application/json' "$BASE/" 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s);const u=(m.launchAsset&&m.launchAsset.url)||m.bundleUrl;if(u)console.log(u)}catch{}})' || true)"
if [ -n "$bundle_url" ]; then
  bundle_url="$(printf '%s' "$bundle_url" | sed -E "s#^https?://[^/]+#$BASE#")"
else
  bundle_url="$BASE/.expo/.virtual-metro-entry.bundle?platform=android&dev=true"
fi
info "Warming the bundle (first build can take a few minutes)…"
start=$(date +%s)
if ! curl -sf --max-time 480 -o /dev/null "$bundle_url"; then
  tail -n 30 "$LOG" >&2
  die "Bundling failed or timed out: $bundle_url
(Metro log tail above; full log $LOG). Fix the error, then re-run npm run device:metro."
fi
ok "Bundle warm ($(( $(date +%s) - start )) s)."

adbs reverse "tcp:$PORT" "tcp:$PORT" >/dev/null || die "adb reverse tcp:$PORT failed."
reversed="$PORT"
if [ "$API" = 1 ]; then
  adbs reverse tcp:8787 tcp:8787 >/dev/null || die "adb reverse tcp:8787 failed."
  reversed="$reversed 8787"
  [ -n "$(port_owner 8787)" ] || warn "Nothing is listening on 8787 yet — start \`npx wrangler dev\` in workers/comments-api (after \`npm run migrate:local\`)."
  grep -qs '^EXPO_PUBLIC_API_BASE_URL=http://localhost:8787' "$MOBILE_DIR/.env.local" ||
    warn "mobile/.env.local does not set EXPO_PUBLIC_API_BASE_URL=http://localhost:8787, so the app still calls the deployed API. Set it, then device:stop + device:metro (it is inlined at bundle time)."
fi
echo "$reversed" >"$STATE_DIR/metro.reverse"
ok "adb reverse: $reversed"

if [ "$OPEN" = 1 ]; then
  if [ "$SDK_CHECK" = 1 ]; then
    bash "$DEVICE_SCRIPTS_DIR/check-sdk.sh" ||
      die "Not opening the app: the installed dev client does not match this tree (above). Fix that, or pass --skip-sdk-check."
  fi
  link="$SCHEME://expo-development-client/?url=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "http://localhost:$PORT")"
  adbs shell am start -a android.intent.action.VIEW -d "$link" "$APP_ID" >/dev/null ||
    die "Could not open the deep link $link"
  ok "Opened $link"
  info "Screenshot: npm run device:shot -- <name>    Logs: adb logcat -d -t 50 ReactNativeJS:* *:E"
fi
