#!/bin/bash
# PATHDIROWNER1120: a learned dir (the dir tmux was found in, the custom Homebrew prefix bin)
# goes in FRONT of a helper plist's PATH, so whoever can write it decides what the job runs.
# scripts/lib/helper-path.sh learns it only when it is a real directory (not a symlink),
# owned by the installing user or root, and writable by neither the group nor others;
# otherwise it is left out and the installer says on stderr which dir and why.
# Run: bash scripts/__tests__/helper-path-dir-owner.test.sh
#
# Hermetic: throwaway dirs only; nothing is installed or loaded.

set -u
umask 022

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3' in '$2')" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
BASE="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

. "$REPO/scripts/lib/helper-path.sh"

# learn DIR -> prints "<learned>|<stderr>"
learn() {
  _hlp_learned=""
  _err="$(_helper_path_learn "$1" "the dir $1" 2>&1 >/dev/null)"
  _helper_path_learn "$1" "the dir $1" 2>/dev/null
  printf '%s|%s' "$_hlp_learned" "$_err"
}

mkdir -p "$TMP/ok" "$TMP/gw" "$TMP/ow" "$TMP/real"
chmod 755 "$TMP/ok" "$TMP/real"
chmod 775 "$TMP/gw"
chmod 757 "$TMP/ow"
ln -s "$TMP/real" "$TMP/link"

echo "the rule, dir by dir"
assert_eq "D1 own dir, 0755 -> learned, silent" "$TMP/ok:|" "$(learn "$TMP/ok")"
out="$(learn "$TMP/gw")"
assert_eq "D2 group-writable -> left out" "|" "${out%%|*}|"
assert_contains "D2 says which dir and why" "$out" "HELPER-PATH-ELVETVE: the dir $TMP/gw is group-writable"
out="$(learn "$TMP/ow")"
assert_eq "D3 writable by others -> left out" "|" "${out%%|*}|"
assert_contains "D3 says which dir and why" "$out" "HELPER-PATH-ELVETVE: the dir $TMP/ow is writable by others"
out="$(learn "$TMP/link")"
assert_eq "D4 a symlink (to an own 0755 dir) -> left out" "|" "${out%%|*}|"
assert_contains "D4 says which dir and why" "$out" "HELPER-PATH-ELVETVE: the dir $TMP/link is a symlink"
out="$(learn "$TMP/missing")"
assert_eq "D5 not there -> left out" "|" "${out%%|*}|"
assert_contains "D5 says which dir and why" "$out" "is not a directory"
assert_eq "D6 root-owned 0755 (/usr/sbin) -> learned" "/usr/sbin:|" "$(learn /usr/sbin)"

# D7: a dir owned by neither us nor root. No such dir can be made without root, so take
# one the system has: not a symlink, not group- or other-writable (else D2/D3 would decide).
FOREIGN="$(/usr/bin/find /var /usr /opt /private/var -maxdepth 3 -type d ! -user 0 ! -user "$EUID" \
  ! -perm -020 ! -perm -002 2>/dev/null | head -1)"
if [ -n "$FOREIGN" ]; then
  out="$(learn "$FOREIGN")"
  assert_eq "D7 owned by another user ($FOREIGN) -> left out" "|" "${out%%|*}|"
  assert_contains "D7 says which dir and why" "$out" "is owned by neither the installing user nor root"
else
  echo "  SKIP: D7 no dir owned by another non-root user found on this machine"
fi

echo "under an empty PATH (builtins only) the check still works"
got="$(PATH="" ; learn "$TMP/ok")"
assert_eq "D8 own 0755 dir learned with PATH empty" "$TMP/ok:|" "$got"
got="$(PATH="" ; learn "$TMP/gw")"
assert_eq "D9 group-writable still left out with PATH empty" "|" "${got%%|*}|"

echo "through helper_launchd_path"
mkdir -p "$TMP/gwtmux"; chmod 775 "$TMP/gwtmux"
printf '#!/bin/sh\nexit 0\n' > "$TMP/gwtmux/tmux"; chmod 755 "$TMP/gwtmux/tmux"
assert_eq "P1 tmux in a group-writable dir -> the fixed list, byte for byte" "$BASE" \
  "$(helper_launchd_path "$TMP/gwtmux/tmux" 2>/dev/null)"
assert_contains "P1 the installer says so" "$(helper_launchd_path "$TMP/gwtmux/tmux" 2>&1 >/dev/null)" \
  "HELPER-PATH-ELVETVE: the dir of $TMP/gwtmux/tmux is group-writable"
# a custom Homebrew prefix whose bin is group-writable: the keg rule finds it, the check drops it
mkdir -p "$TMP/brew/opt/node@22/bin" "$TMP/brew/bin"; chmod 775 "$TMP/brew/bin"
got="$(PATH="$TMP/brew/opt/node@22/bin:/usr/bin:/bin" helper_launchd_path /usr/bin/tmux 2>&1)"
assert_contains "P2 group-writable prefix bin -> said" "$got" \
  "HELPER-PATH-ELVETVE: the Homebrew prefix bin $TMP/brew/bin is group-writable"
assert_eq "P2 group-writable prefix bin -> not in the PATH" "$BASE" "$(printf '%s\n' "$got" | tail -1)"
chmod 755 "$TMP/brew/bin"
assert_eq "P3 (control) the same prefix bin at 0755 -> in front" "$TMP/brew/bin:$BASE" \
  "$(PATH="$TMP/brew/opt/node@22/bin:/usr/bin:/bin" helper_launchd_path /usr/bin/tmux 2>&1)"

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
