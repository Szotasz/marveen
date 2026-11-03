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

# --- VOICECHANNELID1022: the CONFIGURED voice channel id is the reserved one --------
run_case voice-custom "$(printf 'VOICE_CHANNEL_ID=voice-relay\nBOT_NAME="Voice Relay"')"
refused voice-custom && printf '%s\n' "$OUT" | grep -q 'reserved by the system' \
  && pass 'the configured VOICE_CHANNEL_ID is refused as a reserved id' || fail "voice-custom: rc=$RC $OUT"
run_case voice-freed "$(printf 'VOICE_CHANNEL_ID=voice-relay\nBOT_NAME=Hanna')"
[ "$(slug_of)" = "hanna" ] && pass "with another VOICE_CHANNEL_ID, 'hanna' is not reserved" || fail "voice-freed: rc=$RC $OUT"
run_case voice-invalid "$(printf 'VOICE_CHANNEL_ID=Not_Valid\nBOT_NAME=Hanna')"
refused voice-invalid && printf '%s\n' "$OUT" | grep -q 'reserved by the system' \
  && pass "an invalid VOICE_CHANNEL_ID falls back to 'hanna', which stays reserved" || fail "voice-invalid: rc=$RC $OUT"
# The voice id is read with the DASHBOARD's .env grammar (src/env-parse.ts), not the
# BOT_NAME reader's: the script must reserve exactly the id the dashboard uses.
# voice_is <label> <id>: the script reserved <id> as the voice id ("Voice Relay"
# refused, "Hanna" free) -- or, for hanna, the other way round.
voice_is() {
  local label="$1" id="$2" envline="$3"
  run_case "$label-a" "$(printf '%s\nBOT_NAME="Voice Relay"' "$envline")"
  local relay_refused=0; refused "$label-a" && relay_refused=1
  run_case "$label-b" "$(printf '%s\nBOT_NAME=Hanna' "$envline")"
  local hanna_refused=0; refused "$label-b" && hanna_refused=1
  case "$id" in
    voice-relay) [ "$relay_refused" -eq 1 ] && [ "$hanna_refused" -eq 0 ] ;;
    hanna) [ "$relay_refused" -eq 0 ] && [ "$hanna_refused" -eq 1 ] ;;
    none) [ "$relay_refused" -eq 0 ] && [ "$hanna_refused" -eq 0 ] ;;
  esac
}
voice_is grammar-export hanna 'export VOICE_CHANNEL_ID=voice-relay' \
  && pass "'export VOICE_CHANNEL_ID=...' is not the dashboard's key: 'hanna' stays the voice id" || fail 'grammar-export'
voice_is grammar-comment hanna 'VOICE_CHANNEL_ID=voice-relay  # the relay' \
  && pass "a trailing comment is part of the dashboard's value (invalid): 'hanna' stays the voice id" || fail 'grammar-comment'
voice_is grammar-dq voice-relay 'VOICE_CHANNEL_ID="voice-relay"' \
  && pass 'double quotes are stripped, as by the dashboard' || fail 'grammar-dq'
voice_is grammar-sq voice-relay "VOICE_CHANNEL_ID='voice-relay'" \
  && pass 'single quotes are stripped, as by the dashboard' || fail 'grammar-sq'
voice_is grammar-mixed hanna "VOICE_CHANNEL_ID='voice-relay\"" \
  && pass 'mismatched quotes are kept (invalid), as by the dashboard' || fail 'grammar-mixed'
voice_is grammar-ws voice-relay '   VOICE_CHANNEL_ID  =  voice-relay   ' \
  && pass 'whitespace around the key and the value is trimmed, as by the dashboard' || fail 'grammar-ws'
voice_is grammar-ws-quoted voice-relay 'VOICE_CHANNEL_ID=" voice-relay "' \
  && pass 'whitespace inside the quotes is trimmed by the resolver, as by the dashboard' || fail 'grammar-ws-quoted'
voice_is grammar-crlf voice-relay "$(printf 'VOICE_CHANNEL_ID=voice-relay\r')" \
  && pass 'a CRLF line end is trimmed, as by the dashboard' || fail 'grammar-crlf'
voice_is sender-collision hanna "$(printf 'SYSTEM_SENDER_IDS=cortex,voice-relay\nVOICE_CHANNEL_ID=voice-relay')" \
  && pass "a VOICE_CHANNEL_ID that is a SYSTEM_SENDER_IDS entry falls back to 'hanna'" || fail 'sender-collision'
voice_is lane-off none 'OWNER_NAME=hanna' \
  && pass "when even 'hanna' names another sender, no voice id is reserved (the lane is off)" || fail 'lane-off'

# The voice id is resolved again against the NEW main agent id: a migration that
# would move it (here VOICE_CHANNEL_ID=marveen, invalid while marveen is the main
# agent, valid once the main agent is atlas) is refused before anything changes.
run_case voice-moves "$(printf 'VOICE_CHANNEL_ID=marveen\nBOT_NAME=Atlas')"
refused voice-moves && printf '%s\n' "$OUT" | grep -q 'voice channel id would change from "hanna" to "marveen"' \
  && pass 'a migration that would re-point the voice id is refused' || fail "voice-moves: rc=$RC $OUT"
run_case voice-stays "$(printf 'VOICE_CHANNEL_ID=voice-relay\nBOT_NAME=Atlas')"
[ "$(slug_of)" = "atlas" ] && pass 'NEGATIVE CONTROL: a voice id the migration does not move lets it through' || fail "voice-stays: rc=$RC $OUT"

# Only a DIRECTORY under agents/ is a sub-agent, as on the dashboard: a stray file
# named like the voice id does not push it back to 'hanna'.
for d in voice-file-a voice-file-b; do mkdir -p "$TMP/$d/agents" && : > "$TMP/$d/agents/voice-relay"; done
voice_is voice-file voice-relay 'VOICE_CHANNEL_ID=voice-relay' \
  && pass 'a plain file under agents/ is not a sub-agent' || fail 'voice-file'

mkdir -p "$TMP/voice-subagent/agents/voice-relay"
run_case voice-subagent "$(printf 'VOICE_CHANNEL_ID=voice-relay\nBOT_NAME=Hanna')"
refused voice-subagent && printf '%s\n' "$OUT" | grep -q 'reserved by the system' \
  && pass "a VOICE_CHANNEL_ID that is a sub-agent falls back to 'hanna'" || fail "voice-subagent: rc=$RC $OUT"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
