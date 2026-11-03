#!/bin/bash
# The PATH of the periodic helper plists.
# Run: bash scripts/__tests__/helper-plist-path.test.sh
#
# Bug being locked out (measured on a macOS install whose tmux lives only in
# ~/.local/bin): install-channel-keepalive-probe.sh and install-main-inbox-observer.sh
# wrote a fixed PATH (/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin) into their
# plists, so the probe's `command -v tmux` found nothing ("tmux not on PATH"), the
# keepalive never advanced, and the stale alarm respawned a healthy session. The
# channels/dashboard plists already carry ~/.local/bin.
#
# Contract: the dir tmux was found in goes in front of the fixed list; a tmux in a
# listed dir (brew, /usr/bin) or no tmux at all leaves the plist byte-identical.
#
# Hermetic: the installers run against a throwaway HOME, a PATH of symlinked
# system tools WITHOUT tmux, and uname / launchctl stubs; nothing is loaded.

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

# A PATH with the tools the installers use, and no tmux in it.
SYS="$TMP/sys"; mkdir -p "$SYS"
for t in bash sh dirname basename mkdir cat id grep sed cut tr head tail rm mv cp ls env awk find wc sort date chmod readlink; do
  p="$(PATH=/usr/bin:/bin command -v "$t" 2>/dev/null || true)"
  [ -n "$p" ] && ln -s "$p" "$SYS/$t"
done
printf '#!/bin/sh\necho Darwin\n' > "$SYS/uname"; chmod +x "$SYS/uname"
printf '#!/bin/sh\nexit 0\n' > "$SYS/launchctl"; chmod +x "$SYS/launchctl"
[ -e "$SYS/tmux" ] && fail "the tool dir must not hold tmux"

stub_tmux() { mkdir -p "$1"; printf '#!/bin/sh\nexit 0\n' > "$1/tmux"; chmod +x "$1/tmux"; }

# run_installer <installer> <home> <PATH> -- the PATH value written into the plist
run_installer() {
  printf 'SERVICE_ID=hpt\n' > "$TMP/.env"
  rm -rf "$2/Library/LaunchAgents"
  HOME="$2" PATH="$3" MARVEEN_ENV_FILE="$TMP/.env" /bin/bash "$REPO/scripts/$1" >"$TMP/out" 2>&1 || { echo "RC-HIBA $(cat "$TMP/out")"; return; }
  p="$(find "$2/Library/LaunchAgents" -name '*.plist' 2>/dev/null | head -1)"
  [ -n "$p" ] || { echo "NINCS-PLIST"; return; }
  cp "$p" "$TMP/last.plist"
  grep -A1 '<key>PATH</key>' "$p" | tail -1 | sed -E 's#.*<string>(.*)</string>.*#\1#'
}

for INST in install-channel-keepalive-probe.sh install-main-inbox-observer.sh; do
  echo "$INST"

  # P1: tmux only in ~/.local/bin, which is NOT on the installer's PATH (a non-interactive SSH install)
  H="$TMP/p1-$INST"; stub_tmux "$H/.local/bin"
  assert_eq "P1 tmux in ~/.local/bin (not on PATH) -> its dir in front of the fixed list" "$H/.local/bin:$BASE" "$(run_installer "$INST" "$H" "$SYS")"
  if python3 -c "import plistlib,sys; plistlib.load(open(sys.argv[1],'rb'))" "$TMP/last.plist" 2>/dev/null; then
    pass "P1b the written plist parses"
  else
    fail "P1b the written plist parses"
  fi

  # P2: ~/.local/bin on PATH
  H="$TMP/p2-$INST"; stub_tmux "$H/.local/bin"
  assert_eq "P2 tmux in ~/.local/bin on PATH -> its dir in front" "$H/.local/bin:$BASE" "$(run_installer "$INST" "$H" "$H/.local/bin:$SYS")"

  # P3 (INVARIANS): no tmux anywhere -> the fixed list, byte for byte
  H="$TMP/p3-$INST"; mkdir -p "$H"
  assert_eq "P3 INVARIANS no tmux -> the fixed list unchanged" "$BASE" "$(run_installer "$INST" "$H" "$SYS")"

  # P4: tmux in any other dir on PATH -> that dir in front (the dir it was FOUND in, not a guess)
  H="$TMP/p4-$INST"; mkdir -p "$H"; stub_tmux "$TMP/opt-tmux-$INST/bin"
  assert_eq "P4 tmux in another PATH dir -> that dir in front" "$TMP/opt-tmux-$INST/bin:$BASE" \
    "$(run_installer "$INST" "$H" "$TMP/opt-tmux-$INST/bin:$SYS")"
done

echo "scripts/lib/helper-path.sh"
if [ ! -f "$REPO/scripts/lib/helper-path.sh" ]; then
  fail "U0 scripts/lib/helper-path.sh exists"
else
  pass "U0 scripts/lib/helper-path.sh exists"
  . "$REPO/scripts/lib/helper-path.sh"
  assert_eq "U1 INVARIANS brew tmux (/opt/homebrew/bin) -> unchanged" "$BASE" "$(helper_launchd_path /opt/homebrew/bin/tmux)"
  assert_eq "U2 INVARIANS /usr/local/bin/tmux -> unchanged" "$BASE" "$(helper_launchd_path /usr/local/bin/tmux)"
  assert_eq "U3 INVARIANS /usr/bin/tmux -> unchanged" "$BASE" "$(helper_launchd_path /usr/bin/tmux)"
  assert_eq "U4 ~/.local/bin/tmux -> its dir in front" "/Users/x/.local/bin:$BASE" "$(helper_launchd_path /Users/x/.local/bin/tmux)"
  assert_eq "U5 a relative hit -> unchanged" "$BASE" "$(helper_launchd_path relativ/tmux 2>/dev/null)"
  for bad in "/a:b/tmux" "/a<b/tmux" "/a&b/tmux" '/a"b/tmux'; do
    out="$(helper_launchd_path "$bad" 2>"$TMP/err")"
    assert_eq "U6 an unusable dir ($bad) -> unchanged" "$BASE" "$out"
    assert_contains "U6 and says so (HELPER-PATH-ELVETVE)" "$(cat "$TMP/err")" "HELPER-PATH-ELVETVE"
  done
  H="$TMP/u7"; stub_tmux "$H/.local/bin"
  assert_eq "U7 an empty PATH (builtins only) still finds ~/.local/bin/tmux" "$H/.local/bin:$BASE" \
    "$(HOME="$H" PATH= helper_launchd_path)"
fi

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
