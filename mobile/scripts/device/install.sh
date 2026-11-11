#!/usr/bin/env bash
# device:install — install a debug APK, keeping the one it replaces.
#
#   npm run device:install [-- <apk>]
#
# Default APK: this checkout's android/app/build/outputs/apk/debug/app-debug.apk.
# Before installing it pulls the currently installed APK into the cache outside
# the repo ($APK_CACHE_DIR, default ~/.cache/tracknotes-apks/<sdk>-<sha>.apk),
# so `npm run device:restore` can put it back. The new APK is cached too.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
source "$DEVICE_SCRIPTS_DIR/apk-cache.sh"

APK="$DEBUG_APK"
case "${1:-}" in
  -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
  "") ;;
  *)
    # npm runs scripts from mobile/; INIT_CWD is where `npm run` was typed.
    p="$1"; case "$p" in /*) ;; *) p="${INIT_CWD:-$PWD}/$p" ;; esac
    dir="$(cd "$(dirname "$p")" 2>/dev/null && pwd)" || die "No such directory for $1 (resolved: $p)"
    APK="$dir/$(basename "$p")"
    ;;
esac

# The label for a freshly built APK is the commit device:build recorded.
# Refuse while that build is running, or after it failed (unless the APK was
# built by hand since): the APK on disk is then partial or from an older build,
# and would be cached under the wrong commit.
label=""
if [ "$APK" = "$DEBUG_APK" ] && [ -f "$STATE_DIR/build.status" ]; then
  bfield() { grep "^$1=" "$STATE_DIR/build.status" | cut -d= -f2- || true; }
  by_hand=0; [ "$DEBUG_APK" -nt "$STATE_DIR/build.status" ] && by_hand=1
  case "$(bfield state)" in
    running)
      pid_ours "$(bfield pid)" "$(bfield pid_start)" &&
        die "device:build is still running (pid $(bfield pid)). Wait for it: npm run device:wait"
      die "device:build's record says running but its process is gone (killed? reboot?), so $DEBUG_APK may be partial. Run npm run device:wait to record the failure, then rebuild: npm run device:build" ;;
    failed)
      [ "$by_hand" = 1 ] ||
        die "The last device:build failed (exit $(bfield exit_code)), so $DEBUG_APK is not from this tree's build. See npm run device:wait, then rebuild: npm run device:build" ;;
  esac
  if [ "$by_hand" = 1 ]; then
    warn "app-debug.apk is newer than device:build's record — built by hand? Labelling it with HEAD."
  else
    label="$(bfield git)"
  fi
fi
[ -n "$label" ] || label="$(git_label)"
[ -s "$APK" ] || die "No APK at $APK. Build one: npm run device:build && npm run device:wait"
require_device

new_sdk="$(apk_sdk_version "$APK")"
tree_major="$(tree_sdk_major)"
[ -n "$new_sdk" ] || warn "$(basename "$APK") has no assets/app.config sdkVersion — is it a Tracknotes build?"

new_sha="$(sha256_of "$APK")"
installed_tmp="$APK_CACHE_DIR/.pull-$$.apk"
trap 'rm -f "$installed_tmp"' EXIT
if pull_installed_apk "$installed_tmp"; then
  if [ "$(sha256_of "$installed_tmp")" = "$new_sha" ]; then
    rm -f "$installed_tmp"
    ok "This exact APK is already installed on $ANDROID_SERIAL — nothing to do."
    exit 0
  fi
  saved="$(cache_save_installed "$installed_tmp")"
  ok "Saved the installed APK: $saved (Expo SDK $(apk_sdk_version "$saved"))"
else
  info "$APP_ID is not installed yet — nothing to save."
fi

cached_new="$(cache_put "$APK" "$label" installed)"
install_apk "$APK"
ok "Installed $(basename "$cached_new") (Expo SDK ${new_sdk:-unknown}) on $ANDROID_SERIAL."
if [ -n "$new_sdk" ] && [ "${new_sdk%%.*}" != "$tree_major" ]; then
  warn "This APK is Expo SDK ${new_sdk%%.*} but this checkout serves SDK $tree_major — Metro from here will red-box ('MessageQueue doesn't exist')."
fi
info "Undo: npm run device:restore"
