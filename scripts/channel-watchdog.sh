#!/bin/bash
# Independent channels watchdog (systemd --user timer, every 5 min).
#
# WHY a separate timer when the dashboard already has an in-process watchdog:
# the dashboard's watchdog dies WITH the dashboard. This timer is independent,
# so a wedged channels session is still recovered even if the dashboard process
# is down. It is the COARSE net (total-pipe-death / session-wedge); the
# dashboard's userbot inbound-probe handles the finer inbound-only deafness.
#
# Two INDEPENDENT detection signals (PLAN.md GAP 2b, 2026-07-23
# marveen-channels silent outage -- the keepalive signal alone never sees a
# dead model-API token, since the token-free keepalive probe only exercises
# the Telegram Bot API, not Claude):
#   STALE    -- store/.channel-keepalive mtime. Two token-free producers keep
#               it fresh: channel-monitor advances it on organic inbound, and
#               the idle-path channel-keepalive-probe.sh timer touches it every
#               ~3 min while the telegram poller is alive under the channels
#               session. A stale file means the session's channel pipe is
#               genuinely down (wedged / deaf), not merely quiet.
#   AUTHDEAD -- scripts/channels-auth-probe.mjs scans the live pane for the
#               same dead-token markers reauth-healer.ts already detects
#               (Please run /login, API Error: 401, OAuth token expired, ...),
#               ignoring the first-run-gate family (out of scope for this arm).
#               Requires AUTH_DEAD_THRESHOLD_TICKS consecutive dead ticks
#               (~10-15min) before acting -- deliberately coarser than
#               reauth-healer's own ~9-10min confirm cadence, so in the common
#               case (dashboard alive) reauth-healer wins the race and this
#               counter resets to 0 on the next tick without ever firing. This
#               arm only actually fires when reauth-healer couldn't (dashboard
#               down, or channels.sh itself hung) -- the designed backstop role.
#
# Either signal proceeds to the shared grace/backoff/recover step below.
#
# Recovery: `tmux respawn-pane` of ONLY the <id>-channels pane -- the precise,
# fleet-safe restart of just the main channels session. (Historically a
# `systemctl restart` was outright forbidden here: the shared tmux SERVER lives
# in the channels unit's cgroup, and under the old KillMode=control-group a
# restart SIGKILLed the server and every agent session, not just the main one --
# the 2026-06-26 fleet outage. The unit now runs KillMode=process so a restart is
# no longer catastrophic, but respawn-pane stays preferred: it recovers only the
# wedged pane without disturbing any sibling session.)
#
# Safety: a respawn-grace stamp prevents storming; a consecutive-respawn cap
# stops a useless respawn loop when the keepalive is disabled or the problem is
# systemic (it then alerts via the log and backs off instead).

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
KEEPALIVE_FILE="$STORE/.channel-keepalive"
RESPAWN_STAMP="$STORE/.channel-last-respawn"
RESPAWN_COUNT_FILE="$STORE/.channel-watchdog-respawns"
AUTH_DEAD_COUNT_FILE="$STORE/.channel-watchdog-auth-dead-count"
LOG_TAG="channel-watchdog"

STALE_SECONDS=$(( 15 * 60 ))    # keepalive older than this => wedged/deaf
GRACE_SECONDS=$(( 15 * 60 ))    # don't respawn again within this window
MAX_CONSECUTIVE=3               # after this many respawns w/o recovery, back off + alert
AUTH_DEAD_THRESHOLD_TICKS=3     # consecutive dead-token ticks (~15min @ 5min/tick) before acting

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*"; }

# --- resolve the channels session + provider (launch-order / rename independent) ---
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"
# Same helper channels.sh already uses to provision the main-agent isolated
# config dir (PLAN.md GAP 1) -- needed below to give a watchdog-triggered
# respawn the same CLAUDE_CONFIG_DIR the main agent is actually running under.
CHANNEL_PROVIDER="$(grep -E '^CHANNEL_PROVIDER=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"
# Extra co-listen plugins, derived EXACTLY as channels.sh does (see the
# EXTRA_CHANNELS block there). Without this a watchdog respawn silently drops
# every secondary provider: the session comes back on the primary channel only,
# so outbound still works (the MCP tool is loaded) but inbound on the extras is
# dropped with "server not in --channels list" -- a HALF-mute that looks healthy
# to any liveness probe watching the primary. Observed in practice: a watchdog
# respawn dropped the secondary inbound for ~20 minutes while the primary kept
# working, so neither the probes nor the agent itself noticed.
CHANNEL_PLUGINS_EXTRA="$(grep -E '^CHANNEL_PLUGINS_EXTRA=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
EXTRA_CHANNELS=""
for _p in $CHANNEL_PLUGINS_EXTRA; do
  [ -n "$_p" ] && EXTRA_CHANNELS="$EXTRA_CHANNELS plugin:$_p"
done
unset _p

# NB: use TMUX_BIN, not TMUX -- the latter is tmux's own env var (socket,pid,
# session); assigning the binary path to it corrupts server-socket detection.
TMUX_BIN="$(command -v tmux)"
CLAUDE="$(command -v claude)"
if [ -z "$TMUX_BIN" ] || [ -z "$CLAUDE" ]; then
  log "tmux or claude not on PATH; cannot act. PATH=$PATH"
  exit 0
fi

now=$(date +%s)

# --- gate 1: the channels session must EXIST (bridge "running") ---
if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
  log "session $SESSION not present -- systemd marveen-channels.service owns (re)start; watchdog no-op"
  exit 0
fi

# --- signal 1: STALE (keepalive mtime) -- computed independently, no early exit ---
STALE=false
age=0
if [ ! -f "$KEEPALIVE_FILE" ]; then
  # keep-alive task never established -- not "stale" (that would be a config
  # matter, respawning won't help it), but AUTHDEAD below is still checked
  # independently: a genuinely dead token should still recover even when the
  # keepalive probe itself was never configured.
  log "no keepalive file yet ($KEEPALIVE_FILE) -- keep-alive task not established, STALE=false"
else
  ka_mtime=$(stat -c %Y "$KEEPALIVE_FILE" 2>/dev/null || echo 0)
  age=$(( now - ka_mtime ))
  [ "$age" -ge "$STALE_SECONDS" ] && STALE=true
fi

# --- signal 2: AUTHDEAD (pane auth-marker scan via channels-auth-probe.mjs) ---
AUTHDEAD=false
auth_count=$(cat "$AUTH_DEAD_COUNT_FILE" 2>/dev/null || echo 0)
case "$auth_count" in (*[!0-9]*|'') auth_count=0;; esac
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ] && [ -f "$INSTALL_DIR/dist/web/reauth-detect.js" ]; then
  probe_out="$("$TMUX_BIN" capture-pane -p -t "$SESSION" 2>/dev/null | "$NODE_BIN" "$INSTALL_DIR/scripts/channels-auth-probe.mjs" 2>/dev/null)"
  probe_exit=$?
  if [ "$probe_exit" -eq 1 ]; then
    auth_count=$(( auth_count + 1 ))
    echo "$auth_count" > "$AUTH_DEAD_COUNT_FILE"
    if [ "$auth_count" -ge "$AUTH_DEAD_THRESHOLD_TICKS" ]; then
      AUTHDEAD=true
      log "auth-dead ($auth_count consecutive ticks): $probe_out"
    fi
  else
    auth_count=0
    rm -f "$AUTH_DEAD_COUNT_FILE" 2>/dev/null || true
  fi
else
  # Fail-open: no node or no dist build -- treat as healthy, never as dead.
  auth_count=0
fi

# --- neither signal fired: healthy, reset the shared backoff counter, done ---
if [ "$STALE" != true ] && [ "$AUTHDEAD" != true ]; then
  rm -f "$RESPAWN_COUNT_FILE" 2>/dev/null || true
  exit 0
fi

# --- gate 4: respawn grace (shared with the dashboard watchdog) ---
if [ -f "$RESPAWN_STAMP" ]; then
  last=$(stat -c %Y "$RESPAWN_STAMP" 2>/dev/null || echo 0)
  if [ $(( now - last )) -lt "$GRACE_SECONDS" ]; then
    log "problem detected (STALE=$STALE AUTHDEAD=$AUTHDEAD) but within respawn grace -- deferring"
    exit 0
  fi
fi

# --- gate 5: consecutive-respawn backoff ---
count=$(cat "$RESPAWN_COUNT_FILE" 2>/dev/null || echo 0)
case "$count" in (*[!0-9]*|'') count=0;; esac
if [ "$count" -ge "$MAX_CONSECUTIVE" ]; then
  log "ALERT: problem detected (STALE=$STALE AUTHDEAD=$AUTHDEAD) after $count respawns without recovery -- backing off (keepalive disabled or systemic issue). Manual check needed: tmux attach -t $SESSION"
  exit 0
fi

# --- recover: respawn-pane ONLY the channels session, fresh claude ---
# RESPAWNMODEL807: this used to read ONLY .claude/settings.json with jq -- a
# second copy of the model resolution that missed BOTH the .env override (the
# documented per-install route) and the shipped distribution default. The day
# the shipped settings.json stopped pinning a model (#924), this path started
# building a flag-less respawn. One resolver exists and the launch path already
# uses it; ask IT instead of maintaining another copy.
MAIN_MODEL="$(bash "$INSTALL_DIR/scripts/channels.sh" --resolve-main-model 2>/dev/null | head -1)"
MODEL_FLAG=""
[ -n "$MAIN_MODEL" ] && MODEL_FLAG="--model '$MAIN_MODEL' "

# Main-agent isolated-config parity (PLAN.md GAP 1 completeness fix): without
# this, a watchdog-triggered respawn would silently drop the main agent OUT of
# isolated-config mode and back onto the shared ~/.claude -- reintroducing GAP 1
# on exactly the recovery path meant to matter most (dashboard down). Mirrors
# channels.sh's own CFG_ENV construction (channels.sh:254-275) exactly,
# including reading the fleet token via $(cat ...) at spawn time so the secret
# never lands in the RESPAWN_CMD string passed to tmux respawn-pane (visible
# via ps/pane history otherwise).
CFG_ENV=""
if [ -n "$NODE_BIN" ] && [ -f "$INSTALL_DIR/dist/web/agent-process.js" ]; then
  _cfg_line="$("$NODE_BIN" "$INSTALL_DIR/scripts/main-agent-isolated-config.mjs" "$CHANNEL_PROVIDER" 2>>"$STORE/channels-failures.log" || true)"
  _cfg_mode="${_cfg_line%%	*}"
  _cfg_dir="${_cfg_line#*	}"
  if [ -n "$_cfg_line" ] && [ -d "$_cfg_dir" ]; then
    if [ "$_cfg_mode" = "explicit" ]; then
      CFG_ENV="export CLAUDE_CONFIG_DIR='$_cfg_dir' && "
    else
      CFG_ENV="export CLAUDE_CONFIG_DIR='$_cfg_dir' && export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat '$INSTALL_DIR/store/.claude-oauth-token')\" && "
    fi
    log "main-agent $_cfg_mode CLAUDE_CONFIG_DIR=$_cfg_dir"
  fi
  unset _cfg_line _cfg_mode _cfg_dir
fi

# Full PATH with .bun/bin -- without it the respawned bun telegram bridge does
# not come up and the session is channel-less.
RESPAWN_CMD="export PATH=\"/opt/homebrew/bin:\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin\" && export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false && ${CFG_ENV}$CLAUDE --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:${CHANNEL_PROVIDER}@claude-plugins-official${EXTRA_CHANNELS}"

reason="keepalive stale ${age}s"
[ "$STALE" != true ] && reason=""
if [ "$AUTHDEAD" = true ]; then
  if [ -n "$reason" ]; then reason="$reason + auth-dead ($auth_count consecutive ticks)"; else reason="auth-dead ($auth_count consecutive ticks)"; fi
fi

log "$reason and session up -- respawn-pane $SESSION (respawn #$((count+1)))"
if "$TMUX_BIN" respawn-pane -k -t "$SESSION" "$RESPAWN_CMD" 2>/dev/null; then
  date +%s > "$RESPAWN_STAMP"
  echo $(( count + 1 )) > "$RESPAWN_COUNT_FILE"
  rm -f "$AUTH_DEAD_COUNT_FILE" 2>/dev/null || true
  log "respawn-pane issued"
else
  log "respawn-pane FAILED for $SESSION"
fi
exit 0
