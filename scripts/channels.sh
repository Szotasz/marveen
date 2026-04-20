#!/bin/bash
# Main agent Channels -- Claude Code + Telegram bridge tmux session-ben
#
# A LaunchAgent hívja. Működés:
# 1. Tmux session indul a claude processzel
# 2. A script vár amíg a session él
# 3. Ha a claude kilép, a tmux session záródik, a script is kilép
# 4. A launchd KeepAlive újraindítja
#
# Kézzel rácsatlakozás: tmux attach -t <MAIN_AGENT_ID>-channels (pl. marveen-channels)

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Source .env so we know the installer's MAIN_AGENT_ID. Older installs may not
# have this key, so fall back to "marveen" to keep them working.
if [ -f "$INSTALL_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$INSTALL_DIR/.env"
  set +a
fi
SESSION="${MAIN_AGENT_ID:-marveen}-channels"

export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

CLAUDE="$(command -v claude)"
TMUX="$(command -v tmux)"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
[ -z "$TMUX" ]   && echo "ERROR: tmux not found on PATH" >&2 && exit 1

# Régi session takarítás
$TMUX kill-session -t "$SESSION" 2>/dev/null

# Tmux session indítás
$TMUX new-session -d -s "$SESSION" -c "$INSTALL_DIR" \
  "$CLAUDE --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official"

# Session startup guard: if the --dangerously-skip-permissions confirmation
# dialog appears (despite the settings.json flag, e.g. on a Claude Code
# version that renamed the key), auto-accept it. Without this the headless
# session would park forever and the Telegram plugin would never load.
for i in 1 2 3 4 5 6; do
  sleep 1
  pane=$($TMUX capture-pane -t "$SESSION" -p 2>/dev/null || true)
  if echo "$pane" | grep -q "Bypass Permissions mode"; then
    $TMUX send-keys -t "$SESSION" "2" Enter
    break
  fi
  if echo "$pane" | grep -q "Listening for channel messages"; then
    break
  fi
done

# Bot menü beállítás (15 sec késleltetéssel, a plugin után)
"$INSTALL_DIR/scripts/set-bot-menu.sh" &

# Várakozás amíg a session él
while $TMUX has-session -t "$SESSION" 2>/dev/null; do
  sleep 5
done

exit 0
