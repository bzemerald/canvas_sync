#!/bin/bash
# shot.sh out.png: captures the app's main window, even under other windows. (Not in Stage
# Manager's strip: that's a thumbnail; front.sh first.) The image is 2x (Retina): halve.py
# makes a copy in points, the units mouse uses.
here="$(cd "$(dirname "$0")" && pwd)"
id=$("$here/bin/winid" canvas-desktop | awk '$2 == "1" && $0 ~ /Canvas Sync$/ {print $1}' | head -1)
[ -z "$id" ] && id=$("$here/bin/winid" canvas-desktop | awk '$0 ~ /Canvas Sync$/ {print $1}' | head -1)
[ -z "$id" ] && { echo "no Canvas Sync window" >&2; exit 1; }
screencapture -x -o -l "$id" "$1" && echo "$1"
