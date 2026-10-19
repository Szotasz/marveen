#!/bin/bash
# LAUNCHQUOTEREST1008 (SECSZIVEK1007 follow-up): scripts/task-last-run.sh puts
# its arguments into SQL. The task name now goes in as an SQL string literal
# (a quote doubled), and the hours window must be a whole number.
# The script now binds both as query parameters, through python3's sqlite3
# module (the sqlite3 CLI is not an install dependency; the suite died with 127
# on a host without it). The fixture and the final check go
# through lib/sqlite-oracle.sh for the same reason.
# A throwaway install with its own store/claudeclaw.db; nothing else is touched.
# Run: bash scripts/__tests__/task-last-run-args.test.sh
set -u
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
. "$REPO/scripts/__tests__/lib/sqlite-oracle.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/store"
cp "$REPO/scripts/task-last-run.sh" "$TMP/scripts/"
NOW_MS=$(( $(date +%s) * 1000 ))
oracle_exec "$TMP/store/claudeclaw.db" "CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, agent TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'fired');
  INSERT INTO task_runs(name, agent, ts) VALUES ('it''s a task', 'geri', $NOW_MS), ('plain-task', 'geri', $NOW_MS);"

echo "task-last-run.sh arguments in SQL"
OUT="$(bash "$TMP/scripts/task-last-run.sh" "it's a task" 2>&1)"; RC=$?
[ "$RC" = 0 ] && pass "a task name with an apostrophe runs (rc 0)" || fail "a task name with an apostrophe runs (rc $RC: $(printf '%s' "$OUT" | head -2 | tr '\n' ' '))"
printf '%s' "$OUT" | grep -q "fired" && pass "...and finds its row" || fail "...and finds its row (out: $(printf '%s' "$OUT" | head -3 | tr '\n' ' '))"
OUT="$(bash "$TMP/scripts/task-last-run.sh" plain-task 24 2>&1)"; RC=$?
[ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q fired && pass "a plain name with a whole-number window works as before" || fail "a plain name with a whole-number window works as before (rc $RC)"
bash "$TMP/scripts/task-last-run.sh" plain-task "1 OR 1" >/dev/null 2>&1; RC=$?
[ "$RC" = 2 ] && pass "a window that is not a whole number is refused (rc 2)" || fail "a window that is not a whole number is refused (rc $RC)"
OUT="$(bash "$TMP/scripts/task-last-run.sh" "x' OR '1'='1" 2>&1)"; RC=$?
[ "$RC" = 0 ] && ! printf '%s' "$OUT" | grep -q fired && pass "a quote in the name cannot widen the filter" || fail "a quote in the name cannot widen the filter (rc $RC, out: $(printf '%s' "$OUT" | head -3 | tr '\n' ' '))"
OUT="$(bash "$TMP/scripts/task-last-run.sh" --stats 24 2>&1)"; RC=$?
[ "$RC" = 0 ] && printf '%s' "$OUT" | grep -q plain-task && pass "--stats with a whole-number window lists the tasks" || fail "--stats with a whole-number window lists the tasks (rc $RC)"
bash "$TMP/scripts/task-last-run.sh" --stats "24 OR 1" >/dev/null 2>&1; RC=$?
[ "$RC" = 2 ] && pass "--stats refuses the same" || fail "--stats refuses the same (rc $RC)"
[ "$(oracle_query "$TMP/store/claudeclaw.db" 'SELECT count(*) FROM task_runs')" = 2 ] && pass "the table is untouched" || fail "the table is untouched"
echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
