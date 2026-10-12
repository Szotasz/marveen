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

# ---------------------------------------------------------------------------
# 3. update.sh, macOS half (KEEPALIVEMAC926). The Linux migration above landed
#    for #1313; the launchd twin only ever existed in the install-macos.sh
#    TEMPLATE, which by definition never reaches a Mac installed before it. So
#    every such Mac kept the bug, and the weekly update could not cure it.
#    Measured 2026-09-26: launchctl had no com.marveen.channel-keepalive-probe
#    and channels-failures.log showed respawns only between 22:00 and 07:00,
#    every ~15 minutes, zero during the day.
# ---------------------------------------------------------------------------
echo
echo "update.sh install_keepalive_probe_launchd"

MACFN="$(awk '/^install_keepalive_probe_launchd\(\) \{/,/^\}$/' "$REPO/update.sh")"
if [ -z "$MACFN" ]; then
  fail "install_keepalive_probe_launchd() not found in update.sh"
  echo; echo "PASS=$PASS FAIL=$FAIL"; exit 1
fi

assert_contains "run_unit_maintenance calls the launchd half" \
  "$(awk '/^run_unit_maintenance\(\) \{/,/^\}$/' "$REPO/update.sh")" \
  "install_keepalive_probe_launchd"

MAC="$TMP/mac"
mkdir -p "$MAC/install/scripts" "$MAC/home/Library/LaunchAgents" "$MAC/bin"

# launchctl stub: its mere presence is the command -v gate; it is never the
# thing under test (the real installer does the loading).
printf '#!/bin/bash\nexit 0\n' > "$MAC/bin/launchctl"; chmod +x "$MAC/bin/launchctl"

# Installer stub: records the call, and writes the plist the way the real one
# does, so the idempotence contract is exercised end to end.
write_mac_installer() {
  cat > "$MAC/install/scripts/install-channel-keepalive-probe.sh" <<EOF
#!/bin/bash
LABEL="$1"
echo "\$*" >> "$MAC/installer.calls"
mkdir -p "\$HOME/Library/LaunchAgents"
: > "\$HOME/Library/LaunchAgents/$1.plist"
exit ${2:-0}
EOF
  chmod +x "$MAC/install/scripts/install-channel-keepalive-probe.sh"
}

# $1: what `uname -s` should say.
run_mac_fn() {
  printf '#!/bin/bash\necho %s\n' "$1" > "$MAC/bin/uname"; chmod +x "$MAC/bin/uname"
  PATH="$MAC/bin:$PATH" HOME="$MAC/home" \
    bash -c "set -eu; INSTALL_DIR='$MAC/install'; $MACFN
install_keepalive_probe_launchd" 2>&1
}

# 3a. Not a Mac -> the Linux path already owns this host, touch nothing.
write_mac_installer "com.marveen.channel-keepalive-probe"
: > "$MAC/installer.calls"
OUT="$(run_mac_fn Linux)"
assert_eq "non-Darwin host -> installer never called" "0" "$(wc -c < "$MAC/installer.calls" | tr -d ' ')"
assert_eq "non-Darwin host -> prints nothing" "" "$OUT"

# 3b. A Mac missing the probe: install it and say so.
OUT="$(run_mac_fn Darwin)"
assert_contains "installer called with --load" "$(cat "$MAC/installer.calls")" "--load"
assert_eq "plist landed in ~/Library/LaunchAgents" "yes" \
  "$([ -f "$MAC/home/Library/LaunchAgents/com.marveen.channel-keepalive-probe.plist" ] && echo yes || echo no)"
assert_contains "reports what it did" "$OUT" "com.marveen.channel-keepalive-probe"

# 3c. Idempotent: update.sh runs weekly, and a reload every week is not a fix.
: > "$MAC/installer.calls"
OUT="$(run_mac_fn Darwin)"
assert_eq "second run calls no installer" "0" "$(wc -c < "$MAC/installer.calls" | tr -d ' ')"
assert_eq "second run prints nothing" "" "$OUT"

# 3d. Rename drift: the idempotence check must read the label FROM the
#     installer. A hardcoded label would miss the existing plist and reload
#     launchd on every single update -- silently, forever.
write_mac_installer "com.renamed.keepalive-probe"
: > "$MAC/installer.calls"
run_mac_fn Darwin >/dev/null
: > "$MAC/installer.calls"
OUT="$(run_mac_fn Darwin)"
assert_eq "renamed label is honoured on the idempotence check" "0" \
  "$(wc -c < "$MAC/installer.calls" | tr -d ' ')"

# 3e. An install predating the installer script -> do nothing rather than fail
#     the whole update.
rm -f "$MAC/install/scripts/install-channel-keepalive-probe.sh"
rm -f "$MAC/home/Library/LaunchAgents/"*.plist
: > "$MAC/installer.calls"
OUT="$(run_mac_fn Darwin)"
assert_eq "missing installer -> nothing written" "0" \
  "$(ls "$MAC/home/Library/LaunchAgents" | wc -l | tr -d ' ')"
assert_eq "missing installer -> update is not failed" "" "$OUT"

# 3f. A failing installer must WARN, not pass silently.
write_mac_installer "com.marveen.channel-keepalive-probe" 1
rm -f "$MAC/home/Library/LaunchAgents/"*.plist
OUT="$(run_mac_fn Darwin)"
assert_contains "a failed install is reported, not swallowed" "$OUT" "FIGYELEM"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
