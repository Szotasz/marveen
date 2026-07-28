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

# Find the channels claude pid, anchored on OUR tmux pane.
#
# The previous argv-grep discovery was wrong in both legs and silently verified
# the WRONG process: the `grep -F "$INSTALL_DIR"` leg never matches a claude
# (the install dir is the cwd, not part of argv -- it only matched the grep's
# own shell wrapper), and the `grep -vi agent-` fallback took `head -1` of
# every --channels claude on the box, which on a multi-agent host is a sibling
# agent's session, whose argv may carry an entirely different provider set.
# Verifying a sibling agent's process makes checks (c) and (d) meaningless.
#
# The pane of $SESSION is the only authoritative source. tmux runs the claude as
# the pane process directly, but tolerate a wrapper shell by walking descendants.
PANE_PID="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)"
CLAUDE_PID=""
if [ -n "$PANE_PID" ]; then
  case "$(ps -p "$PANE_PID" -o args= 2>/dev/null)" in
    *"--channels plugin:"*) CLAUDE_PID="$PANE_PID" ;;
    *)
      _parents="$PANE_PID"
      for _depth in 1 2 3 4; do
        _children=""
        for _p in $_parents; do
          _children="$_children $(pgrep -P "$_p" 2>/dev/null)" || true
        done
        [ -z "$(echo "$_children" | tr -d ' ')" ] && break
        for _c in $_children; do
          [ -z "$_c" ] && continue
          case "$(ps -p "$_c" -o args= 2>/dev/null)" in
            *"--channels plugin:"*) CLAUDE_PID="$_c"; break 2 ;;
          esac
        done
        _parents="$_children"
      done
      unset _parents _children _p _c _depth
      ;;
  esac
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

# (d) EVERY configured provider is on the live --channels argv (half-mute guard).
# The three checks above all watch the PRIMARY provider, so a respawn that dropped
# a secondary plugin passed them cleanly: outbound kept working (the plugin's MCP
# reply tool is loaded) while inbound was dropped as "server not in --channels
# list". Note it must read the ARGV, not the environment -- CHANNEL_PLUGINS_EXTRA
# can be exported and correct while the argv omits the plugin -- that exact
# combination is how a secondary inbound goes dead while everything else,
# including the env the operator inspects first, looks correct.
CHANNEL_PLUGINS_EXTRA="$(grep -E '^CHANNEL_PLUGINS_EXTRA=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -z "$CHANNEL_PLUGINS_EXTRA" ]; then
  note "(d) SKIP: no CHANNEL_PLUGINS_EXTRA configured"
elif [ -z "$CLAUDE_PID" ]; then
  note "(d) SKIP: channels claude pid not found"
else
  CLAUDE_ARGV="$(ps -p "$CLAUDE_PID" -o args= 2>/dev/null)"
  _missing=""
  for _p in $CHANNEL_PLUGINS_EXTRA; do
    [ -z "$_p" ] && continue
    case "$CLAUDE_ARGV" in
      *"plugin:$_p"*) ;;
      *) _missing="$_missing $_p" ;;
    esac
  done
  if [ -z "$_missing" ]; then
    note "(d) OK: all extra channel plugins on argv"
  else
    note "(d) FAIL: HALF-MUTE -- inbound dropped for:$_missing (outbound still works, so this looks healthy elsewhere)"
    fail=1
  fi
  unset _p _missing CLAUDE_ARGV
fi

if [ "$fail" -eq 0 ]; then
  echo "verify-channels-health: HEALTHY"
else
  echo "verify-channels-health: UNHEALTHY"
fi
exit "$fail"
