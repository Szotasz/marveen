#!/bin/bash
# Unit tests for scripts/intel_db.py (intel registry CLI).
# Run: bash scripts/__tests__/intel-db.test.sh

set -e

PASS=0
FAIL=0
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$INSTALL_DIR/scripts/intel_db.py"
export INTEL_DB="$TMPDIR_BASE/intel.db"

echo "intel_db tests"
echo "=============="

# --- Test 1: plain run on a fresh install creates the schema and exits 0 ---
echo ""
echo "Test 1: plain run bootstraps the schema"
OUT=$(python3 "$CLI")
if echo "$OUT" | grep -q "OK"; then
  pass "no-arg run exits 0 with OK"
else
  fail "no-arg run output unexpected: $OUT"
fi
TABLES=$(sqlite3 "$INTEL_DB" ".tables")
for t in known_facts_registry watchlist decision_log active_focus; do
  if echo "$TABLES" | grep -q "$t"; then
    pass "table $t exists"
  else
    fail "table $t missing"
  fi
done

# --- Test 2: explicit init is idempotent ---
echo ""
echo "Test 2: init is idempotent"
python3 "$CLI" init > /dev/null
python3 "$CLI" init > /dev/null
pass "init twice exits 0"

# --- Test 3: add-fact generates a deterministic id ---
echo ""
echo "Test 3: add-fact deterministic id"
ID1=$(python3 "$CLI" add-fact --title "T1" --domain market --source "src" --tier 2 --content "price moved 5%")
DAY=$(date +%Y%m%d)
if [[ "$ID1" == market-"$DAY"-* ]]; then
  pass "id has <domain>-<YYYYMMDD>-<hash> shape: $ID1"
else
  fail "unexpected id: $ID1"
fi

# --- Test 4: same content again -> same id -> update, not duplicate ---
echo ""
echo "Test 4: repeat sighting is an update"
ID2=$(python3 "$CLI" add-fact --title "T1b" --domain market --source "src" --tier 2 --content "price moved 5%" --status evolving)
COUNT=$(sqlite3 "$INTEL_DB" "SELECT COUNT(*) FROM known_facts_registry")
STATUS=$(sqlite3 "$INTEL_DB" "SELECT status FROM known_facts_registry WHERE id='$ID1'")
if [ "$ID1" = "$ID2" ] && [ "$COUNT" = "1" ] && [ "$STATUS" = "evolving" ]; then
  pass "same content upserted in place (1 row, status=evolving)"
else
  fail "expected upsert, got id=$ID2 count=$COUNT status=$STATUS"
fi

# --- Test 5: same content under a DIFFERENT id -> clean no-op ---
echo ""
echo "Test 5: duplicate content under another id is a no-op"
OUT=$(python3 "$CLI" add-fact --id other-id --title "T1c" --domain market --source "src" --tier 2 --content "price moved 5%")
COUNT=$(sqlite3 "$INTEL_DB" "SELECT COUNT(*) FROM known_facts_registry")
if echo "$OUT" | grep -q "DUPLICATE" && [ "$COUNT" = "1" ]; then
  pass "DUPLICATE reported, still 1 row, exit 0"
else
  fail "expected DUPLICATE no-op, got: $OUT (count=$COUNT)"
fi

# --- Test 6: add-watch / add-focus / log-decision write their tables ---
echo ""
echo "Test 6: secondary writers"
python3 "$CLI" add-watch --title "raw material price" --domain market --direction "upward" > /dev/null
python3 "$CLI" add-focus --topic "Q3 sourcing" --mode deep --days 30 > /dev/null
python3 "$CLI" log-decision --recommendation "hold" --reasoning "band intact" > /dev/null
for t in watchlist active_focus decision_log; do
  N=$(sqlite3 "$INTEL_DB" "SELECT COUNT(*) FROM $t")
  if [ "$N" = "1" ]; then
    pass "$t has 1 row"
  else
    fail "$t expected 1 row, got $N"
  fi
done

# --- Test 7: dump (and --dump alias) returns the fact as JSON ---
echo ""
echo "Test 7: dump JSON"
for form in "dump" "--dump"; do
  OUT=$(python3 "$CLI" $form)
  if echo "$OUT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
assert len(d['registry']) == 1 and d['registry'][0]['id'] == '$ID1'
assert len(d['watchlist']) == 1 and len(d['active_focus']) == 1
"; then
    pass "$form returns registry+watchlist+active_focus"
  else
    fail "$form JSON shape wrong"
  fi
done

# --- Test 8: expired focus and closed facts drop out of dump ---
echo ""
echo "Test 8: lifecycle filtering"
sqlite3 "$INTEL_DB" "UPDATE known_facts_registry SET status='closed' WHERE id='$ID1'"
sqlite3 "$INTEL_DB" "UPDATE active_focus SET expires_at=1"
OUT=$(python3 "$CLI" dump)
if echo "$OUT" | python3 -c "
import json,sys
d = json.load(sys.stdin)
assert d['registry'] == [] and d['active_focus'] == []
"; then
  pass "closed fact and expired focus filtered out"
else
  fail "lifecycle filtering broken"
fi

echo ""
echo "=============="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
