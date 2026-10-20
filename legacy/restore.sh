#!/bin/bash
# Re-enables packages disabled by debloat.sh.
# Usage: bash restore.sh [device] [package ...]   (no packages = restore all)
DIR="$(cd "$(dirname "$0")" && pwd)"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
DEV="${1:-192.168.1.101:5555}"
shift
if [ $# -gt 0 ]; then PKGS=("$@"); else PKGS=($(cat "$DIR/disabled_packages.txt")); fi

for p in "${PKGS[@]}"; do
  printf '%-40s ' "$p"
  "$ADB" -s "$DEV" shell pm enable --user 0 "$p" 2>&1 | tr -d '\r'
done
