#!/bin/bash
# front.sh: brings the app forward (out of Stage Manager's strip) and waits until its window
# has settled at full size, so clicks land where the screenshot says.
here="$(cd "$(dirname "$0")" && pwd)"
osascript -e 'tell application "System Events" to set frontmost of process "canvas-desktop" to true' || exit 1
for _ in $(seq 1 30); do
  sleep 0.5
  line=$("$here/bin/winid" canvas-desktop | awk '$2 == "1" && $0 ~ /Canvas Sync$/')
  size=$(echo "$line" | awk '{print $3}')
  w=${size%x*}; h=${size#*x}
  if [ -n "$line" ] && [ "${w%.*}" -ge 600 ] && [ "${h%.*}" -ge 400 ]; then sleep 1; echo "$line"; exit 0; fi
done
echo "the window didn't settle" >&2; exit 1
