#!/bin/bash
# Contract tests for the main-agent inbox observer's INSTALLATION.
# Run: bash scripts/__tests__/main-inbox-observer-install.test.sh
#
# The defect being locked out is the one the observer's own header names about
# an unscheduled watchdog script, one level up: the repo shipped the observer
# and its units, and NOTHING installed them -- so on a real host the queue was
# still watched only from inside the dashboard process, which is the process
# whose death the observer exists to survive. A probe nobody schedules is not a
# probe.
#
# Three installation paths, so three contracts:
#   1. install-macos.sh runs the launchd installer on a fresh macOS install,
#   2. install-linux.sh writes AND enables the systemd pair on a fresh host,
#   3. update.sh reaches the machines that already exist -- on both platforms.
# Plus the guard that keeps path 1 from pretending to work on path 2's OS.
#
# Hermetic: update.sh's function is extracted and run against a throwaway units
# dir with `systemctl` and `uname` stubs on PATH, so nothing on this machine is
# enabled, loaded or written outside the temp dir.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) fail "$1 (unexpected '$3')" ;; *) pass "$1" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# 1. install-macos.sh -- the launchd path on a fresh install.
# ---------------------------------------------------------------------------
echo "install-macos.sh"
MACOS="$(cat "$REPO/install-macos.sh")"
assert_contains "runs the observer installer" "$MACOS" 'scripts/install-main-inbox-observer.sh" --load'
assert_contains "guards on the installer being present" "$MACOS" '[ -x "$INSTALL_DIR/scripts/install-main-inbox-observer.sh" ]'
# Non-fatal, like the keepalive probe next to it: a failed observer install must
# not take the whole installation down with it.
assert_contains "a failure warns instead of aborting" "$MACOS" 'inbox-figyelo telepitese nem sikerult'
echo ""

# ---------------------------------------------------------------------------
# 2. install-linux.sh -- the systemd pair on a fresh host. Grep-level: the
#    installer is not runnable here, but "written but never enabled" is exactly
#    the bug under test, so the enable list is asserted separately.
# ---------------------------------------------------------------------------
echo "install-linux.sh"
LINUX="$(cat "$REPO/install-linux.sh")"
assert_contains "writes the observer .service unit" "$LINUX" 'cat >"$SYSTEMD_DIR/${INBOX_OBSERVER_UNIT}.service"'
assert_contains "writes the observer .timer unit" "$LINUX" 'cat >"$SYSTEMD_DIR/${INBOX_OBSERVER_UNIT}.timer"'
assert_contains "ExecStart points at the observer" "$LINUX" 'ExecStart=$INSTALL_DIR/scripts/main-inbox-observer.sh'

ENABLE_LINE="$(grep -n 'systemctl --user enable "\${DASH_UNIT}"' "$REPO/install-linux.sh" | head -1)"
assert_contains "the observer timer is in the enable list" "$ENABLE_LINE" '${INBOX_OBSERVER_UNIT}.timer'

# The printed manual-fix command must name every unit the enable covered. A
# command that silently drops one leaves it disabled while the operator sees a
# fix that looks complete.
FIX_LINES="$(grep 'DIM}    ' "$REPO/install-linux.sh")"
assert_contains "the manual-fix hint names the observer timer too" "$FIX_LINES" '${INBOX_OBSERVER_UNIT}.timer'

OBS_TIMER_BLOCK="$(awk '/cat >"\$SYSTEMD_DIR\/\$\{INBOX_OBSERVER_UNIT\}\.timer"/,/^EOF$/' "$REPO/install-linux.sh")"
assert_not_contains "observer timer has no Requires=" "$OBS_TIMER_BLOCK" "Requires="
assert_not_contains "observer timer has no Wants=" "$OBS_TIMER_BLOCK" "Wants="
assert_contains "5-minute cadence, six ticks inside the stall threshold" "$OBS_TIMER_BLOCK" "OnUnitActiveSec=5min"
echo ""

# ---------------------------------------------------------------------------
# 3. update.sh -- the machines that already exist.
# ---------------------------------------------------------------------------
echo "update.sh install_main_inbox_observer_unit"

FN="$(awk '/^install_main_inbox_observer_unit\(\) \{/,/^\}$/' "$REPO/update.sh")"
if [ -z "$FN" ]; then
  fail "install_main_inbox_observer_unit() not found in update.sh"
  echo; echo "PASS=$PASS FAIL=$FAIL"; exit 1
fi
assert_contains "update.sh calls it during unit maintenance" \
  "$(awk '/^run_unit_maintenance\(\) \{/,/^\}$/' "$REPO/update.sh")" "install_main_inbox_observer_unit"

FAKE_INSTALL="$TMP/install"
mkdir -p "$FAKE_INSTALL/scripts" "$FAKE_INSTALL/store" "$TMP/bin" "$TMP/home"
printf '#!/bin/bash\nexit 0\n' > "$FAKE_INSTALL/scripts/main-inbox-observer.sh"
chmod +x "$FAKE_INSTALL/scripts/main-inbox-observer.sh"
printf 'BOT_NAME=TESTBOT\n' > "$FAKE_INSTALL/.env"

cat > "$TMP/bin/systemctl" <<EOF
#!/bin/bash
echo "\$*" >> "$TMP/systemctl.calls"
exit 0
EOF
chmod +x "$TMP/bin/systemctl"

# uname stub: the function branches on it, so the platform under test is chosen
# here instead of by whatever machine happens to run the suite.
make_uname() {
  cat > "$TMP/bin/uname" <<EOF
#!/bin/bash
[ "\${1:-}" = "-s" ] && echo "$1" && exit 0
echo "$1"
EOF
  chmod +x "$TMP/bin/uname"
}

run_fn() {
  PATH="$TMP/bin:$PATH" INSTALL_DIR="$FAKE_INSTALL" HOME="$TMP/home" \
    bash -c "set -u; INSTALL_DIR='$FAKE_INSTALL'; $FN
install_main_inbox_observer_unit '$1'" 2>&1
}

UNITS="$TMP/units"
mkdir -p "$UNITS"
make_uname Linux

# 3a. No channels unit -> nothing to extend.
run_fn "$UNITS" >/dev/null
assert_eq "no channels unit -> no observer units written" "0" "$(ls "$UNITS" | wc -l | tr -d ' ')"

# 3b. A real host: the id comes from the unit on disk.
printf '[Service]\n' > "$UNITS/hex-channels.service"
OUT="$(run_fn "$UNITS")"
assert_eq "observer .service written next to the channels unit" "yes" \
  "$([ -f "$UNITS/hex-main-inbox-observer.service" ] && echo yes || echo no)"
assert_eq "observer .timer written" "yes" \
  "$([ -f "$UNITS/hex-main-inbox-observer.timer" ] && echo yes || echo no)"
assert_contains "the timer was enabled AND started" "$(cat "$TMP/systemctl.calls")" \
  "--user enable --now hex-main-inbox-observer.timer"
assert_contains "ExecStart points at the observer" "$(cat "$UNITS/hex-main-inbox-observer.service")" \
  "ExecStart=$FAKE_INSTALL/scripts/main-inbox-observer.sh"
# The shipped units under scripts/systemd/ are placeholder templates. The unit
# that lands on a host must carry the REAL paths, or it fails at first fire.
assert_not_contains "no placeholder path survives into the written unit" \
  "$(cat "$UNITS/hex-main-inbox-observer.service")" "/path/to/marveen"
assert_not_contains "no placeholder user survives into the written unit" \
  "$(cat "$UNITS/hex-main-inbox-observer.service")" "/home/USER"
assert_contains "Description carries BOT_NAME from .env" \
  "$(cat "$UNITS/hex-main-inbox-observer.service")" "TESTBOT"
assert_contains "5-minute cadence" "$(cat "$UNITS/hex-main-inbox-observer.timer")" "OnUnitActiveSec=5min"
assert_not_contains "no Requires= on the triggered service" \
  "$(cat "$UNITS/hex-main-inbox-observer.timer")" "Requires="
assert_contains "reports what it did" "$OUT" "hex-main-inbox-observer.timer"

# 3c. Idempotent: update.sh runs on every check.
: > "$TMP/systemctl.calls"
OUT="$(run_fn "$UNITS")"
assert_eq "second run calls no systemctl" "0" "$(wc -c < "$TMP/systemctl.calls" | tr -d ' ')"
assert_eq "second run prints nothing" "" "$OUT"

# 3d. A second agent on the same host gets its own timer.
printf '[Service]\n' > "$UNITS/marveen-channels.service"
run_fn "$UNITS" >/dev/null
assert_eq "second agent gets its own observer timer" "yes" \
  "$([ -f "$UNITS/marveen-main-inbox-observer.timer" ] && echo yes || echo no)"

# 3e. macOS: the same function must reach the launchd path instead, or every
#     existing mac install stays exactly as broken as before.
make_uname Darwin
: > "$TMP/systemctl.calls"
cat > "$FAKE_INSTALL/scripts/install-main-inbox-observer.sh" <<EOF
#!/bin/bash
echo "\$*" >> "$TMP/launchd.calls"
exit 0
EOF
chmod +x "$FAKE_INSTALL/scripts/install-main-inbox-observer.sh"
UNITS_MAC="$TMP/units-mac"; mkdir -p "$UNITS_MAC"
printf '[Service]\n' > "$UNITS_MAC/hex-channels.service"
OUT="$(run_fn "$UNITS_MAC")"
assert_contains "on Darwin the launchd installer is run with --load" "$(cat "$TMP/launchd.calls" 2>/dev/null)" "--load"
assert_eq "on Darwin no systemd unit is written" "1" "$(ls "$UNITS_MAC" | wc -l | tr -d ' ')"
assert_eq "on Darwin systemctl is never called" "0" "$(wc -c < "$TMP/systemctl.calls" | tr -d ' ')"

# 3f. An install predating the observer -> write nothing rather than enabling a
#     unit whose ExecStart does not exist.
make_uname Linux
rm -f "$FAKE_INSTALL/scripts/main-inbox-observer.sh"
UNITS2="$TMP/units2"; mkdir -p "$UNITS2"
printf '[Service]\n' > "$UNITS2/hex-channels.service"
run_fn "$UNITS2" >/dev/null
assert_eq "missing observer script -> no units written" "1" "$(ls "$UNITS2" | wc -l | tr -d ' ')"
echo ""

# ---------------------------------------------------------------------------
# 4. The launchd installer's OS guard. Without it a Linux run created
#    ~/Library/LaunchAgents, wrote a plist nothing reads, and exited 0 -- a
#    green install with no observer, which is worse than a loud failure.
# ---------------------------------------------------------------------------
echo "install-main-inbox-observer.sh OS guard"
FAKE_HOME="$TMP/guard-home"; mkdir -p "$FAKE_HOME"
make_uname Linux
OUT="$(PATH="$TMP/bin:$PATH" HOME="$FAKE_HOME" bash "$REPO/scripts/install-main-inbox-observer.sh" 2>&1)"; RC=$?
assert_eq "a non-Darwin run FAILS instead of reporting success" "1" "$RC"
assert_contains "and it names the systemd twin" "$OUT" "systemd"
assert_eq "and writes no plist" "0" \
  "$(find "$FAKE_HOME" -name '*.plist' 2>/dev/null | wc -l | tr -d ' ')"
echo ""

echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
