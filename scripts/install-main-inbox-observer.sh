#!/bin/bash
# install-main-inbox-observer.sh
#
# Installs the launchd twin of scripts/systemd/main-inbox-observer.timer
# (macOS). Without this unit the out-of-process observer of the main agent's
# inbox (scripts/main-inbox-observer.sh) never runs, and the queue keeps the
# property this exists to remove: mail addressed to the main agent can sit
# pending forever with nothing outside the dashboard process to notice.
#
# The unit is what makes the fix real. scripts/watchdog.sh is the cautionary
# case: it documents a cron line in its own header and nothing ever installs it
# -- no crontab entry, no plist, no systemd unit anywhere in the repository, so
# it can sit at zero runs indefinitely.
#
# Period parity with the systemd timer:
#   OnUnitActiveSec=5min  -> StartInterval 300
#   OnBootSec=2min        -> RunAtLoad true (launchd has no boot-delay knob for
#                            agents; an immediate first run is safe -- the tick
#                            is read-only apart from its own stamps)
#
# Five minutes against a 30-minute stall threshold leaves six ticks inside one
# threshold window, so a single missed tick can never delay the alert past it.
#
# Usage:
#   scripts/install-main-inbox-observer.sh            # install, do not start
#   scripts/install-main-inbox-observer.sh --load     # install and start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# #1873: com.<SERVICE_ID>.main-inbox-observer, not a fixed com.marveen.main-inbox-observer -- two installs
# under one user must not share (and overwrite) one helper job.
. "$SCRIPT_DIR/launchd-label.sh"
LABEL="$(helper_launchd_label "$PROJECT_DIR" main-inbox-observer)"
# update.sh asks the installer for the label instead of grepping a fixed one.
if [ "${1:-}" = "--print-label" ]; then printf '%s\n' "$LABEL"; exit 0; fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OBSERVER="$PROJECT_DIR/scripts/main-inbox-observer.sh"

LOAD=0
[ "${1:-}" = "--load" ] && LOAD=1

if [ ! -f "$OBSERVER" ]; then
  echo "ERROR: $OBSERVER not found." >&2
  exit 1
fi

# macOS ONLY, and it has to say so out loud. This script writes a launchd plist,
# and launchd exists on Darwin alone -- but nothing here used to check: on Linux
# it created ~/Library/LaunchAgents, wrote a plist that nothing on the system
# reads, and exited 0. A green install with no observer is worse than a failed
# one, because the failure is what would have sent someone to the systemd twin.
# That twin is scripts/systemd/main-inbox-observer.{service,timer}, installed by
# install-linux.sh on a fresh host and by update.sh on an existing one.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: this installer is macOS-only (it writes a launchd plist; $(uname -s) has no launchd)." >&2
  echo "       On Linux the observer ships as systemd units instead:" >&2
  echo "       scripts/systemd/main-inbox-observer.service + .timer (install-linux.sh / update.sh install them)." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
# ISSUE1895 (#1895): the job's TZ is the install zone, written only when the
# operator pinned one (SCHEDULER_TZ); otherwise no TZ key, so the job follows the
# OS zone like the main dashboard/channels units. It used to be a hardcoded
# Europe/Budapest, so on any other install its log stamps ran off the dashboard's.
. "$SCRIPT_DIR/lib/install-tz.sh"
PINNED_TZ="$(install_tz_pinned "$PROJECT_DIR")"
TZ_XML=""
if [ -n "$PINNED_TZ" ]; then
  # Leading newline: it is appended to the line above, so an unpinned plist
  # has no blank line where the key would be.
  TZ_XML="
    <key>TZ</key>
    <string>$PINNED_TZ</string>"
fi
retire_legacy_helper_label "$PROJECT_DIR" main-inbox-observer "$LABEL" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$OBSERVER</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/store/main-inbox-observer.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/store/main-inbox-observer.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>USER</key>
    <string>$(id -un)</string>$TZ_XML
  </dict>
</dict>
</plist>
PLIST_EOF
echo "Wrote launchd unit: $PLIST"

if [ "$LOAD" = "1" ]; then
  # ISSUE1891 (#1891): registered AND run once, verified -- not a bare load.
  . "$SCRIPT_DIR/launchd-unit.sh"
  RUNS="$(start_launchd_periodic_unit "$PLIST" "$LABEL")"
  if [ -z "$RUNS" ]; then
    echo "NOT RUNNING: $LABEL is installed but did not run. launchd runs these jobs only inside a GUI login session (an install over SSH has none). From a terminal of the GUI login:" >&2
    print_periodic_unit_remedy "$PLIST" "$LABEL" >&2
    exit 3
  fi
  echo "Loaded $LABEL (every 300s + at load). It reads the queue read-only (python3 sqlite3) and alerts over the direct Bot API, so it keeps working while the dashboard process is down."
  echo "Liveness is measurable from outside: store/.main-inbox-observer is rewritten on every tick."
else
  echo "Installed but NOT loaded. To start: launchctl load $PLIST"
fi
