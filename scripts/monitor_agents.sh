#!/bin/bash
# monitor_agents.sh -- aggregate every running agent tmux session into one
# "monitor" session with one labeled window per agent, then attach via
# iTerm2's tmux Control Mode (-CC) so each agent shows up as a native
# iTerm tab/window instead of a single multiplexed pane.
#
# USAGE:
#
#   Local (on the host running the agents):
#     ./scripts/monitor_agents.sh
#
#   Remote (from a laptop with iTerm2):
#     ssh -t <host> "~/marveen/scripts/monitor_agents.sh"
#
# ENV:
#   MAIN_AGENT_ID        override the main agent id (default: read from
#                        install .env, fall back to "marveen")
#   MONITOR_READONLY=1   attach read-only (look, don't touch)
#
# HOW IT FINDS AGENTS:
#   Auto-discovers every running tmux session whose name starts with
#   "agent-" (the sub-agents spawned by the dashboard) plus the main
#   "${MAIN_AGENT_ID}-channels" session. Labels each window with the
#   capitalized agent name. No hardcoded list -- add an agent via the
#   dashboard, re-run the script, and it shows up.
#
# REQUIREMENTS:
#   - iTerm2 (the -CC Control Mode integration is iTerm2-specific;
#     other terminals will just print control-protocol bytes).
#   - tmux 2.0+ on the agent host.
#
# REFRESH:
#   If the monitor session already exists, the script reattaches it
#   as-is (fast path). To pick up agents started AFTER the monitor
#   session was built, kill it first:
#     tmux kill-session -t monitor
#   then re-run the script. Killing the monitor session does NOT touch
#   the underlying agent sessions -- it only removes the linked-window
#   references.

set -e

export PATH="/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin:$PATH"

SESSION="monitor"

# Resolve MAIN_AGENT_ID: explicit env wins; otherwise read the install .env
# one directory up from this script; otherwise fall back to "marveen".
if [ -z "${MAIN_AGENT_ID:-}" ]; then
  INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  if [ -f "$INSTALL_DIR/.env" ]; then
    MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | tail -1 | cut -d'=' -f2- | tr -d '"' || true)"
  fi
  MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
fi

MAIN_SESSION="${MAIN_AGENT_ID}-channels"

ATTACH_CMD=(tmux -CC attach -t "$SESSION")
if [ -n "${MONITOR_READONLY:-}" ]; then
  ATTACH_CMD+=(-r)
fi

# Fast path: monitor session already exists -- reattach as-is.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec "${ATTACH_CMD[@]}"
fi

capitalize() {
  local s="$1"
  printf '%s%s' "$(printf '%s' "${s:0:1}" | tr '[:lower:]' '[:upper:]')" "${s:1}"
}

AGENTS=()
LABELS=()

if tmux has-session -t "$MAIN_SESSION" 2>/dev/null; then
  AGENTS+=("$MAIN_SESSION")
  LABELS+=("$(capitalize "$MAIN_AGENT_ID")")
fi

while IFS= read -r name; do
  [ -z "$name" ] && continue
  AGENTS+=("$name")
  LABELS+=("$(capitalize "${name#agent-}")")
done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^agent-' || true)

if [ "${#AGENTS[@]}" -eq 0 ]; then
  echo "No agent tmux sessions found (expected '$MAIN_SESSION' or 'agent-*')." >&2
  exit 1
fi

# Empty placeholder window so new-session has something to start with;
# killed once the real windows are linked in.
tmux new-session -d -s "$SESSION" -n _placeholder

idx=0
for i in "${!AGENTS[@]}"; do
  src="${AGENTS[$i]}"
  label="${LABELS[$i]}"
  if tmux link-window -s "${src}:0" -t "$SESSION:$((idx+1))" 2>/dev/null; then
    tmux rename-window -t "$SESSION:$((idx+1))" "$label"
    idx=$((idx+1))
  else
    echo "warning: could not link $src -- skipping" >&2
  fi
done

tmux kill-window -t "$SESSION:_placeholder" 2>/dev/null || true
tmux select-window -t "$SESSION:1" 2>/dev/null || true

exec "${ATTACH_CMD[@]}"
