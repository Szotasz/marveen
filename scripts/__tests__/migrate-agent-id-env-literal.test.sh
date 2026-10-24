#!/bin/bash
# FLEETIMPORTFOLLOW1021: scripts/migrate-main-agent-id.sh reads BOT_NAME from
# .env as a LITERAL. It used to `source .env`, and .env is data: a fleet import
# writes its identity values there (#2112 takes only the identity keys, but a
# BOT_NAME of "$(...)" is a valid identity value), so sourcing ran whatever a
# value held. Every case answers "n" at the confirmation prompt, so nothing is
# migrated; the test reads the slug the script announces. The last block
# (FLEETRESERVEDNAME1021) checks that a reserved id or a sub-agent's name is
# refused before anything changes.
# Run: bash scripts/__tests__/migrate-agent-id-env-literal.test.sh

set -u

PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$TMP/bin"
mkdir -p "$BIN"
# An OS that is neither Darwin nor Linux: no launchctl/systemctl is ever reached.
printf '#!/bin/bash\necho TestOS\n' > "$BIN/uname"
printf '#!/bin/bash\nexit 0\n' > "$BIN/tmux"
chmod +x "$BIN/uname" "$BIN/tmux"

# run_case <label> <env file content> [extra env assignment]
# Sets OUT (stdout+stderr) and RC.
run_case() {
  local dir="$TMP/$1"
  mkdir -p "$dir/scripts" "$dir/home"
  cp "$REPO/scripts/migrate-main-agent-id.sh" "$dir/scripts/"
  printf '%s\n' "$2" > "$dir/.env"
  OUT="$(cd "$TMP" && env -u BOT_NAME HOME="$dir/home" PATH="$BIN:$PATH" ${3:-} \
    bash "$dir/scripts/migrate-main-agent-id.sh" <<< "n" 2>&1)"
  RC=$?
}
slug_of() { printf '%s\n' "$OUT" | sed -n 's/^Migrating main agent id: marveen → \([^ ]*\) .*/\1/p'; }

echo "migrate-main-agent-id.sh -- .env is read as data, never sourced"

# --- a value that is a command is NOT run ----------------------------------------
MARK="$TMP/pwned"
run_case cmdsub "BOT_NAME=\$(touch $MARK)"
[ ! -e "$MARK" ] && pass "BOT_NAME=\$(...) is not executed" || fail "BOT_NAME=\$(...) was executed"
case "$(slug_of)" in touch-*pwned*) pass "the slug comes from the literal text" ;; *) fail "unexpected slug: '$(slug_of)' rc=$RC" ;; esac

rm -f "$MARK"
run_case backtick "BOT_NAME=\`touch $MARK\`"
[ ! -e "$MARK" ] && pass "BOT_NAME=\`...\` is not executed" || fail "BOT_NAME=\`...\` was executed"

rm -f "$MARK"
run_case otherkey "$(printf 'BOT_NAME="Test Bot"\nOWNER_NAME=$(touch %s)' "$MARK")"
[ ! -e "$MARK" ] && pass "a command in ANOTHER key is not executed" || fail "a command in another key was executed"
[ "$(slug_of)" = "test-bot" ] && pass "BOT_NAME still read next to it" || fail "slug '$(slug_of)'"

# --- the value shapes source used to accept still read the same --------------------
# The slug drops quotes anyway, so the value itself is read off the announce line.
named() { printf '%s\n' "$OUT" | grep -qF "(BOT_NAME=\"$1\")"; }
run_case dq 'BOT_NAME="Test Bot"'
[ "$(slug_of)" = "test-bot" ] && named 'Test Bot' && pass 'double-quoted value' || fail "double-quoted: '$(slug_of)' $OUT"
run_case sq "BOT_NAME='Test Bot'"
[ "$(slug_of)" = "test-bot" ] && named 'Test Bot' && pass 'single-quoted value' || fail "single-quoted: '$(slug_of)' $OUT"
run_case bare 'BOT_NAME=Atlas'
[ "$(slug_of)" = "atlas" ] && pass 'bare value' || fail "bare: '$(slug_of)'"
run_case export 'export BOT_NAME=Atlas'
[ "$(slug_of)" = "atlas" ] && pass 'export prefix' || fail "export: '$(slug_of)'"
run_case comment 'BOT_NAME=Atlas # the bot'
[ "$(slug_of)" = "atlas" ] && pass 'trailing comment on a bare value' || fail "comment: '$(slug_of)'"
run_case last "$(printf 'BOT_NAME=First\nBOT_NAME=Second')"
[ "$(slug_of)" = "second" ] && pass 'the last assignment wins (as with source)' || fail "last: '$(slug_of)'"

# --- no BOT_NAME in .env: the caller's environment, then the default ----------------
run_case inherited 'WEB_PORT=3420' 'BOT_NAME=Hermes'
[ "$(slug_of)" = "hermes" ] && pass 'no BOT_NAME in .env: the environment value' || fail "inherited: '$(slug_of)'"
run_case default 'WEB_PORT=3420'
printf '%s\n' "$OUT" | grep -q 'Nothing to migrate' && pass 'no BOT_NAME anywhere: the default, nothing to migrate' || fail "default: $OUT"

# --- FLEETRESERVEDNAME1021: a reserved id or a sub-agent's name is refused ----------
# Refused before anything is stopped: exit 1, no "Migrating" line, .env untouched.
refused() { [ "$RC" -eq 1 ] && ! printf '%s\n' "$OUT" | grep -q '^Migrating' && ! grep -q '^MAIN_AGENT_ID=' "$TMP/$1/.env"; }
for name in System Heartbeat Telegram-Coordinator 'Channel Coordinator' Hanna; do
  label="reserved-$(printf '%s' "$name" | tr ' A-Z' '-a-z')"
  run_case "$label" "BOT_NAME=\"$name\""
  refused "$label" && printf '%s\n' "$OUT" | grep -q 'reserved by the system' \
    && pass "BOT_NAME=\"$name\" is refused as a reserved id" || fail "reserved '$name': rc=$RC $OUT"
done
mkdir -p "$TMP/subagent/agents/atlas"
run_case subagent 'BOT_NAME=Atlas'
refused subagent && printf '%s\n' "$OUT" | grep -q 'already a sub-agent' \
  && pass "a BOT_NAME whose id is a sub-agent's is refused" || fail "subagent: rc=$RC $OUT"
mkdir -p "$TMP/defaultsub/agents/marveen"
run_case defaultsub 'BOT_NAME=Marveen'
printf '%s\n' "$OUT" | grep -q 'Nothing to migrate' && pass 'the default id is not refused by an agents/marveen dir' || fail "defaultsub: $OUT"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
