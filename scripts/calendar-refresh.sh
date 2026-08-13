#!/usr/bin/env bash
# Refreshes store/calendar-today.json for the morning briefing.
#
# Runs under the com.marveen.calendar LaunchAgent, NOT from the agent's tmux
# session -- that is the whole point. macOS binds the calendar permission to
# the responsible process, which under tmux is the long-lived tmux server; a
# LaunchAgent gets its own identity and can actually show the consent dialog.
# See the header of calendar-events.swift.
set -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/scripts/bin/calendar-events"
OUT="$ROOT/store/calendar-today.json"
TMP="$OUT.tmp.$$"

if [ ! -x "$BIN" ]; then
  echo "calendar-refresh: HIBA -- nincs meg a binaris: $BIN (fordisd: swiftc -O scripts/calendar-events.swift -o $BIN)" >&2
  exit 1
fi

# The binary exits non-zero when it could NOT read the calendar -- but it still
# prints a valid JSON body saying so, and that body is exactly what we want on
# disk. A missing status is worse than a bad one: the reader would call the
# file absent and we would lose the reason.
"$BIN" "$@" > "$TMP" 2>/dev/null
rc=$?

if [ ! -s "$TMP" ]; then
  rm -f "$TMP"
  echo "calendar-refresh: HIBA -- a binaris ures kimenetet adott (rc=$rc)" >&2
  exit 1
fi

# Reject a truncated or non-JSON body before it replaces a good snapshot.
if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$TMP" 2>/dev/null; then
  rm -f "$TMP"
  echo "calendar-refresh: HIBA -- a kimenet nem ervenyes JSON (rc=$rc)" >&2
  exit 1
fi

# Atomic swap: a reader never sees a half-written file.
mv -f "$TMP" "$OUT" || { rm -f "$TMP"; exit 1; }

status="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('status','?'))" "$OUT" 2>/dev/null)"
count="$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1])).get('events') or []))" "$OUT" 2>/dev/null)"
echo "calendar-refresh: $OUT  status=$status  esemeny=$count"

exit "$rc"
