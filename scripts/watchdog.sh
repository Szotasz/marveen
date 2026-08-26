#!/bin/bash
# Watchdog: checks sessions every 5 minutes, restarts if missing.
# Cron: */5 * * * * ~/marveen/scripts/watchdog.sh

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$INSTALL_DIR/logs/watchdog.log"
mkdir -p "$INSTALL_DIR/logs"

# Dashboard port: config-driven (.env WEB_PORT), default 3420.
[ -f "$INSTALL_DIR/.env" ] && WEB_PORT="$(grep -E '^WEB_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
WEB_PORT="${WEB_PORT:-3420}"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

# Resolve which channel an agent must be respawned on, from its OWN
# agent-config.json channelProvider -- the same field src/web/agent-process.ts
# launches from. Sets AGENT_PROVIDER / TOKEN_VAR / STATE_ENV_VAR.
#
# Hardcoding telegram here had two failure modes for a non-telegram agent:
# (a) no TELEGRAM_BOT_TOKEN in its .env, so the loop hit "no bot token,
# skipping" and the watchdog NEVER restarted it -- precisely the agent the
# watchdog exists for stayed dead, while the log line looked routine; or
# (b) it came back on the wrong channel and was mute on its real one.
#
# Unknown / missing / malformed provider falls back to telegram, matching
# the pre-existing default so single-channel telegram installs are unaffected.
resolve_agent_provider() {
  local agent_dir="$1"
  AGENT_PROVIDER=$(python3 -c "import json; d=json.load(open('$agent_dir/agent-config.json')); print(d.get('channelProvider','telegram'))" 2>/dev/null || echo telegram)
  [ -n "$AGENT_PROVIDER" ] || AGENT_PROVIDER=telegram
  case "$AGENT_PROVIDER" in
    slack)      TOKEN_VAR="SLACK_BOT_TOKEN";      STATE_ENV_VAR="SLACK_STATE_DIR" ;;
    discord)    TOKEN_VAR="DISCORD_BOT_TOKEN";    STATE_ENV_VAR="DISCORD_STATE_DIR" ;;
    teams)      TOKEN_VAR="TEAMS_BOT_TOKEN";      STATE_ENV_VAR="TEAMS_STATE_DIR" ;;
    googlechat) TOKEN_VAR="GOOGLECHAT_BOT_TOKEN"; STATE_ENV_VAR="GOOGLECHAT_STATE_DIR" ;;
    *)          AGENT_PROVIDER=telegram; TOKEN_VAR="TELEGRAM_BOT_TOKEN"; STATE_ENV_VAR="TELEGRAM_STATE_DIR" ;;
  esac
}

# Self-test hook: print the resolution for one agent dir and exit, without
# touching tmux, the dashboard API or the log. Lets the contract be tested
# from fixtures (scripts/__tests__/watchdog-provider.test.sh) instead of
# requiring a live agent with a real bot token.
if [ "${1:-}" = "--resolve-provider" ]; then
  [ -n "${2:-}" ] || { echo "usage: watchdog.sh --resolve-provider <agent-dir>" >&2; exit 2; }
  resolve_agent_provider "$2"
  echo "provider=$AGENT_PROVIDER token_var=$TOKEN_VAR state_env_var=$STATE_ENV_VAR"
  exit 0
fi


export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

TOKEN=""
if [ -f "$INSTALL_DIR/store/.dashboard-token" ]; then
  TOKEN=$(cat "$INSTALL_DIR/store/.dashboard-token")
fi

# Replays delivered-but-not-completed messages from the last 2 hours into
# a freshly restarted agent session. Called after a confirmed restart.
replay_unfinished_messages() {
  local AGENT_ID="$1"
  local SESSION_NAME="$2"

  [ -z "$TOKEN" ] && return

  local NOW CUTOFF RESPONSE TMPDATA
  NOW=$(date +%s)
  CUTOFF=$(( NOW - 7200 ))

  RESPONSE=$(curl -s -m 5 \
    -H "Authorization: Bearer $TOKEN" \
    "http://localhost:${WEB_PORT}/api/messages?to=${AGENT_ID}&limit=200" 2>/dev/null) || return

  [ -z "$RESPONSE" ] || [ "$RESPONSE" = "[]" ] && return

  TMPDATA=$(mktemp)
  echo "$RESPONSE" > "$TMPDATA"

  # Replay logic extracted to its own file (testable) + MSGSZIVARGAS826: every
  # injected message writes a dated marker into the dashboard log -- this used
  # to be a fully record-less injection path, invisible to every detector.
  python3 "$INSTALL_DIR/scripts/watchdog-replay.py" \
    "$SESSION_NAME" "$AGENT_ID" "$CUTOFF" "$TMPDATA" \
    "$INSTALL_DIR/store/dashboard.log" 2>/dev/null

  rm -f "$TMPDATA"
}

# ── Dashboard ──────────────────────────────────────────────────────────────
DASHBOARD_PID=$(ps -ef | grep "node dist/index.js" | grep -v grep | awk '{print $2}' | head -1)
if [ -z "$DASHBOARD_PID" ]; then
  echo "$(timestamp) [watchdog] Dashboard down, restarting..." >> "$LOG"
  cd "$INSTALL_DIR" && nohup npm start >> "$INSTALL_DIR/logs/dashboard.log" 2>&1 &
  sleep 5
  NEW_PID=$(ps -ef | grep "node dist/index.js" | grep -v grep | awk '{print $2}' | head -1)
  echo "$(timestamp) [watchdog] Dashboard restarted (PID: ${NEW_PID:-?})" >> "$LOG"
fi

# ── Main agent session ─────────────────────────────────────────────────────
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_SESSION="${MAIN_AGENT_ID}-channels"

if ! tmux has-session -t "$MAIN_SESSION" 2>/dev/null; then
  echo "$(timestamp) [watchdog] $MAIN_SESSION missing, restarting..." >> "$LOG"
  nohup "$INSTALL_DIR/scripts/channels.sh" >> "$INSTALL_DIR/logs/marveen-channels.log" 2>&1 &
  sleep 5
  if tmux has-session -t "$MAIN_SESSION" 2>/dev/null; then
    echo "$(timestamp) [watchdog] $MAIN_SESSION restarted OK" >> "$LOG"
  else
    echo "$(timestamp) [watchdog] $MAIN_SESSION restart FAILED" >> "$LOG"
  fi
fi

# ── Sub-agents: restart if missing ────────────────────────────────────────
if [ ! -d "$INSTALL_DIR/agents" ]; then
  exit 0
fi

CLAUDE_BIN="$(command -v claude)"

for AGENT_DIR in "$INSTALL_DIR/agents"/*/; do
  AGENT_ID=$(basename "$AGENT_DIR")
  SESSION_NAME="agent-${AGENT_ID}"

  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    continue
  fi

  echo "$(timestamp) [watchdog] $AGENT_ID missing, restarting..." >> "$LOG"

  resolve_agent_provider "$AGENT_DIR"

  CHAN_DIR="$AGENT_DIR/.claude/channels/$AGENT_PROVIDER"
  BOT_TOKEN=$(grep "$TOKEN_VAR" "$CHAN_DIR/.env" 2>/dev/null | cut -d= -f2- | head -1)
  MODEL=$(python3 -c "import json; d=json.load(open('$AGENT_DIR/agent-config.json')); print(d.get('model','claude-haiku-4-5-20251001'))" 2>/dev/null || echo "claude-haiku-4-5-20251001")

  if [ -z "$BOT_TOKEN" ]; then
    echo "$(timestamp) [watchdog] $AGENT_ID: no $AGENT_PROVIDER bot token, skipping" >> "$LOG"
    continue
  fi

  CMD="export PATH=\"/opt/homebrew/bin:\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export ${STATE_ENV_VAR}=\"$CHAN_DIR\" && cd \"$AGENT_DIR\" && ${CLAUDE_BIN} --dangerously-skip-permissions --model '$MODEL' --channels plugin:${AGENT_PROVIDER}@claude-plugins-official"

  tmux new-session -d -s "$SESSION_NAME" "$CMD" 2>/dev/null
  sleep 2

  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "$(timestamp) [watchdog] $AGENT_ID restarted OK" >> "$LOG"
    REPLAY_OUT=$(replay_unfinished_messages "$AGENT_ID" "$SESSION_NAME" 2>&1)
    [ -n "$REPLAY_OUT" ] && echo "$(timestamp) $REPLAY_OUT" >> "$LOG"
  else
    echo "$(timestamp) [watchdog] $AGENT_ID restart FAILED" >> "$LOG"
  fi
done
