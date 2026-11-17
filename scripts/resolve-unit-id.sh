#!/bin/bash
# Sourced by start.sh and stop.sh. Needs INSTALL_DIR and SLUG (MAIN_AGENT_ID);
# sets UNIT_ID, the name the service units carry.
#
# The installer names the units (systemd <id>-dashboard/-channels, launchd
# com.<id>.*) after SERVICE_ID, which equals MAIN_AGENT_ID unless .env sets it
# apart (e.g. a renamed agent keeping its old units). Resolved like backup.sh:
# last definition wins, quotes stripped.
#
# Fallback (review of #2667): if no unit exists under SERVICE_ID but one does
# under MAIN_AGENT_ID (e.g. SERVICE_ID added to .env by hand, units never
# re-installed), use that one. Without this, start.sh finds no unit, falls
# through to the direct nohup launch and starts a second dashboard and channel
# next to the ones the existing units still run.

_unit_exists() { # <id> -> 0 if a dashboard unit or LaunchAgent with that id exists
  local id="$1"
  if [ "$(uname -s)" = "Darwin" ]; then
    [ -f "$HOME/Library/LaunchAgents/com.${id}.dashboard.plist" ]
    return
  fi
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl cat "${id}-dashboard.service" >/dev/null 2>&1 && return 0
  systemctl --user cat "${id}-dashboard.service" >/dev/null 2>&1
}

UNIT_ID=""
if [ -f "$INSTALL_DIR/.env" ]; then
  UNIT_ID="$(grep -E '^[[:space:]]*SERVICE_ID[[:space:]]*=' "$INSTALL_DIR/.env" | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')"
fi
UNIT_ID="${UNIT_ID:-$SLUG}"

if [ "$UNIT_ID" != "$SLUG" ] && ! _unit_exists "$UNIT_ID" && _unit_exists "$SLUG"; then
  echo "WARN: no service unit named ${UNIT_ID}-*, using the existing ${SLUG}-* units (SERVICE_ID in .env does not match the installed units)" >&2
  UNIT_ID="$SLUG"
fi
