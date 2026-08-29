#!/bin/bash
# Stop main agent services

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# See channels.sh for why we grep instead of `set -a && source`.
if [ -f "$INSTALL_DIR/.env" ]; then
  SLUG="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  BOT_NAME="$(grep -E '^BOT_NAME=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
fi
SLUG="${SLUG:-marveen}"

MARVEEN_LANG="$(cat "${INSTALL_DIR}/.lang" 2>/dev/null || echo hu)"
# shellcheck source=../install-lang.sh
source "${INSTALL_DIR}/install-lang.sh"

echo "${BOT_NAME:-Marveen} $(_t stop.stopping)"
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/com.${SLUG}.dashboard.plist" 2>/dev/null
  launchctl unload "$HOME/Library/LaunchAgents/com.${SLUG}.channels.plist" 2>/dev/null
elif [ "$OS" = "Linux" ]; then
  # A root-style install runs the services as SYSTEM units, and as root
  # `systemctl --user` fails -- so this script used to fall through to the
  # pidfile fallback, kill a possibly-stale pidfile PID, report success, and
  # leave the system-unit services running. Check the system scope FIRST
  # (`systemctl cat` sees system units from any uid), and if stopping them
  # fails, say so instead of claiming success over still-running services.
  if pidof systemd >/dev/null 2>&1 && systemctl cat "${SLUG}-dashboard.service" >/dev/null 2>&1; then
    if ! systemctl stop "${SLUG}-dashboard" "${SLUG}-channels" 2>/dev/null; then
      echo "ERROR: system units ${SLUG}-dashboard/${SLUG}-channels exist but could not be stopped (run as root?)" >&2
      exit 1
    fi
  elif pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    systemctl --user stop "${SLUG}-dashboard" "${SLUG}-channels" 2>/dev/null || true
  else
    for svc in dashboard channels; do
      pidfile="$INSTALL_DIR/store/${svc}.pid"
      if [ -f "$pidfile" ]; then
        pid=$(cat "$pidfile")
        kill "$pid" 2>/dev/null || true
        rm -f "$pidfile"
      fi
    done
  fi
fi

# Stop the main channels tmux session. Do NOT kill sub-agent sessions --
# the dashboard restart (update flow) doesn't need them down, and this
# script doesn't bring them back up. Leaving them running keeps the
# update seamless for the operator.
tmux kill-session -t "${SLUG}-channels" 2>/dev/null || true

echo "✓ ${BOT_NAME:-Marveen} $(_t stop.stopped)"
