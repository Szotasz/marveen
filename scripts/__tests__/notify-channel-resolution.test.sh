#!/bin/bash
# Contract tests for the channel-state resolution in scripts/notify.sh.
# Run: bash scripts/__tests__/notify-channel-resolution.test.sh
#
# WHY THIS EXISTS. notify.sh is the fleet's FALLBACK alarm: it fires when the
# Telegram plugin is already down, so a silent regression here is invisible
# until something else is on fire. Until now nothing exercised it, because
# reaching the send means reaching the real Bot API. NOTIFY_RESOLVE_DRYRUN stops
# the script right after resolution and prints what it found, which is exactly
# the part that breaks.
#
# The order under test is the canonical one from src/channel-provider.ts
# (resolveMainChannelStateDir), mapped to shell:
#   1. <PROVIDER>_STATE_DIR   2. install-scoped (while it holds .env)   3. legacy $HOME

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_contains() {
  case "$3" in *"$2"*) pass "$1" ;; *) fail "$1 (expected to contain '$2', got: $3)" ;; esac
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A throwaway install root: notify.sh resolves PROJECT_DIR from its own path, so
# the script is copied in rather than run from the repo.
INSTALL="$TMP/install"
mkdir -p "$INSTALL/scripts/lib" "$INSTALL/.claude/channels/telegram"
REAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cp "$REAL_DIR/notify.sh" "$INSTALL/scripts/notify.sh"
: > "$INSTALL/scripts/lib/send-telegram.sh"   # never reached in dry-run

write_env() { printf 'TELEGRAM_BOT_TOKEN=%s\nALLOWED_CHAT_ID=%s\nMAIN_AGENT_ID=marveen\n' "$1" "$2" > "$INSTALL/.env"; }
write_chan() { mkdir -p "$1"; printf 'TELEGRAM_BOT_TOKEN=%s\n' "$2" > "$1/.env"; }
write_access() { mkdir -p "$1"; printf '{"allowFrom":["%s"]}\n' "$2" > "$1/access.json"; }

run() { HOME="$TMP/home" NOTIFY_RESOLVE_DRYRUN=1 bash "$INSTALL/scripts/notify.sh" "x" 2>&1; }

mkdir -p "$TMP/home/.claude/channels/telegram"

# 1. Everything present in .env: no fallback should be consulted at all.
write_env "env-token" "111"
out="$(run)"
assert_contains "env .env wins for token" "token_src=env" "$out"
assert_contains "env .env wins for chat" "chat_id=111" "$out"

# 2. Placeholder chat id -> access.json of the install-scoped dir.
write_env "env-token" "0"
write_access "$INSTALL/.claude/channels/telegram" "222"
write_chan "$INSTALL/.claude/channels/telegram" "chan-token"
out="$(run)"
assert_contains "placeholder falls back to access.json" "chat_id=222" "$out"
assert_contains "and says so" "chat_src=access.json" "$out"

# 3. Empty token in .env -> the channel state dir supplies it.
write_env "" "333"
out="$(run)"
assert_contains "empty token falls back to the channel dir" "token_src=channel" "$out"

# 4. Install-scoped is preferred over legacy while it holds the .env.
write_access "$TMP/home/.claude/channels/telegram" "999"
write_chan "$TMP/home/.claude/channels/telegram" "legacy-token"
out="$(run)"
assert_contains "install-scoped beats legacy" "chan_dir=$INSTALL/.claude/channels/telegram" "$out"

# 5. NEGATIVE CONTROL: with no install-scoped .env, legacy is used. This is the
#    unmigrated install, and getting it wrong is what made the old code silent.
rm -f "$INSTALL/.claude/channels/telegram/.env"
out="$(run)"
assert_contains "legacy used when install-scoped has no .env" "chan_dir=$TMP/home/.claude/channels/telegram" "$out"

# 6. The env override outranks both.
OVERRIDE="$TMP/override/telegram"; write_chan "$OVERRIDE" "override-token"; write_access "$OVERRIDE" "444"
out="$(HOME="$TMP/home" TELEGRAM_STATE_DIR="$OVERRIDE" NOTIFY_RESOLVE_DRYRUN=1 bash "$INSTALL/scripts/notify.sh" "x" 2>&1)"
assert_contains "TELEGRAM_STATE_DIR outranks install-scoped and legacy" "chan_dir=$OVERRIDE" "$out"

# 7. Nothing anywhere -> loud failure, not a silent success.
rm -rf "$TMP/home/.claude/channels/telegram" "$OVERRIDE" "$INSTALL/.claude/channels/telegram"
write_env "" "0"
out="$(run)"; rc=$?
assert_contains "no token anywhere fails loudly" "nincs bot-token" "$out"
[ "$rc" -ne 0 ] && pass "and exits non-zero" || fail "and exits non-zero (got $rc)"

echo "notify-channel-resolution: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
