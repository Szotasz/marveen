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
#
# --continue csak akkor mukodik ha mar van mentett session log a
# .claude/projects/<this-cwd>/*.jsonl alatt. Friss telepitesnel nincs ->
# Claude Code "No conversation found to continue" hibaval kilep, a launchd
# tight-loopban ujraindit. Ezert csak akkor adjuk meg, ha latjuk hogy van
# mentett session, kulonben szuretlenul indul (uj beszelgetes).
PROJECT_KEY="$(echo "$INSTALL_DIR" | sed 's|/|-|g')"
CLAUDE_PROJECT_DIR="$HOME/.claude/projects/${PROJECT_KEY}"
CONTINUE_FLAG=""
if [ -d "$CLAUDE_PROJECT_DIR" ] && ls "$CLAUDE_PROJECT_DIR"/*.jsonl >/dev/null 2>&1; then
  CONTINUE_FLAG="--continue"
fi

$TMUX new-session -d -s "$SESSION" -c "$INSTALL_DIR" \
  "$CLAUDE --dangerously-skip-permissions $CONTINUE_FLAG --channels plugin:telegram@claude-plugins-official"

# Session startup guard: a Claude Code first-run dialogusait auto-accept-eljuk
# kulonben a headless session orokre parkolna a prompton es a Telegram plugin
# soha nem toltodne be. Tobb fajta dialog elofordulhat:
#  - "Bypass Permissions mode" (--dangerously-skip-permissions confirmation,
#    valasz: 2 Enter = "Yes, I accept")
#  - "Do you trust the files in this folder?" / "trust" prompts (Y Enter)
#  - "Welcome to Claude Code" / kezdo vezetes (Enter a folytatashoz)
# 12 sec timeout ket retry-jal, mert WSL/tmux paint slow lehet first-run-on.
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 1
  pane=$($TMUX capture-pane -t "$SESSION" -p 2>/dev/null || true)
  case "$pane" in
    *"Bypass Permissions mode"*)
      $TMUX send-keys -t "$SESSION" "2" Enter
      sleep 1
      continue
      ;;
    *"trust"*|*"Trust"*)
      $TMUX send-keys -t "$SESSION" "1" Enter
      sleep 1
      continue
      ;;
    *"Welcome to Claude Code"*)
      $TMUX send-keys -t "$SESSION" Enter
      sleep 1
      continue
      ;;
    *"Listening for channel messages"*)
      break
      ;;
  esac
done

# Bot menü beállítás (15 sec késleltetéssel, a plugin után)
"$INSTALL_DIR/scripts/set-bot-menu.sh" &

# Várakozás amíg a session él
while $TMUX has-session -t "$SESSION" 2>/dev/null; do
  sleep 5
done

exit 0
