#!/bin/bash
# Contract tests for the idle-path keepalive probe's INSTALLATION.
# Run: bash scripts/__tests__/keepalive-probe-install.test.sh
#
# Bug being locked out (measured on a live install, night of 2026-09-12/13:
# 13 service restarts, one every ~50 minutes, midnight to morning):
# scripts/channel-keepalive-probe.sh and its placeholder units under
# scripts/systemd/ shipped for weeks, but NOTHING installed them. So the only
# producer of store/.channel-keepalive freshness was organic inbound traffic,
# and a quiet night became indistinguishable from a wedged session: the file
# aged past the dashboard's 45-minute liveness ceiling, channel-monitor
# respawn-paned a healthy main agent (conversation lost, no --continue), that
# killed the telegram plugin, and channels.sh's dead-plugin watchdog exited 181s
# later for a second, whole-unit restart.
#
# Two separate failure modes, so two separate contracts:
#   1. install-linux.sh must WRITE the units and ENABLE the timer (new installs),
#   2. update.sh must install them on ALREADY INSTALLED machines -- the template
#      alone never reaches the hosts that have the bug today.
#
# Hermetic: update.sh's function is extracted and run against a throwaway units
# dir with a `systemctl` stub on PATH, so nothing on this machine is enabled.

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
# 1. install-linux.sh: the template contract (grep-level -- the installer is not
#    runnable here, but a unit nobody enables is the exact bug under test).
# ---------------------------------------------------------------------------
echo "install-linux.sh template"

LINUX="$(cat "$REPO/install-linux.sh")"
assert_contains "writes the probe .service unit" "$LINUX" 'cat >"$SYSTEMD_DIR/${KEEPALIVE_UNIT}.service"'
assert_contains "writes the probe .timer unit" "$LINUX" 'cat >"$SYSTEMD_DIR/${KEEPALIVE_UNIT}.timer"'
assert_contains "ExecStart points at the probe" "$LINUX" 'ExecStart=$INSTALL_DIR/scripts/channel-keepalive-probe.sh'

# The enable line is the whole point: an installed-but-disabled timer produces
# exactly the outage this test exists for.
ENABLE_LINE="$(grep -n 'systemctl --user enable "\${DASH_UNIT}"' "$REPO/install-linux.sh" | head -1)"
assert_contains "the timer is in the enable list" "$ENABLE_LINE" '${KEEPALIVE_UNIT}.timer'

# No Requires=/Wants= on the triggered service (the morning-timer lesson: a
# [Unit] dependency fires the service on every activation of the timer unit).
PROBE_TIMER_BLOCK="$(awk '/cat >"\$SYSTEMD_DIR\/\$\{KEEPALIVE_UNIT\}\.timer"/,/^EOF$/' "$REPO/install-linux.sh")"
assert_not_contains "probe timer has no Requires=" "$PROBE_TIMER_BLOCK" "Requires="
assert_not_contains "probe timer has no Wants=" "$PROBE_TIMER_BLOCK" "Wants="

# ---------------------------------------------------------------------------
# 2. update.sh: the migration onto already-installed hosts.
# ---------------------------------------------------------------------------
echo
echo "update.sh install_keepalive_probe_timer"

# Pull the function out of update.sh and run it for real.
FN="$(awk '/^install_keepalive_probe_timer\(\) \{/,/^\}$/' "$REPO/update.sh")"
if [ -z "$FN" ]; then
  fail "install_keepalive_probe_timer() not found in update.sh"
  echo; echo "PASS=$PASS FAIL=$FAIL"; exit 1
fi

# Throwaway install root: the function requires an executable probe script and
# reads BOT_NAME from .env.
FAKE_INSTALL="$TMP/install"
mkdir -p "$FAKE_INSTALL/scripts" "$FAKE_INSTALL/store" "$TMP/bin"
printf '#!/bin/bash\nexit 0\n' > "$FAKE_INSTALL/scripts/channel-keepalive-probe.sh"
chmod +x "$FAKE_INSTALL/scripts/channel-keepalive-probe.sh"
printf 'BOT_NAME=TESTBOT\n' > "$FAKE_INSTALL/.env"

# systemctl stub: records its arguments instead of touching this machine.
cat > "$TMP/bin/systemctl" <<EOF
#!/bin/bash
echo "\$*" >> "$TMP/systemctl.calls"
exit 0
EOF
chmod +x "$TMP/bin/systemctl"

# $1: units dir. Runs the extracted function with the stub ahead of the real PATH.
run_fn() {
  PATH="$TMP/bin:$PATH" INSTALL_DIR="$FAKE_INSTALL" HOME="$TMP/home" \
    bash -c "set -u; INSTALL_DIR='$FAKE_INSTALL'; $FN
install_keepalive_probe_timer '$1'" 2>&1
}

UNITS="$TMP/units"
mkdir -p "$UNITS" "$TMP/home"

# 2a. No channels unit on the host -> nothing to extend, write nothing.
OUT="$(run_fn "$UNITS")"
assert_eq "no channels unit -> no probe units written" "0" "$(ls "$UNITS" | wc -l | tr -d ' ')"

# 2b. A real install: the id comes from the channels unit, not from .env.
printf '[Service]\n' > "$UNITS/hex-channels.service"
OUT="$(run_fn "$UNITS")"
assert_eq "probe .service written next to the channels unit" "yes" \
  "$([ -f "$UNITS/hex-channel-keepalive-probe.service" ] && echo yes || echo no)"
assert_eq "probe .timer written" "yes" \
  "$([ -f "$UNITS/hex-channel-keepalive-probe.timer" ] && echo yes || echo no)"
assert_contains "the timer was enabled AND started" "$(cat "$TMP/systemctl.calls")" \
  "--user enable --now hex-channel-keepalive-probe.timer"
assert_contains "ExecStart points at the probe" "$(cat "$UNITS/hex-channel-keepalive-probe.service")" \
  "ExecStart=$FAKE_INSTALL/scripts/channel-keepalive-probe.sh"
assert_contains "Description carries BOT_NAME from .env" \
  "$(cat "$UNITS/hex-channel-keepalive-probe.service")" "TESTBOT"
assert_contains "3-minute cadence, well inside every staleness ceiling" \
  "$(cat "$UNITS/hex-channel-keepalive-probe.timer")" "OnUnitActiveSec=3min"
assert_not_contains "no Requires= on the triggered service" \
  "$(cat "$UNITS/hex-channel-keepalive-probe.timer")" "Requires="
assert_contains "reports what it did" "$OUT" "hex-channel-keepalive-probe.timer"

# 2c. Idempotent: update.sh runs on every check, including "nothing to pull".
: > "$TMP/systemctl.calls"
OUT="$(run_fn "$UNITS")"
assert_eq "second run calls no systemctl" "0" "$(wc -c < "$TMP/systemctl.calls" | tr -d ' ')"
assert_eq "second run prints nothing" "" "$OUT"

# 2d. A renamed agent: the timer follows the unit name actually on disk.
printf '[Service]\n' > "$UNITS/marveen-channels.service"
OUT="$(run_fn "$UNITS")"
assert_eq "second agent gets its own probe timer" "yes" \
  "$([ -f "$UNITS/marveen-channel-keepalive-probe.timer" ] && echo yes || echo no)"

# 2e. No probe script (an install predating it) -> write nothing rather than
#     enabling a unit whose ExecStart does not exist.
rm -f "$FAKE_INSTALL/scripts/channel-keepalive-probe.sh"
UNITS2="$TMP/units2"; mkdir -p "$UNITS2"
printf '[Service]\n' > "$UNITS2/hex-channels.service"
run_fn "$UNITS2" >/dev/null
assert_eq "missing probe script -> no units written" "1" "$(ls "$UNITS2" | wc -l | tr -d ' ')"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
