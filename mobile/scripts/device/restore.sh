#!/usr/bin/env bash
# device:restore — reinstall an APK from the cache device:install keeps.
#
#   npm run device:restore              # the APK the last install/restore replaced
#   npm run device:restore -- <file>    # a cached file (name or path)
#   npm run device:restore -- --list    # show the cache
#   npm run device:restore -- --sdk 54  # the newest cached APK for that Expo SDK
#
# Whatever is installed now is cached first, so a restore can be undone too.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
source "$DEVICE_SCRIPTS_DIR/apk-cache.sh"

target=""
case "${1:-}" in
  -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
  --list|-l) cache_list; exit 0 ;;
  --sdk)
    [ -n "${2:-}" ] || die "--sdk needs a major version, e.g. --sdk 54"
    f="$(awk -F'\t' -v m="$2" 'index($3, m ".")==1 {print $2}' "$INDEX" |
      while IFS= read -r n; do [ -f "$APK_CACHE_DIR/$n" ] && echo "$n"; done | tail -1)"
    [ -n "$f" ] || { cache_list; die "No cached APK for Expo SDK $2."; }
    target="$APK_CACHE_DIR/$f" ;;
  "")
    [ -f "$APK_CACHE_DIR/last-displaced" ] ||
      { cache_list; die "Nothing has been displaced yet; name a file: npm run device:restore -- <file>"; }
    target="$(cat "$APK_CACHE_DIR/last-displaced")" ;;
  *)
    if [ -f "$1" ]; then target="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    elif [ -f "$APK_CACHE_DIR/$1" ]; then target="$APK_CACHE_DIR/$1"
    else cache_list; die "No such APK: $1"; fi ;;
esac
[ -s "$target" ] || { cache_list; die "Cached APK $target is missing or empty."; }
require_device

target_sha="$(sha256_of "$target")"
tmp="$APK_CACHE_DIR/.pull-$$.apk"
trap 'rm -f "$tmp"' EXIT
if pull_installed_apk "$tmp"; then
  if [ "$(sha256_of "$tmp")" = "$target_sha" ]; then
    ok "$(basename "$target") is already installed on $ANDROID_SERIAL — nothing to do."
    exit 0
  fi
  saved="$(cache_save_installed "$tmp")"
  ok "Saved the installed APK: $saved"
fi

install_apk "$target"
sdk="$(apk_sdk_version "$target")"
ok "Restored $(basename "$target") (Expo SDK ${sdk:-unknown}) on $ANDROID_SERIAL."
tree_major="$(tree_sdk_major)"
if [ -n "$sdk" ] && [ "${sdk%%.*}" != "$tree_major" ]; then
  warn "It is Expo SDK ${sdk%%.*}; this checkout serves SDK $tree_major. Serve it from a checkout on SDK ${sdk%%.*}."
fi
