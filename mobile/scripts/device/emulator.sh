#!/usr/bin/env bash
# device:emulator — make sure an Android device is online, booting the AVD if not.
#
#   npm run device:emulator
#
# No-op when a device (emulator or USB phone) is already online. Otherwise
# boots $TRACKNOTES_AVD (default Pixel_7) detached, waits for boot_completed,
# and retries once if qemu segfaults (exit 139, intermittent under CPU pressure).
# Extra emulator flags: $TRACKNOTES_EMULATOR_ARGS (default "-no-audio -no-boot-anim").
# Log: ~/.local/state/tracknotes-device/emulator.log. Stop: npm run device:stop -- --emulator
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
case "${1:-}" in -h|--help) sed -n '2,10p' "$0"; exit 0 ;; esac

EMULATOR="$(find_tool emulator emulator/emulator)" ||
  die "The Android emulator binary was not found (looked on PATH and in $ANDROID_SDK/emulator)."
LOG="$HOST_STATE_DIR/emulator.log"
PIDF="$HOST_STATE_DIR/emulator.pid"
EXITF="$HOST_STATE_DIR/emulator.exit"
BOOT_TIMEOUT="${TRACKNOTES_BOOT_TIMEOUT:-300}"
# shellcheck disable=SC2206
ARGS=(${TRACKNOTES_EMULATOR_ARGS:--no-audio -no-boot-anim})

booted() { # serial
  [ "$(adbs -s "$1" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] &&
    adbs -s "$1" shell pm path android >/dev/null 2>&1
}

wait_for_boot() { # pid -> 0 booted, 1 emulator exited, 2 timeout
  local pid="$1" deadline serial
  deadline=$(( $(date +%s) + BOOT_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    serial="$(online_devices | grep -m1 '^emulator-' || true)"
    if [ -n "$serial" ] && booted "$serial"; then
      BOOTED_SERIAL="$serial"; return 0
    fi
    if [ -n "$pid" ] && ! pid_alive "$pid"; then return 1; fi
    sleep 3
  done
  return 2
}

existing="$(online_devices | head -1)"
if [ -n "$existing" ]; then
  if booted "$existing"; then
    ok "Device already online and booted: $existing — nothing to do."
    exit 0
  fi
  info "$existing is online but still booting; waiting…"
  wait_for_boot "" && { ok "Booted: $BOOTED_SERIAL"; exit 0; }
  die "$existing did not finish booting within ${BOOT_TIMEOUT}s. Check it, or stop it: npm run device:stop -- --emulator"
fi

"$EMULATOR" -list-avds 2>/dev/null | grep -qx "$AVD_NAME" ||
  die "No AVD named $AVD_NAME. Available: $("$EMULATOR" -list-avds 2>/dev/null | tr '\n' ' '). Set TRACKNOTES_AVD."

if running="$(pgrep -f -- "-avd $AVD_NAME" | head -1)" && [ -n "$running" ]; then
  info "An emulator process for $AVD_NAME is already running (pid $running) but adb does not list it."
  info "If this shell is sandboxed, its adb server cannot see the emulator: run outside the sandbox."
  info "Waiting up to ${BOOT_TIMEOUT}s for it to register…"
  wait_for_boot "$running" && { ok "Booted: $BOOTED_SERIAL"; exit 0; }
  die "The running emulator (pid $running) never came online in adb. Kill it (kill $running) and re-run."
fi

if pgrep -f 'gradle.*assembleDebug|GradleDaemon' >/dev/null 2>&1; then
  warn "A Gradle build seems to be running; the emulator and Gradle together can exhaust RAM here."
fi

for attempt in 1 2; do
  rm -f "$EXITF"
  info "Booting $AVD_NAME (attempt $attempt)…"
  pid="$(detach "$LOG" bash -c '"$@"; echo $? > "'"$EXITF"'"' _ "$EMULATOR" -avd "$AVD_NAME" "${ARGS[@]}")"
  write_pidfile "$PIDF" "$pid"
  rc=0; wait_for_boot "$pid" || rc=$?
  if [ "$rc" = 0 ]; then
    ok "Booted: $BOOTED_SERIAL (emulator pid $pid)."
    adbs -s "$BOOTED_SERIAL" shell input keyevent 82 >/dev/null 2>&1 || true # dismiss the lock screen
    info "A restarted emulator has no adb reverses and is back at its quick-boot snapshot: re-run npm run device:metro."
    exit 0
  fi
  if [ "$rc" = 2 ]; then
    tail -n 20 "$LOG" >&2
    die "$AVD_NAME did not boot within ${BOOT_TIMEOUT}s (log tail above; $LOG). It is still running: npm run device:stop -- --emulator"
  fi
  code="$(cat "$EXITF" 2>/dev/null || echo '?')"
  if [ "$code" = 139 ] && [ "$attempt" = 1 ]; then
    warn "qemu crashed during boot (exit 139, a known intermittent segfault under CPU pressure) — retrying once."
    sleep 3
    continue
  fi
  tail -n 25 "$LOG" >&2
  die "The emulator exited during boot with code $code (log tail above; full log $LOG)."
done
die "The emulator crashed twice during boot (exit 139). Close CPU-heavy jobs (Gradle, Metro warm-up) and retry."
