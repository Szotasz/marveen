#!/bin/bash
# Marveen Channels -- Claude Code + Telegram bridge tmux session-ben
#
# A LaunchAgent hívja. Működés:
# 1. Tmux session indul a claude processzel
# 2. A script vár amíg a session él
# 3. Ha a claude kilép, a tmux session záródik, a script is kilép
# 4. A launchd KeepAlive újraindítja
#
# Kézzel rácsatlakozás: tmux attach -t marveen-channels

SESSION="marveen-channels"

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

CLAUDE="$(command -v claude)"
TMUX="$(command -v tmux)"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
[ -z "$TMUX" ]   && echo "ERROR: tmux not found on PATH" >&2 && exit 1

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Régi session takarítás
$TMUX kill-session -t "$SESSION" 2>/dev/null

# Tmux session indítás
$TMUX new-session -d -s "$SESSION" -c "$INSTALL_DIR" \
  "$CLAUDE --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official"

# Bot menü beállítás (15 sec késleltetéssel, a plugin után)
"$INSTALL_DIR/scripts/set-bot-menu.sh" &

# Várakozás amíg a session él
while $TMUX has-session -t "$SESSION" 2>/dev/null; do
  sleep 5
done

exit 0
