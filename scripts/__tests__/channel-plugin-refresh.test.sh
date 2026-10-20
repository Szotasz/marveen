#!/bin/bash
# Contract tests for the channel-plugin refresh run by update.sh
# (SLACKPLUGINVER1006; scripts/lib/channel-plugin-refresh.sh).
#
# The library runs against a FAKE `claude` that logs its arguments and the
# environment it was given, and fails on demand. The real update.sh is never
# executed here; its wiring is checked by reading the file.
# Run: bash scripts/__tests__/channel-plugin-refresh.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }
eq() { if [ "$3" = "$2" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="${CHANNEL_PLUGIN_REFRESH_LIB:-$ROOT/scripts/lib/channel-plugin-refresh.sh}"
UPDATE="$ROOT/update.sh"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# The fake claude: one log line per call, "<config dir>|<args>", plus the env
# it saw in a second file. FAKE_FAIL=<substring of a config dir> fails every
# call made against that dir (exit 3); FAKE_FAIL_STEP=marketplace limits that
# to the marketplace step.
cat > "$TMPD/claude" <<'EOF'
#!/bin/bash
echo "${CLAUDE_CONFIG_DIR}|$*" >> "$FAKE_LOG"
# FAKE_READ_STDIN=1: record what the child could read on stdin (must be nothing).
if [ -n "${FAKE_READ_STDIN:-}" ]; then
  l=""; IFS= read -r -t 2 l || true; echo "stdin=[$l]" >> "$FAKE_LOG.stdin"
fi
# FAKE_GRANDCHILD=<s>: leave a child behind first, like the git a real
# `claude plugin marketplace update` starts; it holds the stdout pipe. Its pid
# goes to $FAKE_LOG.gc so the test can check it was killed.
if [ -n "${FAKE_GRANDCHILD:-}" ]; then sleep "$FAKE_GRANDCHILD" & echo $! >> "$FAKE_LOG.gc"; fi
# FAKE_SLEEP=<s>: hang like a stuck `claude plugin ...` (exec, so a kill ends it).
[ -n "${FAKE_SLEEP:-}" ] && exec sleep "$FAKE_SLEEP"
echo "${CLAUDE_CONFIG_DIR}|tg=${TELEGRAM_BOT_TOKEN-unset}|sb=${SLACK_BOT_TOKEN-unset}|sa=${SLACK_APP_TOKEN-unset}|dc=${DISCORD_BOT_TOKEN-unset}|tgs=${TELEGRAM_STATE_DIR-unset}|sls=${SLACK_STATE_DIR-unset}" >> "$FAKE_ENV"
if [ -n "${FAKE_FAIL:-}" ]; then
  case "$CLAUDE_CONFIG_DIR" in *"$FAKE_FAIL"*)
    if [ -z "${FAKE_FAIL_STEP:-}" ] || [ "$2" = "$FAKE_FAIL_STEP" ]; then echo "boom"; exit 3; fi ;;
  esac
fi
[ "$2" = "update" ] && [ -n "${FAKE_UPDATED:-}" ] && echo "✔ Plugin \"slack-channel\" updated from 0.2.1 to 0.2.2 for scope user. Restart to apply changes."
exit 0
EOF
chmod +x "$TMPD/claude"

REG_WITH='{"version":2,"plugins":{"slack-channel@marveen-marketplace":[{"scope":"user","version":"0.2.1"}]}}'
REG_WITHOUT='{"version":2,"plugins":{"telegram@claude-plugins-official":[{"scope":"user","version":"0.0.7"}]}}'

# fixture: <home> and <install> trees; reg <config dir> <json> writes a registry.
reg() { mkdir -p "$1/plugins"; printf '%s\n' "$2" > "$1/plugins/installed_plugins.json"; }
fresh() {
  export CASE="$TMPD/case$RANDOM$RANDOM"
  HOME_D="$CASE/home"; INST="$CASE/install"
  mkdir -p "$HOME_D/.claude" "$INST/agents"
  export FAKE_LOG="$CASE/log" FAKE_ENV="$CASE/env"; : > "$FAKE_LOG"; : > "$FAKE_ENV"
}
run() { # runs refresh_channel_plugins in a subshell, like update.sh does
  # shellcheck source=../lib/channel-plugin-refresh.sh
  OUT="$( (. "$LIB" && CHANNEL_PLUGIN_CLAUDE_BIN="${BIN-$TMPD/claude}" refresh_channel_plugins "$INST" "$HOME_D") 2>&1)"
  RC=$?
}
calls() { wc -l < "$FAKE_LOG" | tr -d ' '; }

echo "the skip branches (nothing to refresh, so claude is never called)"
echo "================================================================"
fresh
reg "$HOME_D/.claude" "$REG_WITHOUT"
mkdir -p "$INST/agents/a1/.claude-config"
reg "$INST/.channels-config" "$REG_WITHOUT"
run
eq "no config dir has the plugin: claude never called" "0" "$(calls)"
eq "...exit 0" "0" "$RC"

fresh
run
eq "no registry anywhere: claude never called" "0" "$(calls)"

fresh
reg "$HOME_D/.claude" "$REG_WITH"
BIN="$TMPD/nope" run
eq "no claude binary: exit 0" "0" "$RC"
case "$OUT" in *"nincs claude parancs"*) pass "...and the skip is logged" ;; *) fail "...and the skip is logged" "nincs claude parancs" "$OUT" ;; esac
unset BIN

fresh
reg "$HOME_D/.claude" '{not json'
run
eq "an unreadable registry counts as not installed" "0" "$(calls)"

echo ""
echo "the refresh branch (only where installed, never install)"
echo "========================================================"
fresh
reg "$HOME_D/.claude" "$REG_WITH"
reg "$INST/.channels-config" "$REG_WITHOUT"
reg "$INST/agents/a1/.claude-config" "$REG_WITH"
mkdir -p "$INST/agents/a2/.claude-config"
FAKE_UPDATED=1 run
HOME_R="$(cd -P "$HOME_D/.claude" && pwd)"; A1_R="$(cd -P "$INST/agents/a1/.claude-config" && pwd)"
eq "two of four config dirs have it: four calls" "4" "$(calls)"
eq "...home: marketplace update first" "$HOME_R|plugin marketplace update marveen-marketplace" "$(sed -n 1p "$FAKE_LOG")"
eq "...then the plugin update" "$HOME_R|plugin update slack-channel@marveen-marketplace" "$(sed -n 2p "$FAKE_LOG")"
eq "...the agent's dir the same way" "$A1_R|plugin update slack-channel@marveen-marketplace" "$(sed -n 4p "$FAKE_LOG")"
eq "...never a plugin install" "0" "$(grep -c 'plugin install' "$FAKE_LOG")"
case "$OUT" in *"2 frissitve, 0 naprakesz, 0 hibas"*) pass "...and the summary counts it" ;; *) fail "...and the summary counts it" "2 frissitve, 0 naprakesz, 0 hibas" "$OUT" ;; esac

fresh
reg "$HOME_D/.claude" "$REG_WITH"
ln -s "$HOME_D/.claude" "$INST/.channels-config"
run
eq "a config dir linked to another is refreshed once" "2" "$(calls)"

echo ""
echo "no channel is reachable from the child claude"
echo "=============================================="
fresh
reg "$HOME_D/.claude" "$REG_WITH"
TELEGRAM_BOT_TOKEN=t SLACK_BOT_TOKEN=b SLACK_APP_TOKEN=a DISCORD_BOT_TOKEN=d \
TELEGRAM_STATE_DIR="$CASE/live-tg" SLACK_STATE_DIR="$CASE/live-slack" run
line="$(sed -n 1p "$FAKE_ENV")"
case "$line" in *"|tg=unset|sb=unset|sa=unset|dc=unset|"*) pass "the channel tokens are not passed on" ;; *) fail "the channel tokens are not passed on" "all unset" "$line" ;; esac
tgs="${line##*|tgs=}"; tgs="${tgs%%|*}"; sls="${line##*|sls=}"
case "$tgs" in "$CASE"/live-tg|unset|"") fail "the Telegram state dir is a fresh empty one" "a temp dir" "$tgs" ;; *) pass "the Telegram state dir is a fresh empty one" ;; esac
eq "...the Slack state dir is the same empty one" "$tgs" "$sls"
eq "...and it is gone afterwards" "no" "$([ -e "$tgs" ] && echo yes || echo no)"
eq "the child is pointed at the config dir it refreshes" "$(cd -P "$HOME_D/.claude" && pwd)" "${line%%|*}"

echo ""
echo "the tolerant branch (a failing claude never fails the update)"
echo "============================================================="
fresh
reg "$HOME_D/.claude" "$REG_WITH"
reg "$INST/agents/a1/.claude-config" "$REG_WITH"
FAKE_FAIL="/home/" run
eq "the update step fails on one dir: exit 0" "0" "$RC"
eq "...the next dir is still refreshed" "1" "$(grep -c 'a1/.claude-config|plugin update' "$FAKE_LOG")"
case "$OUT" in *"FIGYELEM: slack-channel@marveen-marketplace frissitese nem sikerult"*"kilepesi kod 3"*) pass "...and the failure is logged with its exit code" ;; *) fail "...logged" "FIGYELEM ... kilepesi kod 3" "$OUT" ;; esac
case "$OUT" in *"0 frissitve, 1 naprakesz, 1 hibas"*) pass "...and counted" ;; *) fail "...and counted" "0 frissitve, 1 naprakesz, 1 hibas" "$OUT" ;; esac

fresh
reg "$HOME_D/.claude" "$REG_WITH"
FAKE_FAIL="/home/" FAKE_FAIL_STEP=marketplace run
eq "a failed marketplace update skips that dir's plugin update" "0" "$(grep -c 'plugin update slack' "$FAKE_LOG")"
eq "...exit 0" "0" "$RC"

fresh
reg "$HOME_D/.claude" "$REG_WITH"
OUT="$(FAKE_FAIL="/home/" bash -c 'set -e; (. "$1" && CHANNEL_PLUGIN_CLAUDE_BIN="$2" refresh_channel_plugins "$3" "$4") || true; echo after' _ "$LIB" "$TMPD/claude" "$INST" "$HOME_D" 2>&1)"
case "$OUT" in *"kilepesi kod 3"*after) pass "under set -e (as in update.sh) a failing refresh is logged and the script carries on" ;; *) fail "under set -e the script carries on" "after" "$OUT" ;; esac

echo ""
echo "the child gets /dev/null as stdin"
echo "================================="
# Inside the loop stdin is the list of config dirs still to visit: a child that
# reads stdin would eat the next dir and that dir would silently be skipped.
fresh
reg "$HOME_D/.claude" "$REG_WITH"
reg "$INST/agents/a1/.claude-config" "$REG_WITH"
reg "$INST/agents/a2/.claude-config" "$REG_WITH"
FAKE_READ_STDIN=1 run <<< "LEAKED-INPUT"
eq "every call saw an empty stdin" "stdin=[]" "$(sort -u "$FAKE_LOG.stdin")"
eq "...so all three dirs were refreshed (2 calls each)" "6" "$(calls)"

echo ""
echo "a hanging claude is killed in time, also without coreutils timeout"
echo "=================================================================="
# A PATH with the tools the library and the fake need, and NO timeout/gtimeout:
# the shape of a stock macOS install. perl stays (macOS always has it).
mkpath() { # dir tool...
  local d="$1" t p; shift; mkdir -p "$d"
  for t in "$@"; do p="$(command -v "$t")" && ln -sf "$p" "$d/$t"; done
}
BASE_TOOLS="bash env python3 mktemp rm grep sed tail sleep cat"
mkpath "$TMPD/path-perl" $BASE_TOOLS perl
mkpath "$TMPD/path-bare" $BASE_TOOLS
eq "the test PATH really has no timeout" "no" "$(PATH="$TMPD/path-perl" command -v timeout >/dev/null 2>&1 && echo yes || echo no)"

fresh
reg "$HOME_D/.claude" "$REG_WITH"
start=$SECONDS
PATH="$TMPD/path-perl" CHANNEL_PLUGIN_TIMEOUT_S=1 FAKE_SLEEP=30 run
took=$((SECONDS - start))
if [ "$took" -lt 10 ]; then pass "no timeout on PATH: perl's alarm stops a 30 s hang after 1 s (took ${took}s)"; else fail "perl fallback bounds the call" "< 10s" "${took}s"; fi
eq "...exit 0" "0" "$RC"
case "$OUT" in *"kilepesi kod 142"*) pass "...and it is logged as a failure (SIGALRM, 142)" ;; *) fail "...logged as a failure" "kilepesi kod 142" "$OUT" ;; esac
eq "...the plugin update is not attempted after the killed marketplace step" "0" "$(grep -c 'plugin update slack' "$FAKE_LOG")"

# The hang is in a grandchild holding the output pipe (git under claude): the
# whole process group must go, or update.sh waits for the grandchild.
fresh
reg "$HOME_D/.claude" "$REG_WITH"
start=$SECONDS
PATH="$TMPD/path-perl" CHANNEL_PLUGIN_TIMEOUT_S=1 FAKE_GRANDCHILD=20 FAKE_SLEEP=30 run
took=$((SECONDS - start))
if [ "$took" -lt 10 ]; then pass "a grandchild holding the pipe does not hold the refresh (took ${took}s, it would live 20s)"; else fail "the process group is killed" "< 10s" "${took}s"; fi
case "$OUT" in *"kilepesi kod 142"*) pass "...still exit 142" ;; *) fail "...still exit 142" "kilepesi kod 142" "$OUT" ;; esac
gc_alive="no"; while read -r gp; do kill -0 "$gp" 2>/dev/null && gc_alive="yes ($gp)"; done < "$FAKE_LOG.gc"
eq "...and the grandchild is gone" "no" "$gc_alive"
fresh
reg "$HOME_D/.claude" "$REG_WITH"
PATH="$TMPD/path-perl" FAKE_FAIL="/home/" run
case "$OUT" in *"kilepesi kod 3"*) pass "under the perl limit a normal exit code passes through" ;; *) fail "exit code passes through" "kilepesi kod 3" "$OUT" ;; esac

# coreutils timeout, when present, is the one used (a logging stand-in here).
mkdir -p "$TMPD/path-to"
cat > "$TMPD/path-to/timeout" <<'EOF'
#!/bin/bash
echo "timeout-used $1" >> "$FAKE_LOG.timeout"; shift; exec "$@"
EOF
chmod +x "$TMPD/path-to/timeout"
fresh
reg "$HOME_D/.claude" "$REG_WITH"
PATH="$TMPD/path-to:$TMPD/path-perl" run
eq "with timeout on PATH it wraps every call, 300 s by default" "timeout-used 300" "$(sort -u "$FAKE_LOG.timeout")"
eq "...both calls" "2" "$(wc -l < "$FAKE_LOG.timeout" | tr -d ' ')"

fresh
reg "$HOME_D/.claude" "$REG_WITH"
PATH="$TMPD/path-bare" run
eq "neither timeout nor perl: still runs" "2" "$(calls)"
case "$OUT" in *"idokorlat nelkul"*) pass "...and says it is unbounded" ;; *) fail "...says it is unbounded" "idokorlat nelkul" "$OUT" ;; esac

echo ""
echo "update.sh wiring (read, never run)"
echo "=================================="
seed="$(grep -n '^run_seed_refresh$' "$UPDATE" | cut -d: -f1)"
call="$(grep -n 'refresh_channel_plugins "\$INSTALL_DIR" "\$HOME" ) || true$' "$UPDATE" | cut -d: -f1)"
uptodate="$(grep -n '^if \[ "\$OLD_VERSION" = "\$NEW_VERSION" \]; then$' "$UPDATE" | cut -d: -f1)"
restart="$(grep -n '^FINALIZE_SCRIPT=' "$UPDATE" | cut -d: -f1)"
if [ -n "$seed" ] && [ -n "$call" ] && [ -n "$uptodate" ] && [ -n "$restart" ] && [ "$seed" -lt "$call" ] && [ "$call" -lt "$uptodate" ] && [ "$call" -lt "$restart" ]; then
  pass "update.sh calls it in a subshell, never fatal, before the up-to-date exit and the restart"
else
  fail "update.sh wiring" "seed < call < up-to-date exit, call < restart" "seed=$seed call=$call uptodate=$uptodate restart=$restart"
fi
eq "...exactly once" "1" "$(grep -c 'refresh_channel_plugins' "$UPDATE")"

echo ""
echo "the current ref comes from the registry (SLACKPLUGINVER1006B)"
echo "============================================================"
ID=slack-channel@marveen-marketplace
C="$TMPD/c/$RANDOM$RANDOM/cfg"; mkdir -p "$C"
ref_of() { ( . "$LIB" && channel_plugin_current_ref "$C" "$ID" ); }
OUT="$(ref_of)"; RC=$?
eq "no registry: nothing printed" "" "$OUT"; eq "...exit 1" "1" "$RC"
reg "$C" "$REG_WITHOUT"; OUT="$(ref_of)"; RC=$?
eq "registry without the plugin: exit 1" "1" "$RC"
reg "$C" '{not json'; OUT="$(ref_of)"; RC=$?
eq "unreadable registry: exit 1" "1" "$RC"
reg "$C" '{"plugins":{"'"$ID"'":[{"scope":"user","version":"0.2.1"}]}}'; OUT="$(ref_of)"; RC=$?
eq "an entry without installPath does not count: exit 1" "1" "$RC"
reg "$C" '{"plugins":{"'"$ID"'":[{"scope":"user","version":"0.2.1"},{"scope":"project","installPath":"/x/p/0.2.2"}]}}'
eq "...so a user entry without one yields to an entry that has it" "0.2.2" "$(ref_of)"
reg "$C" '{"plugins":{"'"$ID"'":[{"scope":"user","installPath":"/x/slack-channel/0.2.3/"}]}}'
eq "the installPath basename, a trailing slash ignored, no sha" "0.2.3" "$(ref_of)"
reg "$C" '{"plugins":{"'"$ID"'":[{"scope":"user","installPath":"/x/slack-channel/0.1.0","gitCommitSha":"93b32144796c9407c0688af7f9b8de3d8fb278bb"}]}}'
eq "a hand deploy into the same dir is told apart by the commit" "0.1.0@93b32144796c" "$(ref_of)"
reg "$C" '{"plugins":{"'"$ID"'":[{"scope":"project","installPath":"/x/p/0.9.9","lastUpdated":"2026-12-01T00:00:00Z"},{"scope":"user","installPath":"/x/u/0.2.3","lastUpdated":"2026-01-01T00:00:00Z"}]}}'
eq "the user-scope entry wins over a newer project entry" "0.2.3" "$(ref_of)"
reg "$C" '{"plugins":{"'"$ID"'":[{"scope":"project","installPath":"/x/a/0.1.0","lastUpdated":"2026-08-12T18:30:59.439Z"},{"scope":"project","installPath":"/x/b/0.2.3","lastUpdated":"2026-10-15T20:00:00.000Z"},{"scope":"project","installPath":"/x/c/0.2.2","lastUpdated":"2026-10-01T00:00:00.000Z"}]}}'
eq "without a user entry the most recently updated one" "0.2.3" "$(ref_of)"

echo ""
echo "update.sh's Slack smoke-test block sees an official update"
echo "========================================================="
# The block itself, cut out of update.sh and run in a sandbox: HOME and
# INSTALL_DIR are fixtures, no agent has a Slack .env and there is no smoke-test
# script, so nothing can reach Slack; only the ref detection and the ref file
# are measured.
first="$(grep -n '^SLACK_REF_FILE=' "$UPDATE" | cut -d: -f1)"
last="$(grep -n '^# Scrub any polluted channel tokens' "$UPDATE" | cut -d: -f1)"
sed -n "${first},$((last - 1))p" "$UPDATE" > "$TMPD/smoke-block.sh"
run_block() { # home install
  ( HOME="$1" INSTALL_DIR="$2" UPDATE_PIDFILE="$2/pid" UPDATE_PIDFILE_TMP="$2/pid.tmp" \
    RED="" NC="" bash -c 'write_result() { :; }; . "$0"' "$TMPD/smoke-block.sh" 2>&1 )
}
B="$TMPD/b/$RANDOM$RANDOM"; BH="$B/home"; BI="$B/install"
mkdir -p "$BH/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0" \
  "$BH/.claude/plugins/cache/marveen-marketplace/slack-channel/0.2.3" "$BI/store" "$BI/scripts/lib" "$BI/agents"
cp "$LIB" "$BI/scripts/lib/channel-plugin-refresh.sh"
REFF="$BI/store/marveen-marketplace-slack-channel-ref.txt"
echo "0.1.0" > "$REFF"
reg "$BH/.claude" '{"plugins":{"'"$ID"'":[{"scope":"user","installPath":"'"$BH"'/.claude/plugins/cache/marveen-marketplace/slack-channel/0.2.3","gitCommitSha":"abcdef0123456789"}]}}'
OUT="$(run_block "$BH" "$BI")"
case "$OUT" in *"ref valtozott: 0.1.0 -> 0.2.3@abcdef012345"*) pass "a new version dir next to the old one is noticed" ;; *) fail "new version noticed" "ref valtozott: 0.1.0 -> 0.2.3@abcdef012345" "$OUT" ;; esac
eq "...and becomes the stored ref" "0.2.3@abcdef012345" "$(cat "$REFF")"
OUT="$(run_block "$BH" "$BI")"
eq "the next update with nothing new says nothing" "" "$OUT"
rm "$BH/.claude/plugins/installed_plugins.json"; echo "x" > "$REFF"
OUT="$(run_block "$BH" "$BI")"
eq "without a registry the old dir listing is the fallback" "0.1.0" "$(cat "$REFF")"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
