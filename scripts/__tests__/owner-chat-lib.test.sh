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
assert_eq "falls back to a group entry when allowFrom is empty" \
  "-100999" "$(resolve_owner_chat_id "$dir/.env" 2>/dev/null)"

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
