#!/usr/bin/env bash
# device:check-sdk — does the installed dev client match the Expo SDK this
# checkout serves? A mismatch is what the boot red box
# "[runtime not ready]: ReferenceError: Property 'MessageQueue' doesn't exist" means.
#
#   npm run device:check-sdk
#
# Exit 0: match. Exit 1: mismatch, not installed, or no dev launcher.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
case "${1:-}" in -h|--help) sed -n '2,8p' "$0"; exit 0 ;; esac
require_device

tree_major="$(tree_sdk_major)"
tmp="$(mktemp --suffix=.apk)"
trap 'rm -f "$tmp"' EXIT
if ! pull_installed_apk "$tmp"; then
  die "$APP_ID is not installed on $ANDROID_SERIAL. Build and install: npm run device:build && npm run device:wait && npm run device:install"
fi
installed="$(apk_sdk_version "$tmp")"
[ -n "$installed" ] || die "The installed APK has no assets/app.config sdkVersion — not an Expo build?"
installed_major="${installed%%.*}"

status=0
if [ "$installed_major" = "$tree_major" ]; then
  ok "OK: installed dev client is Expo SDK $installed; this checkout ($MOBILE_DIR) serves SDK $tree_major."
else
  warn "MISMATCH: installed dev client is Expo SDK $installed_major ($installed), but this checkout serves SDK $tree_major."
  info "Metro from this checkout will red-box at boot (\"MessageQueue doesn't exist\"). Either:"
  info "  - build and install this tree: npm run device:build && npm run device:wait && npm run device:install"
  info "    (device:install caches the SDK $installed_major APK first; npm run device:restore puts it back), or"
  info "  - serve Metro from a checkout on SDK $installed_major instead."
  status=1
fi

if ! adbs shell pm dump "$APP_ID" 2>/dev/null | grep -qi devlauncher; then
  warn "The installed build has no expo-dev-client launcher: the tracknotes://expo-development-client deep link is a silent no-op and the app loads from 10.0.2.2:8081. Rebuild from this tree."
  status=1
fi
exit "$status"
