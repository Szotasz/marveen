#!/bin/bash
# Contract tests for scripts/disk-space-guard.sh.
# Run: bash scripts/__tests__/disk-space-guard.test.sh
#
# Exercises the threshold logic, the age-guarded allowlist reap, the critical
# alert + cooldown, and the malformed-input no-op -- all through the real script
# via its DISK_GUARD_* test hooks (no actual df / Telegram / rm of real scratch).

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$INSTALL_DIR/scripts/disk-space-guard.sh"

# Run the guard with an isolated scratch + state dir and a usage override.
# Args: usage scratch_dir state_dir  -> prints stdout (logs + any ALERT_DRYRUN).
run_guard() {
  DISK_GUARD_USAGE_OVERRIDE="$1" DISK_GUARD_SCRATCH_DIR="$2" DISK_GUARD_STATE_DIR="$3" \
    DISK_GUARD_ALERT_DRYRUN=1 bash "$GUARD" 2>&1
}

fresh_case() { # -> echoes "scratch state" for a clean case dir
  local d; d="$TMPDIR_BASE/case-$1"; mkdir -p "$d/scratch" "$d/state"
  echo "$d/scratch $d/state"
}

echo "disk-space-guard tests"
echo "======================"

# ---------------------------------------------------------------------------
# (a) Below reap threshold -> total no-op
# ---------------------------------------------------------------------------
echo ""
echo "(a) Below threshold"
read -r SCR ST <<<"$(fresh_case a)"
touch -d '2 hours ago' "$SCR/health_old.bin"
OUT="$(run_guard 50 "$SCR" "$ST")"
assert_eq "below threshold: no reap log" "" "$OUT"
[ -e "$SCR/health_old.bin" ] && pass "below threshold: scratch untouched" || fail "below threshold: scratch was reaped"

# ---------------------------------------------------------------------------
# (b) At/over reap threshold -> reap aged allowlist, keep fresh + unrelated
# ---------------------------------------------------------------------------
echo ""
echo "(b) Reap threshold"
read -r SCR ST <<<"$(fresh_case b)"
touch -d '2 hours ago' "$SCR/health_old.xml"
mkdir -p "$SCR/health_unpacked"; touch -d '2 hours ago' "$SCR/health_unpacked"
touch "$SCR/health_fresh.xml"               # recent -> age guard protects it
touch -d '2 hours ago' "$SCR/keepme.txt"    # not on allowlist -> protected
OUT="$(run_guard 92 "$SCR" "$ST")"
[ ! -e "$SCR/health_old.xml" ] && pass "reap: aged health_* file removed" || fail "reap: aged health file survived"
[ ! -e "$SCR/health_unpacked" ] && pass "reap: aged health_* dir removed" || fail "reap: aged health dir survived"
[ -e "$SCR/health_fresh.xml" ] && pass "reap: fresh health_* file PROTECTED by age guard" || fail "reap: fresh health file was deleted"
[ -e "$SCR/keepme.txt" ] && pass "reap: non-allowlist file PROTECTED" || fail "reap: non-allowlist file deleted"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then fail "reap (92%): must NOT alert below 95%"; else pass "reap (92%): no alert below 95%"; fi

# ---------------------------------------------------------------------------
# (c) At/over alert threshold -> critical alert via dry-run
# ---------------------------------------------------------------------------
echo ""
echo "(c) Alert threshold"
read -r SCR ST <<<"$(fresh_case c)"
OUT="$(run_guard 96 "$SCR" "$ST")"
if printf '%s' "$OUT" | grep -q "ALERT_DRYRUN"; then pass "alert: critical alert emitted at 96%"; else fail "alert: no alert at 96%"; fi
[ -f "$ST/.disk-guard-alerted" ] && pass "alert: cooldown stamp written" || fail "alert: cooldown stamp missing"

# ---------------------------------------------------------------------------
# (d) Alert cooldown -> second run within the hour does NOT re-alert
# ---------------------------------------------------------------------------
echo ""
echo "(d) Alert cooldown"
OUT2="$(run_guard 96 "$SCR" "$ST")"   # same state dir, stamp is fresh
if printf '%s' "$OUT2" | grep -q "ALERT_DRYRUN"; then fail "cooldown: re-alerted within cooldown"; else pass "cooldown: suppressed re-alert within cooldown"; fi

# ---------------------------------------------------------------------------
# (e) Malformed usage -> no-op, no crash
# ---------------------------------------------------------------------------
echo ""
echo "(e) Malformed usage"
read -r SCR ST <<<"$(fresh_case e)"
touch -d '2 hours ago' "$SCR/health_old.bin"
OUT="$(run_guard "garbage" "$SCR" "$ST")"
if printf '%s' "$OUT" | grep -q "could not read disk usage"; then pass "malformed: logs a clean no-op"; else fail "malformed: unexpected output: $OUT"; fi
[ -e "$SCR/health_old.bin" ] && pass "malformed: scratch untouched on bad usage" || fail "malformed: reaped on bad usage"

# ---------------------------------------------------------------------------
# (f) W3 location guard -> refuse to reap a SCRATCH_DIR outside /tmp
# ---------------------------------------------------------------------------
echo ""
echo "(f) W3 location guard"
OUTSIDE="$(TMPDIR="$HOME" mktemp -d 2>/dev/null || true)"
if [ -n "$OUTSIDE" ]; then
  touch -d '2 hours ago' "$OUTSIDE/health_outside.bin"
  run_guard 92 "$OUTSIDE" "$OUTSIDE" >/dev/null 2>&1
  [ -e "$OUTSIDE/health_outside.bin" ] && pass "W3: scratch outside /tmp is NOT reaped" || fail "W3: reaped scratch outside /tmp"
  rm -rf "$OUTSIDE"
else
  fail "W3: could not create an out-of-/tmp test dir"
fi
# A symlinked SCRATCH_DIR (even pointing into /tmp) is refused.
read -r SCR ST <<<"$(fresh_case f)"
touch -d '2 hours ago' "$SCR/health_real.bin"
LINK="$TMPDIR_BASE/f-link"; ln -s "$SCR" "$LINK"
run_guard 92 "$LINK" "$ST" >/dev/null 2>&1
[ -e "$SCR/health_real.bin" ] && pass "W3: symlinked SCRATCH_DIR is NOT reaped" || fail "W3: reaped via symlinked SCRATCH_DIR"

# ---------------------------------------------------------------------------
# (g) W2 reap-age validation -> invalid env falls back to a conservative default
# ---------------------------------------------------------------------------
echo ""
echo "(g) W2 reap-age validation"
read -r SCR ST <<<"$(fresh_case g)"
touch -d '2 hours ago' "$SCR/health_2h.bin"   # 120 min old; < the 1440 fallback
DISK_GUARD_REAP_MIN_AGE_MIN="garbage" run_guard 92 "$SCR" "$ST" >/dev/null 2>&1
[ -e "$SCR/health_2h.bin" ] && pass "W2: invalid reap-age -> conservative default, recent file kept" || fail "W2: invalid reap-age reaped a 2h-old file"
# Sanity: a valid small age still reaps the same 2h-old file.
read -r SCR2 ST2 <<<"$(fresh_case g2)"
touch -d '2 hours ago' "$SCR2/health_2h.bin"
DISK_GUARD_REAP_MIN_AGE_MIN="30" run_guard 92 "$SCR2" "$ST2" >/dev/null 2>&1
[ ! -e "$SCR2/health_2h.bin" ] && pass "W2: valid reap-age still reaps an aged file" || fail "W2: valid reap-age failed to reap"

# ---------------------------------------------------------------------------
# (h) C — reap-age "0" must NOT reap active files (0 -> 1440 fallback)
# ---------------------------------------------------------------------------
echo ""
echo "(h) C reap-age 0 guard"
read -r SCR ST <<<"$(fresh_case h)"
touch "$SCR/health_fresh.bin"   # brand-new; -mmin +0 would match it
DISK_GUARD_REAP_MIN_AGE_MIN="0" run_guard 92 "$SCR" "$ST" >/dev/null 2>&1
[ -e "$SCR/health_fresh.bin" ] && pass "C: reap-age 0 -> 1440 fallback, fresh file kept" || fail "C: reap-age 0 reaped an active file"

# ---------------------------------------------------------------------------
# (i) D — an aged DIR with a fresh file inside is in-progress -> NOT reaped
# ---------------------------------------------------------------------------
echo ""
echo "(i) D directory-mtime guard"
read -r SCR ST <<<"$(fresh_case i)"
mkdir -p "$SCR/health_inprogress"; touch "$SCR/health_inprogress/part.xml"   # fresh file inside
touch -d '2 hours ago' "$SCR/health_inprogress"                              # dir mtime looks old
DISK_GUARD_REAP_MIN_AGE_MIN="30" run_guard 92 "$SCR" "$ST" >/dev/null 2>&1
[ -d "$SCR/health_inprogress" ] && pass "D: aged dir with a fresh file inside is NOT reaped" || fail "D: reaped an in-progress export dir"
# Control: a dir whose files are ALL old IS reaped.
read -r SCR2 ST2 <<<"$(fresh_case i2)"
mkdir -p "$SCR2/health_done"; touch -d '2 hours ago' "$SCR2/health_done/done.xml" "$SCR2/health_done"
DISK_GUARD_REAP_MIN_AGE_MIN="30" run_guard 92 "$SCR2" "$ST2" >/dev/null 2>&1
[ ! -d "$SCR2/health_done" ] && pass "D: fully-old dir is still reaped" || fail "D: fully-old dir not reaped"

# ---------------------------------------------------------------------------
# (j) B — cooldown stamp persists even when STATE_DIR was missing (no alert-spam)
# ---------------------------------------------------------------------------
echo ""
echo "(j) B cooldown-stamp persistence"
JBASE="$TMPDIR_BASE/j"; mkdir -p "$JBASE/scratch"; JSTATE="$JBASE/state-missing"   # JSTATE does not exist
OUTJ1="$(run_guard 96 "$JBASE/scratch" "$JSTATE")"
if printf '%s' "$OUTJ1" | grep -q "ALERT_DRYRUN"; then pass "B: alerts at 96% on first tick"; else fail "B: no alert at 96%"; fi
[ -f "$JSTATE/.disk-guard-alerted" ] && pass "B: cooldown stamp written despite missing STATE_DIR (mkdir at top)" || fail "B: stamp not written -> would re-alert 60x/h"
OUTJ2="$(run_guard 96 "$JBASE/scratch" "$JSTATE")"
if printf '%s' "$OUTJ2" | grep -q "ALERT_DRYRUN"; then fail "B: re-alerted within cooldown (stamp not honoured)"; else pass "B: second tick suppressed by cooldown"; fi

# ---------------------------------------------------------------------------
echo ""
echo "======================"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
