#!/bin/bash
# Contract tests for scripts/watchdog.sh launch-env isolation parity.
#
# Regression origin: the dashboard launches every sub-agent with a per-agent
# CLAUDE_CONFIG_DIR (agent-process.ts provisions <agent>/.claude-config, gated
# on store/.claude-oauth-token), and channel-watchdog.sh rebuilds the same
# CFG_ENV on its respawn path -- but this watchdog's tmux launch dropped both.
# The FIRST auto-recovery therefore silently moved an agent back onto the
# shared ~/.claude, reintroducing the plugin-slot collisions isolation exists
# to prevent (a live fleet measured 9 agents de-isolated this way).
#
# Driven through `watchdog.sh --launch-env <dir>`, which prints the prefix and
# exits before touching tmux, the dashboard API or the log -- so these run
# from fixtures with no live agent and no real token.
# Run: bash scripts/__tests__/watchdog-config-isolation.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to
# confirm it actually fails on the bug.
WATCHDOG="${WATCHDOG_BIN:-$REPO_DIR/scripts/watchdog.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The watchdog resolves store/.claude-oauth-token relative to its own
# INSTALL_DIR; run it from a fixture install so the token file is ours.
FIXTURE_INSTALL="$TMP/install"
mkdir -p "$FIXTURE_INSTALL/scripts" "$FIXTURE_INSTALL/store" "$FIXTURE_INSTALL/agents"
cp "$WATCHDOG" "$FIXTURE_INSTALL/scripts/watchdog.sh"
WD="$FIXTURE_INSTALL/scripts/watchdog.sh"

AGENT_ISO="$FIXTURE_INSTALL/agents/iso-agent"
AGENT_PLAIN="$FIXTURE_INSTALL/agents/plain-agent"
mkdir -p "$AGENT_ISO/.claude-config" "$AGENT_PLAIN"

echo "watchdog launch-env isolation contract:"

# 1) No fleet token at all -> no isolation, even with a provisioned dir
#    (matches agent-process.ts gating: no token -> intended shared mode).
OUT="$(bash "$WD" --launch-env "$AGENT_ISO")"
case "$OUT" in
  isolation=no) pass "no token file -> no isolation" ;;
  *) fail "no token file -> no isolation" "$OUT" ;;
esac

# 2) Empty token file -> still no isolation (gate is -s, not -f).
: > "$FIXTURE_INSTALL/store/.claude-oauth-token"
OUT="$(bash "$WD" --launch-env "$AGENT_ISO")"
case "$OUT" in
  isolation=no) pass "empty token file -> no isolation" ;;
  *) fail "empty token file -> no isolation" "$OUT" ;;
esac

# 3) Token present + provisioned dir -> isolation prefix with both exports.
echo "sk-test-fixture-token" > "$FIXTURE_INSTALL/store/.claude-oauth-token"
OUT="$(bash "$WD" --launch-env "$AGENT_ISO")"
case "$OUT" in
  "isolation=yes prefix="*CLAUDE_CONFIG_DIR*CLAUDE_CODE_OAUTH_TOKEN*)
    pass "token + .claude-config -> isolation prefix" ;;
  *) fail "token + .claude-config -> isolation prefix" "$OUT" ;;
esac

# 4) The literal token must NOT appear in the prefix: it is read inside the
#    pane via \$(cat ...), so it never lands in the command string or ps.
case "$OUT" in
  *sk-test-fixture-token*) fail "literal token kept out of the prefix" "$OUT" ;;
  *'$(cat '*) pass "literal token kept out of the prefix (read via \$(cat))" ;;
  *) fail "literal token kept out of the prefix" "$OUT" ;;
esac

# 5) Token present but the agent has no .claude-config -> no isolation
#    (unprovisioned agents keep their current behaviour).
OUT="$(bash "$WD" --launch-env "$AGENT_PLAIN")"
case "$OUT" in
  isolation=no) pass "no .claude-config dir -> no isolation" ;;
  *) fail "no .claude-config dir -> no isolation" "$OUT" ;;
esac

echo "watchdog-config-isolation: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
