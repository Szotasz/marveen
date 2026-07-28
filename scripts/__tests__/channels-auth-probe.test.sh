#!/bin/bash
# Contract tests for scripts/channels-auth-probe.mjs (PLAN.md GAP 2b,
# 2026-07-23 marveen-channels silent outage). Feeds captured-pane fixture text
# via stdin (no real tmux session, no real Claude process) and asserts exit
# code + stdout marker per the probe's contract. Fixtures reused from
# src/__tests__/reauth-detect.test.ts for consistency (same markers the probe
# dynamically imports and delegates to).
# Run: bash scripts/__tests__/channels-auth-probe.test.sh
#
# Requires a built dist/ (npm run build) -- the probe dynamically imports
# dist/web/reauth-detect.js, exactly like reauth-healer.ts's own detection path.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE="$INSTALL_DIR/scripts/channels-auth-probe.mjs"
NODE_BIN="$(command -v node)"

if [ ! -f "$INSTALL_DIR/dist/web/reauth-detect.js" ]; then
  echo "SKIP: dist/web/reauth-detect.js not built -- run 'npm run build' first"
  exit 0
fi

run_probe() {
  # $1: pane text (via stdin)
  printf '%s' "$1" | "$NODE_BIN" "$PROBE"
}

echo "channels-auth-probe tests"
echo "=========================="

# ---------------------------------------------------------------------------
# (a) Healthy pane -> exit 0, no output
# ---------------------------------------------------------------------------
echo ""
echo "(a) Healthy pane"

OUT="$(run_probe '✻ Sautéed for 1m
❯
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt')"
CODE=$?
if [ "$CODE" -eq 0 ] && [ -z "$OUT" ]; then
  pass "healthy idle pane: exit 0, no output"
else
  fail "healthy idle pane: expected exit 0 + empty output, got exit=$CODE output='$OUT'"
fi

# ---------------------------------------------------------------------------
# (b) Genuine dead-token markers -> exit 1, "DEAD:<reason>"
# ---------------------------------------------------------------------------
echo ""
echo "(b) Genuine dead-token markers"

OUT="$(run_probe 'Some output
  Please run /login
')"
CODE=$?
if [ "$CODE" -eq 1 ] && [ "$OUT" = "DEAD:Please run /login" ]; then
  pass "'Please run /login': exit 1, DEAD:<reason>"
else
  fail "'Please run /login': expected exit 1 + 'DEAD:Please run /login', got exit=$CODE output='$OUT'"
fi

OUT="$(run_probe 'API Error: 401 Invalid authentication credentials')"
CODE=$?
if [ "$CODE" -eq 1 ] && [ "$OUT" = "DEAD:Invalid authentication credentials (401)" ]; then
  pass "401 invalid-credentials: exit 1, DEAD:<reason>"
else
  fail "401 invalid-credentials: expected exit 1 + DEAD marker, got exit=$CODE output='$OUT'"
fi

OUT="$(run_probe 'Your OAuth token has expired.')"
CODE=$?
if [ "$CODE" -eq 1 ] && [ "$OUT" = "DEAD:OAuth token expired" ]; then
  pass "OAuth token expired: exit 1, DEAD:<reason>"
else
  fail "OAuth token expired: expected exit 1 + DEAD marker, got exit=$CODE output='$OUT'"
fi

# ---------------------------------------------------------------------------
# (c) First-run-gate family -> out of scope, exit 0 (not "dead")
# ---------------------------------------------------------------------------
echo ""
echo "(c) First-run-gate: out of scope for this arm"

OUT="$(run_probe ' Welcome to Claude Code

 Select login method:

 ❯ 1. Claude account with subscription
   2. Anthropic Console account')"
CODE=$?
if [ "$CODE" -eq 0 ] && [ -z "$OUT" ]; then
  pass "first-run onboarding picker: exit 0 (out of scope, not dead)"
else
  fail "first-run onboarding picker: expected exit 0 + empty output, got exit=$CODE output='$OUT'"
fi

OUT="$(run_probe ' Use the url below to sign in:

 https://claude.ai/oauth/authorize?code=...

 Paste code here if prompted >')"
CODE=$?
if [ "$CODE" -eq 0 ] && [ -z "$OUT" ]; then
  pass "browser sign-in screen (first-run gate): exit 0 (out of scope, not dead)"
else
  fail "browser sign-in screen (first-run gate): expected exit 0 + empty output, got exit=$CODE output='$OUT'"
fi

# ---------------------------------------------------------------------------
# (d) Does not false-positive on a chat merely discussing the markers
# ---------------------------------------------------------------------------
echo ""
echo "(d) No false positive on scrollback-only mentions"

OUT="$(run_probe '❯ hogyan működik a /login parancs?
  ⏵⏵ bypass permissions on (shift+tab to cycle)')"
CODE=$?
if [ "$CODE" -eq 0 ] && [ -z "$OUT" ]; then
  pass "chat mentioning /login as a topic: exit 0"
else
  fail "chat mentioning /login as a topic: expected exit 0 + empty output, got exit=$CODE output='$OUT'"
fi

# ---------------------------------------------------------------------------
# (e) Empty / null-ish stdin -> fail-open, exit 0
# ---------------------------------------------------------------------------
echo ""
echo "(e) Empty stdin (fail-open)"

OUT="$(printf '' | "$NODE_BIN" "$PROBE")"
CODE=$?
if [ "$CODE" -eq 0 ] && [ -z "$OUT" ]; then
  pass "empty stdin: exit 0, no output"
else
  fail "empty stdin: expected exit 0 + empty output, got exit=$CODE output='$OUT'"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=========================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
