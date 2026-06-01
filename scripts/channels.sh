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
  BOT_NAME="$(grep -E '^BOT_NAME=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  # Claude Code auth: pass API key or OAuth token so the tmux-spawned
  # claude process can authenticate. These are safe to export -- unlike
  # TELEGRAM_BOT_TOKEN they don't cause cross-session conflicts.
  _api_key="$(grep -E '^ANTHROPIC_API_KEY=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  [ -n "$_api_key" ] && export ANTHROPIC_API_KEY="$_api_key"
  _oauth="$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  [ -n "$_oauth" ] && export CLAUDE_CODE_OAUTH_TOKEN="$_oauth"
  unset _api_key _oauth
fi
CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"
SESSION="${MAIN_AGENT_ID:-marveen}-channels"

# Resolve plugin ID from provider
case "$CHANNEL_PROVIDER" in
  slack)    PLUGIN_ID="slack-channel@marveen-marketplace" ;;
  discord)  PLUGIN_ID="discord@claude-plugins-official" ;;
  *)        PLUGIN_ID="telegram@claude-plugins-official" ;;
esac

# ROOT-CAUSE NOTE (kali-linux WSL, claude-code 2.1.152, 2026-05-27):
# Inbound MCP notifications from the `--channels` plugin go through a SECOND
# gate beyond --dangerously-skip-permissions / --dangerously-load-development-
# channels: claude-code checks `/etc/claude-code/managed-settings.json`
# allowedChannelPlugins and SILENTLY DROPS notifications from any plugin not
# in that list. The plugin still sends the MCP notification successfully
# (confirmed by debug-logging the plugin), but the session never ingests it.
# Symptom: bot online, plugin debug shows "MCP notification SENT successfully",
# but claude pane shows no <channel source="..."> inbound and the bot never
# replies. Fix is to add the plugin to managed-settings.json (requires sudo).
# Once that's done, the dev-channels flag is unnecessary -- this is why
# the earlier DEVCHANNELS_FLAG block was removed.

# Extra safety net for existing installs whose tmux server already has a
# polluted global env -- scrub channel tokens so new child sessions don't
# inherit them. The main agent's plugin will still load its token from
# ~/.claude/channels/<provider>/.env via the plugin's own bootstrap.
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u SLACK_BOT_TOKEN 2>/dev/null || true
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u DISCORD_BOT_TOKEN 2>/dev/null || true
unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN

# Issue #189: when this script runs from inside an existing tmux session (the
# user's own work session, for example), the inherited TMUX env var points at
# the parent client's socket. Any `tmux new-session` we spawn then tries to
# attach to that socket and fails with "Permission denied" (different uid,
# different socket dir, or just the new-session-from-inside-tmux block). The
# child marveen-channels session must live on a fresh tmux client context, so
# scrub the env var before any tmux command runs.
unset TMUX

export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

CLAUDE="$(command -v claude)"
TMUX="$(command -v tmux)"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
[ -z "$TMUX" ]   && echo "ERROR: tmux not found on PATH" >&2 && exit 1

# Read the main agent's default model from .claude/settings.json so we can
# pass --model explicitly. Without --model claude-code falls back to its
# built-in default, which can drift across versions. Passing the flag makes
# the choice deterministic and visible in `ps`.
MAIN_MODEL=""
if [ -f "$INSTALL_DIR/.claude/settings.json" ] && command -v jq >/dev/null 2>&1; then
  MAIN_MODEL="$(jq -r '.model // empty' "$INSTALL_DIR/.claude/settings.json" 2>/dev/null)"
fi
MODEL_FLAG=""
# Single-quote the model id so values like `claude-opus-4-8[1m]` survive the
# tmux command-string round-trip without the inner shell glob-expanding `[1m]`.
[ -n "$MAIN_MODEL" ] && MODEL_FLAG="--model '$MAIN_MODEL' "

# Régi session takarítás
$TMUX kill-session -t "$SESSION" 2>/dev/null

# Reap orphan main-agent channel pollers (bun/node grandchildren of the
# previous tmux server). A tmux kill-session does not always tear them down,
# they keep polling getUpdates with the same bot token, and the fresh poller
# we spawn below 409-Conflicts on every cycle until the old one exits. The
# poller env contains *_STATE_DIR=<this main agent's channel dir>; argv does
# not, so `pkill -f` against the env var never matches. We grep `ps eww -e`
# instead, which surfaces each process environment on macOS BSD ps.
MAIN_CHAN_DIR="$INSTALL_DIR/.claude/channels/$CHANNEL_PROVIDER"
case "$CHANNEL_PROVIDER" in
  slack)    STATE_ENV_VAR="SLACK_STATE_DIR" ;;
  discord)  STATE_ENV_VAR="DISCORD_STATE_DIR" ;;
  *)        STATE_ENV_VAR="TELEGRAM_STATE_DIR" ;;
esac
ORPHAN_PIDS="$(/bin/ps eww -e 2>/dev/null | awk -v needle="${STATE_ENV_VAR}=${MAIN_CHAN_DIR}" '$0 ~ needle { print $1 }')"
if [ -n "$ORPHAN_PIDS" ]; then
  # shellcheck disable=SC2086
  /bin/kill -TERM $ORPHAN_PIDS 2>/dev/null || true
  /bin/sleep 0.3
  # shellcheck disable=SC2086
  /bin/kill -KILL $ORPHAN_PIDS 2>/dev/null || true
fi

# P1 FIX: put the Claude auth token into the tmux SERVER global env BEFORE
# new-session. A new session inherits the tmux SERVER's global environment, not
# this shell's. The tmux server is SHARED across every agent, so if a sub-agent
# created the server first, this shell's `export CLAUDE_CODE_OAUTH_TOKEN` (above)
# never reaches the channels claude -> "Not logged in" until the hourly restart.
# Setting it -g makes the launch order irrelevant. Safe to share globally: every
# agent uses the same Claude login (unlike the channel tokens scrubbed above,
# which DO conflict and are -u'd). `|| true` tolerates "no server yet" -- in that
# case new-session creates the server from this shell's exported env, which is
# already correct.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  $TMUX set-environment -g CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN" 2>/dev/null || true
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  $TMUX set-environment -g ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY" 2>/dev/null || true
fi

# Tmux session indítás
#
# Always start a fresh conversation. --continue is intentionally omitted:
# the cwd-based project dir may contain the user's own CLI sessions, and
# resuming one of those loses the --channels activation state, causing
# "Channel notifications skipped: server not in --channels list" errors.
$TMUX new-session -d -s "$SESSION" -c "$INSTALL_DIR" \
  "$CLAUDE --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:${PLUGIN_ID}"

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

# Set agent name once the session is ready. (/remote-control dropped: the operator no
# longer uses Remote Control.)
_bot_name="${BOT_NAME:-${MAIN_AGENT_ID:-marveen}}"
sleep 1
$TMUX send-keys -t "$SESSION" "/name ${_bot_name}" Enter
unset _bot_name

# Reset the keep-alive watchdog baseline so a session that was just restarted
# is not immediately judged stale by the dashboard's checkMainKeepaliveStaleness
# (channel-monitor.ts, ~18min threshold). The dashboard's hardRestartMarveenChannels
# path writes both files when it triggers the restart, but a manual
# `launchctl kickstart -k com.marveen.channels` (or the launchd KeepAlive's own
# restart after a crash) bypasses the dashboard - those code paths never touched
# the watchdog baseline, and the old mtimes survived into the fresh session,
# triggering a false-positive respawn loop within minutes (2026-06-01 18:26).
#
# touch + epoch-write happens unconditionally here so every channels.sh launch
# (manual or dashboard-driven) leaves a consistent baseline. The scheduled
# edit_message keep-alive (every ~6min) takes over from there.
mkdir -p "$INSTALL_DIR/store"
touch "$INSTALL_DIR/store/.channel-keepalive"
date +%s > "$INSTALL_DIR/store/.channel-last-respawn"

# POST-INIT PLUGIN UNLOCK (2026-06-01 Szabi 15:24 incident workaround):
# Claude Code 2.1.159 + telegram-plugin 0.0.6: the `--channels` parameter
# announces "Listening for channel messages from: plugin:telegram@..." in the
# TUI, but the plugin server itself is NOT always spawned on fresh-session
# init - it lands in /mcp's Failed state with no bun-poller child. Manually
# opening /mcp, moving the cursor up to the failed plugin row, and pressing
# Enter twice (enter submenu, press Reconnect) brings the plugin live -
# Szabi's empirical sequence that fixed the 16:31 hard-restart aftermath.
#
# Two-stage detection, both must indicate "no plugin" before we fire keystrokes:
#
#   1. pgrep -P claude_pid bun   -- looks for a bun child of the marveen-channels
#      claude process. This catches the case the env-var grep misses: Claude Code
#      does NOT inherit TELEGRAM_STATE_DIR into the spawned poller on the main
#      session (only on sub-agents), so an env-var-needle scan reports "no
#      poller" even when one is running. A direct child-of-claude pgrep is the
#      authoritative signal.
#
#   2. capture-pane after `/mcp` shows the plugin row marked with "✗ Failed".
#      Connected/Enabled rows must NOT trigger the keystroke sequence, because
#      then `Up`+`Enter`+`Enter` would land on "Disable" in the submenu and
#      disable the plugin instead of reconnecting it (Szabi msg 427).
#
# We sequence both checks, log the decision, and fire only when both agree.
# The subshell is detached so the main script keeps moving to the wait-loop.
(
  sleep 15
  CLAUDE_PID="$($TMUX list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)"
  # Check 1: bun grandchild of the marveen-channels claude
  BUN_CHILD=""
  if [ -n "$CLAUDE_PID" ]; then
    BUN_CHILD="$(/usr/bin/pgrep -P "$CLAUDE_PID" bun 2>/dev/null | head -1)"
  fi
  if [ -n "$BUN_CHILD" ]; then
    # Plugin is alive via the authoritative process-tree check. Don't probe the
    # /mcp menu - any keystroke sequence from idle would risk a stray Enter
    # disabling a healthy plugin.
    exit 0
  fi

  # Check 2: TUI confirmation that the plugin shows ✗ Failed. The /mcp view
  # also shows "(disabled)" markers; we only fire on Failed, never on disabled
  # (Enable-only submenu has no Reconnect, the Up+Enter+Enter sequence would
  # land somewhere unsafe).
  $TMUX send-keys -t "$SESSION" Escape
  sleep 1
  $TMUX send-keys -t "$SESSION" "/mcp" Enter
  sleep 3
  PANE="$($TMUX capture-pane -t "$SESSION" -p 2>/dev/null || true)"

  case "$PANE" in
    *"plugin:telegram@"*"✗ Failed"*|*"plugin:telegram@"*"✗ failed"*)
      echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh post-init: telegram plugin in ✗ Failed state, firing /mcp Up+Enter+Enter unlock" >> "$INSTALL_DIR/store/channels-failures.log"
      $TMUX send-keys -t "$SESSION" Up
      sleep 1
      $TMUX send-keys -t "$SESSION" Enter
      sleep 2
      $TMUX send-keys -t "$SESSION" Enter
      sleep 4
      $TMUX send-keys -t "$SESSION" Escape
      ;;
    *)
      # Plugin is connected/enabled/not-listed, or we couldn't capture. Bail
      # out safely. If the plugin row literally doesn't appear in the /mcp
      # listing (truly unreachable), the dashboard's channel-monitor will
      # detect down and run its own recovery ladder; we don't second-guess.
      echo "$(date '+%Y-%m-%d %H:%M:%S') channels.sh post-init: no Failed plugin row in /mcp pane, skipping unlock (bun child absent but plugin not failed - check manually)" >> "$INSTALL_DIR/store/channels-failures.log"
      $TMUX send-keys -t "$SESSION" Escape
      ;;
  esac
) &

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
