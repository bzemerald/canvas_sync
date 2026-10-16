#!/bin/bash
# idle.sh [seconds]: how long since the last keyboard/mouse input, and which app is in front.
# Exits 1 if there was input in the last [seconds] (default 180): the user may be at the Mac,
# and synthetic clicks would get mixed up with theirs. (Our own clicks count as input too.)
need=${1:-180}
idle=$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}')
front=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)
echo "idle ${idle}s, in front: ${front}"
[ "$idle" -ge "$need" ]
