# Shared helpers for the device:* scripts. Sourced, never run.
# Everything is resolved from this file's own checkout, so a script run from a
# worktree only ever touches that worktree (plus the host-wide emulator, adb and
# the APK cache outside the repo).

set -euo pipefail

DEVICE_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$DEVICE_SCRIPTS_DIR/../.." && pwd)"
REPO_DIR="$(cd "$MOBILE_DIR/.." && pwd)"

APP_ID="com.tracknotes.app"
SCHEME="tracknotes"
AVD_NAME="${TRACKNOTES_AVD:-Pixel_7}"

# Per-checkout state (build + Metro): gitignored, beside the tree it describes.
STATE_DIR="$MOBILE_DIR/.device"
# Host-wide state (the emulator is shared by every checkout).
HOST_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/tracknotes-device"
# Known-good APKs, outside every repo so no checkout or `git clean` loses them.
APK_CACHE_DIR="${TRACKNOTES_APK_CACHE:-$HOME/.cache/tracknotes-apks}"

DEBUG_APK="$MOBILE_DIR/android/app/build/outputs/apk/debug/app-debug.apk"

mkdir -p "$STATE_DIR" "$HOST_STATE_DIR"

if [ -t 2 ]; then
  _red=$'\e[31m'; _yel=$'\e[33m'; _grn=$'\e[32m'; _off=$'\e[0m'
else
  _red=''; _yel=''; _grn=''; _off=''
fi
info() { printf '%s\n' "$*" >&2; }
ok() { printf '%s%s%s\n' "$_grn" "$*" "$_off" >&2; }
warn() { printf '%sWARNING:%s %s\n' "$_yel" "$_off" "$*" >&2; }
die() { printf '%sERROR:%s %s\n' "$_red" "$_off" "$*" >&2; exit 1; }

# Locate the Android SDK tools even when they are not on PATH.
ANDROID_SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
find_tool() { # name relpath
  if command -v "$1" >/dev/null 2>&1; then command -v "$1"
  elif [ -x "$ANDROID_SDK/$2" ]; then printf '%s\n' "$ANDROID_SDK/$2"
  else return 1; fi
}
ADB="$(find_tool adb platform-tools/adb)" ||
  die "adb not found on PATH or in \$ANDROID_HOME/platform-tools (ANDROID_HOME=${ANDROID_HOME:-unset}). Install the Android SDK platform-tools or export ANDROID_HOME."

adbs() { "$ADB" "$@"; }

# Devices in the "device" state, one serial per line.
online_devices() { adbs devices | awk 'NR>1 && $2=="device" {print $1}'; }

# Pick the device to talk to: $ANDROID_SERIAL if set, else the only one online.
# Exports ANDROID_SERIAL so every later adb call targets it.
require_device() {
  if [ -n "${ANDROID_SERIAL:-}" ]; then
    online_devices | grep -qx "$ANDROID_SERIAL" ||
      die "ANDROID_SERIAL=$ANDROID_SERIAL is not an online device. \`adb devices\` shows:
$(adbs devices | tail -n +2)"
    return 0
  fi
  local devs n other
  devs="$(online_devices)"
  n="$(printf '%s' "$devs" | grep -c . || true)"
  if [ "$n" -eq 0 ]; then
    other="$(adbs devices | awk 'NR>1 && NF {print "  " $0}')"
    die "No online Android device.${other:+ adb sees:
$other
(\"unauthorized\": accept the prompt on the device; \"offline\": wait, or restart it.)}
Boot the emulator with: npm run device:emulator
If the emulator window is up but adb lists nothing, this shell's adb is probably a
sandboxed server that cannot see it: run the command outside the sandbox."
  elif [ "$n" -gt 1 ]; then
    die "More than one device online; set ANDROID_SERIAL to one of:
$devs"
  fi
  export ANDROID_SERIAL="$devs"
}

# Expo SDK major the served tree is on (from mobile/package.json "expo").
tree_sdk_major() {
  node -e 'const v=require(process.argv[1]).dependencies.expo; const m=String(v).match(/(\d+)/); if(!m) process.exit(1); console.log(m[1])' \
    "$MOBILE_DIR/package.json" || die "Could not read the expo version from $MOBILE_DIR/package.json"
}

# Expo sdkVersion baked into an APK (assets/app.config), e.g. 58.0.0; empty if none.
apk_sdk_version() {
  command -v unzip >/dev/null || die "unzip is required to read an APK's app.config."
  { unzip -p "$1" assets/app.config 2>/dev/null || true; } |
    grep -o '"sdkVersion":"[^"]*"' | head -1 | cut -d'"' -f4 || true
}

# Path of the installed base APK on the device; empty if not installed.
installed_apk_path() {
  { adbs shell pm path "$APP_ID" 2>/dev/null || true; } |
    tr -d '\r' | grep -m1 'base.apk' | sed 's/^package://' || true
}

# Pull the installed base APK to $1. Returns 1 if the app is not installed.
pull_installed_apk() {
  local remote
  remote="$(installed_apk_path)"
  [ -n "$remote" ] || return 1
  local out
  out="$(adbs pull "$remote" "$1" 2>&1)" || die "adb pull $remote failed: $out"
}

# Short sha of this checkout, with -dirty if mobile/ or src/lib has uncommitted changes.
git_label() {
  local sha
  sha="$(cd "$REPO_DIR" && git rev-parse --short=10 HEAD 2>/dev/null || echo nogit)"
  if [ -n "$(cd "$REPO_DIR" && git status --porcelain -- mobile src/lib 2>/dev/null | grep -v '^?? mobile/.device/' || true)" ]; then
    sha="$sha-dirty"
  fi
  printf '%s\n' "$sha"
}

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# Start time of a running process (ps lstart); empty if it is not running.
# Stored beside every pid we record, so a pid the kernel reused after a reboot
# or a crash is never mistaken for (or killed as) one of ours.
pid_start() {
  [ -n "${1:-}" ] || return 0
  { ps -o lstart= -p "$1" 2>/dev/null || true; } | sed 's/^ *//; s/ *$//'
}
# pid_ours PID START: PID is alive and is still the process that started at START.
pid_ours() { pid_alive "${1:-}" && [ -n "${2:-}" ] && [ "$(pid_start "$1")" = "$2" ]; }
# write_pidfile FILE PID: record PID with its start time.
write_pidfile() { printf '%s\n%s\n' "$2" "$(pid_start "$2")" >"$1"; }
# read_pidfile FILE: print the recorded pid if it is still ours, else nothing.
read_pidfile() {
  local pid="" start=""
  { read -r pid; read -r start; } 2>/dev/null <"$1" || true
  if pid_ours "$pid" "$start"; then printf '%s\n' "$pid"; fi
}

# Start a command fully detached: its own session (setsid), so the harness
# reaping the caller's process group at the 10-minute cap cannot kill it;
# stdin from /dev/null; output to LOG. Prints the pid (= the session's pgid).
# Usage: detach LOG cmd args...
detach() {
  local log="$1"; shift
  command -v setsid >/dev/null || die "setsid not found (it ships with util-linux)."
  setsid nohup "$@" >"$log" 2>&1 </dev/null &
  printf '%s\n' "$!"
}

# Kill a detached session started by detach(): the whole process group, then
# SIGKILL whatever is left after a grace period.
kill_session() { # pid [label]
  local pid="$1" label="${2:-process}" i
  pid_alive "$pid" || return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 20); do
    pid_alive "$pid" || { info "Stopped $label (pid $pid)."; return 0; }
    sleep 0.5
  done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  info "Killed $label (pid $pid) after it ignored SIGTERM."
}
