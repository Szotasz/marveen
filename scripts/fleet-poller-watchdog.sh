#!/bin/bash
# Fleet poller watchdog -- keeps EVERY agent's Telegram poller alive.
#
# WHY this exists separately from channel-watchdog.sh:
#   channel-watchdog.sh guards ONLY the main Boss session (marveen-channels),
#   using the keep-alive file mtime as its health signal. The 11 FLEET agents
#   (agents/<name>) have no keep-alive round-trip, so NOTHING was watching their
#   pollers. When a fleet agent's `claude --channels` stays up but its bun
#   Telegram MCP child dies, the agent goes SILENT (receives nothing) with no
#   automatic recovery -- exactly the "spinner/success/firesales/saldo nema"
#   incident. This watchdog closes that gap for the whole fleet.
#
# HEALTH SIGNAL (token-free, getUpdates-safe):
#   Each agent runs `claude --channels` which spawns a `bun .../server.ts`
#   Telegram MCP poller. If the pane has a live claude but NO bun descendant,
#   the poller is dead -> the agent is deaf. We never call getUpdates (that
#   would steal the live long-poll and cause 409); we only inspect the local
#   process tree.
#
# RECOVERY:
#   `tmux respawn-pane -k` of ONLY that agent's pane, routed through
#   launch-channels-claude.sh (per-token flock single-flight) with the agent's
#   own TELEGRAM_STATE_DIR + model. respawn-pane -k kills the wedged/deaf claude
#   (releasing any held poller lock); the launcher's -w wait then reacquires and
#   starts a fresh claude --continue --channels, re-establishing the poller.
#   This is dashboard-INDEPENDENT (does not call /api/agents/.../restart), so a
#   flapping dashboard cannot block fleet recovery.
#
# SAFETY (mirrors channel-watchdog.sh):
#   - 2-strike confirmation: a poller seen dead only ONCE is given a grace
#     window (could be mid-boot); only respawned if still dead on a later run.
#   - per-agent respawn grace: never respawn the same agent within GRACE_SECONDS.
#   - consecutive-respawn cap: after MAX_CONSECUTIVE respawns without recovery,
#     back off + log (systemic problem -- respawning won't help, alert instead).
#
# Modes:
#   (default, cron)  2-strike confirmation before respawn.
#   --now            skip the first-detection grace; respawn any dead poller now
#                    (still honors respawn-grace + cap). Use for manual recovery.
#   --dry-run        detect + report only: logs each agent's poller health and
#                    what it WOULD respawn, but takes NO action and mutates NO
#                    state. Safe to run anytime to validate detection.

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
STATE="$STORE/.fleet-poller-watchdog"   # per-agent stamps live here
LAUNCHER="$INSTALL_DIR/scripts/launch-channels-claude.sh"
LOG_TAG="fleet-poller-watchdog"

CONFIRM_SECONDS=$(( 2 * 60 ))    # dead this long (across runs) before respawn
GRACE_SECONDS=$(( 12 * 60 ))     # don't respawn the same agent within this
MAX_CONSECUTIVE=3                # back off + alert after this many w/o recovery

NOW_MODE=0
DRY_RUN=0
FIX_IDENTITY=0
for arg in "$@"; do
  case "$arg" in
    --now)         NOW_MODE=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    --fix-identity) FIX_IDENTITY=1 ;;
  esac
done

mkdir -p "$STATE" 2>/dev/null || true
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*"; }

# IMPORTANT: tmux uses the env var $TMUX to locate its server socket (e.g.
# "/tmp/tmux-0/default,PID,N"). Naming our binary path variable "TMUX" would
# CLOBBER that, making every `tmux` call try to connect to a socket at the
# binary path -> "no server running on /usr/bin/tmux" -> has-session fails ->
# every agent looks "not present" and the watchdog never acts. So use a
# DIFFERENT name AND unset any inherited $TMUX so tmux uses the default socket
# (where the dashboard creates the agent sessions, and where cron sees them).
unset TMUX
TMUX_BIN="$(command -v tmux)"
[ -z "$TMUX_BIN" ] && { log "tmux not on PATH; abort"; exit 0; }
[ -x "$LAUNCHER" ] || { log "launcher missing: $LAUNCHER; abort"; exit 0; }
CLAUDE="$(command -v claude 2>/dev/null || echo /usr/bin/claude)"

now=$(date +%s)

# Telegram-enabled fleet agents (the main Boss is handled by channel-watchdog.sh).
AGENTS="coder firegina firegmovie firegtor firesales irnok kartoreka piktor saldo spinner success tester"

# Static model fallback if the running claude's --model can't be read.
model_for() {
  case "$1" in
    spinner|tester) echo "claude-sonnet-4-6" ;;
    kartoreka)      echo "claude-opus-4-8[1m]" ;;
    *)              echo "claude-opus-4-8" ;;
  esac
}

# Read the --model flag from the claude process currently in the pane (most
# accurate -- preserves whatever the agent was actually launched with).
running_model() {
  local pane_pid="$1" cpid m
  for cpid in $(pgrep -P "$pane_pid" 2>/dev/null) "$pane_pid"; do
    m=$(tr '\0' '\n' < /proc/$cpid/cmdline 2>/dev/null \
        | grep -A1 -x -- '--model' | tail -1)
    [ -n "$m" ] && { echo "$m"; return; }
  done
}

# Does the pane's process tree contain the live Telegram MCP poller?
# Token-free: BFS the descendants and match the poller's OWN cmdline
# (`bun .../server.ts`). This is more precise than `pstree | grep bun` -- it
# confirms the actual server.ts poller, not just any "bun" string in the tree,
# and is robust to the flock->claude->bun launch chain (the pane_pid may be the
# flock single-flight wrapper; we still find server.ts below it).
poller_alive() {
  local root="$1" pid child queue next depth
  queue="$root"
  for depth in 1 2 3 4 5 6; do
    next=""
    for pid in $queue; do
      for child in $(pgrep -P "$pid" 2>/dev/null); do
        if tr '\0' ' ' < "/proc/$child/cmdline" 2>/dev/null | grep -q 'server\.ts'; then
          return 0
        fi
        next="$next $child"
      done
    done
    queue="$next"
    [ -z "$queue" ] && break
  done
  return 1
}

respawn() {
  local agent="$1" pane_pid="$2" mode="${3:-continue}"
  local home="$INSTALL_DIR/agents/$agent"
  local sdir="$home/.claude/channels/telegram"
  local model; model="$(running_model "$pane_pid")"; [ -z "$model" ] && model="$(model_for "$agent")"
  # CRITICAL: the respawned claude MUST start in the agent's OWN home dir, or it
  # loads the wrong CLAUDE.md (e.g. /root/marveen -> the Boss persona) and the
  # agent comes back identity-corrupted (Boss brain on its own bot token).
  # respawn-pane inherits the *calling client's* cwd when -c is omitted, so a
  # cron/manual run from /root/marveen silently mis-homed every agent. Force the
  # pane start-dir with -c AND `cd` defensively inside the command.
  #
  # RESUME-GATE (mode=fresh): `claude --continue` on a large/long session stops
  # at the interactive ">Resume from summary?" prompt and WAITS for input -> the
  # bun poller never starts, and the cron re-kills it every run (churn). For
  # poller RECOVERY we launch FRESH (no --continue): it boots straight to the
  # poller with no prompt. Trade-off: the recovered agent starts a NEW
  # conversation -- acceptable for a deaf agent. (fix-identity keeps --continue.)
  local cont="--continue "
  [ "$mode" = "fresh" ] && cont=""
  local cmd="cd \"$home\" && export PATH=\"\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin\" && \
export TELEGRAM_STATE_DIR=\"$sdir\" && CLAUDE=\"$CLAUDE\" \"$LAUNCHER\" ${cont}--dangerously-skip-permissions --model '$model' --channels plugin:telegram@claude-plugins-official"
  if "$TMUX_BIN" respawn-pane -k -c "$home" -t "agent-$agent" "$cmd" 2>/dev/null; then
    log "RESPAWN agent-$agent (mode=$mode, model=$model, home=$home)"
    return 0
  fi
  log "RESPAWN FAILED agent-$agent"
  return 1
}

# cwd of the `claude --continue` process under a pane (its loaded CLAUDE.md =
# identity). Empty if not found.
claude_cwd() {
  local root="$1" pid child queue next depth
  queue="$root"
  for depth in 1 2 3 4 5 6; do
    next=""
    for pid in $queue; do
      if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'claude --continue'; then
        readlink "/proc/$pid/cwd" 2>/dev/null; return
      fi
      for child in $(pgrep -P "$pid" 2>/dev/null); do next="$next $child"; done
    done
    queue="$next"; [ -z "$queue" ] && break
  done
}

for a in $AGENTS; do
  sess="agent-$a"
  "$TMUX_BIN" has-session -t "$sess" 2>/dev/null || { log "$sess not present -- skip"; continue; }
  pane_pid="$("$TMUX_BIN" list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null | head -1)"
  [ -z "$pane_pid" ] && { log "$sess no pane -- skip"; continue; }

  # --- --fix-identity: re-home any agent whose claude is running from the wrong
  # cwd (loaded the wrong CLAUDE.md). Independent of poller health.
  if [ "$FIX_IDENTITY" -eq 1 ]; then
    home="$INSTALL_DIR/agents/$a"
    cwd="$(claude_cwd "$pane_pid")"
    if [ -z "$cwd" ]; then
      log "FIX-IDENTITY: $sess no claude --continue found -- skip"
    elif [ "$cwd" = "$home" ]; then
      [ "$DRY_RUN" -eq 1 ] && log "FIX-IDENTITY: $sess cwd OK ($cwd)"
    else
      if [ "$DRY_RUN" -eq 1 ]; then
        log "FIX-IDENTITY: $sess WRONG cwd ($cwd != $home) -- WOULD re-home"
      else
        log "FIX-IDENTITY: $sess WRONG cwd ($cwd) -- re-homing to $home"
        respawn "$a" "$pane_pid"
      fi
    fi
    continue
  fi

  dead_stamp="$STATE/$a.dead"
  grace_stamp="$STATE/$a.last-respawn"
  count_file="$STATE/$a.count"

  if poller_alive "$pane_pid"; then
    # Healthy -> clear dead-mark + reset consecutive counter.
    rm -f "$dead_stamp" "$count_file" 2>/dev/null || true
    [ "$DRY_RUN" -eq 1 ] && log "DRY-RUN: $sess poller OK (pane_pid=$pane_pid)"
    continue
  fi

  # --- poller dead ---
  # Dry-run: report the dead poller and stop here -- NO state writes, NO respawn.
  if [ "$DRY_RUN" -eq 1 ]; then
    drm="$(running_model "$pane_pid")"; [ -z "$drm" ] && drm="$(model_for "$a")"
    log "DRY-RUN: $sess poller DEAD (pane_pid=$pane_pid, model=$drm) -- WOULD respawn after 2-strike/grace/cap checks"
    continue
  fi

  # PAUSE flag: detect + log only, NO state writes, NO respawn. Halts cron churn
  # while a controlled recovery is coordinated (the respawn cascade + resume-gate
  # was pulling pollers down repeatedly). Remove the flag to re-arm.
  if [ -f "$STORE/.fleet-poller-watchdog.pause" ]; then
    log "$sess poller DEAD but respawn PAUSED (flag present) -- no action (controlled recovery in progress)"
    continue
  fi

  # 2-strike confirmation (skipped in --now mode).
  if [ "$NOW_MODE" -eq 0 ]; then
    if [ ! -f "$dead_stamp" ]; then
      date +%s > "$dead_stamp"
      log "$sess poller dead (1st sighting) -- grace, will confirm next run"
      continue
    fi
    first=$(cat "$dead_stamp" 2>/dev/null || echo "$now")
    case "$first" in (*[!0-9]*|'') first=$now;; esac
    if [ $(( now - first )) -lt "$CONFIRM_SECONDS" ]; then
      log "$sess poller dead but within confirm window -- deferring"
      continue
    fi
  fi

  # respawn grace
  if [ -f "$grace_stamp" ]; then
    last=$(stat -c %Y "$grace_stamp" 2>/dev/null || echo 0)
    if [ $(( now - last )) -lt "$GRACE_SECONDS" ]; then
      log "$sess poller dead but within respawn grace -- deferring"
      continue
    fi
  fi

  # consecutive-respawn cap
  count=$(cat "$count_file" 2>/dev/null || echo 0)
  case "$count" in (*[!0-9]*|'') count=0;; esac
  if [ "$count" -ge "$MAX_CONSECUTIVE" ]; then
    log "ALERT $sess: poller still dead after $count respawns -- backing off (systemic; manual check: tmux attach -t $sess)"
    continue
  fi

  # Poller recovery launches FRESH (no --continue) to clear the resume-gate.
  if respawn "$a" "$pane_pid" fresh; then
    date +%s > "$grace_stamp"
    echo $(( count + 1 )) > "$count_file"
    rm -f "$dead_stamp" 2>/dev/null || true
  fi
done

exit 0
