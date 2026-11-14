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

# ISOLATION PARITY: the dashboard launches every sub-agent with a per-agent
# CLAUDE_CONFIG_DIR (agent-process.ts provisions <agent>/.claude-config, gated
# on the fleet OAuth token) so plugin registries never clobber each other in
# the shared ~/.claude. channel-watchdog.sh already rebuilds the same CFG_ENV
# on its respawn path (channel-watchdog.sh:183-201); this watchdog's tmux
# launch dropped it, so the FIRST auto-recovery silently moved an agent back
# onto the shared ~/.claude. Same gating as agent-process.ts: no token file ->
# no isolation (degraded shared mode is then the intended behaviour). The
# token is read inside the pane via $(cat), so the literal secret never lands
# in the command string, `ps` output or tmux pane history.
agent_launch_env() {
  local AGENT_DIR="$1"
  if [ -d "$AGENT_DIR/.claude-config" ] && [ -s "$INSTALL_DIR/store/.claude-oauth-token" ]; then
    printf '%s' "export CLAUDE_CONFIG_DIR=\"$AGENT_DIR/.claude-config\" && export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat '$INSTALL_DIR/store/.claude-oauth-token')\" && "
  fi
}

# BASHSANDBOX1022: an agent on the owner's BASH_SANDBOX_AGENTS list runs its Bash in Claude
# Code's sandbox, from a --settings file the dashboard writes on every start of it (and removes
# for an agent the switch does not list). A restart from here must carry the same file, or the
# first auto-recovery would bring the agent back unsandboxed. The file's presence decides: this
# script cannot read the dashboard's settings, and a stale file errs on the restrictive side.
agent_sandbox_flag() {
  local F="$INSTALL_DIR/store/bash-sandbox/$1.settings.json"
  if [ -f "$F" ]; then printf " --settings '%s'" "$F"; fi
}

# Self-test hook, mirroring --resolve-provider: print the launch-env prefix
# for one agent dir and exit, so the isolation contract is testable from
# fixtures (scripts/__tests__/watchdog-config-isolation.test.sh).
if [ "${1:-}" = "--sandbox-flag" ]; then
  [ -n "${2:-}" ] || { echo "usage: watchdog.sh --sandbox-flag <agent-id>" >&2; exit 2; }
  echo "flag=$(agent_sandbox_flag "$2")"
  exit 0
fi
if [ "${1:-}" = "--launch-env" ]; then
  [ -n "${2:-}" ] || { echo "usage: watchdog.sh --launch-env <agent-dir>" >&2; exit 2; }
  ENV_PREFIX="$(agent_launch_env "$2")"
  if [ -n "$ENV_PREFIX" ]; then echo "isolation=yes prefix=$ENV_PREFIX"; else echo "isolation=no"; fi
  exit 0
fi

# An agent is READY to be started only once both personality files exist. The
# dashboard wizard creates the directory first and generates CLAUDE.md /
# SOUL.md afterwards through an LLM call that can take minutes
# (routes/agents.ts: "Generating agent CLAUDE.md and SOUL.md..."), so a
# directory alone proves nothing about whether the agent is finished. Claude
# Code reads CLAUDE.md at startup: a session started before the files land
# comes up with no identity, no rules and no persona, and stays that way
# until restarted by hand -- from the outside the creation looks failed.
agent_is_scaffolded() {
  [ -f "$1/CLAUDE.md" ] && [ -f "$1/SOUL.md" ]
}

# Self-test hook, mirroring --resolve-provider: evaluate the predicate and
# exit before touching tmux, so the contract is testable from fixtures
# (scripts/__tests__/watchdog-scaffold-guard.test.sh).
if [ "${1:-}" = "--check-scaffolded" ]; then
  [ -n "${2:-}" ] || { echo "usage: watchdog.sh --check-scaffolded <agent-dir>" >&2; exit 2; }
  if agent_is_scaffolded "$2"; then echo "scaffolded=yes"; else echo "scaffolded=no"; fi
  exit 0
fi


# NATIVECLAUDEFIRST1011 (#1896): $HOME/.local/bin first, as in channels.sh -- the
# sub-agent restart below resolves claude by name (CLAUDE_BIN) under this PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
. "$INSTALL_DIR/scripts/fleet-venv-prefix.sh" 2>/dev/null || fleet_venv_prefix() { :; }

TOKEN=""
if [ -f "$INSTALL_DIR/store/.dashboard-token" ]; then
  TOKEN=$(cat "$INSTALL_DIR/store/.dashboard-token")
fi
# VOICETOKENLEAK1101 round 3: never in a child's environment (an exported TOKEN the caller had keeps its export
# attribute through the assignment), and never on curl's argv (the redelivery request below passes it by process
# substitution).
export -n TOKEN

# REPLAYNOENVELOPE1114: after a confirmed restart, ask the dashboard to put this agent's delivered, not closed
# messages back in its queue (POST /api/agents/<id>/redeliver-unseen). The message router then delivers them again
# through its normal path: envelope with sender and msg_id, a note that it is a redelivery, the pane mapping, the
# chunker, the delivery trace, the seen sweep. This script types NOTHING into the pane any more (the Python replay
# it used to call typed raw content with no envelope), and the call carries only the agent name: the server
# chooses the rows (never a system directive, each row at most once). No token, no dashboard or a non-200 answer
# means no redelivery, and each of those is a line in $LOG, never silent.
request_unseen_redelivery() {
  local AGENT_ID="$1"
  local RESPONSE HTTP_CODE BODY COUNT

  if [ -z "$TOKEN" ]; then
    echo "$(timestamp) [watchdog] $AGENT_ID: nincs dashboard token, ujrakezbesites kihagyva" >> "$LOG"
    return
  fi

  # The token goes in a header read from a process substitution (printf is a builtin): never on curl's argv, never
  # exported. -w appends the HTTP code on its own last line; without -f curl exits 0 on a 4xx/5xx too, so the code
  # is what tells success. An empty -X POST sends no body, which is the only body the endpoint accepts.
  if ! RESPONSE=$(curl -s -m 5 -X POST \
    -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
    -w '\n%{http_code}' \
    "http://localhost:${WEB_PORT}/api/agents/${AGENT_ID}/redeliver-unseen" 2>/dev/null); then
    echo "$(timestamp) [watchdog] $AGENT_ID: dashboard nem erheto el, ujrakezbesites kihagyva" >> "$LOG"
    return
  fi
  HTTP_CODE=$(printf '%s' "$RESPONSE" | tail -n1)
  BODY=$(printf '%s' "$RESPONSE" | sed '$d')
  if [ "$HTTP_CODE" != "200" ]; then
    echo "$(timestamp) [watchdog] $AGENT_ID: redeliver-unseen HTTP $HTTP_CODE, ujrakezbesites kihagyva" >> "$LOG"
    return
  fi
  COUNT=$(printf '%s' "$BODY" | sed -n 's/.*"requeued":\([0-9][0-9]*\).*/\1/p' | head -n1)
  if [ -z "$COUNT" ]; then
    echo "$(timestamp) [watchdog] $AGENT_ID: redeliver-unseen HTTP 200, de a valaszban nincs requeued szam" >> "$LOG"
    return
  fi
  # Quiet on zero: a restart with nothing to put back is the normal case.
  if [ "$COUNT" -gt 0 ]; then
    echo "$(timestamp) [watchdog] $AGENT_ID: $COUNT uzenet visszateve ujrakezbesitesre (redeliver-unseen)" >> "$LOG"
  fi
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

if ! tmux has-session -t "=$MAIN_SESSION:" 2>/dev/null; then
  # Mutual-exclusion gate, mirroring channel-watchdog.sh's gate 4. The dashboard
  # channel-monitor, channel-watchdog.sh, systemd (Restart=always) and this cron
  # loop can all recreate the main channels session; they coordinate through the
  # shared respawn stamp (store/.channel-last-respawn, written by channels.sh).
  # Without this gate this loop spawned a competing channels.sh every 5 min while
  # another actor was mid-respawn -> two claude processes contending for the same
  # bot token (409) and rapid-exit (root-caused 2026-08-06, ~4.5h outage). Defer
  # while a respawn is inside the grace window (same 15 min as channel-watchdog.sh);
  # only act as the last-resort backstop once every other actor has stopped trying.
  MAIN_RESPAWN_STAMP="$INSTALL_DIR/store/.channel-last-respawn"
  _mlast=0
  [ -f "$MAIN_RESPAWN_STAMP" ] && _mlast="$(stat -c %Y "$MAIN_RESPAWN_STAMP" 2>/dev/null || echo 0)"
  if [ "$(( $(date +%s) - _mlast ))" -lt 900 ]; then
    echo "$(timestamp) [watchdog] $MAIN_SESSION missing but a respawn is within the 900s grace -- deferring (systemd/channels.sh/channel-watchdog cover it)" >> "$LOG"
  else
    echo "$(timestamp) [watchdog] $MAIN_SESSION missing, restarting..." >> "$LOG"
    nohup "$INSTALL_DIR/scripts/channels.sh" >> "$INSTALL_DIR/logs/marveen-channels.log" 2>&1 &
    sleep 5
    if tmux has-session -t "=$MAIN_SESSION:" 2>/dev/null; then
      echo "$(timestamp) [watchdog] $MAIN_SESSION restarted OK" >> "$LOG"
    else
      echo "$(timestamp) [watchdog] $MAIN_SESSION restart FAILED" >> "$LOG"
    fi
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

  if tmux has-session -t "=$SESSION_NAME:" 2>/dev/null; then
    continue
  fi

  # Do not start a half-scaffolded agent: the wizard's LLM call may still be
  # writing CLAUDE.md / SOUL.md. The next tick starts it once both exist.
  if ! agent_is_scaffolded "$AGENT_DIR"; then
    echo "$(timestamp) [watchdog] $AGENT_ID: personality files not ready yet (wizard still generating?), skipping this tick" >> "$LOG"
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

  ISO_ENV="$(agent_launch_env "$AGENT_DIR")"
  # FLEETVENV923: the fleet venv's bin/ first, as in startAgentProcess -- a
  # watchdog restart must not hand the agent a different python3 (#1626 review).
  FLEET_VENV_PREFIX="$(fleet_venv_prefix "$INSTALL_DIR" "$LOG")"

  CMD="${ISO_ENV}export PATH=\"${FLEET_VENV_PREFIX}\$HOME/.local/bin:/opt/homebrew/bin:\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CODE_DISABLE_AGENT_VIEW=1 && { [ \"\$(id -u)\" != 0 ] || export IS_SANDBOX=1; } && export ${STATE_ENV_VAR}=\"$CHAN_DIR\" && cd \"$AGENT_DIR\" && ${CLAUDE_BIN} --dangerously-skip-permissions --model '$MODEL' --channels plugin:${AGENT_PROVIDER}@claude-plugins-official$(agent_sandbox_flag "$AGENT_ID")"

  tmux new-session -d -s "$SESSION_NAME" "$CMD" 2>/dev/null
  sleep 2

  if tmux has-session -t "=$SESSION_NAME:" 2>/dev/null; then
    echo "$(timestamp) [watchdog] $AGENT_ID restarted OK" >> "$LOG"
    request_unseen_redelivery "$AGENT_ID"
  else
    echo "$(timestamp) [watchdog] $AGENT_ID restart FAILED" >> "$LOG"
  fi
done
