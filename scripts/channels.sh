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

# Read MAIN_AGENT_ID from .env WITHOUT exporting every variable into the
# shell environment. `set -a && source .env` would also export
# TELEGRAM_BOT_TOKEN, which then leaks into the tmux server's global
# environment and gets inherited by every sub-agent tmux session the
# dashboard starts later -- they'd all use the main agent's token and
# fight over the same getUpdates slot, 409 Conflict in a tight loop.
if [ -f "$INSTALL_DIR/.env" ]; then
  MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
fi
SESSION="${MAIN_AGENT_ID:-marveen}-channels"

# Extra safety net for existing installs whose tmux server already has a
# polluted global env -- scrub the key so new child sessions don't inherit it.
# The main agent's plugin will still load its token from
# ~/.claude/channels/telegram/.env via the plugin's own bootstrap.
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
unset TELEGRAM_BOT_TOKEN

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
