#!/usr/bin/env bash
# device:shot — screenshot the device and print the PNG's path (then Read it).
#
#   npm run device:shot -- <name>
#
# Writes $TRACKNOTES_SHOT_DIR/<name>.png (default /tmp/tracknotes-shots),
# overwriting an earlier shot of the same name.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

name="${1:-}"
case "$name" in
  -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
  "") die "Name the screenshot: npm run device:shot -- <name>" ;;
esac
name="${name%.png}"
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "Use letters, digits, '.', '_' or '-' in the name, got: $name"
require_device

dir="${TRACKNOTES_SHOT_DIR:-/tmp/tracknotes-shots}"
mkdir -p "$dir"
out="$dir/$name.png"
adbs exec-out screencap -p >"$out.part" || { rm -f "$out.part"; die "adb screencap failed."; }
if [ "$(head -c 4 "$out.part" | od -An -tx1 | tr -d ' \n')" != 89504e47 ]; then
  head -c 200 "$out.part" >&2; rm -f "$out.part"
  die "screencap did not return a PNG (output above) — is the device still booting or the screen off?"
fi
mv "$out.part" "$out"
printf '%s\n' "$out"
