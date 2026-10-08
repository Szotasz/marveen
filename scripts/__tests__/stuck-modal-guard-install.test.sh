#!/bin/bash
# Contract tests for the stuck-modal guard's macOS INSTALLATION (MODELCONFIRM1005).
# Run: bash scripts/__tests__/stuck-modal-guard-install.test.sh
#
# Bug being locked out (measured 2026-10-05 on the Mac mini): the guard only
# ever shipped as a systemd timer, so on macOS nothing ran it. After a /model the
# CLI's "Switch model?" dialog held the main session for half an hour, every
# inbound Telegram message queued behind it, and launchctl had no job of any
# modal guard. Three contracts, as for the keepalive probe:
#   1. the installer writes a valid launchd unit (every 60 s + at load) and
#      touches launchctl only with --load,
#   2. install-macos.sh runs it for new installs,
#   3. update.sh installs it on Macs that are ALREADY installed, once.
#
# Hermetic: HOME is a throwaway dir and launchctl / uname are stubs.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
INSTALLER="$REPO/scripts/install-stuck-modal-guard.sh"

# ---------------------------------------------------------------------------
echo "1. install-stuck-modal-guard.sh"

mkdir -p "$TMP/home" "$TMP/bin"
cat > "$TMP/bin/launchctl" <<EOF
#!/bin/bash
echo "\$*" >> "$TMP/launchctl.calls"
exit 0
EOF
chmod +x "$TMP/bin/launchctl"
: > "$TMP/launchctl.calls"

PLIST="$TMP/home/Library/LaunchAgents/com.marveen.stuck-modal-guard.plist"
PATH="$TMP/bin:$PATH" HOME="$TMP/home" bash "$INSTALLER" >/dev/null 2>&1
assert_eq "the plist is written" "yes" "$([ -f "$PLIST" ] && echo yes || echo no)"
P="$(cat "$PLIST" 2>/dev/null)"
assert_contains "label" "$P" "<string>com.marveen.stuck-modal-guard</string>"
assert_contains "runs the guard of THIS install" "$P" "<string>$REPO/scripts/stuck-modal-guard.sh</string>"
assert_contains "every 60 s, like the systemd timer" "$P" "<key>StartInterval</key>
  <integer>60</integer>"
assert_contains "and once at load" "$P" "<key>RunAtLoad</key>
  <true/>"
assert_contains "Homebrew on PATH (tmux and the claude CLI live there)" "$P" "/opt/homebrew/bin"
assert_eq "without --load launchctl is never touched" "0" "$(wc -c < "$TMP/launchctl.calls" | tr -d ' ')"
if command -v plutil >/dev/null 2>&1; then
  assert_eq "plutil accepts the plist" "0" "$(plutil -lint "$PLIST" >/dev/null 2>&1; echo $?)"
fi
FIRST="$(cat "$PLIST")"
PATH="$TMP/bin:$PATH" HOME="$TMP/home" bash "$INSTALLER" >/dev/null 2>&1
assert_eq "a second run writes the same plist" "$FIRST" "$(cat "$PLIST")"
PATH="$TMP/bin:$PATH" HOME="$TMP/home" bash "$INSTALLER" --load >/dev/null 2>&1
assert_contains "--load loads it" "$(cat "$TMP/launchctl.calls")" "load $PLIST"

# ---------------------------------------------------------------------------
echo
echo "2. install-macos.sh"
assert_contains "new installs run the installer with --load" "$(cat "$REPO/install-macos.sh")" \
  '"$INSTALL_DIR/scripts/install-stuck-modal-guard.sh" --load'

# ---------------------------------------------------------------------------
echo
echo "3. update.sh install_stuck_modal_guard_launchd"

FN="$(awk '/^install_stuck_modal_guard_launchd\(\) \{/,/^\}$/' "$REPO/update.sh")"
if [ -z "$FN" ]; then
  fail "install_stuck_modal_guard_launchd() not found in update.sh"
  echo; echo "PASS=$PASS FAIL=$FAIL"; exit 1
fi
assert_contains "run_unit_maintenance calls it" \
  "$(awk '/^run_unit_maintenance\(\) \{/,/^\}$/' "$REPO/update.sh")" "install_stuck_modal_guard_launchd"

MAC="$TMP/mac"
mkdir -p "$MAC/install/scripts" "$MAC/home/Library/LaunchAgents" "$MAC/bin"
# launchctl stub: `list <label>` answers from $MAC/loaded (the job is loaded iff
# the file names the label); every other call is ignored.
cat > "$MAC/bin/launchctl" <<EOF
#!/bin/bash
if [ "\$1" = list ]; then grep -qxF "\$2" "$MAC/loaded" 2>/dev/null; exit \$?; fi
exit 0
EOF
chmod +x "$MAC/bin/launchctl"
# Installer stub: records the call; with exit 0 it "loads" the job, with
# exit 1 it leaves only the plist behind (a half-finished run).
write_installer() {  # $1 label, $2 exit code
  cat > "$MAC/install/scripts/install-stuck-modal-guard.sh" <<EOF
#!/bin/bash
LABEL="$1"
echo "\$*" >> "$MAC/installer.calls"
mkdir -p "\$HOME/Library/LaunchAgents"
: > "\$HOME/Library/LaunchAgents/$1.plist"
[ "${2:-0}" = 0 ] && echo "$1" >> "$MAC/loaded"
exit ${2:-0}
EOF
  chmod +x "$MAC/install/scripts/install-stuck-modal-guard.sh"
}
run_fn() {
  printf '#!/bin/bash\necho %s\n' "$1" > "$MAC/bin/uname"; chmod +x "$MAC/bin/uname"
  PATH="$MAC/bin:$PATH" HOME="$MAC/home" bash -c "set -eu; INSTALL_DIR='$MAC/install'; $FN
install_stuck_modal_guard_launchd" 2>&1
}
reset_mac() { : > "$MAC/installer.calls"; : > "$MAC/loaded"; rm -f "$MAC/home/Library/LaunchAgents/"*.plist "$MAC/install/.env"; }

reset_mac; write_installer "com.marveen.stuck-modal-guard"
OUT="$(run_fn Linux)"
assert_eq "non-Darwin host -> installer never called" "0" "$(wc -c < "$MAC/installer.calls" | tr -d ' ')"
assert_eq "non-Darwin host -> prints nothing" "" "$OUT"

OUT="$(run_fn Darwin)"
assert_contains "a Mac without the job: installer called with --load" "$(cat "$MAC/installer.calls")" "--load"
assert_contains "and it says so" "$OUT" "com.marveen.stuck-modal-guard"

: > "$MAC/installer.calls"
OUT="$(run_fn Darwin)"
assert_eq "job loaded: the next run calls no installer" "0" "$(wc -c < "$MAC/installer.calls" | tr -d ' ')"
assert_eq "job loaded: the next run prints nothing" "" "$OUT"

# Half-finished run (review): the plist exists but the job never loaded. Keyed on
# the plist, every later run went quiet forever; keyed on the loaded job it is
# retried and reported until it loads.
reset_mac; write_installer "com.marveen.stuck-modal-guard" 1
OUT1="$(run_fn Darwin)"; OUT2="$(run_fn Darwin)"
assert_eq "a failed load leaves the plist behind" "yes" "$([ -f "$MAC/home/Library/LaunchAgents/com.marveen.stuck-modal-guard.plist" ] && echo yes || echo no)"
assert_eq "the next run retries it" "2" "$(grep -c -- --load "$MAC/installer.calls" | tr -d ' ')"
assert_contains "and warns again, not just once" "$OUT2" "FIGYELEM"

# Opt-out that survives updates (review): STUCK_MODAL_MODE=off in .env.
reset_mac; write_installer "com.marveen.stuck-modal-guard"
printf 'MAIN_AGENT_ID=x\nSTUCK_MODAL_MODE=off\n' > "$MAC/install/.env"
OUT="$(run_fn Darwin)"
assert_eq "STUCK_MODAL_MODE=off -> never installed" "0" "$(wc -c < "$MAC/installer.calls" | tr -d ' ')"
assert_eq "STUCK_MODAL_MODE=off -> silent" "" "$OUT"
printf 'STUCK_MODAL_MODE="OFF"\n' > "$MAC/install/.env"
run_fn Darwin >/dev/null
assert_eq "quoted / upper-case OFF counts too" "0" "$(wc -c < "$MAC/installer.calls" | tr -d ' ')"

reset_mac; write_installer "com.renamed.stuck-modal-guard"
run_fn Darwin >/dev/null
assert_contains "the label is read from the installer" "$(cat "$MAC/installer.calls")" "--load"
: > "$MAC/installer.calls"
run_fn Darwin >/dev/null
assert_eq "...and once loaded under that label, stays quiet" "0" "$(wc -c < "$MAC/installer.calls" | tr -d ' ')"

echo
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
