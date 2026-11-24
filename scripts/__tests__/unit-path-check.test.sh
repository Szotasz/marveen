#!/bin/bash
# scripts/lib/unit-path-check.sh (BREWPREFIXREST1107): the doctor's unit PATH report.
# Hermetic: a throwaway HOME with stub plists / systemd units, stub tmux, claude and
# node in a fake custom Homebrew prefix, and a PATH of only those dirs plus
# /usr/bin:/bin. Nothing reads or writes the real ~/Library or launchctl. The last
# section mutates a copy of the lib and expects the suite to notice.
#
# Run: bash scripts/__tests__/unit-path-check.test.sh
set -u
INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="$INSTALL_DIR/scripts/lib/unit-path-check.sh"

FAILED=0
pass(){ echo "  PASS  $*"; }
fail(){ echo "  FAIL  $*"; FAILED=1; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/unit-path-check-XXXX")"
FIX="$(cd "$FIX" && pwd -P)"
trap 'rm -rf "$FIX"' EXIT

PFX="$FIX/custombrew"           # the custom Homebrew prefix
KEG="$PFX/opt/node@22/bin"      # node@22's keg, the installer's NODE_BIN_DIR
mkdir -p "$PFX/bin" "$KEG"
for t in tmux claude; do printf '#!/bin/sh\nexit 0\n' > "$PFX/bin/$t"; chmod +x "$PFX/bin/$t"; done
printf '#!/bin/sh\nexit 0\n' > "$KEG/node"; chmod +x "$KEG/node"
TOOLPATH="$KEG:$PFX/bin:/usr/bin:/bin"

# plist <home> <label> <PATH value>: a launchd plist the way the installers write it.
plist(){
  mkdir -p "$1/Library/LaunchAgents"
  cat > "$1/Library/LaunchAgents/$2.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$2</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$3</string>
    <key>HOME</key>
    <string>$1</string>
  </dict>
</dict>
</plist>
EOF
}
# unit <home> <name> <Environment line>: a systemd user unit.
unit(){
  mkdir -p "$1/.config/systemd/user"
  printf '[Service]\nExecStart=/bin/true\n%s\n' "$3" > "$1/.config/systemd/user/$2.service"
}

run(){ # run <lib> <home> <os> [sid]
  HOME="$2" PATH="$TOOLPATH" INSTALL_DIR="$INSTALL_DIR" /bin/bash -c ". \"$1\"; unit_path_check \"$3\" \"${4:-marveen}\"" 2>&1
}

FIXED="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "--- macOS, custom prefix: main units learn it at run time, a helper does not ---"
H1="$FIX/h1"
plist "$H1" com.marveen.channels "$KEG:$H1/.local/bin:/opt/homebrew/bin:$H1/.bun/bin:/usr/local/bin:/usr/bin:/bin"
plist "$H1" com.marveen.dashboard "$KEG:$H1/.local/bin:/opt/homebrew/bin:$H1/.bun/bin:/usr/local/bin:/usr/bin:/bin"
plist "$H1" com.marveen.channel-coordinator "$FIXED"
plist "$H1" com.marveen.telegram-progress-watchdog "$FIXED"
out="$(run "$LIB" "$H1" Darwin)"; rc=$?
[ $rc -eq 0 ] && [ "$(echo "$out" | grep -c '^warn|')" -eq 3 ] \
  && pass "exit 0, one warn line per tool (3)" || fail "expected 3 warn lines (rc=$rc): $out"
echo "$out" | grep -q "^warn|tmux: $PFX/bin (where $PFX/bin/tmux is) is not on the PATH of com.marveen.channel-coordinator, com.marveen.telegram-progress-watchdog, so these jobs may not find it. Fix: bash scripts/install-channel-coordinator.sh; bash scripts/install-telegram-progress-hook.sh$" \
  && pass "tmux line: missing dir, the two helpers, their install scripts" || fail "tmux line not as expected: $out"
echo "$out" | grep -q "^warn|claude: $PFX/bin " && pass "claude line names $PFX/bin" || fail "claude line missing: $out"
echo "$out" | grep -q "^warn|node: $KEG (where $KEG/node is) is not on the PATH of com.marveen.channel-coordinator, com.marveen.telegram-progress-watchdog," \
  && pass "node line names the keg dir and only the helpers" || fail "node line not as expected: $out"
echo "$out" | grep -q 'com.marveen.channels\|com.marveen.dashboard' \
  && fail "channels/dashboard flagged although #2578 adds the prefix bin at run time: $out" \
  || pass "channels and dashboard not flagged (prefix bin learned from their keg entry)"

echo "--- macOS: a main unit with NO keg entry does not learn the prefix: flagged, fix is the installer ---"
H2="$FIX/h2"
plist "$H2" com.marveen.channels "$H2/.local/bin:/opt/homebrew/bin:$H2/.bun/bin:/usr/local/bin:/usr/bin:/bin"
out="$(run "$LIB" "$H2" Darwin)"
echo "$out" | grep -q "^warn|tmux: $PFX/bin .* PATH of com.marveen.channels, .* Fix: ./install.sh$" \
  && pass "channels without keg entry flagged, fix ./install.sh" || fail "expected channels flagged: $out"

echo "--- macOS: everything on PATH (default prefix layout): one ok line, no warn ---"
H3="$FIX/h3"
plist "$H3" com.marveen.channels "$KEG:$PFX/bin:$FIXED"
plist "$H3" com.marveen.channel-keepalive-probe "$KEG:$PFX/bin/:$FIXED"
out="$(run "$LIB" "$H3" Darwin)"; rc=$?
[ $rc -eq 0 ] && [ "$out" = "ok|tmux, claude and node are on the PATH of every installed unit" ] \
  && pass "ok line only (a trailing slash on a PATH dir counts as the same dir)" || fail "expected only the ok line (rc=$rc): $out"

echo "--- macOS: a SERVICE_ID other than marveen; the fixed-label outage alarm still read; plist without PATH skipped ---"
H4="$FIX/h4"
plist "$H4" com.acme.stuck-modal-guard "$FIXED"
plist "$H4" com.marveen.channel-outage-alarm "$FIXED"
plist "$H4" com.marveen.channels "$FIXED"            # another install's unit: not ours
mkdir -p "$H4/Library/LaunchAgents"; printf '<plist><dict><key>Label</key><string>com.acme.app</string></dict></plist>\n' > "$H4/Library/LaunchAgents/com.acme.app.plist"
out="$(run "$LIB" "$H4" Darwin acme)"
echo "$out" | grep -q "^warn|tmux: .* PATH of com.acme.stuck-modal-guard, com.marveen.channel-outage-alarm, .* Fix: bash scripts/install-stuck-modal-guard.sh; bash scripts/install-channel-outage-alarm.sh$" \
  && pass "com.acme.* and the fixed outage-alarm label read, fixes named" || fail "acme case not as expected: $out"
echo "$out" | grep -q 'com.acme.app\|com.marveen.channels' \
  && fail "a PATH-less plist or another install's unit was flagged: $out" || pass "PATH-less plist and foreign unit not flagged"

echo "--- Linux: systemd Environment=PATH (plain and quoted), the main unit learns the keg prefix ---"
H5="$FIX/h5"
unit "$H5" marveen-channels "Environment=PATH=$KEG:$H5/.local/bin:/usr/local/bin:/usr/bin:/bin"
unit "$H5" marveen-keepalive "Environment=\"PATH=$H5/.local/bin:/usr/local/bin:/usr/bin:/bin\""
unit "$H5" marveen-slack-progress-watchdog "Environment=PATH=$KEG:$PFX/bin:/usr/bin:/bin"
out="$(run "$LIB" "$H5" Linux)"
echo "$out" | grep -q "^warn|tmux: $PFX/bin .* PATH of marveen-keepalive, so these jobs may not find it. Fix: ./install.sh$" \
  && pass "keepalive unit flagged (quoted form read), channels and the watchdog not" || fail "linux tmux line not as expected: $out"
echo "$out" | grep -q "^warn|node: $KEG .* PATH of marveen-keepalive," \
  && pass "node flagged on keepalive only" || fail "linux node line not as expected: $out"
H6="$FIX/h6"
unit "$H6" marveen-telegram-progress-watchdog "Environment=PATH=/usr/bin:/bin"
out="$(run "$LIB" "$H6" Linux)"
echo "$out" | grep -q "Fix: bash scripts/install-telegram-progress-hook.sh$" \
  && pass "linux progress watchdog fix names its install script" || fail "linux watchdog fix not as expected: $out"

echo "--- no unit, no tool: skip / nothing flagged ---"
out="$(run "$LIB" "$FIX/empty" Darwin)"
[ "$out" = "skip|no installed unit found to compare" ] && pass "no unit: skip" || fail "no unit must skip: $out"
out="$(HOME="$H1" PATH="/usr/bin:/bin" /bin/bash -c ". \"$LIB\"; unit_path_check Darwin marveen" 2>&1)"
echo "$out" | grep -q '^warn|' && fail "a tool command -v cannot find was flagged: $out" \
  || pass "tools not found on the doctor's PATH: no warn"

echo "--- doctor.sh: the section sources the lib, reports only, and runs with the doctor's helpers ---"
DOC="$INSTALL_DIR/scripts/doctor.sh"
block="$(sed -n '/^# --- Unit PATH (BREWPREFIXREST1107) ---$/,/^# --- Channel keepalive ---$/p' "$DOC")"
echo "$block" | grep -q 'scripts/lib/unit-path-check.sh' && echo "$block" | grep -q 'unit_path_check "$(uname -s)" "$SERVICE_ID_DOC"' \
  && ! echo "$block" | grep -q 'fail ' \
  && pass "sources the lib, passes the OS and SERVICE_ID_DOC, no fail call" || fail "doctor.sh Unit PATH block not as expected"
SNIP="$FIX/doctor-block.sh"
{
  echo 'BOLD=""; RESET=""; FAIL=0'
  echo 'ok(){ echo "OK $1"; }; warn(){ echo "WARN $1"; }; fail(){ echo "FAILCALL $1"; FAIL=1; }'
  # The fixture is a macOS one (plists): the test names the OS, so the run is the same on a Linux CI runner.
  echo 'uname(){ echo Darwin; }'
  echo "$block"
  echo 'echo "FAIL=$FAIL"'
} > "$SNIP"
out="$(HOME="$H1" PATH="$TOOLPATH" INSTALL_DIR="$INSTALL_DIR" SERVICE_ID_DOC=marveen /bin/bash "$SNIP" 2>&1)"
[ "$(echo "$out" | grep -c '^WARN tmux: \|^WARN claude: \|^WARN node: ')" -eq 3 ] && echo "$out" | grep -q '^FAIL=0$' \
  && ! echo "$out" | grep -q FAILCALL \
  && pass "doctor block prints the 3 warnings through warn() and leaves FAIL=0" || fail "doctor block run not as expected: $out"

echo "--- mutation control: a lib without the comparison is caught ---"
MUT="$FIX/unit-path-check-mutated.sh"
sed 's/\*":$_upc_dir:"\*|\*":$_upc_dir\/:"\*) continue ;;/*) continue ;;/' "$LIB" > "$MUT"
if diff -q "$LIB" "$MUT" >/dev/null 2>&1; then
  fail "the sed pattern matched nothing: the mutation did not change the file"
else
  out="$(run "$MUT" "$H1" Darwin)"
  echo "$out" | grep -q '^warn|' \
    && fail "mutated lib still warns: the custom-prefix case does not measure the comparison" \
    || pass "mutated lib gives no warn: the custom-prefix case can fail"
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "unit-path-check: ALL PASS"; else echo "unit-path-check: FAILURES"; fi
exit "$FAILED"
