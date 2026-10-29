#!/bin/bash
# Type text into a UI field via clipboard paste — immune to IME interference.
# Usage: type.sh <x> <y> <text>   (screen coordinates in points)
# The field is focused by clicking first; existing content is replaced (cmd+a).
set -euo pipefail
X="$1"; Y="$2"; TEXT="$3"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

osascript -e 'set the clipboard to "'"${TEXT//\"/\\\"}"'"'
swift "$SCRIPT_DIR/click.swift" "$X" "$Y"
sleep 0.4
osascript -e 'tell application "System Events" to keystroke "a" using command down'
sleep 0.2
osascript -e 'tell application "System Events" to keystroke "v" using command down'
sleep 0.4
echo "typed into $X,$Y"
