#!/bin/bash
# Start main agent services

# Dashboard port: env WEB_PORT, else the install .env, else the 3420 default.
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$(dirname "$0")/../.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')}"
WEB_PORT="${WEB_PORT:-3420}"

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Read only what this script actually needs; avoid `set -a && source .env`,
# which would leak TELEGRAM_BOT_TOKEN into the environment and then into
# every tmux session the dashboard launches (see channels.sh for details).
if [ -f "$INSTALL_DIR/.env" ]; then
  SLUG="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  BOT_NAME="$(grep -E '^BOT_NAME=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
fi
SLUG="${SLUG:-marveen}"

MARVEEN_LANG="$(cat "${INSTALL_DIR}/.lang" 2>/dev/null || echo hu)"
# shellcheck source=../install-lang.sh
source "${INSTALL_DIR}/install-lang.sh"

# Root VPS / container: claude refuses --dangerously-skip-permissions as uid 0.
# The dashboard (and the agent tmux sessions it spawns) hit the same wall as
# channels.sh, so export the sandbox escape hatch for the whole stack when root.
[ "$(id -u)" = "0" ] && export IS_SANDBOX=1

# Prune stale hook paths (e.g. /tmp scratchpad installs that survived a reboot)
# before launching agents -- a missing hook script causes non-zero exit which
# blocks every UserPromptSubmit, creating a silent fleet lockout (2026-07-14 incident).
INSTALL_DIR="$INSTALL_DIR" python3 "${INSTALL_DIR}/scripts/boot-hook-prune.py" 2>&1 | grep -v '^$' | sed 's/^/[boot-hook-prune] /' || true

# Timestamp every run: this script appends to store/boot.log across reboots,
# and without a date the log cannot tell "started once" from "started twice".
echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
echo "${BOT_NAME:-Marveen} $(_t start.starting)"
OS="$(uname -s)"
LAUNCHD_FAILED=""
if [ "$OS" = "Darwin" ]; then
  # `launchctl load` alone leaves a RunAtLoad job pended on modern macOS, so
  # this script used to print the dashboard URL and "channel started" over two
  # units that never ran. Same helper as install-macos.sh: load, kickstart,
  # verify.
  . "${INSTALL_DIR}/scripts/launchd-unit.sh"
  for _svc in dashboard channels; do
    if [ -z "$(start_launchd_unit "com.${SLUG}.${_svc}")" ]; then
      LAUNCHD_FAILED="${LAUNCHD_FAILED}${_svc} "
    fi
  done
  unset _svc
elif [ "$OS" = "Linux" ]; then
  # System-scope units first (root-style install): as root `systemctl --user`
  # fails, so this script used to fall through to the direct nohup launch and
  # start a SECOND dashboard instance next to the system-unit one
  # (EADDRINUSE crash loop). Mirrors the same branch in stop.sh.
  if pidof systemd >/dev/null 2>&1 && systemctl cat "${SLUG}-dashboard.service" >/dev/null 2>&1; then
    if ! systemctl start "${SLUG}-dashboard" "${SLUG}-channels"; then
      echo "ERROR: system units ${SLUG}-dashboard/${SLUG}-channels exist but could not be started (run as root?)" >&2
      exit 1
    fi
  elif pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    systemctl --user start "${SLUG}-dashboard" "${SLUG}-channels"
  else
    echo "systemd not available (WSL or container), using direct launch..."
    mkdir -p "$INSTALL_DIR/store"
    # The entry is src/index.ts (built to dist/index.js); the old src/web/serve.ts
    # is gone. better-sqlite3 is unsupported under bun (oven-sh/bun#4290), and on
    # some setups `node` on PATH actually resolves to bun -- so pick a real node
    # (its --version starts with "v"; bun's does not) and run the built output.
    NODE_BIN=""
    for cand in node nodejs; do
      cand_path="$(command -v "$cand" 2>/dev/null)" || continue
      case "$("$cand_path" --version 2>/dev/null)" in
        v*) NODE_BIN="$cand_path"; break ;;
      esac
    done
    if [ -z "$NODE_BIN" ]; then
      echo "ERROR: no real node found on PATH (bun cannot run better-sqlite3)." >&2
      exit 1
    fi
    # Idempotent launch. On WSL two independent autostart hooks can reach this
    # script on the same boot -- the wsl.conf [boot] command and a Windows
    # ONLOGON task -- and a plain relaunch would put a second dashboard on the
    # same port and, far worse, a second channels.sh polling the same bot token,
    # which splits incoming messages between two pollers with no error anywhere.
    # flock serializes the two hooks; the pidfile checks below make the loser a
    # no-op. fd 9 is closed in the children so the lock is released when this
    # script exits, not when the daemons do.
    #
    # The critical section is "ensure built, THEN ensure running". `npm run build`
    # writes into the shared dist/, so two hooks arriving on the same boot would
    # otherwise run two concurrent compilers over the same output and the loser
    # could launch from a half-written dist/index.js. A full build of this project
    # measures ~10s here, well inside the wait below.
    #
    # The lock is taken on store/ ITSELF, so it introduces no file of its own.
    # It is deliberately NOT taken on a pidfile: stop.sh unlinks those, and flock
    # binds to the inode, not the name -- so a lock held on an unlinked pidfile
    # silently stops being a mutex. Measured 2026-09-02: with the pidfile removed
    # mid-flight the waiting hook's `exec 9>` created a FRESH inode, flock
    # returned at once, and both hooks entered the critical section together.
    # This is also not the mkdir-style "lock directory" idiom, which really does
    # leave an orphaned lock behind after kill -9; here the directory is only an
    # fd and carries no state, and the kernel drops the flock when the holder
    # dies -- on kill -9 and on power loss alike -- so no boot can inherit a
    # stale lock.
    #
    # Every way of NOT getting the lock says so. The bug this guard exists for is
    # invisible by nature -- two pollers splitting one bot's messages, with no
    # error anywhere -- so silently running without the guard would reintroduce
    # exactly the failure it prevents, minus the evidence. Falling through is
    # still the right choice: the pidfile checks below are the actual protection,
    # and refusing to start would risk leaving the box with nothing running.
    #
    # "Already running" is decided from the pidfile, NOT from `pgrep -f`. An
    # existence check on the process table cannot tell a live service from one
    # that is still winding down, and stop.sh's callers hit exactly that: the
    # update finalizer runs stop.sh then start.sh back to back, so a pgrep check
    # sees the dying dashboard, skips the launch, and leaves the box with
    # nothing running once it finally exits -- the update then fails its health
    # check and rolls back. stop.sh removes the pidfile once the process is
    # confirmed gone, so a deliberate stop is unambiguous here. The pid is
    # cross-checked against /proc/<pid>/cmdline because a pidfile that survived a
    # reboot can point at an unrelated recycled pid.
    _service_live() { # $1 pidfile, $2 cmdline needle
      local _pid
      [ -f "$1" ] || return 1
      _pid="$(cat "$1" 2>/dev/null)"
      case "$_pid" in ''|*[!0-9]*) return 1 ;; esac
      kill -0 "$_pid" 2>/dev/null || return 1
      tr '\0' ' ' < "/proc/$_pid/cmdline" 2>/dev/null | grep -qF "$2"
    }
    _lock_held=""
    if ! command -v flock >/dev/null 2>&1; then
      echo "  flock not found (util-linux); starting WITHOUT the start lock -- the pidfile checks below still apply." >&2
    elif ! exec 9<"$INSTALL_DIR/store"; then
      echo "  cannot open $INSTALL_DIR/store for locking; starting WITHOUT the start lock." >&2
    elif flock -w 120 9; then
      _lock_held=1
    else
      echo "  another start.sh held the start lock for 120s; continuing WITHOUT it." >&2
    fi
    [ -f "$INSTALL_DIR/dist/index.js" ] || (cd "$INSTALL_DIR" && npm run build)
    if _service_live "$INSTALL_DIR/store/dashboard.pid" "dist/index.js"; then
      echo "Dashboard mar fut, ujrainditas kihagyva."
    else
      nohup "$NODE_BIN" "$INSTALL_DIR/dist/index.js" > "$INSTALL_DIR/store/dashboard.log" 2>&1 9>&- &
      echo $! > "$INSTALL_DIR/store/dashboard.pid"
    fi
    if _service_live "$INSTALL_DIR/store/channels.pid" "channels.sh"; then
      echo "Csatorna mar fut, ujrainditas kihagyva."
    else
      nohup bash "$INSTALL_DIR/scripts/channels.sh" > "$INSTALL_DIR/store/channels.log" 2>&1 9>&- &
      echo $! > "$INSTALL_DIR/store/channels.pid"
    fi
    # Released here (not on daemon exit): the pidfiles are already written, so a
    # second hook waking up now sees a live service and correctly no-ops.
    [ -n "$_lock_held" ] && exec 9<&-
    unset _lock_held
  fi
fi

if [ -n "$LAUNCHD_FAILED" ]; then
  # "nem igazolt", not "nem indult el", and no claim about what that means for
  # the bot: this reports what the verification established, nothing beyond it.
  echo "✗ A szolgaltatas indulasa nem igazolt: ${LAUNCHD_FAILED}" >&2
  for _svc in $LAUNCHD_FAILED; do
    echo "  Ujraprobalas: launchctl kickstart -p gui/$(id -u)/com.${SLUG}.${_svc}" >&2
    echo "  Ellenorzes:   launchctl print gui/$(id -u)/com.${SLUG}.${_svc} | grep -E 'state|pid'" >&2
  done
  unset _svc
  exit 1
fi
echo "✓ Dashboard: http://localhost:${WEB_PORT:-3420}"
echo "$(_t start.channel_started)"
