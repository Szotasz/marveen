#!/bin/bash
# scripts/lib/spotlight-check.sh (SPOTLIGHT1022): the doctor's macOS Spotlight report.
# Hermetic: fake mdutil and ps binaries in a throwaway dir, so the verdict does
# not depend on the host's real index. The last section mutates a copy of the lib
# and expects the suite to notice.
#
# Run: bash scripts/__tests__/spotlight-check.test.sh
set -u
INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$INSTALL_DIR/scripts/lib/spotlight-check.sh"

FAILED=0
pass(){ echo "  PASS  $*"; }
fail(){ echo "  FAIL  $*"; FAILED=1; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-check-XXXX")"
trap 'rm -rf "$FIX"' EXIT

# fake_mdutil <status text>: an mdutil that answers -s with the given text.
fake_mdutil(){ printf '#!/bin/bash\nprintf "%%s:\\n\\t%%s\\n" "$2" "%s"\n' "$1" > "$FIX/mdutil"; chmod +x "$FIX/mdutil"; }
printf '#!/bin/bash\necho "  1:02.03 /usr/libexec/other"\necho "552:26.85 /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/Metadata.framework/Versions/A/Support/mds_stores"\n' > "$FIX/ps"
chmod +x "$FIX/ps"

# The lib checks /System/Volumes/Data and falls back to / where it does not exist (Linux CI).
VOL="/System/Volumes/Data"; [ -d "$VOL" ] || VOL="/"

run(){ # run <lib>
  INSTALL_DIR="/opt/marveen-test" MDUTIL="$FIX/mdutil" PS="$FIX/ps" bash -c ". \"$1\"; spotlight_check" 2>&1
}

echo "--- indexing on: two warn lines, the fix and the root-only commands ---"
fake_mdutil "Indexing enabled. "
out="$(run "$LIB")"; rc=$?
[ $rc -eq 0 ] && [ "$(echo "$out" | grep -c '^warn|')" -eq 2 ] \
  && pass "exit 0, two warn lines" || fail "expected two warn lines (rc=$rc): $out"
echo "$out" | grep -q "Search Privacy, add /opt/marveen-test and ~/.claude" \
  && pass "names the fix: Search Privacy, the actual install folder and ~/.claude" || fail "fix text missing: $out"
echo "$out" | grep -q "mds_stores CPU time: 552:26.85" \
  && pass "reports the mds_stores CPU time from ps" || fail "CPU time missing: $out"
echo "$out" | grep -q "sudo du -sh .*/.Spotlight-V100 ; sudo lsof -c mds_stores" \
  && pass "prints the root-only measurement commands" || fail "sudo commands missing: $out"
echo "$out" | grep -q "docs/macos-spotlight.md" && [ -f "$INSTALL_DIR/docs/macos-spotlight.md" ] \
  && pass "points to docs/macos-spotlight.md, which exists" || fail "doc pointer missing or the doc does not exist"

echo "--- indexing off: one ok line ---"
fake_mdutil "Indexing disabled."
out="$(run "$LIB")"; rc=$?
[ $rc -eq 0 ] && [ "$out" = "ok|Spotlight indexing is off on $VOL" ] \
  && pass "exit 0, ok line" || fail "expected the ok line (rc=$rc): $out"

echo "--- unknown answer and missing binary: skip, never warn ---"
fake_mdutil "Error: unknown indexing state."
out="$(run "$LIB")"; rc=$?
[ $rc -eq 0 ] && echo "$out" | grep -q '^skip|' && ! echo "$out" | grep -q '^warn|' \
  && pass "unknown status: skip" || fail "unknown status must skip (rc=$rc): $out"
out="$(MDUTIL="$FIX/nope" PS="$FIX/ps" bash -c ". \"$LIB\"; spotlight_check" 2>&1)"; rc=$?
[ $rc -eq 0 ] && [ "$out" = "skip|mdutil not found (not macOS?)" ] \
  && pass "no mdutil: skip" || fail "missing mdutil must skip (rc=$rc): $out"

echo "--- doctor.sh sources the lib only on macOS and never fails the run on it ---"
DOC="$INSTALL_DIR/scripts/doctor.sh"
block="$(sed -n '/^# --- Spotlight (macOS) ---$/,/^# --- Summary ---$/p' "$DOC")"
echo "$block" | grep -q 'if \[ "$(uname -s)" = "Darwin" \]; then' \
  && echo "$block" | grep -q 'scripts/lib/spotlight-check.sh' \
  && ! echo "$block" | grep -q 'fail ' \
  && pass "Darwin-guarded, sources the lib, no fail call" || fail "doctor.sh Spotlight block not as expected"

echo "--- mutation control: a lib that never warns is caught ---"
MUT="$FIX/spotlight-check-mutated.sh"
sed 's/\*"Indexing enabled"\*)/*"NEVER-MATCHES"*)/' "$LIB" > "$MUT"
if diff -q "$LIB" "$MUT" >/dev/null 2>&1; then
  fail "the sed pattern matched nothing: the mutation did not change the file"
else
  fake_mdutil "Indexing enabled. "
  out="$(run "$MUT")"
  echo "$out" | grep -q '^warn|' \
    && fail "mutated lib still warns: the indexing-on case does not measure the match" \
    || pass "mutated lib gives no warn: the indexing-on case can fail"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "OSSZES PASS"
  exit 0
else
  echo "VAN BUKOTT TESZT"
  exit 1
fi
