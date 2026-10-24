#!/bin/bash
# PreToolUse hook (matcher "*"), KILLSWITCH1022: while the fleet is frozen
# (store/fleet-freeze.json exists), every tool call is denied with exit 2.
# Deliberately tiny: no interpreter, no parsing, one file test. The dashboard
# owns the switch (POST /api/fleet/freeze, /api/fleet/unfreeze); see
# docs/fleet-freeze.md. FLEET_FREEZE_FILE overrides the path (tests only).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FREEZE="${FLEET_FREEZE_FILE:-$ROOT/store/fleet-freeze.json}"
if [ -e "$FREEZE" ]; then
  echo "FLOTTA FAGYASZTVA (piros gomb, KILLSWITCH1022): most egyetlen eszkozt sem futtathatsz. Ne probalkozz megkerulni: varj, a gazda a dashboardon oldja fel." >&2
  exit 2
fi
exit 0
