#!/bin/bash
# Contract tests for the running-maximum fields of scripts/memory-index-gate.sh.
#
# The defect (2026-08-29): the state file carried `max_seen` with no time of its
# own, next to a `measured_at` that belongs to `size`. A reader took the nearby
# timestamp for the peak's timestamp and announced a two-day-old peak as that
# day's -- and the script's own comment invited exactly that reading ("a nap
# folyaman"), although nothing in it ever resets per day.
#
# So a running aggregate needs THREE fields, not one: the value, the time of the
# value, and the zero point it counts from. These tests pin all three, and pin
# the one property that makes them worth anything: a timestamp that is NOT known
# must stay null, never be invented as "now".
#
# Every case runs on fixtures through MEMORY_INDEX_PATH / MEMORY_INDEX_STATE, so
# the live index and the live state file are never touched.
# Run: bash scripts/__tests__/memory-index-gate-max-seen.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to
# confirm it actually fails on the bug (a green test that cannot go red is
# worse than no test -- it certifies health it never checked).
GATE="${GATE_BIN:-$INSTALL_DIR/scripts/memory-index-gate.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ ! -f "$GATE" ]; then
  echo "FAIL: gate not found at $GATE"
  exit 1
fi
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required by the gate and by this suite"; exit 1; }

NOW="$(date +%s)"
IDX="$TMP/MEMORY.md"
# A short, well-formed index: under WARN, with the hot-section boundary present
# and no over-long hot line, so the verdict path stays on SKIP unless a case
# deliberately changes the size.
{
  echo "# Forro bejegyzesek"
  echo "- egy rovid sor"
  echo "# Téma-hubok"
  echo "- [hub](hub.md)"
} > "$IDX"
# The hub the fixture index points at has to EXIST on disk. Since 2026-09-18 the
# gate also counts dangling `](...md)` targets, and a fixture with a pointer to
# nowhere would wake on that -- turning this suite's size-verdict case red for a
# reason that has nothing to do with size. The fixture was always meant to be a
# well-formed small index; now it has to be one.
echo "hub tartalom" > "$TMP/hub.md"
IDXSIZE="$(wc -c < "$IDX" | tr -d ' ')"

# $1 = state file path (may not exist). Runs one tick on the fixture index.
run_gate() {
  MEMORY_INDEX_PATH="$IDX" MEMORY_INDEX_STATE="$1" bash "$GATE" 2>/dev/null
}
# $1 = state file, $2 = jq path
jqv() { jq -r "$2" "$1" 2>/dev/null; }

echo "memory-index-gate running-maximum tests"
echo "======================================="
echo ""

# ---------------------------------------------------------------------------
# (a) Empty check first: with no prior state there is nothing to carry, so both
#     timestamps are KNOWN and must be set. This pins what "fresh" means before
#     any carry-forward case can pass vacuously.
# ---------------------------------------------------------------------------
echo "(a) First run, no prior state"
S="$TMP/a.json"; rm -f "$S"
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .max_seen)" = "$IDXSIZE" ]; then pass "max_seen is the measured size"; else fail "max_seen is the measured size" "$(cat "$S")"; fi
MA="$(jqv "$S" .max_seen_at)"
if [ "$MA" != null ] && [ -n "$MA" ] && [ "$MA" -ge "$NOW" ] 2>/dev/null; then pass "max_seen_at is set to the moment of the peak"; else fail "max_seen_at is set" "$MA"; fi
SI="$(jqv "$S" .since)"
if [ "$SI" != null ] && [ -n "$SI" ] && [ "$SI" -ge "$NOW" ] 2>/dev/null; then pass "since is set: the running maximum starts counting now"; else fail "since is set" "$SI"; fi
echo ""

# ---------------------------------------------------------------------------
# (b) THE DEFECT ITSELF. A carried peak must keep its own timestamp untouched
#     while measured_at moves -- that pair is what tells a reader the peak is
#     OLD, which is the thing nobody could see before.
# ---------------------------------------------------------------------------
echo "(b) A carried peak keeps its own time"
S="$TMP/b.json"
cat > "$S" <<'JSON'
{"measured_at":1,"size":9999,"max_seen":24408,"max_seen_at":1000000000,"since":900000000,"warn":20000,"hard":24400,"over_hard":false,"hot_scan":"ok"}
JSON
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .max_seen)" = 24408 ]; then pass "the larger peak is preserved"; else fail "the larger peak is preserved" "$(cat "$S")"; fi
if [ "$(jqv "$S" .max_seen_at)" = 1000000000 ]; then pass "max_seen_at is NOT bumped when the maximum did not grow"; else fail "max_seen_at is NOT bumped" "$(jqv "$S" .max_seen_at)"; fi
if [ "$(jqv "$S" .since)" = 900000000 ]; then pass "since is carried unchanged"; else fail "since is carried unchanged" "$(jqv "$S" .since)"; fi
MEAS="$(jqv "$S" .measured_at)"; MA="$(jqv "$S" .max_seen_at)"
if [ "$MEAS" -ge "$NOW" ] 2>/dev/null && [ "$MA" = 1000000000 ] && [ "$MEAS" != "$MA" ]; then
  pass "measured_at moved while max_seen_at stood still (the two are now distinguishable)"
else
  fail "measured_at moved while max_seen_at stood still" "measured_at=$MEAS max_seen_at=$MA"
fi
echo ""

# ---------------------------------------------------------------------------
# (c) Growth is the ONLY thing that may move max_seen_at.
# ---------------------------------------------------------------------------
echo "(c) A new peak moves its own timestamp"
S="$TMP/c.json"
cat > "$S" <<'JSON'
{"measured_at":1,"size":50,"max_seen":50,"max_seen_at":1000000000,"since":900000000}
JSON
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .max_seen)" = "$IDXSIZE" ]; then pass "the grown maximum is recorded"; else fail "the grown maximum is recorded" "$(cat "$S")"; fi
MA="$(jqv "$S" .max_seen_at)"
if [ "$MA" != 1000000000 ] && [ "$MA" -ge "$NOW" ] 2>/dev/null; then pass "max_seen_at moves WITH the new peak"; else fail "max_seen_at moves with the new peak" "$MA"; fi
if [ "$(jqv "$S" .since)" = 900000000 ]; then pass "a new peak does not restart the zero point"; else fail "a new peak does not restart the zero point" "$(jqv "$S" .since)"; fi
echo ""

# ---------------------------------------------------------------------------
# (d) The honesty case. A state written by the OLD format carries a peak whose
#     time nobody recorded. Inventing "now" for it would reproduce the original
#     defect with a date attached -- which the card calls the worse shape.
# ---------------------------------------------------------------------------
echo "(d) An unknown timestamp stays unknown"
S="$TMP/d.json"
cat > "$S" <<'JSON'
{"measured_at":1787991663,"size":18563,"max_seen":24408,"warn":20000,"hard":24400,"over_hard":false,"hot_scan":"ok"}
JSON
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .max_seen)" = 24408 ]; then pass "the legacy peak is preserved"; else fail "the legacy peak is preserved" "$(cat "$S")"; fi
if [ "$(jqv "$S" .max_seen_at)" = null ]; then pass "an unrecorded peak time is null, NOT now"; else fail "an unrecorded peak time is null" "$(jqv "$S" .max_seen_at)"; fi
if [ "$(jqv "$S" .since)" = null ]; then pass "an unrecorded zero point is null, NOT now"; else fail "an unrecorded zero point is null" "$(jqv "$S" .since)"; fi
echo ""

echo "(e) Growth on a legacy state answers what it can, and only that"
S="$TMP/e.json"
cat > "$S" <<'JSON'
{"measured_at":1787991663,"size":10,"max_seen":10,"warn":20000,"hard":24400}
JSON
run_gate "$S" >/dev/null
MA="$(jqv "$S" .max_seen_at)"
if [ "$MA" != null ] && [ "$MA" -ge "$NOW" ] 2>/dev/null; then pass "the NEW peak gets a real timestamp"; else fail "the new peak gets a real timestamp" "$MA"; fi
if [ "$(jqv "$S" .since)" = null ]; then pass "but the zero point is still unknown, so it stays null"; else fail "the zero point stays null" "$(jqv "$S" .since)"; fi
echo ""

# ---------------------------------------------------------------------------
# (f) The reset that `since` exists to expose: a fail-open write leaves a state
#     with no max_seen, so the running maximum genuinely restarts. That restart
#     must be visible instead of silently re-anchoring an old number.
# ---------------------------------------------------------------------------
echo "(f) After a fail-open state the count visibly restarts"
S="$TMP/f.json"
cat > "$S" <<'JSON'
{"measured_at":1787991663,"error":"index nem talalhato","path":"/nincs"}
JSON
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .max_seen)" = "$IDXSIZE" ]; then pass "the maximum restarts from the current size"; else fail "the maximum restarts from the current size" "$(cat "$S")"; fi
SI="$(jqv "$S" .since)"
if [ "$SI" != null ] && [ "$SI" -ge "$NOW" ] 2>/dev/null; then pass "since says the count restarted now (the reset is not hidden)"; else fail "since says the count restarted now" "$SI"; fi
echo ""

echo "(g) The zero point survives an ordinary run"
S="$TMP/g.json"; rm -f "$S"
run_gate "$S" >/dev/null
SI1="$(jqv "$S" .since)"
run_gate "$S" >/dev/null
SI2="$(jqv "$S" .since)"
if [ -n "$SI1" ] && [ "$SI1" = "$SI2" ]; then pass "since is stable across consecutive ticks"; else fail "since is stable across ticks" "$SI1 -> $SI2"; fi
echo ""

# ---------------------------------------------------------------------------
# (h) Shape: the state file is machine-read, so the two new fields must be a
#     number or a real null -- never the string "null", never absent.
# ---------------------------------------------------------------------------
echo "(h) The state file stays machine-readable"
for f in a b c d e f g; do
  S="$TMP/$f.json"
  [ -f "$S" ] || continue
  if ! jq -e . "$S" >/dev/null 2>&1; then fail "$f.json is valid JSON" "$(cat "$S")"; continue; fi
  if jq -e '(has("max_seen_at") and has("since"))
            and (.max_seen_at == null or (.max_seen_at|type) == "number")
            and (.since       == null or (.since      |type) == "number")' "$S" >/dev/null 2>&1; then
    pass "$f.json: both fields present and typed (number or null)"
  else
    fail "$f.json: both fields present and typed" "$(cat "$S")"
  fi
done
echo ""

# ---------------------------------------------------------------------------
# (i) Regression: the verdict path is what the scheduler acts on. Adding fields
#     must not move it.
# ---------------------------------------------------------------------------
echo "(i) The verdict is unchanged"
S="$TMP/i.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ "$OUT" = "SKIP" ]; then pass "a small index still prints SKIP"; else fail "a small index still prints SKIP" "$OUT"; fi

BIG="$TMP/BIG.md"
{
  echo "# Forro bejegyzesek"
  awk 'BEGIN { for (i = 0; i < 350; i++) print "- ez egy otven bajt korul mozgo rovid sor a forro szekciobol" }'
  echo "# Téma-hubok"
} > "$BIG"
BIGSIZE="$(wc -c < "$BIG" | tr -d ' ')"
S="$TMP/j.json"; rm -f "$S"
OUT="$(MEMORY_INDEX_PATH="$BIG" MEMORY_INDEX_STATE="$S" bash "$GATE" 2>/dev/null)"
if [ "$BIGSIZE" -gt 20000 ] && [ -z "$OUT" ]; then
  pass "an index over the warn threshold still wakes (empty stdout), size=$BIGSIZE"
else
  fail "an index over the warn threshold still wakes" "size=$BIGSIZE out='$OUT'"
fi
if [ "$(jqv "$S" .max_seen)" = "$BIGSIZE" ] && [ "$BIGSIZE" -lt 24400 ] && [ "$(jqv "$S" .over_hard)" = false ]; then
  pass "the wake path writes the same fields as before (over warn, under hard)"
else
  fail "the wake path writes the same fields as before" "$(cat "$S")"
fi
echo ""

echo "======================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
