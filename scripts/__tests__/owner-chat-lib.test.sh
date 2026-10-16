#!/bin/bash
# Contract tests for scripts/lib/owner-chat.sh (CHATID0).
# Run: bash scripts/__tests__/owner-chat-lib.test.sh
#
# The cases mirror src/__tests__/owner-chat.test.ts (the TS original) plus the
# shell-specific edge cases a hand-edited .env produces: CRLF line endings and
# quoted values, which the TS reader never sees (env.ts strips those before
# owner-chat.ts runs).

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
. "$REPO/scripts/lib/owner-chat.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Hermetic: run inside an agent session, the inherited channel state dir and
# HOME (legacy ~/.claude/channels) would point at the live access.json.
unset TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR
export HOME="$TMP/home"
mkdir -p "$HOME"

echo "owner-chat.sh"

# --- .env value normalization -------------------------------------------
dir="$TMP/plain"
mkdir -p "$dir"
printf 'ALLOWED_CHAT_ID=5040302010\n' > "$dir/.env"
assert_eq "a real configured id passes through" \
  "5040302010" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

dir="$TMP/placeholder"
mkdir -p "$dir"
printf 'ALLOWED_CHAT_ID=0\n' > "$dir/.env"
out="$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"; rc=$?
assert_eq "the \"0\" placeholder resolves to nothing" "" "$out"
[ "$rc" -ne 0 ] && pass "the \"0\" placeholder is a failure exit" || fail "the \"0\" placeholder is a failure exit"

dir="$TMP/empty"
mkdir -p "$dir"
printf 'ALLOWED_CHAT_ID=\n' > "$dir/.env"
assert_eq "an empty value resolves to nothing" \
  "" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

# --- CRLF .env (hand-edited on Windows) ----------------------------------
dir="$TMP/crlf"
mkdir -p "$dir"
printf 'ALLOWED_CHAT_ID=5040302010\r\n' > "$dir/.env"
assert_eq "a CRLF-terminated value strips the CR" \
  "5040302010" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

dir="$TMP/crlf-placeholder"
mkdir -p "$dir"
printf 'ALLOWED_CHAT_ID=0\r\n' > "$dir/.env"
assert_eq "a CRLF-terminated placeholder is still refused" \
  "" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

# --- quoted .env value ----------------------------------------------------
dir="$TMP/quoted"
mkdir -p "$dir"
printf 'ALLOWED_CHAT_ID="5040302010"\n' > "$dir/.env"
assert_eq "a quoted value has its quotes stripped" \
  "5040302010" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

dir="$TMP/quoted-placeholder"
mkdir -p "$dir"
printf "ALLOWED_CHAT_ID='0'\n" > "$dir/.env"
assert_eq "a quoted placeholder is still refused" \
  "" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

# --- access.json fallback --------------------------------------------------
dir="$TMP/access-fallback"
mkdir -p "$dir/.claude/channels/telegram"
printf 'ALLOWED_CHAT_ID=0\n' > "$dir/.env"
printf 'TELEGRAM_BOT_TOKEN=x\n' > "$dir/.claude/channels/telegram/.env"
printf '{"allowFrom":["1268077055"]}\n' > "$dir/.claude/channels/telegram/access.json"
assert_eq "placeholder .env falls back to a paired access.json entry" \
  "1268077055" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

dir="$TMP/access-groups"
mkdir -p "$dir/.claude/channels/telegram"
printf 'ALLOWED_CHAT_ID=0\n' > "$dir/.env"
printf 'TELEGRAM_BOT_TOKEN=x\n' > "$dir/.claude/channels/telegram/.env"
printf '{"allowFrom":[],"groups":{"-100999":{}}}\n' > "$dir/.claude/channels/telegram/access.json"
out="$(resolve_owner_chat_id "$dir/.env" 2>"$TMP/err")"; rc=$?
assert_eq "never falls back to a group entry (alerts: DM only)" "" "$out"
[ "$rc" -ne 0 ] && pass "group-only access.json -> failure exit" || fail "group-only access.json -> failure exit"
grep -q "no DM entry" "$TMP/err" && pass "group-only: the reason names the missing DM entry" || fail "group-only: reason line missing ($(cat "$TMP/err"))"

# --- exactly one DM entry (review round 1, item 3) ----------------------
dir="$TMP/access-two-dm"
mkdir -p "$dir/.claude/channels/telegram"
printf 'ALLOWED_CHAT_ID=0\n' > "$dir/.env"
printf 'TELEGRAM_BOT_TOKEN=x\n' > "$dir/.claude/channels/telegram/.env"
printf '{"allowFrom":["1268077055","2233445566"]}\n' > "$dir/.claude/channels/telegram/access.json"
out="$(resolve_owner_chat_id "$dir/.env" 2>"$TMP/err")"; rc=$?
assert_eq "two DM entries -> nothing (the first would be a guess)" "" "$out"
[ "$rc" -ne 0 ] && pass "two DM entries -> failure exit" || fail "two DM entries -> failure exit"
grep -q "2 DM entries" "$TMP/err" && pass "two DM entries: the reason says so" || fail "two DM entries: reason line missing ($(cat "$TMP/err"))"

dir="$TMP/access-dup-dm"
mkdir -p "$dir/.claude/channels/telegram"
printf 'ALLOWED_CHAT_ID=0\n' > "$dir/.env"
printf 'TELEGRAM_BOT_TOKEN=x\n' > "$dir/.claude/channels/telegram/.env"
printf '{"allowFrom":["1268077055",1268077055,"0"]}\n' > "$dir/.claude/channels/telegram/access.json"
assert_eq "the same person listed twice (string + number) is still one entry" \
  "1268077055" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

dir="$TMP/access-negative-dm"
mkdir -p "$dir/.claude/channels/telegram"
printf 'ALLOWED_CHAT_ID=0\n' > "$dir/.env"
printf 'TELEGRAM_BOT_TOKEN=x\n' > "$dir/.claude/channels/telegram/.env"
printf '{"allowFrom":["-100999","1268077055"]}\n' > "$dir/.claude/channels/telegram/access.json"
assert_eq "a negative (group/channel) id in allowFrom is not a DM entry" \
  "1268077055" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

# --- a sub-agent's TELEGRAM_STATE_DIR (review round 1, item 1) -----------
# notify.sh runs in agents' environments. A sub-agent with its own channel
# carries its own state dir in TELEGRAM_STATE_DIR; the resolver must still read
# the MAIN install's access.json, never the sub-agent's paired person.
dir="$TMP/subagent"
mkdir -p "$dir/.claude/channels/telegram" "$dir/agents/helper/.claude/channels/telegram"
printf 'ALLOWED_CHAT_ID=0\n' > "$dir/.env"
printf 'TELEGRAM_BOT_TOKEN=x\n' > "$dir/.claude/channels/telegram/.env"
printf '{"allowFrom":["1268077055"]}\n' > "$dir/.claude/channels/telegram/access.json"
printf 'TELEGRAM_BOT_TOKEN=y\n' > "$dir/agents/helper/.claude/channels/telegram/.env"
printf '{"allowFrom":["9988776655"]}\n' > "$dir/agents/helper/.claude/channels/telegram/access.json"
assert_eq "a sub-agent TELEGRAM_STATE_DIR does not redirect to the sub-agent's person" \
  "1268077055" "$(TELEGRAM_STATE_DIR="$dir/agents/helper/.claude/channels/telegram" resolve_owner_chat_id "$dir/.env" 2>/dev/null)"
rm "$dir/.claude/channels/telegram/access.json"
assert_eq "...and with no main access.json it sends nowhere, not to the sub-agent" \
  "" "$(TELEGRAM_STATE_DIR="$dir/agents/helper/.claude/channels/telegram" resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

dir="$TMP/no-owner-chat"
mkdir -p "$dir"
printf 'ALLOWED_CHAT_ID=0\n' > "$dir/.env"
out="$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"; rc=$?
assert_eq "no access.json at all -> nothing" "" "$out"
[ "$rc" -ne 0 ] && pass "no access.json at all -> failure exit" || fail "no access.json at all -> failure exit"

# --- CLI-like invocation (source + call from a subshell script) ----------
cli_out="$(bash -c '. "'"$REPO"'/scripts/lib/owner-chat.sh"; resolve_owner_chat_id "'"$TMP"'/access-fallback/.env" 2>/dev/null')"
assert_eq "CLI-style invocation (subshell source + call) matches" "1268077055" "$cli_out"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
