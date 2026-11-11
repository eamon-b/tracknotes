# APK cache helpers for device:install / device:restore. Sourced after lib.sh.
#
# $APK_CACHE_DIR/<sdk-major>-<git-sha>.apk   one file per distinct APK (deduped by sha256)
# $APK_CACHE_DIR/index.tsv                    sha256  file  sdkVersion  label  saved-at  how
# $APK_CACHE_DIR/last-displaced               the file device:install/restore last replaced

INDEX="$APK_CACHE_DIR/index.tsv"
mkdir -p "$APK_CACHE_DIR"
touch "$INDEX"

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# The cached file holding this exact APK, if any (and still on disk).
cache_lookup() { # sha256
  local f
  f="$(awk -F'\t' -v s="$1" '$1==s {print $2}' "$INDEX" | tail -1)"
  [ -n "$f" ] && [ -f "$APK_CACHE_DIR/$f" ] && printf '%s\n' "$APK_CACHE_DIR/$f"
  return 0
}

# Copy APK into the cache (no-op if the same bytes are already there).
# Prints the cached path. Usage: cache_put APK LABEL HOW
cache_put() {
  local apk="$1" label="$2" how="$3" sha sdk major name existing
  sha="$(sha256_of "$apk")"
  existing="$(cache_lookup "$sha")"
  if [ -n "$existing" ]; then printf '%s\n' "$existing"; return 0; fi
  sdk="$(apk_sdk_version "$apk")"
  major="${sdk%%.*}"
  name="sdk${major:-unknown}-${label}.apk"
  [ -e "$APK_CACHE_DIR/$name" ] && name="sdk${major:-unknown}-${label}-${sha:0:8}.apk"
  cp "$apk" "$APK_CACHE_DIR/$name.part" && mv "$APK_CACHE_DIR/$name.part" "$APK_CACHE_DIR/$name" ||
    die "Could not write $APK_CACHE_DIR/$name (disk full?)."
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$sha" "$name" "${sdk:-?}" "$label" "$(date -Is)" "$how" >>"$INDEX"
  printf '%s\n' "$APK_CACHE_DIR/$name"
}

# Cache the installed APK — already pulled to $1 — and remember it as the last
# displaced APK. Consumes $1. Prints the cached path.
cache_save_installed() {
  local tmp="$1" sha label cached
  sha="$(sha256_of "$tmp")"
  cached="$(cache_lookup "$sha")"
  if [ -z "$cached" ]; then
    # Not an APK these scripts installed, so its commit is unknown.
    label="unknown-${sha:0:10}"
    cached="$(cache_put "$tmp" "$label" pulled-from-device)"
  fi
  rm -f "$tmp"
  printf '%s\n' "$cached" >"$APK_CACHE_DIR/last-displaced"
  printf '%s\n' "$cached"
}

cache_list() {
  if [ ! -s "$INDEX" ]; then info "The APK cache ($APK_CACHE_DIR) is empty."; return 0; fi
  info "Cached APKs in $APK_CACHE_DIR (newest last):"
  awk -F'\t' '{printf "  %-44s sdk %-8s saved %s  (%s)\n", $2, $3, substr($5,1,16), $6}' "$INDEX" |
    while IFS= read -r line; do
      f="$(printf '%s' "$line" | awk '{print $1}')"
      [ -f "$APK_CACHE_DIR/$f" ] && printf '%s\n' "$line" >&2
    done
  [ -f "$APK_CACHE_DIR/last-displaced" ] && info "Last displaced: $(cat "$APK_CACHE_DIR/last-displaced")"
  info "Total: $(du -sh "$APK_CACHE_DIR" | cut -f1)"
}

# adb install with actionable messages for the usual failures.
install_apk() { # apk
  local out
  info "Installing $(basename "$1") on $ANDROID_SERIAL…"
  if out="$(adbs install -r -d "$1" 2>&1)"; then
    printf '%s\n' "$out" | tail -n 1 >&2
    return 0
  fi
  printf '%s\n' "$out" >&2
  case "$out" in
    *INSTALL_FAILED_UPDATE_INCOMPATIBLE*|*signatures\ do\ not\ match*)
      die "The installed app is signed with a different key. The old APK is cached (see above).
To replace it you must uninstall first, which WIPES the app's data on the device:
  adb uninstall $APP_ID && npm run device:install" ;;
    *INSUFFICIENT_STORAGE*)
      die "The device is out of storage. Free space (e.g. adb shell pm clear on other apps) or wipe the AVD." ;;
    *) die "adb install failed (output above)." ;;
  esac
}
