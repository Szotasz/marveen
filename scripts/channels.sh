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
  whatsapp) PLUGIN_ID="whatsapp@marveen-marketplace" ;;
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

# Root VPS / container: Claude Code refuses --dangerously-skip-permissions when
# running as uid 0 ("cannot be used with root/sudo privileges"), so the tmux
# claude session below dies instantly and the bot never comes online. On a
# root-only host there is no non-root user to drop to, so opt into the
# documented sandbox escape hatch. Harmless for non-root (guarded by uid check).
[ "$(id -u)" = "0" ] && export IS_SANDBOX=1

CLAUDE="$(command -v claude)"
TMUX="$(command -v tmux)"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
[ -z "$TMUX" ]   && echo "ERROR: tmux not found on PATH" >&2 && exit 1

# MCP startup-batch tuning for the MAIN session (2026-06-26).
#
# The --channels telegram plugin registers as a stdio MCP server. Claude Code
# connects stdio MCP servers in batches of MCP_SERVER_CONNECTION_BATCH_SIZE
# (default 3) and, by default, blocks on each connection. The main session runs
# the MOST MCP servers of any agent (filesystem + playwright + chrome + the
# claude.ai Gmail/Calendar/Drive connectors + the channel plugin), so the slow
# remote connectors starve the telegram plugin out of the startup batch / push
# it past MCP_TIMEOUT -- it never registers, no poller spawns, and the main bot
# goes silent (observed 2026-06-26: ~2h outage, auto-recovery exhausted).
#
# startAgentProcess already sets these for every sub-agent (which is why their
# channels come up); channels.sh did NOT, so the main session never got the
# mitigation. Set them inline on the launch command -- the tmux SERVER predates
# this script and does not inherit its environment, so exporting here alone
# would not reach the new claude. Mirrors the sub-agent launch.
#
# CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false also added here: the sub-agent spawn
# (startAgentProcess) sets it to suppress the DIM ghost-text autocomplete, but
# the MAIN channels session never got it -- so a dim ghost in the main box was
# the one place the pane-scrape recovery could still misread it (the v1.15.0
# dim-strip catches it on the recovery side, but killing it at the SOURCE on MAIN
# too closes the gap end-to-end). Parity with the sub-agent launch.
MCP_BATCH_ENV="export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false MCP_SERVER_CONNECTION_BATCH_SIZE=10 MCP_CONNECTION_NONBLOCKING=1 MCP_TIMEOUT=60000 && "

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
  whatsapp) STATE_ENV_VAR="WHATSAPP_STATE_DIR" ;;
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

# Second reap pass for plugin builds that DON'T set *_STATE_DIR in the poller
# env (e.g. telegram@0.0.1). Those pollers carry CLAUDE_PLUGIN_ROOT=.../<provider>
# instead, so the STATE_DIR grep above never matches and orphans accumulate
# across restarts -> multiple getUpdates long-polls -> 409 Conflict -> the bot
# goes silent/flaky.
#
# Scope to THIS (main) agent only. The tmux server is SHARED across the fleet,
# and every sub-agent runs its OWN provider poller out of
# $INSTALL_DIR/agents/<name>/. Those processes carry that agent dir in their
# environment; the main agent's pollers do not. CLAUDE_PLUGIN_ROOT points at the
# shared user-level plugin cache for every agent, so it cannot tell main from
# sub on its own -- without the agents/ exclusion this pass SIGKILLs every live
# sub-agent poller on a main restart (they would only recover on each
# sub-agent's own next restart). A main orphan from an old build has no agent
# dir, so it is still reaped. index() is a literal (non-regex) substring test so
# an install path with regex metacharacters can't break the exclusion. The var
# is named `subdir` (not `sub`) because `sub` is a reserved awk function name and
# BSD/macOS awk syntax-errors on it.
ORPHAN_PIDS2="$(/bin/ps eww -e 2>/dev/null | awk -v needle="CLAUDE_PLUGIN_ROOT=" -v prov="/${CHANNEL_PROVIDER}" -v subdir="${INSTALL_DIR}/agents/" '$0 ~ needle && $0 ~ prov && index($0, subdir) == 0 { print $1 }')"
if [ -n "$ORPHAN_PIDS2" ]; then
  # shellcheck disable=SC2086
  /bin/kill -TERM $ORPHAN_PIDS2 2>/dev/null || true
  /bin/sleep 0.3
  # shellcheck disable=SC2086
  /bin/kill -KILL $ORPHAN_PIDS2 2>/dev/null || true
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

# Hybrid channel-coordinator model: the native plugin stays the PRIMARY inbound
# path (it always polls getUpdates here -- never outbound-only). The standalone
# marveen-channel-coordinator only BACKFILLS while this session's plugin is
# down, so there is never a second concurrent poller in steady state. Nothing to
# set here: the coordinator gates itself on native liveness.

# Tmux session indítás
#
# Always start a fresh conversation. --continue is intentionally omitted:
# the cwd-based project dir may contain the user's own CLI sessions, and
# resuming one of those loses the --channels activation state, causing
# "Channel notifications skipped: server not in --channels list" errors.
#
# Idempotent launch: the service runs KillMode=process so a `systemctl stop`
# no longer cgroup-kills the SHARED tmux server (which would tear down every
# sibling agent session on this host -- the 2026-06-26 fleet-wide outage). The
# trade-off is that a prior "$SESSION" can survive into this relaunch, so kill
# just THIS session first -- never the server, never another agent's session --
# otherwise new-session below fails with "duplicate session".
$TMUX kill-session -t "$SESSION" 2>/dev/null || true
$TMUX new-session -d -s "$SESSION" -c "$INSTALL_DIR" \
  "${MCP_BATCH_ENV}$CLAUDE --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:${PLUGIN_ID}"

# Session startup guard: a Claude Code first-run dialogusait auto-accept-eljuk
# kulonben a headless session orokre parkolna a prompton es a Telegram plugin
# soha nem toltodne be. Tobb fajta dialog elofordulhat:
#  - "Bypass Permissions mode" (--dangerously-skip-permissions confirmation,
#    valasz: 2 Enter = "Yes, I accept")
#  - "Do you trust the files in this folder?" / "trust" prompts (Y Enter)
#  - "Welcome to Claude Code" / kezdo vezetes (Enter a folytatashoz)
# 12 sec timeout ket retry-jal, mert WSL/tmux paint slow lehet first-run-on.
#
# EPERM fallback (Claude Code 2.1.183+ regression): launching --channels in a
# trusted project directory throws EPERM before any dialog appears. Detected
# below; one auto-restart from /tmp where the trust dialog fires instead.
_eperm_restarted=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 1
  pane=$($TMUX capture-pane -t "$SESSION" -p 2>/dev/null || true)
  case "$pane" in
    *"EPERM"*|*"Operation not permitted"*|*"operation not permitted"*)
      if [ "$_eperm_restarted" = "0" ]; then
        _eperm_restarted=1
        $TMUX kill-session -t "$SESSION" 2>/dev/null
        _CHANNELS_STARTDIR="$(mktemp -d /tmp/marveen-channels-XXXXXX)"
        # Carry the project CLAUDE.md into the fallback cwd so the session keeps
        # Marveen's instructions/personality instead of running as a generic,
        # context-less assistant (the biggest degradation of the /tmp fallback).
        # Best-effort: a symlink failure degrades to the prior behaviour and
        # never blocks startup. The trust dialog for the fresh /tmp path still
        # fires and is handled by the guard below; EPERM is keyed on the
        # registered project path, not on file presence, so seeding CLAUDE.md
        # does not re-trigger it.
        #
        # NOTE: the project-scoped MCP servers (gmail/calendar) are NOT restored
        # here. Claude Code keys those by project PATH in ~/.claude.json, not in
        # the project .mcp.json, so a random /tmp path has no entry and symlinking
        # files cannot bring them back. Restoring them needs a separate, more
        # invasive change (a stable fallback dir + a seeded ~/.claude.json project
        # entry); see the PR description / card 7EB18437.
        [ -e "$INSTALL_DIR/CLAUDE.md" ] && ln -sf "$INSTALL_DIR/CLAUDE.md" "$_CHANNELS_STARTDIR/CLAUDE.md" 2>/dev/null || true
        $TMUX new-session -d -s "$SESSION" -c "$_CHANNELS_STARTDIR" \
          "${MCP_BATCH_ENV}$CLAUDE --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:${PLUGIN_ID}"
        unset _CHANNELS_STARTDIR
      fi
      continue
      ;;
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
unset _eperm_restarted

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

# Plugin liveness watchdog (main channels session only) -- a last-resort
# backstop UNDER the dashboard channel-monitor, not a replacement. The monitor
# is the primary recovery, but its down-state lives in dashboard process
# memory: a plugin that dies WHILE THE DASHBOARD ITSELF IS RESTARTING is missed
# (the in-memory state machine resets and never re-detects it). This in-session
# shell watchdog is independent of the dashboard. If the channel bot process
# (tracked via the plugin's bot.pid) never comes up, OR comes up and then stays
# dead, we exit so the service manager (launchd/systemd) restarts us with a
# fresh Claude + plugin.
#
# Thresholds are deliberately COARSER than the dashboard monitor's (~60-120s)
# so in normal operation the dashboard acts FIRST and this only fires when the
# dashboard couldn't -- avoids double-restart races. bot.pid lives at the
# main-agent channelStateDir(): ~/.claude/channels/<provider>/bot.pid (HOME-,
# not INSTALL_DIR-relative; see src/channel-provider.ts channelStateDir()).
MAIN_BOT_PID_FILE="$HOME/.claude/channels/$CHANNEL_PROVIDER/bot.pid"
# Never-started budget: generous so a slow cold-start (WSL first-run, MCP
# handshake + /mcp unlock retries) is never killed prematurely. The plugin
# normally writes bot.pid within ~1-2 min; 10 min is a safe ceiling.
PLUGIN_NEVER_STARTED_DEADLINE=$((START_TS + 600))
# Died-after-up budget: once we have seen the plugin alive, a continuous
# disappearance this long means it crashed and is not self-recovering.
PLUGIN_DEAD_GRACE=180
PLUGIN_SEEN_ONCE=false
PLUGIN_DEAD_SINCE=0

# Várakozás amíg a session él
while $TMUX has-session -t "$SESSION" 2>/dev/null; do
  sleep 5

  NOW=$(date +%s)
  _plugin_alive=false
  if [ -f "$MAIN_BOT_PID_FILE" ]; then
    _bot_pid=$(cat "$MAIN_BOT_PID_FILE" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$_bot_pid" ] && [ "$_bot_pid" -gt 1 ] 2>/dev/null && kill -0 "$_bot_pid" 2>/dev/null; then
      _plugin_alive=true
    fi
  fi
  unset _bot_pid
  # Fallback for plugin builds that never write bot.pid (e.g. telegram@0.0.1):
  # treat a running plugin poller as alive. The poller is a bun process whose
  # env CLAUDE_PLUGIN_ROOT points at the <provider> plugin dir. `ps eww -e`
  # surfaces each process environment on macOS BSD ps (same technique the
  # orphan-reaper above uses). Without this the watchdog false-restarts every
  # ~10 min on plugin versions that don't emit a bot.pid.
  if [ "$_plugin_alive" != "true" ]; then
    if /bin/ps eww -e 2>/dev/null | grep -qE "CLAUDE_PLUGIN_ROOT=[^ ]*/${CHANNEL_PROVIDER}(/|@| |$)"; then
      _plugin_alive=true
    fi
  fi

  if [ "$_plugin_alive" = "true" ]; then
    PLUGIN_SEEN_ONCE=true
    PLUGIN_DEAD_SINCE=0
  elif [ "$PLUGIN_SEEN_ONCE" = "true" ]; then
    # Was up, now gone -- start/continue the dead-grace timer (a transient
    # gap that recovers resets it, so only a sustained death triggers exit).
    if [ "$PLUGIN_DEAD_SINCE" -eq 0 ]; then
      PLUGIN_DEAD_SINCE=$NOW
      echo "WARN: $CHANNEL_PROVIDER plugin (bot.pid) disappeared -- ${PLUGIN_DEAD_GRACE}s grace before restart" >&2
    elif [ "$((NOW - PLUGIN_DEAD_SINCE))" -ge "$PLUGIN_DEAD_GRACE" ]; then
      echo "WARN: $CHANNEL_PROVIDER plugin dead for $((NOW - PLUGIN_DEAD_SINCE))s -- exiting for service-manager restart" >&2
      break
    fi
  else
    # Never came up at all (e.g. a Claude Code build that silently disables
    # --channels). Give it the full cold-start budget, then restart.
    if [ "$NOW" -ge "$PLUGIN_NEVER_STARTED_DEADLINE" ]; then
      echo "WARN: $CHANNEL_PROVIDER plugin never started within $((PLUGIN_NEVER_STARTED_DEADLINE - START_TS))s -- exiting for service-manager restart" >&2
      break
    fi
  fi
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
