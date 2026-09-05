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
    # Signal, then WAIT for the process to actually be gone. `kill` only queues
    # a SIGTERM; returning immediately means this script reports "stopped" while
    # the service is still winding down, and the next start.sh (the update
    # finalizer runs stop.sh then start.sh back to back) races a half-dead
    # process. SIGKILL after the grace period so a wedged service cannot make
    # the caller hang forever.
    #
    # The pidfile is removed only once the process is CONFIRMED gone. Removing it
    # up front means that a service surviving even SIGKILL -- uninterruptible
    # sleep on a stuck mount or device -- leaves start.sh with no pidfile and
    # therefore no reason not to launch a SECOND instance: the exact double
    # poller this pair of scripts exists to prevent. A survivor keeps its pidfile
    # so the next start.sh correctly reads the service as still running.
    for svc in dashboard channels; do
      pidfile="$INSTALL_DIR/store/${svc}.pid"
      if [ -f "$pidfile" ]; then
        pid=$(cat "$pidfile")
        case "$pid" in ''|*[!0-9]*) rm -f "$pidfile"; continue ;; esac
        kill "$pid" 2>/dev/null || true
        i=0
        while [ "$i" -lt 15 ] && kill -0 "$pid" 2>/dev/null; do
          sleep 1; i=$(( i + 1 ))
        done
        if kill -0 "$pid" 2>/dev/null; then
          echo "  ${svc}: nem allt le ${i}s alatt, SIGKILL." >&2
          kill -9 "$pid" 2>/dev/null || true
          i=0
          while [ "$i" -lt 5 ] && kill -0 "$pid" 2>/dev/null; do
            sleep 1; i=$(( i + 1 ))
          done
        fi
        if kill -0 "$pid" 2>/dev/null; then
          echo "  ${svc}: pid ${pid} a SIGKILL-t is tulelte; a ${pidfile} MARAD, hogy a start.sh ne inditson masodik peldanyt." >&2
        else
          rm -f "$pidfile"
        fi
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
