#!/bin/bash
# Contract tests for scripts/disk-space-guard.sh.
# Run: bash scripts/__tests__/disk-space-guard.test.sh
#
# Exercises the threshold logic, the age-guarded allowlist reap, the critical
# alert + cooldown, and the malformed-input no-op -- all through the real script
# via its DISK_GUARD_* test hooks (no actual df / Telegram / rm of real scratch).

set -u

# Hermetic (#1555 review round 1): inside an agent session the inherited
# channel state dir points at a live access.json / bot token.
unset TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$INSTALL_DIR/scripts/disk-space-guard.sh"

# SHTEST807: GNU `touch_aged` is not portable -- BSD (macOS) touch
# rejects it, the fixture files were never created, and every "survives the
# reap" assert read the missing file as "deleted" (3 false FAILs + 2 more).
# `touch -t [[CC]YY]MMDDhhmm` is accepted by BSD and GNU alike.
TS_2H_AGO="$(python3 -c 'import time; print(time.strftime("%Y%m%d%H%M", time.localtime(time.time()-7200)))')"
touch_aged() { touch -t "$TS_2H_AGO" "$@"; }

# Run the guard with an isolated scratch + state dir and a usage override.
# Args: usage scratch_dir state_dir  -> prints stdout (logs + any ALERT_DRYRUN).
run_guard() {
  DISK_GUARD_USAGE_OVERRIDE="$1" DISK_GUARD_SCRATCH_DIR="$2" DISK_GUARD_STATE_DIR="$3" \
    DISK_GUARD_ALERT_DRYRUN=1 bash "$GUARD" 2>&1
}

# SHTEST807: the scratch fixture must live under the REAL /tmp -- macOS mktemp
# honours TMPDIR=/var/folders/..., which the guard's W3 location guard rightly
# refuses, so every reap assert failed before it began. State can stay anywhere.
SCRATCH_BASE="$(mktemp -d /tmp/dsg-test-XXXXXX)"
trap 'rm -rf "$TMPDIR_BASE" "$SCRATCH_BASE"' EXIT
fresh_case() { # -> echoes "scratch state" for a clean case dir
  local d s; d="$TMPDIR_BASE/case-$1"; s="$SCRATCH_BASE/case-$1"; mkdir -p "$s" "$d/state"
  echo "$s $d/state"
}

echo "disk-space-guard tests"
echo "======================"

# ---------------------------------------------------------------------------
# (a) Below reap threshold -> total no-op
# ---------------------------------------------------------------------------
echo ""
echo "(a) Below threshold"
read -r SCR ST <<<"$(fresh_case a)"
touch_aged "$SCR/health_old.bin"
OUT="$(run_guard 50 "$SCR" "$ST")"
assert_eq "below threshold: no reap log" "" "$OUT"
[ -e "$SCR/health_old.bin" ] && pass "below threshold: scratch untouched" || fail "below threshold: scratch was reaped"

# ---------------------------------------------------------------------------
# (b) At/over reap threshold -> reap aged allowlist, keep fresh + unrelated
# ---------------------------------------------------------------------------
echo ""
echo "(b) Reap threshold"
read -r SCR ST <<<"$(fresh_case b)"
touch_aged "$SCR/health_old.xml"
mkdir -p "$SCR/health_unpacked"; touch_aged "$SCR/health_unpacked"
touch "$SCR/health_fresh.xml"               # recent -> age guard protects it
touch_aged "$SCR/keepme.txt"    # not on allowlist -> protected
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
touch_aged "$SCR/health_old.bin"
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
  touch_aged "$OUTSIDE/health_outside.bin"
  run_guard 92 "$OUTSIDE" "$OUTSIDE" >/dev/null 2>&1
  [ -e "$OUTSIDE/health_outside.bin" ] && pass "W3: scratch outside /tmp is NOT reaped" || fail "W3: reaped scratch outside /tmp"
  rm -rf "$OUTSIDE"
else
  fail "W3: could not create an out-of-/tmp test dir"
fi
# A symlinked SCRATCH_DIR (even pointing into /tmp) is refused.
read -r SCR ST <<<"$(fresh_case f)"
touch_aged "$SCR/health_real.bin"
LINK="$TMPDIR_BASE/f-link"; ln -s "$SCR" "$LINK"
run_guard 92 "$LINK" "$ST" >/dev/null 2>&1
[ -e "$SCR/health_real.bin" ] && pass "W3: symlinked SCRATCH_DIR is NOT reaped" || fail "W3: reaped via symlinked SCRATCH_DIR"

# ---------------------------------------------------------------------------
# (g) W2 reap-age validation -> invalid env falls back to a conservative default
# ---------------------------------------------------------------------------
echo ""
echo "(g) W2 reap-age validation"
read -r SCR ST <<<"$(fresh_case g)"
touch_aged "$SCR/health_2h.bin"   # 120 min old; < the 1440 fallback
DISK_GUARD_REAP_MIN_AGE_MIN="garbage" run_guard 92 "$SCR" "$ST" >/dev/null 2>&1
[ -e "$SCR/health_2h.bin" ] && pass "W2: invalid reap-age -> conservative default, recent file kept" || fail "W2: invalid reap-age reaped a 2h-old file"
# Sanity: a valid small age still reaps the same 2h-old file.
read -r SCR2 ST2 <<<"$(fresh_case g2)"
touch_aged "$SCR2/health_2h.bin"
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
touch_aged "$SCR/health_inprogress"                              # dir mtime looks old
DISK_GUARD_REAP_MIN_AGE_MIN="30" run_guard 92 "$SCR" "$ST" >/dev/null 2>&1
[ -d "$SCR/health_inprogress" ] && pass "D: aged dir with a fresh file inside is NOT reaped" || fail "D: reaped an in-progress export dir"
# Control: a dir whose files are ALL old IS reaped.
read -r SCR2 ST2 <<<"$(fresh_case i2)"
mkdir -p "$SCR2/health_done"; touch_aged "$SCR2/health_done/done.xml" "$SCR2/health_done"
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
# (k) CHATID0 — the real (non-dry-run) alert path resolves the owner chat,
# refusing the "0" placeholder and falling back to a paired access.json.
# Needs a full copy of the guard under a throwaway INSTALL_DIR, since
# INSTALL_DIR is derived from $0, not overridable via env.
# ---------------------------------------------------------------------------
echo ""
echo "(k) CHATID0 owner-chat resolution"
KBASE="$TMPDIR_BASE/k"
mkdir -p "$KBASE/bin" "$KBASE/home"
cat > "$KBASE/bin/curl" <<'STUB'
#!/bin/bash
for a in "$@"; do
  case "$a" in
    chat_id=*) echo "SEEN_CHAT_ID:${a#chat_id=}" >> "$CURL_LOG" ;;
  esac
done
printf '{"ok":true,"result":{"message_id":1}}'
STUB
chmod +x "$KBASE/bin/curl"

# (k1) ALLOWED_CHAT_ID=0, paired access.json -> alerts the REAL resolved id.
K1="$KBASE/inst1"; mkdir -p "$K1/store" "$K1/.claude/channels/telegram" "$K1/scripts/lib"
cp "$INSTALL_DIR/scripts/disk-space-guard.sh" "$K1/scripts/"
cp "$INSTALL_DIR/scripts/lib/owner-chat.sh" "$K1/scripts/lib/"
cp "$INSTALL_DIR/scripts/lib/send-telegram.sh" "$K1/scripts/lib/"
printf 'ALLOWED_CHAT_ID=0\n' > "$K1/.env"
printf 'TELEGRAM_BOT_TOKEN=faketoken\n' > "$K1/.claude/channels/telegram/.env"
printf '{"allowFrom":["7777777"]}\n' > "$K1/.claude/channels/telegram/access.json"
CURL_LOG="$K1/curl.log"; : > "$CURL_LOG"
# The guard's own INSTALL_DIR is scripts/.. -- run it FROM K1 so $0's dirname resolves there.
CURL_LOG="$CURL_LOG" DISK_GUARD_USAGE_OVERRIDE=96 DISK_GUARD_STATE_DIR="$K1/store" \
  HOME="$KBASE/home" bash -c 'cd "$1" && PATH="'"$KBASE"'/bin:$PATH" bash scripts/disk-space-guard.sh' _ "$K1" >/dev/null 2>&1
if grep -q "SEEN_CHAT_ID:7777777" "$CURL_LOG" 2>/dev/null; then
  pass "CHATID0: ALLOWED_CHAT_ID=0 + paired access.json -> alerts the real resolved id"
else
  fail "CHATID0: ALLOWED_CHAT_ID=0 + paired access.json -> expected chat_id=7777777, log: $(cat "$CURL_LOG" 2>/dev/null)"
fi

# (k2) ALLOWED_CHAT_ID=0, no access.json -> no send, and no "0" chat_id anywhere.
K2="$KBASE/inst2"; mkdir -p "$K2/store" "$K2/scripts/lib"
cp "$INSTALL_DIR/scripts/disk-space-guard.sh" "$K2/scripts/"
cp "$INSTALL_DIR/scripts/lib/owner-chat.sh" "$K2/scripts/lib/"
cp "$INSTALL_DIR/scripts/lib/send-telegram.sh" "$K2/scripts/lib/"
printf 'ALLOWED_CHAT_ID=0\n' > "$K2/.env"
CURL_LOG2="$K2/curl.log"; : > "$CURL_LOG2"
CURL_LOG="$CURL_LOG2" DISK_GUARD_USAGE_OVERRIDE=96 DISK_GUARD_STATE_DIR="$K2/store" \
  HOME="$KBASE/home" bash -c 'cd "$1" && PATH="'"$KBASE"'/bin:$PATH" bash scripts/disk-space-guard.sh' _ "$K2" >/dev/null 2>&1
if [ ! -s "$CURL_LOG2" ]; then
  pass "CHATID0: ALLOWED_CHAT_ID=0, no access.json -> no send attempted"
else
  fail "CHATID0: ALLOWED_CHAT_ID=0, no access.json -> unexpected send: $(cat "$CURL_LOG2")"
fi
if grep -q "SEEN_CHAT_ID:0" "$CURL_LOG2" 2>/dev/null; then
  fail "CHATID0: the '0' placeholder must never reach curl"
else
  pass "CHATID0: the '0' placeholder never reaches curl"
fi

# ---------------------------------------------------------------------------
echo ""
echo "======================"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
