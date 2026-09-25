#!/bin/bash
# Contract tests for the morning briefing's same-day dedup stamp.
# Run: bash scripts/__tests__/morning-stamp-gate.test.sh
#
# Bug being locked out (observed 2026-09-13): the stamp recorded "the process
# exited 0", not "the owner got the briefing". The 07:27 run refused its own
# task (its config dir carried no channel allowlist, so the reply tool rejected
# the owner's chat_id), printed an explanation, exited 0 -- and stamped the day
# as delivered. The guard then suppressed every retry and the owner got nothing.
#
# Fix under test: the run must print the per-run sentinel on its own line,
# which it is told to do ONLY after a reply tool call actually succeeded. No
# sentinel means no stamp, so the next trigger tries again. The sentinel
# carries a per-run nonce (MORNTIMERPARK914): a fixed constant is a control
# trigger that matches its own instruction text, so a run that merely QUOTES
# the instruction on a bare line would stamp an undelivered day.
#
# Hermetic: `claude` is a stub on PATH, and the script runs against a throwaway
# INSTALL_DIR, so nothing is sent and the real store/ is untouched. The stub
# extracts the actual sentinel from the prompt it receives -- the tests must
# not know the nonce in advance, exactly like a real run.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

TODAY="$(date +%F)"

# Builds a throwaway install with a `claude` stub, runs the briefing, and
# echoes the resulting stamp content ("<none>" if unstamped).
#   $1: stub mode -- what the fake run prints:
#       success       the real sentinel (parsed from the prompt) on its own line
#       refuse        an explanation, no sentinel anywhere
#       substring     the real sentinel embedded inside a longer line
#       old_constant  the bare pre-nonce constant "MORNING_SENT_OK"
#   $2: stub exit code
run_case() {
  local mode="$1" stub_rc="$2"
  local dir="$TMP/inst.$RANDOM"
  mkdir -p "$dir/scripts" "$dir/store" "$dir/bin"
  cp "$REPO/scripts/morning-briefing.sh" "$dir/scripts/"
  printf 'ALLOWED_CHAT_ID=1234\n' > "$dir/.env"
  # The stub sees the same argv a real claude would, so it recovers the
  # sentinel the same way an obedient run does: from the prompt text.
  cat > "$dir/bin/claude" <<STUB
#!/bin/bash
S="\$(printf '%s\n' "\$@" | grep -o 'MORNING_SENT_OK_[0-9]*_[0-9]*' | head -1)"
case "$mode" in
  success)      echo "Elkuldve."; echo "\$S" ;;
  refuse)       echo "A reply tool elutasitotta a chat_id-t, nem kuldtem semmit." ;;
  substring)    echo "Nem sikerult, ezert nem irom ki hogy \$S volna." ;;
  old_constant) echo "MORNING_SENT_OK" ;;
esac
exit $stub_rc
STUB
  chmod +x "$dir/bin/claude"
  # CLAUDE_BIN, not PATH: the script exports its own minimal PATH, so a
  # prepended stub dir is discarded and the real binary would run instead.
  CLAUDE_BIN="$dir/bin/claude" bash "$dir/scripts/morning-briefing.sh" >/dev/null 2>&1
  cat "$dir/store/.morning-last-sent" 2>/dev/null || echo "<none>"
}

echo "morning-briefing stamp gate"

assert_eq "sentinel (from the prompt, with nonce) -> stamped" \
  "$TODAY" "$(run_case success 0)"

assert_eq "refusal without sentinel -> NOT stamped (the 2026-09-13 bug)" \
  "<none>" "$(run_case refuse 0)"

assert_eq "sentinel only as part of a longer line -> NOT stamped" \
  "<none>" "$(run_case substring 0)"

assert_eq "nonzero exit with sentinel -> NOT stamped" \
  "<none>" "$(run_case success 1)"

# The nonce contract itself: the bare pre-nonce constant -- the exact string a
# run could produce by quoting its own instruction, or a replayed transcript
# from an earlier version -- must no longer satisfy the gate.
assert_eq "bare constant without the run's nonce -> NOT stamped" \
  "<none>" "$(run_case old_constant 0)"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
