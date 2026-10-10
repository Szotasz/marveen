#!/bin/bash
# Contract tests for the snapshot, the manifest and the retention of
# scripts/pre-modify-backup.sh (card 252ab361). Run:
#   bash scripts/__tests__/pre-modify-backup-retention.test.sh
#
# Four defects measured on develop 4a12c410 (2026-09-28), each pinned here:
#   (a) without the sqlite3 CLI (not an install dependency) the database was a
#       raw, possibly torn copy -- python3's backup API now takes a consistent one;
#   (b) three runs without a checksum tool (exit 3) pushed the three oldest
#       VERIFIED snapshots out of the retention window: 7 of 10 were left;
#   (c) a failed run kept a plain directory name, so 9 failed runs and then one
#       successful run left 0 of 3 good snapshots;
#   (d) no manifest listed the WHOLE snapshot: the database had no recorded sum
#       or size.
#
# Hermetic: a throwaway repo and curated PATHs of symlinks, never the live store.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) fail "$1 (unexpected '$3')" ;; *) pass "$1" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO/scripts/pre-modify-backup.sh"
TMP="$(mktemp -d)"
trap 'chmod -R u+rw "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
. "$REPO/scripts/__tests__/lib/sqlite-oracle.sh"

echo "pre-modify-backup: snapshot, manifest and retention"
echo "===================================================="

FAKE="$TMP/repo"
mkdir -p "$FAKE/scripts" "$FAKE/store"
cp "$SCRIPT" "$FAKE/scripts/"
oracle_exec "$FAKE/store/claudeclaw.db" "PRAGMA journal_mode=WAL; CREATE TABLE t(a); INSERT INTO t VALUES (42);"
: > "$FAKE/store/personal-scripts.txt"
B="$FAKE/store/backups"

# A curated PATH: symlinks to the named commands and nothing else.
curated_path() {
  local dir="$1"; shift
  mkdir -p "$dir"
  for c in "$@"; do
    for d in /usr/bin /bin /usr/local/bin /opt/homebrew/bin /usr/sbin; do
      if [ -x "$d/$c" ]; then ln -sf "$d/$c" "$dir/$c"; break; fi
    done
  done
}
BASE_CMDS="bash find mv cp mkdir grep cut date du ls tail rm dirname basename git wc sed awk head sort uname env python3"
NOCLI="$TMP/bin-nocli";  curated_path "$NOCLI"  $BASE_CMDS sha256sum shasum
NOSUM="$TMP/bin-nosum";  curated_path "$NOSUM"  $BASE_CMDS
NOFIND="$TMP/bin-nofind"; curated_path "$NOFIND" bash mv cp mkdir grep cut date du ls tail rm dirname basename git wc sed awk head sort uname env python3 sha256sum shasum
for pair in "$NOCLI:sqlite3" "$NOSUM:sha256sum" "$NOSUM:shasum" "$NOFIND:find"; do
  if PATH="${pair%%:*}" command -v "${pair##*:}" >/dev/null 2>&1; then
    fail "the curated PATH ${pair%%:*} really has no ${pair##*:}"
  fi
done
[ -x "$NOCLI/python3" ] && [ -x "$NOCLI/find" ] || fail "the curated PATH carries python3 and find (otherwise this suite proves nothing)"
run() { PATH="$1" /usr/bin/env bash "$FAKE/scripts/pre-modify-backup.sh" "$2" 2>&1; }
count() { ls -1d "$@" 2>/dev/null | wc -l | tr -d ' '; }

# ---------------------------------------------------------------------------
echo ""
echo "(a)+(d) No sqlite3 CLI: a consistent snapshot through python3, and a manifest of the whole snapshot"
rm -rf "$B"
OUT="$(run "$NOCLI" nocli)"; RC=$?
SNAP="$(ls -1dt "$B"/*/ 2>/dev/null | head -1)"
assert_eq "exit 0" "0" "$RC"
assert_contains "the snapshot is consistent, through python3" "$OUT" "consistent snapshot ok (python3"
assert_not_contains "no raw copy" "$OUT" "no sqlite3 snapshot"
assert_eq "the snapshot is a readable database with the row" "42" "$(oracle_query "${SNAP}claudeclaw.db" "SELECT a FROM t" 2>/dev/null)"
LINE="$(grep '  claudeclaw\.db$' "${SNAP}MANIFEST.sha256" 2>/dev/null)"
case "$LINE" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*"  claudeclaw.db") pass "the manifest lists the database with a real sum" ;;
  *) fail "the manifest lists the database with a real sum (got '$LINE')" ;;
esac
assert_eq "and with its exact size in bytes" "$(wc -c < "${SNAP}claudeclaw.db" | tr -d ' ')" "$(printf '%s' "$LINE" | awk '{print $2}')"
FILES="$(cd "$SNAP" && find . -type f ! -name MANIFEST.sha256 | wc -l | tr -d ' ')"
assert_eq "every file of the snapshot is listed" "$FILES" "$(grep -c '' "${SNAP}MANIFEST.sha256")"

# ---------------------------------------------------------------------------
echo ""
echo "(b) 10 verified snapshots, then 3 runs without a checksum tool (exit 3): all 10 stay"
rm -rf "$B"; mkdir -p "$B"
for i in 01 02 03 04 05 06 07 08 09 10; do
  d="$B/202601${i}-000000-verified${i}"; mkdir -p "$d"; touch -t "202601${i}0000" "$d"
done
RCS=""
for n in 1 2 3; do run "$NOSUM" "unverified${n}" >/dev/null; RCS="$RCS$?"; done
assert_eq "all three runs exit 3" "333" "$RCS"
assert_eq "all 10 verified snapshots survive (on develop 4a12c410: 7)" "10" "$(count "$B"/*-verified*/)"
assert_eq "the 3 unverified runs are marked -INCOMPLETE" "3" "$(count "$B"/*-unverified*-INCOMPLETE/)"
assert_eq "only the 10 verified ones read as usable" "10" "$(ls -1d "$B"/*/ 2>/dev/null | grep -vc -- '-INCOMPLETE/$')"
OUT="$(run "$NOCLI" verified11)"; RC=$?
assert_eq "CONTROL: a verified run after them succeeds" "0" "$RC"
assert_contains "and prunes the oldest verified snapshot: the rotation still works" "$OUT" "pruned old snapshot: 20260101-000000-verified01"
assert_eq "10 verified snapshots are kept" "10" "$(count "$B"/*-verified*/)"
run "$NOSUM" unverified4 >/dev/null; RC=$?
assert_eq "a fourth unverified run exits 3" "3" "$RC"
assert_eq "the -INCOMPLETE compartment keeps its newest 3" "3" "$(count "$B"/*-INCOMPLETE/)"
assert_eq "the fourth one is among them" "1" "$(count "$B"/*-unverified4-INCOMPLETE/)"
assert_eq "and the 10 verified ones are untouched" "10" "$(count "$B"/*-verified*/)"

echo ""
echo "(b2) 11 verified snapshots and an unverified run: none of the 11 is pruned"
rm -rf "$B"; mkdir -p "$B"
for i in 01 02 03 04 05 06 07 08 09 10 11; do
  d="$B/202601${i}-000000-verified${i}"; mkdir -p "$d"; touch -t "202601${i}0000" "$d"
done
OUT="$(run "$NOSUM" unverified)"; RC=$?
assert_eq "exit 3" "3" "$RC"
assert_not_contains "it prunes no verified snapshot" "$OUT" "pruned old snapshot:"
assert_eq "all 11 verified snapshots are still there" "11" "$(count "$B"/*-verified*/)"
assert_contains "the manifest line reads the snapshot" "$OUT" "file(s) listed with sha256 + size"
assert_not_contains "and finds its files there" "$OUT" "No such file"

# ---------------------------------------------------------------------------
echo ""
echo "(c) 3 good snapshots, 9 failed runs (the database cannot be captured), then 1 successful run"
rm -rf "$B"; mkdir -p "$B"
for i in 1 2 3; do
  d="$B/2026010${i}-000000-good${i}"; mkdir -p "$d"; touch -t "20260101010${i}" "$d"
done
chmod 000 "$FAKE/store/claudeclaw.db"
if [ -r "$FAKE/store/claudeclaw.db" ]; then
  chmod 644 "$FAKE/store/claudeclaw.db"
  echo "  SKIP: running as root, an unreadable db cannot be produced -- case (c) NOT measured"
else
  RCS=""
  for n in 1 2 3 4 5 6 7 8 9; do run "$NOCLI" "failed${n}" >/dev/null; RCS="$RCS$?"; sleep 1; done
  chmod 644 "$FAKE/store/claudeclaw.db"
  assert_eq "all nine failed runs exit 1" "111111111" "$RCS"
  assert_eq "no failed directory keeps a plain name" "0" "$(ls -1d "$B"/*-failed*/ 2>/dev/null | grep -vc -- '-INCOMPLETE/$')"
  assert_eq "the -INCOMPLETE compartment keeps the newest 3 of them" "3" "$(count "$B"/*-failed*-INCOMPLETE/)"
  OUT="$(run "$NOCLI" ok)"; RC=$?
  assert_eq "the successful run exits 0" "0" "$RC"
  assert_eq "all 3 good snapshots survive (on develop 4a12c410: 0)" "3" "$(count "$B"/*-good*/)"
fi

# ---------------------------------------------------------------------------
echo ""
echo "(d2) No find: the manifest cannot be written, so the run does not count as verified"
rm -rf "$B"; mkdir -p "$B"
d="$B/20260101-000000-verified01"; mkdir -p "$d"; touch -t "202601010000" "$d"
OUT="$(run "$NOFIND" nofind)"; RC=$?
assert_eq "exit 3" "3" "$RC"
assert_contains "it says the manifest could not be written" "$OUT" "its manifest could not be written"
assert_eq "the run is marked -INCOMPLETE" "1" "$(count "$B"/*-nofind-INCOMPLETE/)"
assert_eq "the database is still in it" "yes" "$([ -s "$(ls -1d "$B"/*-nofind-INCOMPLETE/ | head -1)claudeclaw.db" ] && echo yes || echo no)"

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
