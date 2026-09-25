#!/usr/bin/env bash
# What a worker is doing right now, in a form the orchestrator can relay.
#
# The owner asked to see the workers' thinking the same way he sees the main
# agent's -- so the orchestrator polls this and forwards the delta to Telegram.
#
#   worker-tail.sh <agent-id> [lines]     one worker's live pane
#   worker-tail.sh --list                 which workers are running
set -uo pipefail

if [ "${1:-}" = "--list" ]; then
  tmux ls 2>/dev/null | grep -E '^(agent-|worker-rembrandt-)' | sed 's/:.*//' || echo "(nincs futo worker)"
  exit 0
fi

AGENT="${1:-}"; LINES="${2:-25}"
[ -z "$AGENT" ] && { echo "usage: worker-tail.sh <agent-id> [lines] | --list" >&2; exit 2; }

# Rembrandt runs in its own tmux naming scheme; Claude workers use agent-<id>.
case "$AGENT" in
  rembrandt-*) SESSION="worker-rembrandt-${AGENT#rembrandt-}" ;;
  worker-*)    SESSION="$AGENT" ;;
  *)           SESSION="agent-$AGENT" ;;
esac

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "STATE: stopped ($SESSION nem fut)"
  exit 0
fi

# The trailing prompt box and the tmux hint line are noise for a Telegram
# relay -- strip them so the orchestrator forwards content, not chrome.
tmux capture-pane -p -t "$SESSION" 2>/dev/null \
  | grep -vE '^\s*$' \
  | grep -vE 'tmux detected · scroll|shift\+tab to cycle|for agents$' \
  | tail -n "$LINES"

echo "STATE: running ($SESSION)"
