#!/bin/bash
# ISSUE1891 (#1891): the three macOS helper jobs (keep-alive probe, stuck-modal
# guard, main-inbox observer) are registered in gui/<uid>, run once and VERIFIED
# by their installers -- not loaded with a bare `launchctl load` followed by an
# unconditional "Loaded" line.
#
# Without a GUI login session (an install over SSH) there is no gui/<uid>
# domain; launchd runs such agents only inside one (launchctl(1): "Aqua agents
# are loaded only when a user has logged in at the GUI"), so the job never ran
# while the installer said it was loaded, and on that Mac the dashboard kept
# respawning a healthy idle main session because the keep-alive probe never
# refreshed its file.
#
# launchctl is a stateful stub: with $ST/gui present the GUI domain exists,
# bootstrap registers, kickstart and RunAtLoad count runs, print shows them;
# without it bootstrap fails (rc 5, as measured for an SSH-driven install) and
# print fails. Each installer runs for real (set -euo pipefail) in a throwaway
# HOME under /bin/bash. Nothing here touches this machine's launchd.
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
ST="$TMP/state"
UID_="$(id -u)"

cat > "$TMP/launchctl" <<EOF
#!/bin/bash
echo "\$*" >> "$ST/calls"
cmd="\$1"; shift
case "\$cmd" in
  bootstrap)
    [ -e "$ST/gui" ] || { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    plist="\$2"; label="\$(basename "\$plist" .plist)"
    [ -e "$ST/reg-\$label" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    echo 1 > "$ST/reg-\$label"; exit 0 ;;
  bootout)
    label="\${1##*/}"; [ -e "$ST/reg-\$label" ] || exit 3; rm -f "$ST/reg-\$label"; exit 0 ;;
  kickstart)
    label="\${1##*/}"; [ -e "$ST/reg-\$label" ] || exit 113
    [ -e "$ST/norun" ] || echo \$(( \$(cat "$ST/reg-\$label") + 1 )) > "$ST/reg-\$label"; exit 0 ;;
  print)
    label="\${1##*/}"; [ -e "$ST/gui" ] && [ -e "$ST/reg-\$label" ] || exit 113
    runs="\$(cat "$ST/reg-\$label")"; [ -e "$ST/norun" ] && runs=0
    printf '%s = {\n\tstate = not running\n\truns = %s\n\tlast exit code = 0\n}\n' "\$label" "\$runs"; exit 0 ;;
  load|unload) exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$TMP/launchctl"
mkdir -p "$TMP/bin"; cp "$TMP/launchctl" "$TMP/bin/launchctl"
# The platform is chosen here, not by whatever host runs the suite: CI is Linux,
# and install-main-inbox-observer.sh exits "macOS-only" on a non-Darwin uname.
printf '#!/bin/bash\necho Darwin\n' > "$TMP/bin/uname"; chmod +x "$TMP/bin/uname"

# $1: installer basename; the rest: state flags (gui, norun). Echoes "<rc>|<stdout>|<stderr>".
run_installer() {
  local inst="$1"; shift
  rm -rf "$ST" "$TMP/home"; mkdir -p "$ST" "$TMP/home"; : > "$ST/calls"
  for f in "$@"; do : > "$ST/$f"; done
  local out err rc
  out="$(PATH="$TMP/bin:/usr/bin:/bin" HOME="$TMP/home" LAUNCHD_START_TRIES=2 /bin/bash "$REPO/scripts/$inst.sh" --load 2>"$TMP/err")"; rc=$?
  err="$(cat "$TMP/err")"
  printf '%s|%s|%s' "$rc" "$out" "$err"
}

for inst in install-channel-keepalive-probe install-stuck-modal-guard install-main-inbox-observer; do
  LABEL="$(HOME="$TMP/home" /bin/bash "$REPO/scripts/$inst.sh" --print-label 2>/dev/null | head -1)"
  PLIST="$TMP/home/Library/LaunchAgents/$LABEL.plist"
  echo "== $inst ($LABEL)"

  R="$(run_installer "$inst" gui)"
  RC="${R%%|*}"; REST="${R#*|}"; OUT="${REST%%|*}"; ERR="${REST#*|}"
  CALLS="$(cat "$ST/calls")"
  assert_eq "GUI session: exit 0" "0" "$RC"
  assert_contains "GUI session: registered in gui/<uid> from its own plist" "$CALLS" "bootstrap gui/$UID_ $PLIST"
  assert_contains "GUI session: run once (kickstart)" "$CALLS" "kickstart gui/$UID_/$LABEL"
  assert_contains "GUI session: verified through print" "$CALLS" "print gui/$UID_/$LABEL"
  assert_contains "GUI session: says Loaded only after that" "$OUT" "Loaded $LABEL"
  assert_eq "GUI session: no NOT RUNNING line" "" "$ERR"

  R="$(run_installer "$inst" gui)"; touch "$ST/gui"
  # A re-run on a registered job: bootout first, so bootstrap does not hit EIO.
  : > "$ST/calls"; echo 3 > "$ST/reg-$LABEL"
  OUT="$(PATH="$TMP/bin:/usr/bin:/bin" HOME="$TMP/home" LAUNCHD_START_TRIES=2 /bin/bash "$REPO/scripts/$inst.sh" --load 2>/dev/null)"; RC=$?
  CALLS="$(cat "$ST/calls")"
  assert_eq "re-run on a registered job: exit 0" "0" "$RC"
  assert_contains "re-run: bootout before bootstrap" "$(printf '%s' "$CALLS" | head -1)" "bootout gui/$UID_/$LABEL"

  R="$(run_installer "$inst")"
  RC="${R%%|*}"; REST="${R#*|}"; OUT="${REST%%|*}"; ERR="${REST#*|}"
  assert_eq "no GUI session: exit 3, not 0" "3" "$RC"
  assert_not_contains "no GUI session: never claims Loaded" "$OUT" "Loaded"
  assert_contains "no GUI session: says it is not running" "$ERR" "NOT RUNNING: $LABEL"
  assert_contains "no GUI session: gives the remedy for a GUI terminal" "$ERR" \
    "launchctl bootstrap gui/$UID_ \"$PLIST\" 2>/dev/null; launchctl kickstart gui/$UID_/$LABEL"
  assert_eq "no GUI session: the plist is still written (the remedy uses it)" "yes" "$([ -f "$PLIST" ] && echo yes || echo no)"

  R="$(run_installer "$inst" gui norun)"
  RC="${R%%|*}"
  assert_eq "registered but never ran: exit 3" "3" "$RC"
done

echo "== install-macos.sh wiring (source pins: the closing summary and the remedy)"
M="$(cat "$REPO/install-macos.sh")"
for inst in install-channel-keepalive-probe install-stuck-modal-guard install-main-inbox-observer; do
  assert_contains "a failed $inst is collected for the summary" "$M" "note_helper_down $inst"
done
assert_contains "the summary lists the helpers that do not run" "$M" 'SEGED-JOBOK, AMELYEK NEM FUTNAK'
assert_contains "the summary prints the remedy per helper" "$M" 'print_periodic_unit_remedy "$HOME/Library/LaunchAgents/${_hl}.plist" "$_hl"'

echo "== install-macos.sh, run: a helper that is not running is reported, and the install goes on"
# note_helper_down and the closing-summary block, extracted from install-macos.sh
# and run in a throwaway install whose helper installers only answer --print-label.
NH="$(awk '/^note_helper_down\(\) \{/,/^\}$/' "$REPO/install-macos.sh")"
SUMMARY="$(awk '/^# ISSUE1891 \(#1891\): a helper job that is not running is repeated at the end/,/^fi$/' "$REPO/install-macos.sh")"
assert_contains "note_helper_down extracted" "$NH" "note_helper_down()"
assert_contains "the summary block extracted" "$SUMMARY" 'if [ -n "${HELPERS_DOWN:-}" ]; then'
mkdir -p "$TMP/inst/scripts"
for inst in install-channel-keepalive-probe install-main-inbox-observer; do
  printf '#!/bin/bash\n[ "${1:-}" = "--print-label" ] && echo com.test.%s\n' "${inst#install-}" > "$TMP/inst/scripts/$inst.sh"
  chmod +x "$TMP/inst/scripts/$inst.sh"
done
RUN="$(PATH="$TMP/bin:/usr/bin:/bin" HOME="$TMP/home" INSTALL_DIR="$TMP/inst" /bin/bash -c "
set -e
trap 'echo ERR-TRAP; exit 1' ERR
NC= DIM= BOLD= ORANGE= RED= GREEN= BLUE=
. '$REPO/scripts/launchd-unit.sh'
$NH
note_helper_down install-channel-keepalive-probe
note_helper_down install-main-inbox-observer
$SUMMARY
echo REACHED-AFTER-SUMMARY
" 2>&1)"; RC=$?
assert_eq "the block ends normally (a down helper does not stop or fail the install)" "0" "$RC"
assert_contains "and the install goes on after it" "$RUN" "REACHED-AFTER-SUMMARY"
assert_not_contains "no ERR trap" "$RUN" "ERR-TRAP"
assert_contains "the closing summary is printed" "$RUN" "SEGED-JOBOK, AMELYEK NEM FUTNAK"
assert_contains "it names the first helper" "$RUN" "com.test.channel-keepalive-probe: nem fut"
assert_contains "it names the second helper" "$RUN" "com.test.main-inbox-observer: nem fut"
assert_contains "with the remedy for each" "$RUN" \
  "launchctl kickstart gui/$UID_/com.test.main-inbox-observer"
RUN0="$(PATH="$TMP/bin:/usr/bin:/bin" HOME="$TMP/home" INSTALL_DIR="$TMP/inst" /bin/bash -c "
set -e
NC= DIM= BOLD= ORANGE= RED= GREEN= BLUE=
. '$REPO/scripts/launchd-unit.sh'
HELPERS_DOWN=''
$SUMMARY
echo REACHED-AFTER-SUMMARY
" 2>&1)"
assert_not_contains "no helper down: no summary block" "$RUN0" "SEGED-JOBOK"
assert_contains "no helper down: the install goes on" "$RUN0" "REACHED-AFTER-SUMMARY"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
