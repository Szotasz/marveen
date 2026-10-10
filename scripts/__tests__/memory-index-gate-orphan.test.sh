#!/bin/bash
# Contract tests for the ORPHAN (a page nothing points at) measurement of
# scripts/memory-index-gate.sh + scripts/memory-index-linkcheck.py.
#
# The gap: the dangling-pointer count walks index -> disk. The reverse walk is
# the same silent failure turned around -- the page is written, it is correct,
# and no line leads to it, so nothing ever loads it. On this install a one-way
# check was GREEN while two memories were absent from the index altogether.
#
# What this suite is really about: an orphan count is easy to make TOO EAGER.
# A page the index does not name but a hub does is reachable -- that is where a
# line goes when it leaves the index -- and reporting it would turn the designed
# structure into a defect. So half the cases below pin what must NOT be
# reported.
#
# Every case runs on fixtures through MEMORY_INDEX_PATH / MEMORY_INDEX_STATE /
# MEMORY_LINKCHECK_BIN, so the live index, the live state file and the live
# checker are never touched.
# Run: bash scripts/__tests__/memory-index-gate-orphan.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="${GATE_BIN:-$INSTALL_DIR/scripts/memory-index-gate.sh}"
CHECK="${LINKCHECK_BIN:-$INSTALL_DIR/scripts/memory-index-linkcheck.py}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$GATE" ]  || { echo "FAIL: gate not found at $GATE"; exit 1; }
[ -f "$CHECK" ] || { echo "FAIL: link checker not found at $CHECK"; exit 1; }
command -v jq      >/dev/null 2>&1 || { echo "FAIL: jq is required"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 is required"; exit 1; }

MEM="$TMP/memory"; mkdir -p "$MEM"
IDX="$MEM/MEMORY.md"

run_gate() {
  MEMORY_INDEX_PATH="$IDX" MEMORY_INDEX_STATE="$1" MEMORY_LINKCHECK_BIN="$CHECK" \
    bash "$GATE" 2>/dev/null
}
jqv() { jq -r "$2" "$1" 2>/dev/null; }
# index -> hub.md -> lap.md. Nothing is orphaned, and `lap.md` is the case that
# matters: the index does not name it, a hub does.
clean_index() {
  rm -f "$MEM"/*.md
  {
    echo "# Forro bejegyzesek"
    echo "- egy rovid sor"
    echo "# Téma-hubok"
    echo "- [hub](hub.md)"
  } > "$IDX"
  echo "- [lap](lap.md)" > "$MEM/hub.md"
  echo "tartalom" > "$MEM/lap.md"
}

echo "memory-index-gate orphan tests"
echo "=============================="
echo ""

# ---------------------------------------------------------------------------
# (a) EMPTY CHECK FIRST. A "0 orphans" is worth nothing until the scan is shown
#     to have listed pages at all -- a scanner that sees no file also reports
#     zero orphans, and the two must not read the same.
# ---------------------------------------------------------------------------
echo "(a) A clean tree: zero orphans, and the zero is not vacuous"
clean_index
S="$TMP/a.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ "$OUT" = "SKIP" ]; then pass "a clean tree still prints SKIP"; else fail "a clean tree prints SKIP" "$OUT"; fi
if [ "$(jqv "$S" .orphans)" = 0 ]; then pass "orphans is 0"; else fail "orphans is 0" "$(cat "$S")"; fi
PG="$(jqv "$S" .pages_seen)"
if [ -n "$PG" ] && [ "$PG" = 3 ] 2>/dev/null; then pass "pages_seen=3 (index + hub + lap) -- the zero is not vacuous"; else fail "pages_seen is 3" "$PG"; fi
echo ""

# ---------------------------------------------------------------------------
# (b) THE FINDING ITSELF. A page next to the index that nothing points at.
# ---------------------------------------------------------------------------
echo "(b) A page nothing points at is ONE orphan, named, and it wakes"
clean_index
echo "sosem olvassa senki" > "$MEM/arva.md"
S="$TMP/b.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ -z "$OUT" ]; then pass "an orphan wakes (no SKIP)"; else fail "an orphan wakes" "$OUT"; fi
if [ "$(jqv "$S" .orphans)" = 1 ]; then pass "orphans is 1"; else fail "orphans is 1" "$(cat "$S")"; fi
if [ "$(jqv "$S" '.orphan_list[0]')" = "arva.md" ]; then pass "the orphan is NAMED, not just counted"; else fail "orphan_list names arva.md" "$(jqv "$S" .orphan_list)"; fi
# The size branch must not be the reason: this fixture is far under WARN.
SZ="$(jqv "$S" .size)"; W="$(jqv "$S" .warn)"
if [ "$SZ" -lt "$W" ] 2>/dev/null; then pass "and the wake is NOT the size branch (size=$SZ < warn=$W)"; else fail "the wake is not the size branch" "size=$SZ warn=$W"; fi
echo ""

# ---------------------------------------------------------------------------
# (c) WHAT MUST NOT BE REPORTED, part 1: reachable through a hub.
#     This is the case that decides whether the measure is reachability or
#     index membership. `lap.md` is only ever named by the hub.
# ---------------------------------------------------------------------------
echo "(c) A page the index does not name but a HUB does is not an orphan"
clean_index
S="$TMP/c.json"; rm -f "$S"
run_gate "$S" >/dev/null
if ! grep -q "lap.md" "$S"; then pass "lap.md (hub-reachable only) is not reported"; else fail "lap.md is not reported" "$(jqv "$S" .orphan_list)"; fi
echo ""

# ---------------------------------------------------------------------------
# (d) WHAT MUST NOT BE REPORTED, part 2: the index itself, and a target that
#     is missing from disk. A missing target is the OTHER measurement -- it
#     must not be double-counted here as a page nobody points at.
# ---------------------------------------------------------------------------
echo "(d) The index itself is not an orphan, and a dangling target is not one either"
clean_index
echo "- [nincs](nincs-ilyen.md)" >> "$IDX"
S="$TMP/d.json"; rm -f "$S"
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .orphans)" = 0 ]; then pass "a dangling target adds 0 orphans"; else fail "a dangling target adds 0 orphans" "$(jqv "$S" .orphan_list)"; fi
if [ "$(jqv "$S" .missing_links)" = 1 ]; then pass "it is counted once, as a missing link"; else fail "counted as a missing link" "$(jqv "$S" .missing_links)"; fi
if [ "$(jqv "$S" '.orphan_list | map(select(. == "MEMORY.md")) | length')" = 0 ]; then pass "MEMORY.md itself is never an orphan"; else fail "MEMORY.md is not an orphan" "$(jqv "$S" .orphan_list)"; fi
echo ""

# ---------------------------------------------------------------------------
# (e) A page whose only reference stands in PROSE or in a code fence is an
#     orphan: the filtering that keeps the dangling-pointer count honest must
#     not accidentally make a page look reachable.
# ---------------------------------------------------------------------------
echo "(e) A reference that only LOOKS like a link does not make a page reachable"
clean_index
echo "arva" > "$MEM/kodban.md"
{
  echo 'A minta alakja igy nez ki: `](kodban.md)` -- es ez csak proza.'
  echo '```'
  echo '- [kodban](kodban.md)'
  echo '```'
} >> "$IDX"
S="$TMP/e.json"; rm -f "$S"
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .orphans)" = 1 ] && [ "$(jqv "$S" '.orphan_list[0]')" = "kodban.md" ]; then
  pass "a code-fenced / prose reference leaves the page an orphan"
else
  fail "a fenced reference does not make a page reachable" "$(cat "$S")"
fi
echo ""

# ---------------------------------------------------------------------------
# (f) MANY orphans: the list is capped, and the CAP IS VISIBLE. A truncated
#     list that does not say so is how a 30-hole tree reads as a 10-hole one.
# ---------------------------------------------------------------------------
echo "(f) Many orphans: counted in full, listed up to the cap, and the cap is flagged"
clean_index
i=1; while [ "$i" -le 12 ]; do echo "arva $i" > "$MEM/arva$i.md"; i=$((i + 1)); done
S="$TMP/f.json"; rm -f "$S"
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .orphans)" = 12 ]; then pass "all 12 are counted"; else fail "all 12 are counted" "$(jqv "$S" .orphans)"; fi
if [ "$(jqv "$S" '.orphan_list | length')" = 10 ]; then pass "the list stops at 10"; else fail "the list stops at 10" "$(jqv "$S" '.orphan_list | length')"; fi
if [ "$(python3 "$CHECK" "$IDX" | jq -r .orphans_truncated)" = true ]; then pass "orphans_truncated says the list is short"; else fail "orphans_truncated is true" "$(python3 "$CHECK" "$IDX" | jq -r .orphans_truncated)"; fi
echo ""

# ---------------------------------------------------------------------------
# (g) FAIL-OPEN, not fail-silent. A checker that cannot produce the number
#     must wake, and the state file must say WHY -- the same rule the other
#     measurements already follow.
# ---------------------------------------------------------------------------
echo "(g) A checker that answers without the orphan number wakes, with a reason"
clean_index
STUB="$TMP/stub-no-orphans.py"
cat > "$STUB" <<'PY'
import json
# The old shape: every link field, and no orphan field. A gate that reads this
# as "zero orphans" would report green on a measurement that never ran.
print(json.dumps({"files_scanned": 2, "links_checked": 2, "unique_targets": 2,
                  "missing": 0, "missing_occurrences": 0, "missing_list": [],
                  "truncated": False}))
PY
S="$TMP/g.json"; rm -f "$S"
OUT="$(MEMORY_INDEX_PATH="$IDX" MEMORY_INDEX_STATE="$S" MEMORY_LINKCHECK_BIN="$STUB" bash "$GATE" 2>/dev/null)"
if [ -z "$OUT" ]; then pass "a reply without the orphan number wakes (no SKIP)"; else fail "a reply without the orphan number wakes" "$OUT"; fi
if [ "$(jqv "$S" .link_scan)" != "ok" ] && [ -n "$(jqv "$S" .link_scan)" ]; then
  pass "the state file carries the reason: $(jqv "$S" .link_scan)"
else
  fail "the state file names the reason" "$(cat "$S")"
fi
echo ""

# ---------------------------------------------------------------------------
# (h) An unlistable memory directory is NOT zero orphans.
# ---------------------------------------------------------------------------
echo "(h) An unreadable memory directory is a failed scan, not a clean one"
UNMEM="$TMP/unreadable"; mkdir -p "$UNMEM"
echo "- [x](x.md)" > "$UNMEM/MEMORY.md"
chmod 300 "$UNMEM"
RC=0
RES="$(python3 "$CHECK" "$UNMEM/MEMORY.md" 2>/dev/null)" || RC=$?
chmod 700 "$UNMEM"
if [ "$RC" = 2 ]; then pass "the checker exits 2 (could not run)"; else fail "the checker exits 2" "rc=$RC res=$RES"; fi
if [ "$(printf '%s' "$RES" | jq -r '.orphans // "nincs"')" = "nincs" ]; then pass "and it reports NO orphan number rather than 0"; else fail "no orphan number on a failed scan" "$RES"; fi
echo ""

echo "======================================="
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
