#!/bin/bash
# MORNTIMER2197 (#2197): scripts/morning-briefing.sh runs its headless
# `claude -p` on an API key only. The daily briefing ships as the seeded
# reggeli-napindito task inside the live channel session; this script is the
# opt-in manual path, and it must not spend the install's subscription login on
# an unattended run.
#
# Contract:
#   1. no ANTHROPIC_API_KEY (neither the .env nor the caller) -> claude is never
#      started, the day is not stamped, the exit status is non-zero, and the log
#      says why;
#   2. a key in the .env -> the run starts, with the key, and WITHOUT the
#      subscription tokens the same .env carries (CLAUDE_CODE_OAUTH_TOKEN,
#      ANTHROPIC_AUTH_TOKEN; the latter outranks the API key in Claude Code's
#      documented auth order);
#   3. a key only in the caller's environment -> the run starts too.
# Hermetic: throwaway install dirs, a claude stub via CLAUDE_BIN that refuses
# (no sentinel), so nothing is delivered and no Bot API is reached.
# Run: bash scripts/__tests__/morning-briefing-api-key-only.test.sh
set -u

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# run_case <dotenv extra lines> [caller key]
# Sets RC, DIR; the stub writes $DIR/store/claude-env when it runs.
run_case() {
  local extra="$1" caller_key="${2:-}"
  DIR="$TMP/inst.$RANDOM"
  mkdir -p "$DIR/scripts/lib" "$DIR/store" "$DIR/bin"
  cp "$REPO/scripts/morning-briefing.sh" "$DIR/scripts/"
  cp "$REPO/scripts/lib/owner-chat.sh" "$REPO/scripts/lib/send-telegram.sh" "$DIR/scripts/lib/"
  printf 'ALLOWED_CHAT_ID=1234\nTELEGRAM_BOT_TOKEN=tok-ok\n%s' "$extra" > "$DIR/.env"
  cat > "$DIR/bin/claude" <<'STUB'
#!/bin/bash
OUT="$(dirname "$0")/../store"
for v in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN; do
  printf '%s=%s\n' "$v" "${!v-<unset>}"
done > "$OUT/claude-env"
echo "stub: not sending"
STUB
  chmod +x "$DIR/bin/claude"
  if [ -n "$caller_key" ]; then
    env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY="$caller_key" \
      HOME="$DIR" CLAUDE_BIN="$DIR/bin/claude" bash "$DIR/scripts/morning-briefing.sh" >/dev/null 2>&1
  else
    env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_AUTH_TOKEN \
      HOME="$DIR" CLAUDE_BIN="$DIR/bin/claude" bash "$DIR/scripts/morning-briefing.sh" >/dev/null 2>&1
  fi
  RC=$?
}

echo "morning-briefing: API key only (MORNTIMER2197)"

# 1. Subscription token only: refused before the model call.
run_case 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-subscription
'
if [ -f "$DIR/store/claude-env" ]; then fail "no key -> claude is never started"; else pass "no key -> claude is never started"; fi
if [ "$RC" -ne 0 ]; then pass "no key -> non-zero exit ($RC)"; else fail "no key -> non-zero exit (got 0)"; fi
assert_eq "no key -> the day is not stamped" "<none>" "$(cat "$DIR/store/.morning-last-sent" 2>/dev/null || echo '<none>')"
if grep -q 'MEGTAGADVA: nincs ANTHROPIC_API_KEY' "$DIR/store/morning.log" 2>/dev/null; then
  pass "no key -> the log says why"
else
  fail "no key -> the log says why"
fi

# 2. Key in the .env, next to the subscription tokens.
run_case 'ANTHROPIC_API_KEY=sk-ant-api-test
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-subscription
ANTHROPIC_AUTH_TOKEN=bearer-test
'
if [ -f "$DIR/store/claude-env" ]; then pass "key in .env -> the run starts"; else fail "key in .env -> the run starts"; fi
assert_eq "key in .env -> claude gets the key" "ANTHROPIC_API_KEY=sk-ant-api-test" "$(grep '^ANTHROPIC_API_KEY=' "$DIR/store/claude-env" 2>/dev/null)"
assert_eq "key in .env -> no CLAUDE_CODE_OAUTH_TOKEN reaches claude" "CLAUDE_CODE_OAUTH_TOKEN=<unset>" "$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$DIR/store/claude-env" 2>/dev/null)"
assert_eq "key in .env -> no ANTHROPIC_AUTH_TOKEN reaches claude" "ANTHROPIC_AUTH_TOKEN=<unset>" "$(grep '^ANTHROPIC_AUTH_TOKEN=' "$DIR/store/claude-env" 2>/dev/null)"

# 3. Key only in the caller's environment (a unit Environment= line, a shell).
run_case '' 'sk-ant-api-caller'
if [ -f "$DIR/store/claude-env" ]; then pass "key from the caller -> the run starts"; else fail "key from the caller -> the run starts"; fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
