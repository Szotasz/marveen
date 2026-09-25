#!/bin/bash
# Contract tests for the LOGO-HIVATKOZAS (dangling pointer) measurement of
# scripts/memory-index-gate.sh + scripts/memory-index-linkcheck.py.
#
# The gap (2026-09-18): the gate measured the index SIZE, because above the load
# limit the end of the file truncates in silence. An index line pointing at a
# page that does not exist is the same silence in another shape -- and it was a
# human re-reading, not a gate, that found the live one.
#
# The reason this suite is long for a counter: the checker itself can lie, and
# BOTH directions already fired here in one round (2026-09-10, three false
# alarms) -- prose that merely writes the pattern down, and a target lifted out
# of the link TEXT instead of the link. So the cases below are as much about
# what must NOT be reported as about what must. Coming up with a defect that
# does not exist costs the same as hiding one that does.
#
# Every case runs on fixtures through MEMORY_INDEX_PATH / MEMORY_INDEX_STATE /
# MEMORY_LINKCHECK_BIN, so the live index, the live state file and the live
# checker are never touched.
# Run: bash scripts/__tests__/memory-index-gate-linkcheck.test.sh

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

# $1 = state path. One gate tick on the fixture index with the real checker.
run_gate() {
  MEMORY_INDEX_PATH="$IDX" MEMORY_INDEX_STATE="$1" MEMORY_LINKCHECK_BIN="$CHECK" \
    bash "$GATE" 2>/dev/null
}
jqv() { jq -r "$2" "$1" 2>/dev/null; }
# Fresh index body shared by the cases that must stay clean.
clean_index() {
  {
    echo "# Forro bejegyzesek"
    echo "- egy rovid sor"
    echo "# Téma-hubok"
    echo "- [hub](hub.md)"
  } > "$IDX"
  echo "- [lap](lap.md)" > "$MEM/hub.md"
  echo "tartalom" > "$MEM/lap.md"
}

echo "memory-index-gate logo-hivatkozas tests"
echo "======================================="
echo ""

# ---------------------------------------------------------------------------
# (a) EMPTY CHECK FIRST. A "0 missing" is worth nothing until the scan is shown
#     to have seen links at all -- a scanner that reads no file also reports
#     zero defects.
# ---------------------------------------------------------------------------
echo "(a) A clean index: zero missing, and the scan provably looked at something"
clean_index
S="$TMP/a.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ "$OUT" = "SKIP" ]; then pass "a clean index still prints SKIP"; else fail "a clean index prints SKIP" "$OUT"; fi
if [ "$(jqv "$S" .missing_links)" = 0 ]; then pass "missing_links is 0"; else fail "missing_links is 0" "$(cat "$S")"; fi
CH="$(jqv "$S" .links_checked)"
if [ -n "$CH" ] && [ "$CH" -ge 2 ] 2>/dev/null; then pass "links_checked=$CH -- the zero is not vacuous"; else fail "links_checked is non-zero" "$CH"; fi
if [ "$(jqv "$S" .link_files)" = 2 ]; then pass "the scope is the index PLUS the hub it points at"; else fail "the scope is index + hub" "$(jqv "$S" .link_files)"; fi
echo ""

# ---------------------------------------------------------------------------
# (b) POSITIVE CONTROL: the live defect. Without this the whole suite could be
#     green on a checker that can never go red.
# ---------------------------------------------------------------------------
echo "(b) A deliberately dangling pointer IS reported"
clean_index
echo "- [nincs meg](sosem-letezett-lap.md)" >> "$IDX"
S="$TMP/b.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ -z "$OUT" ]; then pass "the gate wakes (empty stdout) on a dangling pointer"; else fail "the gate wakes on a dangling pointer" "$OUT"; fi
if [ "$(jqv "$S" .missing_links)" = 1 ]; then pass "missing_links counts exactly the one"; else fail "missing_links is 1" "$(cat "$S")"; fi
if [ "$(jqv "$S" '.missing_list[0].target')" = "sosem-letezett-lap.md" ]; then
  pass "the state NAMES the target (a number alone cannot be acted on)"
else
  fail "the state names the target" "$(jqv "$S" .missing_list)"
fi
if [ "$(jqv "$S" '.missing_list[0].line')" = 5 ]; then pass "and the line number, so the page opens where the hole is"; else fail "the line number is reported" "$(jqv "$S" '.missing_list[0].line')"; fi
echo ""

# ---------------------------------------------------------------------------
# (b2) THE UNIT OF AN ALARM. Measured 2026-09-18 on one page: 43 occurrences,
#      27 distinct targets -- both correct, answering different questions. A
#      page that is missing and linked from several places is ONE hole to fill;
#      counting occurrences would make one gap look like several, and the bigger
#      number is the one people act on.
# ---------------------------------------------------------------------------
echo "(b2) One missing page linked three times is ONE finding"
clean_index
{
  echo "- [elso](sosem-letezett-lap.md)"
  echo "- [masodik](sosem-letezett-lap.md)"
} >> "$IDX"
echo "- [harmadik](sosem-letezett-lap.md)" >> "$MEM/hub.md"
S="$TMP/b2.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ -z "$OUT" ]; then pass "it still wakes"; else fail "it still wakes" "$OUT"; fi
if [ "$(jqv "$S" .missing_links)" = 1 ]; then pass "missing_links counts the TARGET once, not the three links"; else fail "missing_links is 1" "$(cat "$S")"; fi
if [ "$(jqv "$S" .missing_occurrences)" = 3 ]; then pass "the three occurrences stay visible as context"; else fail "missing_occurrences is 3" "$(jqv "$S" .missing_occurrences)"; fi
if [ "$(jqv "$S" '.missing_list | length')" = 1 ] && [ "$(jqv "$S" '.missing_list[0].occurrences')" = 3 ]; then
  pass "the list carries one row with its occurrence count"
else
  fail "the list carries one row with its count" "$(jqv "$S" .missing_list)"
fi
# And the counterpart: two DIFFERENT missing pages are two findings, so the
# de-duplication cannot be hiding holes.
clean_index
echo "- [egyik](nincs-egy.md)" >> "$IDX"
echo "- [masik](nincs-ketto.md)" >> "$IDX"
S="$TMP/b3.json"; rm -f "$S"
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .missing_links)" = 2 ]; then pass "but two different missing pages are two findings"; else fail "two different missing pages are two findings" "$(cat "$S")"; fi
echo ""

# ---------------------------------------------------------------------------
# (c) FALSE ALARM #1, measured 2026-09-10: a `](...md)` shape standing in PROSE
#     that describes the pattern. Both spellings: inside a code span (how we
#     write it) and bare (how a hurried line writes it).
# ---------------------------------------------------------------------------
echo "(c) Prose that merely writes the pattern down is NOT a pointer"
clean_index
{
  echo '- A kapu azt szamolja, hany `](...md)` hivatkozas celja hianyzik.'
  echo '- Egy ](...md) alaku minta prozaban, idezojel nelkul.'
} >> "$IDX"
S="$TMP/c.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ "$(jqv "$S" .missing_links)" = 0 ]; then pass "neither prose spelling is reported"; else fail "prose is not reported" "$(jqv "$S" .missing_list)"; fi
if [ "$OUT" = "SKIP" ]; then pass "and the verdict stays SKIP"; else fail "the verdict stays SKIP" "$OUT"; fi
echo ""

# ---------------------------------------------------------------------------
# (d) FALSE ALARM #2, measured 2026-09-10 by two agents independently: a
#     wikilink inside the link TEXT read as a separate target. The real target
#     is right there in the same line and exists.
# ---------------------------------------------------------------------------
echo "(d) A [[wikilink]] in the link text is text, not a target"
clean_index
echo "- [A [[CONTEXT-GUARD]] boritek nelkul jon...](context-guard-lap.md)" >> "$IDX"
echo "tartalom" > "$MEM/context-guard-lap.md"
S="$TMP/d.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ "$(jqv "$S" .missing_links)" = 0 ]; then pass "the wikilink in the text raises nothing"; else fail "the wikilink raises nothing" "$(jqv "$S" .missing_list)"; fi
if [ "$OUT" = "SKIP" ]; then pass "and the verdict stays SKIP"; else fail "the verdict stays SKIP" "$OUT"; fi
# NEGATIVE control for the same line shape: if the REAL target of that same
# line goes missing, it must still be caught. Otherwise (d) could pass by the
# checker ignoring the line altogether.
rm -f "$MEM/context-guard-lap.md"
S="$TMP/d2.json"; rm -f "$S"
run_gate "$S" >/dev/null
if [ "$(jqv "$S" .missing_links)" = 1 ] && [ "$(jqv "$S" '.missing_list[0].target')" = "context-guard-lap.md" ]; then
  pass "but the REAL target of that same line is still checked"
else
  fail "the real target of that line is still checked" "$(cat "$S")"
fi
echo ""

# ---------------------------------------------------------------------------
# (e) A fenced block is a quoted example, not a link list.
# ---------------------------------------------------------------------------
echo "(e) A link inside a fenced code block is an example"
clean_index
{
  echo '```markdown'
  echo '- [pelda](nincs-ilyen-lap.md)'
  echo '```'
} >> "$IDX"
S="$TMP/e.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ "$(jqv "$S" .missing_links)" = 0 ] && [ "$OUT" = "SKIP" ]; then pass "the fenced example is not reported"; else fail "the fenced example is not reported" "$(jqv "$S" .missing_list) out='$OUT'"; fi
echo ""

# ---------------------------------------------------------------------------
# (f) SCOPE: the hubs are where a line goes when it leaves the index, so a hub
#     that lost its own target is the next silent hole. Depth 1 must be real.
# ---------------------------------------------------------------------------
echo "(f) A hole in a HUB is found, not only one in the index"
clean_index
echo "- [elveszett](hub-alatti-lap.md)" >> "$MEM/hub.md"
S="$TMP/f.json"; rm -f "$S"
OUT="$(run_gate "$S")"
if [ -z "$OUT" ] && [ "$(jqv "$S" .missing_links)" = 1 ]; then pass "the hub's dangling pointer wakes the gate"; else fail "the hub's dangling pointer wakes the gate" "out='$OUT' $(cat "$S")"; fi
if [ "$(jqv "$S" '.missing_list[0].in')" = "hub.md" ]; then pass "the state says WHICH file carries it"; else fail "the state says which file" "$(jqv "$S" .missing_list)"; fi
echo ""

# ---------------------------------------------------------------------------
# (g) FAIL-OPEN. If the measurement itself dies, that must be a WAKE with the
#     reason recorded -- never silence, which reads exactly like "all clean".
# ---------------------------------------------------------------------------
echo "(g) A checker that blows up wakes the gate and says why"
clean_index
BROKEN="$TMP/broken-check.py"
printf '#!/usr/bin/env python3\nimport sys\nsys.stderr.write("boom\\n")\nsys.exit(2)\n' > "$BROKEN"
S="$TMP/g.json"; rm -f "$S"
OUT="$(MEMORY_INDEX_PATH="$IDX" MEMORY_INDEX_STATE="$S" MEMORY_LINKCHECK_BIN="$BROKEN" bash "$GATE" 2>/dev/null)"
if [ -z "$OUT" ]; then pass "a failing checker wakes the gate"; else fail "a failing checker wakes the gate" "$OUT"; fi
LS="$(jqv "$S" .link_scan)"
if [ -n "$LS" ] && [ "$LS" != ok ] && [ "$LS" != null ]; then pass "the state carries the reason: $LS"; else fail "the state carries the reason" "$(cat "$S")"; fi
if jq -e . "$S" >/dev/null 2>&1; then pass "and the state is still valid JSON"; else fail "the state is valid JSON" "$(cat "$S")"; fi
echo ""

echo "(h) A checker that is not there at all is the same class"
S="$TMP/h.json"; rm -f "$S"
OUT="$(MEMORY_INDEX_PATH="$IDX" MEMORY_INDEX_STATE="$S" MEMORY_LINKCHECK_BIN="$TMP/nincs-ilyen.py" bash "$GATE" 2>/dev/null)"
if [ -z "$OUT" ] && [ "$(jqv "$S" .link_scan)" != ok ]; then pass "a missing checker wakes, with the reason recorded"; else fail "a missing checker wakes with a reason" "out='$OUT' $(cat "$S")"; fi
echo ""

# ---------------------------------------------------------------------------
# (i) REGRESSION. This is an ADDITION: the size verdict must be exactly what it
#     was, both directions, and the size fields must keep their shape.
# ---------------------------------------------------------------------------
echo "(i) The size gate is untouched"
BIG="$TMP/BIG.md"
{
  echo "# Forro bejegyzesek"
  awk 'BEGIN { for (i = 0; i < 350; i++) print "- ez egy otven bajt korul mozgo rovid sor a forro szekciobol" }'
  echo "# Téma-hubok"
} > "$BIG"
BIGSIZE="$(wc -c < "$BIG" | tr -d ' ')"
S="$TMP/i.json"; rm -f "$S"
OUT="$(MEMORY_INDEX_PATH="$BIG" MEMORY_INDEX_STATE="$S" MEMORY_LINKCHECK_BIN="$CHECK" bash "$GATE" 2>/dev/null)"
if [ "$BIGSIZE" -gt 20000 ] && [ -z "$OUT" ]; then pass "over the warn threshold still wakes, size=$BIGSIZE"; else fail "over warn still wakes" "size=$BIGSIZE out='$OUT'"; fi
if [ "$(jqv "$S" .size)" = "$BIGSIZE" ] && [ "$(jqv "$S" .over_hard)" = false ] && [ "$(jqv "$S" .hot_scan)" = ok ]; then
  pass "the size fields are written exactly as before"
else
  fail "the size fields are written as before" "$(cat "$S")"
fi
clean_index
S="$TMP/i2.json"; rm -f "$S"
if [ "$(run_gate "$S")" = "SKIP" ]; then pass "and a small clean index still prints SKIP"; else fail "a small clean index prints SKIP" "$(run_gate "$S")"; fi
echo ""

echo "(j) The state file stays machine-readable with the new fields"
for f in a b b2 b3 c d e f i2; do
  S="$TMP/$f.json"
  [ -f "$S" ] || continue
  if jq -e 'has("link_scan") and (.missing_links == null or (.missing_links|type) == "number")' "$S" >/dev/null 2>&1; then
    pass "$f.json: link_scan present, missing_links typed"
  else
    fail "$f.json: link_scan present and typed" "$(cat "$S")"
  fi
done
echo ""

echo "======================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
