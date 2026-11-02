#!/bin/bash
# Edge cases of the helper plists' PATH, on top of helper-plist-path.test.sh.
# Run: bash scripts/__tests__/helper-path-edge.test.sh
#
# A dir with a space, $, backslash, # or a doubled slash is valid in a PATH value and
# in the plist, so it goes in front as it is. A control character (tab, CR, newline)
# cannot, so the fixed list stays. A tmux that is not executable, a directory called
# tmux (a lookup answering with either is simulated here; bash 3.2 was not measured),
# a relative hit and an empty or relative PATH element must never put a dir in front.
#
# Hermetic: a throwaway HOME; the installers run with uname / launchctl stubs.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

stub_tmux() { mkdir -p "$1"; printf '#!/bin/sh\nexit 0\n' > "$1/tmux"; chmod +x "$1/tmux"; }

. "$REPO/scripts/lib/helper-path.sh"

echo "dirs that are valid in a PATH value go in front as they are"
assert_eq "E1 a space in the dir" "/Users/a b/.local/bin:$BASE" "$(helper_launchd_path '/Users/a b/.local/bin/tmux' 2>&1)"
assert_eq "E2 a dollar sign in the dir" '/Users/a$x/bin:'"$BASE" "$(helper_launchd_path '/Users/a$x/bin/tmux' 2>&1)"
assert_eq "E3 a backslash in the dir" '/Users/a\b/bin:'"$BASE" "$(helper_launchd_path '/Users/a\b/bin/tmux' 2>&1)"
assert_eq "E4 a hash in the dir" "/Users/a#b/bin:$BASE" "$(helper_launchd_path '/Users/a#b/bin/tmux' 2>&1)"
assert_eq "E5 a doubled slash in the dir" "/a//b:$BASE" "$(helper_launchd_path '/a//b/tmux' 2>&1)"

echo "control characters cannot go in a PATH value"
tab="$(printf '\t')"; cr="$(printf '\r')"; nl="$(printf '\n_')"; nl="${nl%_}"; ctl="$(printf '\001')"
for pair in "tab|/a${tab}b/tmux" "CR|/a${cr}b/tmux" "newline|/a${nl}b/tmux" "SOH|/a${ctl}b/tmux"; do
  name="${pair%%|*}"; arg="${pair#*|}"
  out="$(helper_launchd_path "$arg" 2>"$TMP/err")"
  assert_eq "E6 $name in the dir -> the fixed list" "$BASE" "$out"
  assert_contains "E6 $name says so (HELPER-PATH-ELVETVE)" "$(cat "$TMP/err")" "HELPER-PATH-ELVETVE"
done

echo "what the lookup may answer with"
H="$TMP/e7"; mkdir -p "$H/.local/bin"
printf 'not a program\n' > "$H/.local/bin/tmux"; chmod -x "$H/.local/bin/tmux"
out="$(command() { printf '%s\n' "$H/.local/bin/tmux"; }; HOME="$H" PATH= helper_launchd_path 2>&1)"
assert_eq "E7 a lookup answering with a file that is not executable -> the fixed list" "$BASE" "$out"
H="$TMP/e8"; mkdir -p "$H/.local/bin/tmux"
out="$(command() { printf '%s\n' "$H/.local/bin/tmux"; }; HOME="$H" PATH= helper_launchd_path 2>&1)"
assert_eq "E8 a lookup answering with a directory called tmux -> the fixed list" "$BASE" "$out"
H="$TMP/e9"; stub_tmux "$H/.local/bin"
out="$(command() { printf '%s\n' "$H/.local/bin/tmux"; }; HOME="$H" PATH= helper_launchd_path 2>&1)"
assert_eq "E9 (control) the same lookup with an executable file -> its dir in front" "$H/.local/bin:$BASE" "$out"

echo "an empty or relative PATH element does not find a tmux in the working dir"
H="$TMP/e10"; mkdir -p "$H/work/rel/bin"; stub_tmux "$H/work"; stub_tmux "$H/work/rel/bin"
out="$(cd "$H/work" && HOME="$H/none" PATH=":/nonexistent" helper_launchd_path 2>&1)"
assert_eq "E10 an empty PATH element, tmux in the working dir -> the fixed list" "$BASE" "$out"
out="$(cd "$H/work" && HOME="$H/none" PATH="rel/bin:/nonexistent" helper_launchd_path 2>&1)"
assert_eq "E11 a relative PATH element -> the fixed list" "$BASE" "$out"

echo "no HOME at all"
out="$(set -u; unset HOME; PATH= helper_launchd_path 2>&1; echo "rc=$?")"
assert_eq "E12 HOME unset under set -u -> the fixed list, rc 0" "$BASE
rc=0" "$out"

echo "the installers with an awkward HOME"
printf '#!/bin/sh\necho Darwin\n' > "$TMP/uname"; chmod +x "$TMP/uname"
printf '#!/bin/sh\nexit 0\n' > "$TMP/launchctl"; chmod +x "$TMP/launchctl"
SYS="$TMP/sys"; mkdir -p "$SYS"
for t in bash sh dirname basename mkdir cat id grep sed cut tr head tail rm mv cp ls env awk find wc sort date chmod readlink; do
  p="$(PATH=/usr/bin:/bin command -v "$t" 2>/dev/null || true)"
  [ -n "$p" ] && ln -s "$p" "$SYS/$t"
done
cp "$TMP/uname" "$TMP/launchctl" "$SYS/"
for INST in install-channel-keepalive-probe.sh install-main-inbox-observer.sh; do
  H="$TMP/e13 sp"'$x#b'"-$INST"; stub_tmux "$H/.local/bin"
  printf 'SERVICE_ID=hpe\n' > "$TMP/.env"
  HOME="$H" PATH="$SYS" MARVEEN_ENV_FILE="$TMP/.env" /bin/bash "$REPO/scripts/$INST" >"$TMP/out" 2>&1
  p="$(find "$H/Library/LaunchAgents" -name '*.plist' 2>/dev/null | head -1)"
  got="$(python3 -c "import plistlib,sys; print(plistlib.load(open(sys.argv[1],'rb'))['EnvironmentVariables']['PATH'])" "$p" 2>&1)"
  assert_eq "E13 $INST: the plist parses and its PATH starts with the awkward dir" "$H/.local/bin:$BASE" "$got"
done

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
