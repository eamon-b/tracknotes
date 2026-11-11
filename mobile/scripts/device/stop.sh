#!/usr/bin/env bash
# device:stop — clean up what the device:* scripts started.
#
#   npm run device:stop                   # this checkout's Metro + its adb reverses
#   npm run device:stop -- --build        # also a running device:build
#   npm run device:stop -- --emulator     # also the emulator
#   npm run device:stop -- --all          # all of the above
#
# Safe to run when nothing is running.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BUILD=0; EMU=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --emulator) EMU=1 ;;
    --all) BUILD=1; EMU=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg (try --help)" ;;
  esac
done

# Metro
pid="$(read_pidfile "$STATE_DIR/metro.pid")"
if pid_alive "$pid"; then kill_session "$pid" "Metro (port $(cat "$STATE_DIR/metro.port" 2>/dev/null))"
else info "Metro: not running from this checkout."; fi
rm -f "$STATE_DIR/metro.pid" "$STATE_DIR/metro.port"

# adb reverses this checkout's Metro made (only if the device is reachable).
# tcp:8787 (--api) is left alone: every checkout's --api shares it, it only points
# at the host's wrangler dev, and removing it would cut another checkout's Metro off.
if [ -f "$STATE_DIR/metro.reverse" ]; then
  removed=""
  for p in $(cat "$STATE_DIR/metro.reverse"); do
    [ "$p" = 8787 ] && continue
    for s in $(online_devices); do adbs -s "$s" reverse --remove "tcp:$p" >/dev/null 2>&1 || true; done
    removed="$removed $p"
  done
  info "Removed adb reverse:${removed:- none}"
  grep -qw 8787 "$STATE_DIR/metro.reverse" &&
    info "Left adb reverse tcp:8787 (shared by every checkout's --api). Remove it by hand if nothing needs it: adb reverse --remove tcp:8787"
  rm -f "$STATE_DIR/metro.reverse"
fi

# Build
if [ "$BUILD" = 1 ]; then
  bpid="$(grep '^pid=' "$STATE_DIR/build.status" 2>/dev/null | cut -d= -f2 || true)"
  bstart="$(grep '^pid_start=' "$STATE_DIR/build.status" 2>/dev/null | cut -d= -f2- || true)"
  if pid_ours "$bpid" "$bstart"; then
    kill_session "$bpid" "device:build"
    if [ -x "$MOBILE_DIR/android/gradlew" ]; then (cd "$MOBILE_DIR/android" && ./gradlew --stop >/dev/null 2>&1) || true; fi
    sed -i 's/^state=running/state=failed/; s/^exit_code=$/exit_code=stopped/' "$STATE_DIR/build.status"
  else info "Build: none running in this checkout."; fi
fi

# Emulator
if [ "$EMU" = 1 ]; then
  emus="$(online_devices | grep '^emulator-' || true)"
  for s in $emus; do adbs -s "$s" emu kill >/dev/null 2>&1 || true; info "Asked $s to shut down."; done
  epid="$(read_pidfile "$HOST_STATE_DIR/emulator.pid")"
  for _ in $(seq 1 30); do
    if ! pid_alive "$epid" && ! pgrep -f -- "-avd $AVD_NAME" >/dev/null; then break; fi
    sleep 1
  done
  if pid_alive "$epid"; then kill_session "$epid" emulator; fi
  if left="$(pgrep -f -- "-avd $AVD_NAME")"; then
    warn "Emulator processes still alive: $left (not started by device:emulator?). kill them by hand if they should go."
  elif [ -z "$emus" ] && [ -z "$epid" ]; then
    info "Emulator: not running."
  else
    info "Emulator: stopped."
  fi
  rm -f "$HOST_STATE_DIR/emulator.pid"
fi
