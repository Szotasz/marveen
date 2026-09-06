#!/usr/bin/env bash
# List agent tmux sessions with total process-tree RSS.
#
# Without --json: one line per agent, "<name> <rssGiB>", sorted descending.
#   Backward-compatible output consumed by older callers.
#
# With --json: machine-readable JSON on stdout —
#   {
#     "source": "list-agent-rss.sh",
#     "status": "ok" | "partial" | "error",
#     "measuredAgentCount": N,
#     "failedAgentCount": N,
#     "agents": [{"name": "...", "rssBytes": N}, ...],
#     "totalRssBytes": N | null
#   }
#
#   status "ok"       — every running agent was measured.
#   status "partial"  — at least one agent measured, at least one failed.
#   status "error"    — tmux not available, or NO agent could be measured.
#                       totalRssBytes is null on error — ZERO MEANS WE MEASURED
#                       AND THERE ARE GENUINELY NO AGENTS; null means we could
#                       not measure at all.
#
# Called by: memory-pressure-gate.ts (eviction selector),
#            memory-pressure-monitor.ts (state telemetry).
# ONE authoritative process-tree measurement for both consumers.
#
# Principle: walks from the tmux pane PID — session name IS the agent identity,
# not cmdline heuristics.  cmdline-based detection is PROVEN WRONG here (commit
# a6b9743 measured 0.012 GiB against 2.2 GiB real) and must not be reintroduced.

set -euo pipefail

JSON_MODE=false
if [ "${1:-}" = "--json" ]; then
  JSON_MODE=true
fi

# ── error exit for JSON mode ──────────────────────────────────────────────────

json_error() {
  local msg="$1"
  cat <<EOF
{
  "source": "list-agent-rss.sh",
  "status": "error",
  "error": "$msg",
  "measuredAgentCount": 0,
  "failedAgentCount": 0,
  "agents": [],
  "totalRssBytes": null
}
EOF
  exit 0  # never crash the caller; status field carries the error
}

# ── tmux guard ────────────────────────────────────────────────────────────────

if ! command -v tmux >/dev/null 2>&1; then
  if $JSON_MODE; then
    json_error "tmux not available"
  fi
  exit 0
fi

# ── text mode (backward-compatible) ───────────────────────────────────────────

if ! $JSON_MODE; then
  tmux ls 2>/dev/null | grep '^agent-' | while IFS=: read -r session _; do
    name="${session#agent-}"
    pids=$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null)
    if [ -z "$pids" ]; then continue; fi

    rss_kb=0
    for pid in $pids; do
      children=$(ps -eo pid,ppid,rss --no-headers 2>/dev/null | \
        awk -v p="$pid" '$2==p || $1==p {r+=$3} END{print r+0}')
      rss_kb=$((rss_kb + children))
    done

    rss_gb=$(awk "BEGIN {printf \"%.4f\", $rss_kb / 1048576}")
    echo "$name $rss_gb"
  done | sort -k2 -rn
  exit 0
fi

# ── JSON mode ─────────────────────────────────────────────────────────────────

# Collect session list first (do NOT pipe — pipes create subshells and we need
# the variables to survive into the JSON output block).
SESSIONS=$(tmux ls 2>/dev/null | grep '^agent-' || true)

if [ -z "$SESSIONS" ]; then
  # Genuinely zero running agents — ok, not error.
  cat <<EOF
{
  "source": "list-agent-rss.sh",
  "status": "ok",
  "measuredAgentCount": 0,
  "failedAgentCount": 0,
  "agents": [],
  "totalRssBytes": 0
}
EOF
  exit 0
fi

MEASURED=0
FAILED=0
AGENT_ENTRIES=""
TOTAL_RSS_BYTES=0

while IFS=: read -r session _; do
  [ -z "$session" ] && continue
  name="${session#agent-}"

  pids=$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null || true)
  if [ -z "$pids" ]; then
    FAILED=$((FAILED + 1))
    continue
  fi

  rss_kb=0
  for pid in $pids; do
    # Capture ps output first, then feed to awk.  A failing ps (exit != 0,
    # output empty) means we cannot measure this agent.  We must detect this
    # rather than silently reporting 0 bytes (which would falsely claim the
    # agent uses no memory when ps is just broken).
    #
    # The subshell grouping ( ... ) is REQUIRED: || binds LOWER than | in
    # bash, so without it, "ps ... || true | awk" parses as
    # "ps || (true | awk)", sending raw ps output directly to $children.
    ps_out=$(ps -eo pid,ppid,rss --no-headers 2>/dev/null && echo "PS_OK" || echo "PS_FAIL")
    if echo "$ps_out" | tail -1 | grep -q "PS_FAIL"; then
      FAILED=$((FAILED + 1))
      continue
    fi
    # Remove the PS_OK marker line before feeding to awk
    ps_data=$(echo "$ps_out" | sed '$d')
    children=$(echo "$ps_data" | \
      awk -v p="$pid" '$2==p || $1==p {r+=$3} END{print r+0}')
    rss_kb=$((rss_kb + children))
  done

  # Convert KiB to bytes (×1024) for the JSON output.
  rss_bytes=$((rss_kb * 1024))

  TOTAL_RSS_BYTES=$((TOTAL_RSS_BYTES + rss_bytes))
  MEASURED=$((MEASURED + 1))

  # Build JSON agent entry.  Escape double-quotes in agent names defensively
  # (agent names are [a-z0-9-]+ so this is belt-and-suspenders, not a real
  # risk — but shell JSON generation must never break the structure).
  escaped_name=$(printf '%s' "$name" | sed 's/"/\\"/g')
  if [ -n "$AGENT_ENTRIES" ]; then
    AGENT_ENTRIES="$AGENT_ENTRIES,"
  fi
  AGENT_ENTRIES="$AGENT_ENTRIES{\"name\":\"$escaped_name\",\"rssBytes\":$rss_bytes}"
done <<< "$SESSIONS"

# Determine status
if [ "$MEASURED" -eq 0 ]; then
  STATUS="error"
  TOTAL_RSS_BYTES_NULL="null"
else
  TOTAL_RSS_BYTES_NULL="$TOTAL_RSS_BYTES"
  if [ "$FAILED" -eq 0 ]; then
    STATUS="ok"
  else
    STATUS="partial"
  fi
fi

# Output JSON
cat <<EOF
{
  "source": "list-agent-rss.sh",
  "status": "$STATUS",
  "measuredAgentCount": $MEASURED,
  "failedAgentCount": $FAILED,
  "agents": [$AGENT_ENTRIES],
  "totalRssBytes": $TOTAL_RSS_BYTES_NULL
}
EOF
