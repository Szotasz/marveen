#!/bin/bash
# Runtime contract check for the main channels session after a
# (re)spawn. Verifies the three invariants from the deafness fix:
#   (a) a bun child runs under the main channels claude (the telegram bridge),
#   (b) bot.pid exists and the recorded pid is alive,
#   (c) the channels claude's PATH contains .bun/bin (so bun resolves).
#
# Exit 0 = healthy, 1 = a check failed. Pure observation, no side effects.

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
# N2: sanitize — strip any character that is not alphanumeric, underscore, or hyphen.
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"
BOT_PID_FILE="$HOME/.claude/channels/telegram/bot.pid"

fail=0
note() { echo "  $1"; }

# Find the channels claude pid: a `claude ... --channels` process whose cwd is
# the install dir. We match the session's claude by argv + the --channels flag.
CLAUDE_PID="$(pgrep -af -- '--channels plugin:' | grep -F "$INSTALL_DIR" 2>/dev/null | awk '{print $1}' | head -1)"
if [ -z "$CLAUDE_PID" ]; then
  # Fallback: any claude with --channels (single main session on this box).
  CLAUDE_PID="$(pgrep -af -- '--channels plugin:' | grep -vi 'agent-' | awk '{print $1}' | head -1)"
fi

echo "verify-channels-health: session=$SESSION"

# (a) bun bridge descendant under the ${MAIN_AGENT_ID}-channels tmux pane
# Walk the pane shell's own process-tree (up to 4 levels deep) for a
# "bun server.ts" process.  Every PID checked is a descendant of the
# pane PID — never a global match — so Dia's or Ernő's bun processes
# on the same host are not accidentally matched.
PANE_PID="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)"
if [ -z "$PANE_PID" ]; then
  note "(a) FAIL: tmux session $SESSION not found"; fail=1
else
  BUN_CHILD=""
  _parents="$PANE_PID"
  for _depth in 1 2 3 4; do
    _children=""
    for _p in $_parents; do
      _kids="$(pgrep -P "$_p" 2>/dev/null)" || true
      _children="$_children $_kids"
    done
    [ -z "$(echo "$_children" | tr -d ' ')" ] && break
    for _c in $_children; do
      [ -z "$_c" ] && continue
      _cmd="$(ps -p "$_c" -o args= 2>/dev/null)" || continue
      case "$_cmd" in
        *bun*server.ts*) BUN_CHILD="$_c"; break 2 ;;
      esac
    done
    _parents="$_children"
  done
  if [ -n "$BUN_CHILD" ]; then
    note "(a) OK: bun bridge pid=$BUN_CHILD under pane pid=$PANE_PID"
  else
    note "(a) FAIL: no bun server.ts descendant of pane pid=$PANE_PID"; fail=1
  fi
fi

# (b) bot.pid alive
if [ -f "$BOT_PID_FILE" ]; then
  BOT_PID="$(cat "$BOT_PID_FILE" 2>/dev/null)"
  if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
    note "(b) OK: bot.pid=$BOT_PID alive"
  else
    note "(b) FAIL: bot.pid=$BOT_PID not alive"; fail=1
  fi
else
  note "(b) FAIL: $BOT_PID_FILE missing"; fail=1
fi

# (c) channels claude PATH contains .bun/bin
if [ -n "$CLAUDE_PID" ] && [ -r "/proc/$CLAUDE_PID/environ" ]; then
  # N1: SECURITY: only PATH crosses the pipe; never print the full environ
  if grep -z '^PATH=' "/proc/$CLAUDE_PID/environ" | tr '\0' '\n' | grep -q '\.bun/bin'; then
    note "(c) OK: claude PATH includes .bun/bin"
  else
    note "(c) FAIL: claude PATH missing .bun/bin"; fail=1
  fi
else
  note "(c) SKIP: cannot read /proc/$CLAUDE_PID/environ"
fi

if [ "$fail" -eq 0 ]; then
  echo "verify-channels-health: HEALTHY"
else
  echo "verify-channels-health: UNHEALTHY"
fi
exit "$fail"
