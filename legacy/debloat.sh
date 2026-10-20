#!/bin/bash
# Disables bloat on the TCL G10 Google TV (reversible: see restore.sh).
# Usage: bash debloat.sh [device]   (default 192.168.1.101:5555)
DIR="$(cd "$(dirname "$0")" && pwd)"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
DEV="${1:-192.168.1.101:5555}"

PKGS=(
  # tracking / telemetry
  tv.samba.ssm.ui
  com.tcl.logkit
  # TCL extras
  com.tcl.waterfall.overseas
  com.tcl.channelplus
  com.tcl.esticker
  com.tcl.exhibit
  com.tcl.gamebar
  com.tcl.messagebox
  com.tcl.interactive
  com.tcl.ocean.instructions
  com.tcl.repairguide
  com.tcl.usercenter
  com.tcl.smartalexa
  com.tcl.magiconnectfree
  com.tcl.hearaid
  # Google extras
  com.google.android.feedback
  com.google.android.play.games
  com.android.printspooler
  com.android.wallpaper.livepicker
  com.google.android.apps.tv.dreamx
  # unused streaming / accessibility
  com.amazon.amazonvideo.livingroom
  com.netflix.ninja
  com.google.android.youtube.tvmusic
  com.google.android.videos
  com.google.android.marvin.talkback
  com.tcl.ui_mediaCenter
  com.tcl.t_solo
  com.tcl.tv.tclhome_passive
  com.google.android.youtube.tv
  # stock launcher + setup wizard (Projectivy is home; keep it installed first)
  com.google.android.apps.tv.launcherx
  com.google.android.tungsten.setupwraith
)

for p in "${PKGS[@]}"; do
  printf '%-40s ' "$p"
  "$ADB" -s "$DEV" shell pm disable-user --user 0 "$p" 2>&1 | tr -d '\r'
done
printf '%s\n' "${PKGS[@]}" > "$DIR/disabled_packages.txt"
echo "list saved to $DIR/disabled_packages.txt"
