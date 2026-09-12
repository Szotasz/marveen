#!/bin/bash
# PORTSTAT912: the shared portable mtime helper, and a guard that stops the
# GNU-only spelling from coming back.
#
# The bug this closes was never exotic. `stat -c %Y` is GNU-only; on macOS it
# exits 1 and the fallback every caller wrote -- `|| echo 0` -- turned that into
# mtime=0, so a file touched a second ago measured as 56 years old. What made it
# dangerous is WHERE it was spelled: every caller is a grace, backoff or
# staleness gate, and zero tips all of them the SAME way, the permissive one.
# channel-watchdog.sh read a fresh keepalive as infinitely stale (respawn the
# pane, every tick), and the very next gate -- the respawn-grace stamp meant to
# stop that storm -- read zero too and never deferred. watchdog.sh:169 and
# stuck-modal-guard.sh:238 are the same pair. One bug that disables its own
# brakes, in four places.
#
# So this file has two jobs:
#   1. hold scripts/lib/portable-stat.sh to its contract, INCLUDING the branch
#      that cannot run on the host doing the testing (via a stub `stat`), and
#   2. fail if any shell script starts spelling mtime a single way again --
#      otherwise we are back here in a year.
# Run: bash scripts/__tests__/portable-stat.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$INSTALL_DIR/scripts/lib/portable-stat.sh"

echo "portable mtime helper + no-regression guard (PORTSTAT912)"
echo "  platform: $(uname -s)"

if [ ! -f "$LIB" ]; then
  fail "the library exists" "$LIB" "absent"
  echo; echo "  $PASS passed, $FAIL failed"; exit 1
fi
# shellcheck disable=SC1090
. "$LIB"

if ! command -v python3 >/dev/null 2>&1; then
  fail "prerequisite: an independent mtime oracle" "python3 on PATH" "absent"
  echo; echo "  $PASS passed, $FAIL failed"; exit 1
fi
mtime_oracle() { python3 -c 'import os,sys; print(int(os.stat(sys.argv[1]).st_mtime))' "$1" 2>/dev/null; }

BOX="$(mktemp -d -t portstat912b)"
trap 'case "$BOX" in *portstat912b*) rm -rf "$BOX" ;; esac' EXIT

fresh="$BOX/fresh"; : > "$fresh"
truth="$(mtime_oracle "$fresh")"

# --- contract on this host ---------------------------------------------------
got="$(file_mtime "$fresh")"
if [ "$got" = "$truth" ] && [ "$got" != "0" ]; then
  pass "fresh file: the real mtime, not 0"
else
  fail "fresh file: the real mtime, not 0" "$truth" "[$got]"
fi

old="$BOX/old"; : > "$old"
touch -t 202601011200 "$old" 2>/dev/null || touch -d '2026-01-01 12:00' "$old" 2>/dev/null
got="$(file_mtime "$old")"; want="$(mtime_oracle "$old")"
# A helper that always answered "now" would pass the case above while silently
# switching staleness detection off everywhere.
if [ "$got" = "$want" ] && [ "$got" != "0" ]; then
  pass "backdated file: the old mtime, not now"
else
  fail "backdated file: the old mtime, not now" "$want" "[$got]"
fi

got="$(file_mtime "$BOX/nope")"
if [ "$got" = "0" ]; then
  pass "missing file: 0, the historical 'unknown means act' contract"
else
  fail "missing file: 0, the historical 'unknown means act' contract" "0" "[$got]"
fi

# --- the branch this host cannot reach ---------------------------------------
# On any single machine one of the two spellings is dead code, and dead code
# rots. A stub `stat` earlier on PATH lets the GNU-side branch be exercised
# from a BSD host and vice versa. This is a stub of the documented behaviour,
# NOT real GNU coreutils -- it measures our branch logic, not their binary.
mkdir -p "$BOX/bin"

# GNU-like: -c works; -f is a valid but DIFFERENT option (file-system status),
# so the BSD spelling gets a bogus operand and exits non-zero.
cat > "$BOX/bin/stat" <<'STUB'
#!/bin/bash
if [ "$1" = "-c" ]; then
  python3 -c 'import os,sys; print(int(os.stat(sys.argv[1]).st_mtime))' "$3"
  exit 0
fi
echo "  File: \"$2\""
echo "    ID: 0 Namelen: 255     Type: ext2/ext3"
exit 1
STUB
chmod +x "$BOX/bin/stat"
got="$(PATH="$BOX/bin:$PATH" file_mtime "$fresh")"
if [ "$got" = "$truth" ]; then
  pass "GNU-like stat: falls through to -c and returns the real mtime"
else
  fail "GNU-like stat: falls through to -c and returns the real mtime" "$truth" "[$got]"
fi

# The same, but the wrong-spelling call exits 0 while printing a filesystem
# report. This is what makes the all-digits check load-bearing rather than
# decorative: an implementation trusting the exit code alone hands that blob
# back as if it were a timestamp.
cat > "$BOX/bin/stat" <<'STUB'
#!/bin/bash
if [ "$1" = "-c" ]; then
  python3 -c 'import os,sys; print(int(os.stat(sys.argv[1]).st_mtime))' "$3"
  exit 0
fi
echo "Blocks: Total: 121938 Free: 60469"
exit 0
STUB
chmod +x "$BOX/bin/stat"
got="$(PATH="$BOX/bin:$PATH" file_mtime "$fresh")"
if [ "$got" = "$truth" ]; then
  pass "wrong spelling exits 0 with a non-numeric blob: rejected, not returned"
else
  fail "wrong spelling exits 0 with a non-numeric blob: rejected, not returned" "$truth" "[$got]"
fi

# --- the test seam itself -----------------------------------------------------
got="$(PORTABLE_STAT_DISABLE="bsd gnu" file_mtime "$fresh")"
if [ "$got" = "0" ]; then
  pass "both spellings disabled: 0, never an invented timestamp"
else
  fail "both spellings disabled: 0, never an invented timestamp" "0" "[$got]"
fi

# --- the four converted call sites still go through the helper ---------------
# Structural, deliberately: these live inside long-running guards with real side
# effects, so the durable assertion is that none of them re-grows its own copy.
for f in scripts/watchdog.sh scripts/stuck-modal-guard.sh scripts/host-restart-watchdog.sh; do
  if grep -q '^\. "\$INSTALL_DIR/scripts/lib/portable-stat.sh"' "$INSTALL_DIR/$f" \
     && grep -q 'file_mtime "' "$INSTALL_DIR/$f"; then
    pass "$f sources the shared helper and uses it"
  else
    fail "$f sources the shared helper and uses it" "a source line and a file_mtime call" "missing one"
  fi
done

# --- the guard: no new single-spelling mtime ---------------------------------
# Every tracked *.sh is scanned with comments stripped. A line is acceptable if
# it spells BOTH forms (a self-contained dual-form one-liner). Anything else has
# to be listed here, with a reason -- so adding one is a decision somebody makes
# on purpose, not a habit that spreads.
#
# scripts/__tests__/ is excluded: a test of this helper must be free to write
# both spellings, including inside stubs.
allowed_file() {
  case "$1" in
    scripts/lib/portable-stat.sh) return 0 ;;  # the one implementation
    scripts/__tests__/*)          return 0 ;;  # stubs and fixtures, see above
    scripts/doctor.sh)            return 0 ;;  # picks the spelling from `uname -s` explicitly
    *) return 1 ;;
  esac
}

offenders=""
while IFS= read -r f; do
  allowed_file "$f" && continue
  [ -f "$INSTALL_DIR/$f" ] || continue
  while IFS= read -r line; do
    case "$line" in \#*) continue ;; esac
    case "$line" in *"stat -c"*|*"stat -f"*) : ;; *) continue ;; esac
    case "$line" in *"stat -c"*) has_c=1 ;; *) has_c=0 ;; esac
    case "$line" in *"stat -f"*) has_f=1 ;; *) has_f=0 ;; esac
    [ "$has_c" = 1 ] && [ "$has_f" = 1 ] && continue   # dual-form one-liner
    offenders="$offenders
    $f: $(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
  done < <(sed 's/^[[:space:]]*//' "$INSTALL_DIR/$f")
done < <(cd "$INSTALL_DIR" && git ls-files '*.sh' 2>/dev/null)

if [ -z "$offenders" ]; then
  pass "no tracked *.sh spells mtime a single way outside the allowlist"
else
  fail "no tracked *.sh spells mtime a single way outside the allowlist" \
       "file_mtime from scripts/lib/portable-stat.sh" "$offenders"
fi

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
