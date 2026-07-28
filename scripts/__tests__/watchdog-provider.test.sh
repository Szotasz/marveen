#!/bin/bash
# Contract tests for scripts/watchdog.sh provider resolution.
#
# Regression origin (2026-07-26): the sub-agent watchdog read the bot token
# from .claude/channels/telegram/.env and respawned with plugin:telegram,
# regardless of the agent's actual channelProvider. A discord-primary agent
# therefore hit "no bot token, skipping" and was NEVER restarted -- the log
# line looks routine, so the outage was invisible. Two live agents sat in
# that state undetected.
#
# Driven through `watchdog.sh --resolve-provider <dir>`, which resolves and
# exits before touching tmux, the dashboard API or the log -- so these run
# from fixtures with no live agent and no real token.
# Run: bash scripts/__tests__/watchdog-provider.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to
# confirm it actually fails on the bug (a green test that cannot go red is
# worse than no test -- it certifies health it never checked).
WATCHDOG="${WATCHDOG_BIN:-$INSTALL_DIR/scripts/watchdog.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# $1 = fixture name, $2 = agent-config.json content ("" = no file at all)
make_agent() {
  local dir="$TMP/$1"
  mkdir -p "$dir"
  [ -n "$2" ] && printf '%s' "$2" > "$dir/agent-config.json"
  echo "$dir"
}

# $1 = label, $2 = agent dir, $3 = expected full output line
expect_resolve() {
  local got
  got=$(bash "$WATCHDOG" --resolve-provider "$2" 2>&1)
  if [ "$got" = "$3" ]; then pass "$1"; else fail "$1" "$got"; fi
}

echo "watchdog provider-resolution tests"
echo "==================================="
echo ""

# ---------------------------------------------------------------------------
# The bug: discord-primary agent must resolve to discord, not telegram.
# ---------------------------------------------------------------------------
echo "(a) Explicit providers"
expect_resolve "discord agent resolves to discord" \
  "$(make_agent discord '{"channelProvider":"discord","model":"claude-opus-4-8"}')" \
  "provider=discord token_var=DISCORD_BOT_TOKEN state_env_var=DISCORD_STATE_DIR"
expect_resolve "slack agent resolves to slack" \
  "$(make_agent slack '{"channelProvider":"slack"}')" \
  "provider=slack token_var=SLACK_BOT_TOKEN state_env_var=SLACK_STATE_DIR"
expect_resolve "teams agent resolves to teams" \
  "$(make_agent teams '{"channelProvider":"teams"}')" \
  "provider=teams token_var=TEAMS_BOT_TOKEN state_env_var=TEAMS_STATE_DIR"
expect_resolve "googlechat agent resolves to googlechat" \
  "$(make_agent gchat '{"channelProvider":"googlechat"}')" \
  "provider=googlechat token_var=GOOGLECHAT_BOT_TOKEN state_env_var=GOOGLECHAT_STATE_DIR"
expect_resolve "telegram agent resolves to telegram" \
  "$(make_agent tg '{"channelProvider":"telegram"}')" \
  "provider=telegram token_var=TELEGRAM_BOT_TOKEN state_env_var=TELEGRAM_STATE_DIR"

# ---------------------------------------------------------------------------
# Back-compat: every degenerate input must still land on telegram, so
# existing single-channel installs are untouched by this change.
# ---------------------------------------------------------------------------
echo ""
echo "(b) Fallback to telegram"
TG_LINE="provider=telegram token_var=TELEGRAM_BOT_TOKEN state_env_var=TELEGRAM_STATE_DIR"
expect_resolve "config without channelProvider" \
  "$(make_agent noprov '{"model":"claude-haiku-4-5-20251001"}')" "$TG_LINE"
expect_resolve "no agent-config.json at all" \
  "$(make_agent nofile '')" "$TG_LINE"
expect_resolve "malformed JSON" \
  "$(make_agent badjson '{not valid json')" "$TG_LINE"
expect_resolve "empty channelProvider string" \
  "$(make_agent emptyprov '{"channelProvider":""}')" "$TG_LINE"
expect_resolve "unknown provider name" \
  "$(make_agent unknown '{"channelProvider":"carrier-pigeon"}')" "$TG_LINE"

# ---------------------------------------------------------------------------
# The self-test hook must not fire on a normal watchdog run, and must not
# silently succeed when called wrong.
# ---------------------------------------------------------------------------
echo ""
echo "(c) Hook contract"
bash "$WATCHDOG" --resolve-provider >/dev/null 2>&1
if [ $? -eq 2 ]; then pass "missing dir argument exits 2"; else fail "missing dir argument exits 2" "exit=$?"; fi

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
