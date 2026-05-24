#!/bin/bash
# Main agent Channels -- Claude Code channel bridge in a tmux session.
#
# Supports Telegram (default) and Slack providers. The provider is read
# from CHANNEL_PROVIDER in .env; when absent, defaults to "telegram" for
# full backward compatibility.
#
# A LaunchAgent hívja. Működés:
# 1. Tmux session indul a claude processzel
# 2. A script vár amíg a session él
# 3. Ha a claude kilép, a tmux session záródik, a script is kilép
# 4. A launchd KeepAlive újraindítja
#
# Kézzel rácsatlakozás: tmux attach -t <MAIN_AGENT_ID>-channels (pl. marveen-channels)

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Read MAIN_AGENT_ID and CHANNEL_PROVIDER from .env WITHOUT exporting
# every variable into the shell environment. `set -a && source .env`
# would also export TELEGRAM_BOT_TOKEN, which then leaks into the tmux
# server's global environment and gets inherited by every sub-agent tmux
# session the dashboard starts later -- they'd all use the main agent's
# token and fight over the same getUpdates slot, 409 Conflict in a loop.
if [ -f "$INSTALL_DIR/.env" ]; then
  MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  CHANNEL_PROVIDER="$(grep -E '^CHANNEL_PROVIDER=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
fi
CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"
SESSION="${MAIN_AGENT_ID:-marveen}-channels"

# Resolve plugin ID from provider
case "$CHANNEL_PROVIDER" in
  slack)  PLUGIN_ID="slack@jeremylongshore/claude-code-slack-channel" ;;
  *)      PLUGIN_ID="telegram@claude-plugins-official" ;;
esac

# Extra safety net for existing installs whose tmux server already has a
# polluted global env -- scrub channel tokens so new child sessions don't
# inherit them. The main agent's plugin will still load its token from
# ~/.claude/channels/<provider>/.env via the plugin's own bootstrap.
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u SLACK_BOT_TOKEN 2>/dev/null || true
unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN

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
  "$CLAUDE --dangerously-skip-permissions $CONTINUE_FLAG --channels plugin:${PLUGIN_ID}"

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
    *"Bypass Permissions mode"*"Yes, I accept"*)
      $TMUX send-keys -t "$SESSION" "2" Enter
      sleep 1
      continue
      ;;
    *"Do you trust the files in this folder?"*)
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

# Bot menu setup (Telegram only; Slack uses App Manifest)
if [ "$CHANNEL_PROVIDER" = "telegram" ]; then
  "$INSTALL_DIR/scripts/set-bot-menu.sh" &
fi

# Rapid-failure detection: if claude exits within 30s of startup, this is
# likely a config error (bad token, missing plugin, auth issue). We log the
# failure and exit non-zero so the service manager's own back-off kicks in
# instead of tight-looping and burning API tokens.
START_TS=$(date +%s)

# Várakozás amíg a session él
while $TMUX has-session -t "$SESSION" 2>/dev/null; do
  sleep 5
done

ELAPSED=$(( $(date +%s) - START_TS ))
if [ "$ELAPSED" -lt 30 ]; then
  echo "WARN: channels session exited after ${ELAPSED}s (likely config error). Check logs." >&2
  echo "$(date '+%Y-%m-%d %H:%M:%S') rapid-exit after ${ELAPSED}s" >> "$INSTALL_DIR/store/channels-failures.log"
  FAIL_COUNT=$(wc -l < "$INSTALL_DIR/store/channels-failures.log" 2>/dev/null || echo 0)
  FAIL_COUNT=$((FAIL_COUNT))
  if [ "$FAIL_COUNT" -ge 5 ]; then
    echo "ERROR: ${FAIL_COUNT} rapid failures detected. Waiting 300s before next attempt." >&2
    sleep 300
  elif [ "$FAIL_COUNT" -ge 3 ]; then
    echo "WARN: ${FAIL_COUNT} rapid failures. Waiting 60s." >&2
    sleep 60
  fi
  exit 1
fi

# Normal exit: clear failure log
rm -f "$INSTALL_DIR/store/channels-failures.log"
exit 0
