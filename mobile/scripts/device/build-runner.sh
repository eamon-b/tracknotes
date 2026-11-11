#!/usr/bin/env bash
# The detached half of device:build: runs prebuild + Gradle and records the
# outcome in .device/build.status. Started by build.sh via setsid; not meant to
# be run by hand (use `npm run device:build`).
set -uo pipefail

STATUS="$1"; CLEAN="$2"; LABEL="$3"; SDK="$4"
MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$MOBILE_DIR/.device"
GRADLE_ARGS="${TRACKNOTES_GRADLE_ARGS:--PreactNativeArchitectures=x86_64 --max-workers=3}"

write_status() { # state exit_code
  {
    printf 'state=%s\n' "$1"
    printf 'exit_code=%s\n' "$2"
    printf 'pid=%s\n' "$$"
    printf 'started=%s\n' "$STARTED"
    printf 'finished=%s\n' "$(date -Is)"
    printf 'git=%s\n' "$LABEL"
    printf 'sdk=%s\n' "$SDK"
  } >"$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}
STARTED="$(date -Is)"
write_status running ""

finish() {
  local code="$1"
  if [ -d "$MOBILE_DIR/android" ] && [ -x "$MOBILE_DIR/android/gradlew" ]; then
    # Free the daemon's RAM (several GB) so the emulator can boot afterwards.
    (cd "$MOBILE_DIR/android" && ./gradlew --stop >/dev/null 2>&1) || true
  fi
  if [ "$code" -eq 0 ]; then write_status succeeded 0; else write_status failed "$code"; fi
  echo "=== device:build finished: exit $code at $(date -Is) ==="
  exit "$code"
}
trap 'finish 143' TERM INT

cd "$MOBILE_DIR" || finish 1
echo "=== device:build started $STARTED in $MOBILE_DIR (git $LABEL, Expo SDK $SDK) ==="

PREBUILD=(npx expo prebuild --platform android --no-install)
[ "$CLEAN" = "1" ] && PREBUILD+=(--clean)
echo "+ ${PREBUILD[*]}"
CI=1 "${PREBUILD[@]}" || { echo "!!! prebuild failed"; finish 10; }
echo "$SDK" >"$STATE_DIR/prebuild-sdk"

cd android || finish 11
# shellcheck disable=SC2086 # GRADLE_ARGS is a word list on purpose
echo "+ ./gradlew :app:assembleDebug $GRADLE_ARGS"
# shellcheck disable=SC2086
./gradlew :app:assembleDebug $GRADLE_ARGS --console=plain &
GRADLE_PID=$!
wait "$GRADLE_PID"
code=$?
[ "$code" -eq 0 ] || { echo "!!! gradle failed (exit $code)"; finish "$code"; }
[ -s app/build/outputs/apk/debug/app-debug.apk ] || { echo "!!! gradle succeeded but no app-debug.apk"; finish 12; }
finish 0
