#!/bin/bash
# UPDATETIMER1012 (#1902 follow-up): update.sh starts an existing but inactive
# keepalive-probe / inbox-observer timer, without rewriting its unit.
#
# The two repairs in update.sh used to skip every timer whose unit file already
# existed ("[ -f <unit>.timer ] && continue"). An install whose installer only
# ENABLED the timers (#1902: both fire on OnBootSec, long passed on a host that
# has been up) kept them inactive until the next reboot, and the update never
# cured that.
#
# The functions are extracted from update.sh and run under `set -e` -- update.sh
# runs under it, and a start that fails must not stop the update (the #1903
# review's lesson: a test that never runs the failing start under `set -e`
# cannot see a dropped guard). systemctl and pidof are stateful stubs; nothing
# here touches this machine's systemd.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) fail "$1 (unexpected '$3')" ;; *) pass "$1" ;; esac; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FNS=""
for f in _user_systemd_up ensure_timer_running install_keepalive_probe_timer install_main_inbox_observer_unit; do
  body="$(awk "/^${f}\\(\\) \\{/,/^\\}\$/" "$REPO/update.sh")"
  if [ -z "$body" ]; then
    fail "$f() not found in update.sh"; echo; echo "PASS=$PASS FAIL=$FAIL"; exit 1
  fi
  FNS="$FNS
$body"
done

FAKE_INSTALL="$TMP/install"
mkdir -p "$FAKE_INSTALL/scripts" "$FAKE_INSTALL/store" "$TMP/bin" "$TMP/home"
for s in channel-keepalive-probe.sh main-inbox-observer.sh; do
  printf '#!/bin/bash\nexit 0\n' > "$FAKE_INSTALL/scripts/$s"; chmod +x "$FAKE_INSTALL/scripts/$s"
done
printf 'BOT_NAME=TESTBOT\n' > "$FAKE_INSTALL/.env"
printf '#!/bin/bash\necho Linux\n' > "$TMP/bin/uname"; chmod +x "$TMP/bin/uname"

# State: $ST/active/<unit>, $ST/enabled/<unit>, $ST/masked/<unit>; $ST/fail/<unit>
# makes enable/start of that unit fail; $ST/no-session makes `--user status` fail;
# $ST/no-systemd makes pidof fail. A unit can only start if its file is on disk.
ST="$TMP/state"
cat > "$TMP/bin/systemctl" <<EOF
#!/bin/bash
echo "\$*" >> "$ST/calls"
[ "\$1" = --user ] && shift
cmd="\$1"; shift
case "\$cmd" in
  status) [ -e "$ST/no-session" ] && exit 1; exit 0 ;;
  daemon-reload) exit 0 ;;
  is-active) for u in "\$@"; do :; done; [ -e "$ST/active/\$u" ] ;;
  is-enabled)
    u="\$1"
    if [ -e "$ST/masked/\$u" ]; then echo masked; exit 1; fi
    if [ -e "$ST/masked-runtime/\$u" ]; then echo masked-runtime; exit 1; fi
    if [ -e "$ST/enabled/\$u" ]; then echo enabled; exit 0; fi
    echo disabled; exit 1 ;;
  enable|start)
    now=0; [ "\$cmd" = start ] && now=1
    rc=0
    for u in "\$@"; do
      case "\$u" in --now) now=1; continue ;; esac
      if [ -e "$ST/fail/\$u" ] || [ ! -e "$ST/units/\$u" ] || [ -e "$ST/masked/\$u" ] || [ -e "$ST/masked-runtime/\$u" ]; then
        echo "Failed to \$cmd \$u" >&2; rc=1; continue
      fi
      [ "\$cmd" = enable ] && touch "$ST/enabled/\$u"
      [ "\$now" = 1 ] && touch "$ST/active/\$u"
    done
    exit \$rc ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$TMP/bin/systemctl"
cat > "$TMP/bin/pidof" <<EOF
#!/bin/sh
[ -e "$ST/no-systemd" ] && exit 1
echo 1
EOF
chmod +x "$TMP/bin/pidof"

KA=hex-channel-keepalive-probe.timer
IO=hex-main-inbox-observer.timer

# A host the installer set up: channels unit + both timer pairs on disk, both
# timers enabled, neither running (the #1902 state). $1..: extra setup words.
reset_host() {
  rm -rf "$ST" "$TMP/units"; mkdir -p "$ST/active" "$ST/enabled" "$ST/masked" "$ST/masked-runtime" "$ST/fail" "$ST/units" "$TMP/units"
  : > "$ST/calls"
  printf '[Service]\n' > "$TMP/units/hex-channels.service"
  for u in hex-channel-keepalive-probe hex-main-inbox-observer; do
    printf '[Unit]\nDescription=installed earlier\n' > "$TMP/units/$u.service"
    printf '[Timer]\nOnBootSec=90s\n# installed earlier\n' > "$TMP/units/$u.timer"
    touch "$ST/units/$u.timer" "$ST/enabled/$u.timer"
  done
}
unit_sums() { cat "$TMP/units/"* | shasum | cut -c1-40; }

# Both repairs, in update.sh's order, under set -e; "REACHED-END" proves the
# script did not stop on the way.
run_update() {
  PATH="$TMP/bin:/usr/bin:/bin" INSTALL_DIR="$FAKE_INSTALL" HOME="$TMP/home" \
    bash -c "set -eu; INSTALL_DIR='$FAKE_INSTALL'; $FNS
install_keepalive_probe_timer '$TMP/units'
install_main_inbox_observer_unit '$TMP/units'
echo REACHED-END" 2>&1
}
active() { [ -e "$ST/active/$1" ] && echo yes || echo no; }

echo "1. existing, enabled, inactive timers (the #1902 state) are started, units untouched"
reset_host
BEFORE="$(unit_sums)"
OUT="$(run_update)"
assert_eq "keepalive timer running after the update" yes "$(active $KA)"
assert_eq "inbox-observer timer running after the update" yes "$(active $IO)"
assert_contains "each timer started with its own call (keepalive)" "$(cat "$ST/calls")" "--user enable --now $KA"
assert_contains "each timer started with its own call (observer)" "$(cat "$ST/calls")" "--user enable --now $IO"
assert_not_contains "never one call naming both timers" "$(cat "$ST/calls")" "$KA $IO"
assert_eq "no unit file rewritten" "$BEFORE" "$(unit_sums)"
assert_not_contains "no daemon-reload (nothing was written)" "$(cat "$ST/calls")" "daemon-reload"
assert_contains "says what it did" "$OUT" "Inaktiv timer elinditva: $KA"
assert_contains "the update went on" "$OUT" "REACHED-END"

echo "2. already running: no-op"
reset_host; touch "$ST/active/$KA" "$ST/active/$IO"
OUT="$(run_update)"
assert_not_contains "no enable/start for a running timer" "$(cat "$ST/calls")" "enable"
assert_eq "prints nothing but the end marker" "REACHED-END" "$OUT"

echo "3. a start that FAILS under set -e: a warning with the fix, the other timer still starts, the update goes on"
reset_host; touch "$ST/fail/$KA"
OUT="$(run_update)"
assert_contains "names the timer and the command that fixes it" "$OUT" \
  "FIGYELEM: $KA nem fut, es nem indult el -- inditsd kezzel: systemctl --user enable --now $KA"
assert_eq "the failed timer stays down" no "$(active $KA)"
assert_eq "the other timer is started anyway" yes "$(active $IO)"
assert_contains "the update was not stopped by the failure" "$OUT" "REACHED-END"

echo "4. a timer whose enable failed at install (disabled, inactive) is enabled and started"
reset_host; rm -f "$ST/enabled/$KA"
run_update >/dev/null
assert_eq "enabled now" yes "$([ -e "$ST/enabled/$KA" ] && echo yes || echo no)"
assert_eq "running now" yes "$(active $KA)"

echo "5. a masked timer is the operator's opt-out: left alone, silently"
reset_host; touch "$ST/masked/$KA"
OUT="$(run_update)"
assert_not_contains "no enable/start for the masked timer" "$(cat "$ST/calls")" "enable --now $KA"
assert_not_contains "no warning about it" "$OUT" "$KA"
assert_eq "the unmasked one is still started" yes "$(active $IO)"

echo "5b. a runtime mask (systemctl mask --runtime) is an opt-out too: no start, no warning asking to undo it"
reset_host; touch "$ST/masked-runtime/$KA"
OUT="$(run_update)"
assert_not_contains "no enable/start for the runtime-masked timer" "$(cat "$ST/calls")" "enable --now $KA"
assert_not_contains "no warning about it" "$OUT" "$KA"
assert_eq "the other one is still started" yes "$(active $IO)"

echo "6. no systemd at all: the branch does not run"
reset_host; touch "$ST/no-systemd"
OUT="$(run_update)"
assert_eq "no systemctl call" "" "$(cat "$ST/calls")"
assert_eq "prints nothing but the end marker" "REACHED-END" "$OUT"

echo "7. systemd but no user session (WSL, container, VPS without linger): only the probe, no start"
reset_host; touch "$ST/no-session"
OUT="$(run_update)"
assert_not_contains "no is-active / enable after the failed session probe" "$(cat "$ST/calls")" "is-active"
assert_not_contains "no enable" "$(cat "$ST/calls")" "enable"
assert_eq "prints nothing but the end marker" "REACHED-END" "$OUT"

echo "8. control: a host with no timer files gets them written and started, as before"
reset_host; rm -f "$TMP/units/"hex-channel-keepalive-probe.* "$TMP/units/"hex-main-inbox-observer.* "$ST/units/"*
touch "$ST/units/$KA" "$ST/units/$IO"
OUT="$(run_update)"
assert_eq "keepalive timer written" yes "$([ -f "$TMP/units/$KA" ] && echo yes || echo no)"
assert_contains "and enabled + started" "$(cat "$ST/calls")" "--user enable --now $KA"
assert_contains "the update went on" "$OUT" "REACHED-END"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
