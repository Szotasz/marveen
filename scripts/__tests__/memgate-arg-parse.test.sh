#!/usr/bin/env bash
# MEMGATEARG924 -- fleet-memory-gate.sh argument parsing.
#
# WHAT THIS GUARDS, MEASURED 2026-09-24 on the unfixed script:
#   1. `--check` as the LAST argument -> infinite loop. `shift 2` with one
#      argument left is a bash error that shifts nothing, so `$#` stays 1 and
#      `while [[ $# -gt 0 ]]` never ends. Measured: exit 124 under `timeout 5`.
#   2. `--check --dry-run` -> the switch was SWALLOWED as the agent name
#      (ARG="--dry-run") and DRY_RUN stayed 0. That is the quiet one: a run
#      asked to be side-effect free wrote the safe-mode flag and attempted a
#      Telegram alert. Measured: the flag appeared.
#
# The live callers pass a name (channel-monitor.ts execFileSync, and
# fleet-safe-start.sh:78/80), and channel-monitor additionally has a 5s timeout
# plus fail-open, so case 1 does not freeze the fleet today. Case 2 is reachable
# by hand, which is precisely when a human is being careful.
#
# MEMGATE_SCRIPT overrides the script under test (used to measure the fix
# before/after); it defaults to the repo copy.
#
# Run:  bash scripts/__tests__/memgate-arg-parse.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GATE="${MEMGATE_SCRIPT:-$ROOT/scripts/fleet-memory-gate.sh}"
# MUSZER-ONIGAZOLAS (HEX merte 2026-09-24): 3 of the 9 of these assertions PASS against a
# script that does not exist, because a no-op assertion is satisfied by nothing
# just as well as by correct silence. The suite cannot tell "correctly did
# nothing" from "was not there at all" -- so it must first prove its own target.
# Same principle as the positive control below, pointed the other way.
[ -x "$GATE" ] || { echo "FATAL: the script under test is missing or not executable: $GATE" >&2; exit 2; }

FAILS=0; DONE=0

check() { DONE=$((DONE+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/memgatearg.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/store" "$SANDBOX/bin"

# curl stub: nothing leaves the machine even if an alert is attempted.
cat > "$SANDBOX/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo '{"ok":true,"result":{"message_id":1}}'
STUB
chmod +x "$SANDBOX/bin/curl"

# Well past the hard band, so the safe-mode flag is written on every non-dry run.
printf 'MemTotal:       16000000 kB\nMemAvailable:     400000 kB\n' > "$SANDBOX/meminfo"

SAFE_FLAG="$SANDBOX/store/.fleet-safe-mode"

# run_gate <timeout-sec> <args...>  -> exit code in RC, stdout+stderr in OUT
run_gate() {
  local secs="$1"; shift
  rm -f "$SAFE_FLAG" "$SANDBOX/store/.fleet-memgate-alert"
  OUT="$(env PATH="$SANDBOX/bin:$PATH" \
      MEMGATE_PROC_MEMINFO="$SANDBOX/meminfo" \
      MARVEEN_STORE="$SANDBOX/store" \
      MARVEEN_ALERT_CHAT_ID="111" \
      MARVEEN_CORE_AGENTS="__no_core__" \
      MARVEEN_MEM_GATE_OBSERVE=0 \
      timeout "$secs" bash "$GATE" "$@" 2>&1)"
  RC=$?
}

# 1. `--check` alone must terminate (the infinite loop), and fail open.
run_gate 5 --check
check "--check alone terminates (no infinite loop)" \
      "$([ "$RC" != "124" ] && echo 0 || echo 1)" "exit 124 = timeout killed it"
check "--check alone fails open with no-agent" \
      "$(echo "$OUT" | grep -q 'no-agent: allow' && echo 0 || echo 1)" "got: $OUT"

# 2. POSITIVE CONTROL: without --dry-run the flag MUST appear, otherwise test 3
#    would pass for the wrong reason (a blind instrument).
run_gate 5 --check somebody
check "positive control: a non-dry run DOES write the safe-mode flag" \
      "$([ -f "$SAFE_FLAG" ] && echo 0 || echo 1)" "flag missing; the check below would be vacuous"

# 3. `--check --dry-run` must not be swallowed: no flag, and the dry-run log line.
run_gate 5 --check --dry-run
check "--check --dry-run stays dry (no safe-mode flag written)" \
      "$([ ! -f "$SAFE_FLAG" ] && echo 0 || echo 1)" "flag was written: --dry-run was swallowed"
check "--check --dry-run reaches the alert as DRY-RUN" \
      "$(echo "$OUT" | grep -q 'DRY-RUN alert' && echo 0 || echo 1)" "got: $OUT"

# 4. The normal, documented form must keep working.
run_gate 5 --check somebody --dry-run
check "--check <agent> --dry-run still dry" \
      "$([ ! -f "$SAFE_FLAG" ] && echo 0 || echo 1)" "flag was written"
check "--check <agent> --dry-run still names the agent" \
      "$(echo "$OUT" | grep -q 'somebody' && echo 0 || echo 1)" "got: $OUT"

# 5. The other modes are untouched.
run_gate 5 --status --dry-run
check "--status still reports a status line" \
      "$(echo "$OUT" | grep -q 'used=' && echo 0 || echo 1)" "got: $OUT"
run_gate 5 --verdict --dry-run
check "--verdict still reports a status line" \
      "$(echo "$OUT" | grep -q 'used=' && echo 0 || echo 1)" "got: $OUT"

echo
echo "$((DONE-FAILS))/$DONE passed  (script under test: $GATE)"
[ "$FAILS" = "0" ] || exit 1
