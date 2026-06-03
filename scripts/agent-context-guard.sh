#!/bin/bash
# Context-exhaustion guard for the always-alive channel agents.
#
# Symptom it fixes (2026-06-02): sub-agents run with `claude --continue`, so
# their conversation grows without bound. At ~100% context the next turn would
# need the 1M-context window, which requires usage credits that are not enabled
# -> every reply dies with "Usage credits required for 1M context". The agent
# still RECEIVES inbound messages (channel is alive -- this is NOT deafness),
# it just cannot answer.
#
# Recovery: issue `/clear` into the wedged pane. That resets the conversation
# client-side (no API call, no credits), the channel stays connected, and the
# agent answers the next message. We only act when the credit-wall error is
# visible on the pane RIGHT NOW, so the agent is already non-functional and
# /clear loses nothing that was not already broken.
#
# Invoked every minute by marveen-agent-context-guard.timer (systemd --user).

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# tmux session names of the agents to guard. Override with CTXGUARD_SESSIONS
# (space-separated) so the list is not hardcoded to one deployment's agents.
if [ -n "${CTXGUARD_SESSIONS:-}" ]; then
  read -r -a SESSIONS <<< "$CTXGUARD_SESSIONS"
else
  SESSIONS=(aladar-channels agent-dia agent-erno-ba agent-virgil)
fi

# The exact wedge signature printed by claude when context is full and the
# 1M-context spill needs credits.
WEDGE_RE='Usage credits required for 1M context'

# Per-session cooldown so a still-settling pane is not cleared twice in a row.
COOLDOWN=600   # seconds
STATE_DIR="${CTXGUARD_STATE_DIR:-$INSTALL_DIR/store}"
mkdir -p "$STATE_DIR" 2>/dev/null || true   # ensure stamp writes never fail on a missing dir

ts() { date '+%F %T'; }

for s in "${SESSIONS[@]}"; do
  tmux has-session -t "$s" 2>/dev/null || continue

  pane="$(tmux capture-pane -t "$s" -p 2>/dev/null)"
  printf '%s' "$pane" | grep -q "$WEDGE_RE" || continue

  stamp="$STATE_DIR/.ctxguard-$s"
  if [ -f "$stamp" ]; then
    last="$(cat "$stamp" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    if [ $((now - last)) -lt "$COOLDOWN" ]; then
      echo "$(ts) $s wedged but in cooldown ($((now - last))s) -- skip"
      continue
    fi
  fi

  echo "$(ts) $s WEDGED on context/credit wall -> issuing /clear"
  tmux send-keys -t "$s" Escape;  sleep 1
  tmux send-keys -t "$s" C-u;     sleep 1
  tmux send-keys -t "$s" "/clear"; sleep 1
  tmux send-keys -t "$s" Enter;   sleep 3

  if tmux capture-pane -t "$s" -p 2>/dev/null | grep -q "$WEDGE_RE"; then
    echo "$(ts) $s still shows wedge after /clear -- needs manual attention"
  else
    echo "$(ts) $s recovered (context cleared)"
  fi
  date +%s > "$stamp" 2>/dev/null || true   # best-effort: tolerate ENOSPC
done
