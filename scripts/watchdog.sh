#!/bin/bash
# Watchdog: checks sessions every 5 minutes, restarts if missing.
# Cron: */5 * * * * ~/marveen/scripts/watchdog.sh

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$INSTALL_DIR/logs/watchdog.log"
mkdir -p "$INSTALL_DIR/logs"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }


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
    "http://localhost:3420/api/messages?to=${AGENT_ID}&limit=200" 2>/dev/null) || return

  [ -z "$RESPONSE" ] || [ "$RESPONSE" = "[]" ] && return

  TMPDATA=$(mktemp)
  echo "$RESPONSE" > "$TMPDATA"

  python3 - "$SESSION_NAME" "$AGENT_ID" "$CUTOFF" "$TMPDATA" <<'PYEOF' 2>/dev/null
import json, sys, subprocess, time

session_name, agent_id, cutoff_str, data_file = sys.argv[1:5]
cutoff = int(cutoff_str)

with open(data_file) as f:
    msgs = json.load(f)

pending = [
    m for m in msgs
    if m.get('to_agent') == agent_id
       and m.get('status') == 'delivered'
       and m.get('completed_at') is None
       and m.get('created_at', 0) >= cutoff
]

if not pending:
    sys.exit(0)

print(f"[watchdog] {agent_id}: replaying {len(pending)} unfinished message(s)", flush=True)
time.sleep(15)  # let claude boot up and reach the prompt

for m in pending:
    content = m.get('content', '')
    full_msg = f"[Újraküldés - feladat elveszett restart előtt]: {content}"
    chunk_size = 990
    for i in range(0, len(full_msg), chunk_size):
        chunk = full_msg[i:i + chunk_size]
        subprocess.run(['tmux', 'send-keys', '-t', session_name, '-l', chunk],
                       timeout=5, capture_output=True)
    subprocess.run(['tmux', 'send-keys', '-t', session_name, 'Enter'],
                   timeout=5, capture_output=True)
    time.sleep(2)

PYEOF

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

  CHAN_DIR="$AGENT_DIR/.claude/channels/telegram"
  BOT_TOKEN=$(grep "TELEGRAM_BOT_TOKEN" "$CHAN_DIR/.env" 2>/dev/null | cut -d= -f2- | head -1)
  MODEL=$(python3 -c "import json; d=json.load(open('$AGENT_DIR/agent-config.json')); print(d.get('model','claude-haiku-4-5-20251001'))" 2>/dev/null || echo "claude-haiku-4-5-20251001")

  if [ -z "$BOT_TOKEN" ]; then
    echo "$(timestamp) [watchdog] $AGENT_ID: no bot token, skipping" >> "$LOG"
    continue
  fi

  CMD="export PATH=\"/opt/homebrew/bin:\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export TELEGRAM_STATE_DIR=\"$CHAN_DIR\" && cd \"$AGENT_DIR\" && ${CLAUDE_BIN} --dangerously-skip-permissions --model $MODEL --channels plugin:telegram@claude-plugins-official"

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
