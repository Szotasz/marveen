#!/bin/bash
# Contract tests for scripts/watchdog.sh carrying the dashboard's Code Mode decision (CODEMODEFOLLOW1119).
#
# The dashboard decides whether an agent runs in Code Mode (resolveCodeModeLaunch) and keeps
# store/code-mode/<id>.on in step on every start. The watchdog's own relaunch used to export neither
# value, so a restart from here silently dropped the owner's switch and left an inherited value alone.
# Wanted: after a watchdog restart the variable is 1 for an agent that runs Code Mode, 0 otherwise.
#
# Part 1 drives `watchdog.sh --code-mode-env <id>`, which prints the piece and exits before touching tmux.
# Part 2 runs the whole script once from a fixture install, with tmux / ps / claude / sleep stubbed first
# on PATH (a fixture HOME: the script puts $HOME/.local/bin first) and a private TMUX_TMPDIR, so no live
# session is ever touched. The tmux stub records the relaunch command; its prefix up to `cd` is then
# evaluated with the variable inherited as 1, the way the tmux server would hand it on.
# Run: bash scripts/__tests__/watchdog-code-mode.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to confirm it fails on the bug.
WATCHDOG="${WATCHDOG_BIN:-$REPO_DIR/scripts/watchdog.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

VAR=CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
FX="$TMP/install"
mkdir -p "$FX/scripts" "$FX/store/code-mode" "$FX/agents" "$FX/logs"
cp "$WATCHDOG" "$FX/scripts/watchdog.sh"
WD="$FX/scripts/watchdog.sh"
echo "sk-test-fixture-token" > "$FX/store/.claude-oauth-token"
echo '[]' > "$FX/store/agent-package-hidden.json"

# A complete, isolated sub-agent: personality files, a telegram bot token, its own .claude-config.
make_agent() {
  local d="$FX/agents/$1"
  mkdir -p "$d/.claude-config" "$d/.claude/channels/telegram"
  echo "# $1" > "$d/CLAUDE.md"; echo "# $1" > "$d/SOUL.md"
  echo '{"model":"claude-test-model"}' > "$d/agent-config.json"
  echo "TELEGRAM_BOT_TOKEN=000:fixture" > "$d/.claude/channels/telegram/.env"
}
make_agent cm-on
make_agent cm-off
make_agent cm-noiso
rm -rf "$FX/agents/cm-noiso/.claude-config"
: > "$FX/store/code-mode/cm-on.on"
: > "$FX/store/code-mode/cm-noiso.on"

echo "watchdog Code Mode contract:"

# ── Part 1: the piece ────────────────────────────────────────────────────
OUT="$(bash "$WD" --code-mode-env cm-on)"
[ "$OUT" = "env=export $VAR=1 && " ] && pass "marker + own .claude-config -> =1" || fail "marker + own .claude-config -> =1" "$OUT"

OUT="$(bash "$WD" --code-mode-env cm-off)"
[ "$OUT" = "env=export $VAR=0 && " ] && pass "no marker -> an explicit =0" || fail "no marker -> an explicit =0" "$OUT"

OUT="$(bash "$WD" --code-mode-env cm-noiso)"
[ "$OUT" = "env=export $VAR=0 && " ] && pass "marker but no own .claude-config -> =0" || fail "marker but no own .claude-config -> =0" "$OUT"

mv "$FX/store/.claude-oauth-token" "$FX/store/.claude-oauth-token.off"
OUT="$(bash "$WD" --code-mode-env cm-on)"
[ "$OUT" = "env=export $VAR=0 && " ] && pass "marker but no fleet token (shared config) -> =0" || fail "marker but no fleet token (shared config) -> =0" "$OUT"
mv "$FX/store/.claude-oauth-token.off" "$FX/store/.claude-oauth-token"

# ── Part 2: the real relaunch ────────────────────────────────────────────
FH="$TMP/home"
STUBS="$FH/.local/bin"
mkdir -p "$STUBS" "$TMP/tmux-sock"
CMDS="$TMP/new-session.cmds"
: > "$CMDS"
# tmux: the main session is up, every agent session is missing; new-session writes its command, one per line.
cat > "$STUBS/tmux" <<EOF
#!/bin/bash
case "\$1" in
  has-session) case "\$*" in *-channels:*) exit 0 ;; *) exit 1 ;; esac ;;
  new-session) printf '%s\t%s\n' "\$4" "\$5" >> "$CMDS"; exit 0 ;;
esac
exit 0
EOF
printf '#!/bin/bash\necho "501 4242 1 0 0:00 ?? 0:00.00 node dist/index.js"\n' > "$STUBS/ps"
printf '#!/bin/bash\nexit 0\n' > "$STUBS/claude"
printf '#!/bin/bash\nexit 0\n' > "$STUBS/sleep"
# node: the Bash sandbox helper's answer for an agent the owner's list does not name (WDSANDBOXMARKER1119); without
# it the watchdog refuses every start, since it cannot read the list.
printf '#!/bin/bash\necho settings=\n' > "$STUBS/node"
chmod +x "$STUBS"/*

# Guard: the stubs must be what the script resolves, or the run would reach a real tmux.
RESOLVED="$(HOME="$FH" bash -c 'export PATH="$HOME/.local/bin:$PATH"; command -v tmux'):$(HOME="$FH" bash -c 'export PATH="$HOME/.local/bin:$PATH"; command -v claude')"
if [ "$RESOLVED" != "$STUBS/tmux:$STUBS/claude" ]; then
  fail "stubs resolve first (refusing to run the whole script)" "$RESOLVED"
else
  env -u TMUX HOME="$FH" TMUX_TMPDIR="$TMP/tmux-sock" PATH="$STUBS:/usr/bin:/bin" bash "$WD" >/dev/null 2>&1

  cmd_of() { awk -F'\t' -v s="agent-$1" '$1 == s { print $2 }' "$CMDS"; }
  # The relaunch command's prefix up to `cd "<agent dir>"`, run with the variable inherited as 1.
  seen() {
    local c; c="$(cmd_of "$1")"
    [ -n "$c" ] || { echo "NO-RELAUNCH"; return; }
    env "$VAR=1" HOME="$FH" bash -c "${c%%cd \"*}printf '%s' \"\${$VAR-UNSET}\""
  }

  C_ON="$(cmd_of cm-on)"
  case "$C_ON" in
    *"export $VAR=1 && cd \"$FX/agents/cm-on/\""*) pass "relaunch command carries export $VAR=1 right before cd" ;;
    *) fail "relaunch command carries export $VAR=1 right before cd" "$C_ON" ;;
  esac
  case "$(cmd_of cm-off)" in
    *"export $VAR=0 && cd "*) pass "relaunch command without a marker carries =0" ;;
    *) fail "relaunch command without a marker carries =0" "$(cmd_of cm-off)" ;;
  esac
  case "$C_ON" in
    *--continue*) fail "the relaunch is fresh (no --continue), so a mode change never resumes" "$C_ON" ;;
    *) pass "the relaunch is fresh (no --continue), so a mode change never resumes" ;;
  esac

  OUT="$(seen cm-on)";    [ "$OUT" = 1 ] && pass "after the restart: Code Mode agent sees 1" || fail "after the restart: Code Mode agent sees 1" "$OUT"
  OUT="$(seen cm-off)";   [ "$OUT" = 0 ] && pass "after the restart: an inherited 1 is 0 without a marker" || fail "after the restart: an inherited 1 is 0 without a marker" "$OUT"
  OUT="$(seen cm-noiso)"; [ "$OUT" = 0 ] && pass "after the restart: marker without own config dir sees 0" || fail "after the restart: marker without own config dir sees 0" "$OUT"
fi

echo "watchdog-code-mode: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
