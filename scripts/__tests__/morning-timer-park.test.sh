#!/bin/bash
# Contract tests for parking the deprecated 07:27 morning timer on ALREADY
# INSTALLED hosts (MORNTIMERPARK914 -- the missing half of the locked MORNCONS1
# decision). Run: bash scripts/__tests__/morning-timer-park.test.sh
#
# Bug being locked out: #1313 stopped ENABLING the timer on new installs, but
# update.sh never disabled it on the existing park, so every already-installed
# Linux host kept firing a paid, structurally undeliverable headless run daily
# (or, with an allowlisted headless config, a SECOND briefing at 07:27).
#
# The contracts, straight from the MORNCONS1 conditions:
#   1. The timer is parked ONLY while the runner-side task is provably present
#      and enabled on the host -- otherwise it stays, loudly.
#   2. Everything prints to update.sh's own output; nothing reaches a user.
#   3. ONE-SHOT: a marker settles the migration, so an operator who re-enables
#      the timer afterwards (#1313's documented path) is never fought.
#
# Hermetic: update.sh's function is extracted and run against a throwaway
# units dir, HOME and INSTALL_DIR, with a `systemctl` stub on PATH, so nothing
# on this machine is touched.

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

FN="$(awk '/^park_morning_timer\(\) \{/,/^\}$/' "$REPO/update.sh")"
if [ -z "$FN" ]; then
  fail "park_morning_timer() not found in update.sh"
  echo; echo "PASS=$PASS FAIL=$FAIL"; exit 1
fi

# systemctl stub: `is-enabled <unit>` answers from a state file the test
# controls; every call is recorded; disable flips the state to disabled so a
# repeated run inside one case sees its own effect.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/systemctl" <<EOF
#!/bin/bash
echo "\$*" >> "$TMP/systemctl.calls"
if [ "\$2" = "is-enabled" ]; then
  state="\$(cat "$TMP/state.\$3" 2>/dev/null || echo disabled)"
  echo "\$state"
  [ "\$state" = "enabled" ]
  exit \$?
fi
if [ "\$2" = "disable" ]; then
  for u in "\$@"; do echo disabled > "$TMP/state.\$u"; done
fi
exit 0
EOF
chmod +x "$TMP/bin/systemctl"

# Builds a fresh sandbox (units dir, HOME, INSTALL_DIR) and runs the extracted
# function in it. Globals per case:
#   CASE           name -> sandbox under $TMP/<name>
#   TIMER_STATE    enabled|disabled|absent   (the *-morning.timer unit)
#   TASK           enabled|disabled|missing  (the runner task on the host)
#   MARKER         present|absent            (pre-existing migration marker)
run_park() {
  local name="$1" timer="$2" task="$3" marker="$4"
  local box="$TMP/$name"
  mkdir -p "$box/units" "$box/home/.claude/scheduled-tasks/reggeli-napindito" "$box/install/store"
  : > "$TMP/systemctl.calls"
  if [ "$timer" != "absent" ]; then
    printf '[Timer]\n' > "$box/units/hex-morning.timer"
    echo "$timer" > "$TMP/state.hex-morning.timer"
  fi
  case "$task" in
    enabled)  printf '{\n  "schedule": "30 7 * * *",\n  "enabled": true\n}\n'  > "$box/home/.claude/scheduled-tasks/reggeli-napindito/task-config.json" ;;
    disabled) printf '{\n  "schedule": "30 7 * * *",\n  "enabled": false\n}\n' > "$box/home/.claude/scheduled-tasks/reggeli-napindito/task-config.json" ;;
    missing)  rm -rf "$box/home/.claude/scheduled-tasks/reggeli-napindito" ;;
  esac
  [ "$marker" = "present" ] && echo "parked_at=earlier" > "$box/install/store/.morning-timer-parked"
  PATH="$TMP/bin:$PATH" HOME="$box/home" \
    bash -c "set -u; INSTALL_DIR='$box/install'; $FN
park_morning_timer '$box/units'" 2>&1
}

echo "update.sh park_morning_timer"

# 1. The main case: enabled timer + present runner task -> parked, loudly,
#    with the re-enable hint, and the migration is settled.
OUT="$(run_park main enabled enabled absent)"
assert_contains "disable --now was called" "$(cat "$TMP/systemctl.calls")" "--user disable --now hex-morning.timer"
assert_contains "says what it did and why" "$OUT" "07:27 timer leallitva"
assert_contains "prints the operator re-enable path" "$OUT" "enable --now hex-morning.timer"
assert_eq "marker written" "yes" "$([ -f "$TMP/main/install/store/.morning-timer-parked" ] && echo yes || echo no)"

# 2. MORNCONS1 condition 1: no runner task -> the timer STAYS, loudly, and the
#    migration is NOT settled (it must retry once the task is seeded).
OUT="$(run_park notask enabled missing absent)"
assert_not_contains "no disable without the runner task" "$(cat "$TMP/systemctl.calls")" "disable"
assert_contains "says why the timer stays" "$OUT" "MORNCONS1"
assert_eq "no marker while blocked" "no" "$([ -f "$TMP/notask/install/store/.morning-timer-parked" ] && echo yes || echo no)"

# 3. A present but DISABLED runner task blocks the same way.
OUT="$(run_park taskoff enabled disabled absent)"
assert_not_contains "no disable with a disabled runner task" "$(cat "$TMP/systemctl.calls")" "disable"
assert_eq "no marker with a disabled task" "no" "$([ -f "$TMP/taskoff/install/store/.morning-timer-parked" ] && echo yes || echo no)"

# 4. ONE-SHOT: with the marker present, an enabled timer is the operator's
#    deliberate choice -- not even is-enabled is asked.
OUT="$(run_park settled enabled enabled present)"
assert_eq "marker short-circuits every systemctl call" "0" "$(wc -c < "$TMP/systemctl.calls" | tr -d ' ')"
assert_eq "and prints nothing" "" "$OUT"

# 5. Already-disabled timer -> nothing to do, migration settles silently.
OUT="$(run_park quiet disabled enabled absent)"
assert_not_contains "no disable call on a disabled timer" "$(cat "$TMP/systemctl.calls")" "disable"
assert_contains "but is-enabled was consulted, not assumed" "$(cat "$TMP/systemctl.calls")" "is-enabled hex-morning.timer"
assert_eq "marker written (nothing was needed)" "yes" "$([ -f "$TMP/quiet/install/store/.morning-timer-parked" ] && echo yes || echo no)"
assert_eq "silent when there is nothing to say" "" "$OUT"

# 6. No timer unit at all (a #1313-era install) -> settle silently.
OUT="$(run_park notimer absent enabled absent)"
assert_eq "no systemctl calls without a timer unit" "0" "$(wc -c < "$TMP/systemctl.calls" | tr -d ' ')"
assert_eq "marker written on a timer-less host" "yes" "$([ -f "$TMP/notimer/install/store/.morning-timer-parked" ] && echo yes || echo no)"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
