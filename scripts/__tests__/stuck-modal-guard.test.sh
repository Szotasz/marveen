#!/bin/bash
# Contract tests for scripts/stuck-modal-guard.sh.
# Run: bash scripts/__tests__/stuck-modal-guard.test.sh
#
# Pins the pure pane classifier (idle / busy / stuck / empty) against captured
# pane fixtures and the confirm-window decision, so the false-positive guarantee
# ("a legitimately working session is NEVER touched") is locked by a test.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$INSTALL_DIR/scripts/stuck-modal-guard.sh"

classify() { printf '%s' "$1" | bash "$GUARD" classify; }
decide()   { bash "$GUARD" decide "$1" "$2" "$3"; }

echo "stuck-modal-guard tests"
echo "======================="

# ---------------------------------------------------------------------------
# (a) Classifier: healthy panes -> idle / busy (NEVER stuck)
# ---------------------------------------------------------------------------
echo ""
echo "(a) Healthy panes are never 'stuck'"

IDLE_BYPASS='Some reply text from the agent.
                                                      ⏵⏵ bypass permissions on (shift+tab to cycle)'
assert_eq "idle: bypass-permissions footer" "idle" "$(classify "$IDLE_BYPASS")"

IDLE_SHORTCUTS='╭─────────────╮
│ ❯           │
╰─────────────╯
  ? for shortcuts'
assert_eq "idle: '? for shortcuts' footer" "idle" "$(classify "$IDLE_SHORTCUTS")"

BUSY_INTERRUPT='✻ Combobulating… (8s · ↓ 1.2k tokens · esc to interrupt)
⏵⏵ bypass permissions on (shift+tab to cycle)'
assert_eq "busy: 'esc to interrupt' (working footer) -> busy NOT stuck" "busy" "$(classify "$BUSY_INTERRUPT")"

BUSY_TOKENS='✻ Thinking… (52s · ↓ 2.6k tokens)'
assert_eq "busy: token counter '(Ns · ↓' -> busy" "busy" "$(classify "$BUSY_TOKENS")"

# W2 regression: the counter separator may render as an ASCII period (locale /
# terminal dependent) instead of the Unicode middle-dot. A working pane MUST
# still classify as busy, never stuck (else it gets respawned mid-turn).
BUSY_TOKENS_ASCII='✻ Thinking… (52s . ↓ 2.6k tokens)'
assert_eq "busy: token counter '(Ns . ↓' ASCII-dot -> busy" "busy" "$(classify "$BUSY_TOKENS_ASCII")"

# ---------------------------------------------------------------------------
# (b) Classifier: a wedged /mcp modal -> stuck
# ---------------------------------------------------------------------------
echo ""
echo "(b) Wedged /mcp modal is 'stuck'"

MCP_MODAL='Manage MCP servers

  ❯ 1. telegram   ✗ failed
       Reconnect
       View tools

  Esc to go back'
assert_eq "stuck: /mcp modal (no idle/busy markers)" "stuck" "$(classify "$MCP_MODAL")"

TRUST_DIALOG='Do you trust the files in this folder?
  1. Yes
  2. No'
assert_eq "stuck: an unexpected blocking dialog with no footer" "stuck" "$(classify "$TRUST_DIALOG")"

# ---------------------------------------------------------------------------
# (c) Classifier: empty capture -> empty (inconclusive)
# ---------------------------------------------------------------------------
echo ""
echo "(c) Empty capture"
assert_eq "empty: whitespace-only pane" "empty" "$(classify '
   ')"

# ---------------------------------------------------------------------------
# (d) Decision: confirm-window persistence (anti-flap) + healthy-clears
# ---------------------------------------------------------------------------
echo ""
echo "(d) Confirm-window decision (STUCK_SECONDS=120)"
assert_eq "decide: first stuck sighting -> start-confirm" "start-confirm" "$(decide stuck 0 1000)"
assert_eq "decide: stuck 30s (< 120) -> wait-confirm"     "wait-confirm"  "$(decide stuck 970 1000)"
assert_eq "decide: stuck 200s (>= 120) -> act"            "act"           "$(decide stuck 800 1000)"
assert_eq "decide: idle -> clear confirm window"          "clear"         "$(decide idle 800 1000)"
assert_eq "decide: busy -> clear confirm window"          "clear"         "$(decide busy 800 1000)"
assert_eq "decide: empty capture -> hold (preserve window)" "hold"        "$(decide empty 800 1000)"

# Custom STUCK_SECONDS is honoured (env override)
assert_eq "decide: honours STUCK_MODAL_SECONDS override" "act" \
  "$(STUCK_MODAL_SECONDS=10 bash "$GUARD" decide stuck 980 1000)"
# F: a non-integer STUCK_MODAL_SECONDS must fall back to the default (not error
# the -ge comparison and short-circuit recovery). 200s elapsed >= 120 -> act.
assert_eq "decide: invalid STUCK_MODAL_SECONDS falls back to default" "act" \
  "$(STUCK_MODAL_SECONDS=garbage bash "$GUARD" decide stuck 800 1000)"

# ---------------------------------------------------------------------------
# (e) Model-id sanitization (W1) — safe to interpolate into the respawn string
# ---------------------------------------------------------------------------
echo ""
echo "(e) Model-id sanitization"
assert_eq "sanitize: legit bracketed model id is preserved" "claude-opus-4-8[1m]" \
  "$(bash "$GUARD" sanitize-model 'claude-opus-4-8[1m]')"
SAN="$(bash "$GUARD" sanitize-model "claude'; rm -rf / #")"
case "$SAN" in
  *"'"*|*";"*|*" "*|*"/"*|*'$'*|*'`'*|*'#'*) fail "sanitize: shell metacharacter survived: $SAN" ;;
  *) pass "sanitize: shell metacharacters stripped ($SAN)" ;;
esac

# ---------------------------------------------------------------------------
# (f) F1 — a missing state dir is created (no flock defer-forever, cold install)
# ---------------------------------------------------------------------------
echo ""
echo "(f) State-dir auto-create"
# CHANNELS_SESSION points at a non-existent session so the guard no-ops at the
# has-session check WITHOUT touching any real pane; the mkdir runs before that.
TMP_F1="$(mktemp -d)"; NOSTORE="$TMP_F1/sub"   # NOSTORE does not exist yet
CHANNELS_SESSION="nonexistent-modal-guard-test-channels" STUCK_MODAL_STATE_DIR="$NOSTORE" \
  bash "$GUARD" >/dev/null 2>&1
[ -d "$NOSTORE" ] && pass "F1: run_guard creates a missing state dir (lock can't defer forever)" \
  || fail "F1: missing state dir not created — exec 9> on the lock would fail and defer recovery"
rm -rf "$TMP_F1"

# ---------------------------------------------------------------------------
echo ""
echo "======================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
