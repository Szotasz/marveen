#!/bin/bash
# Contract tests for the guarded native `claude update` in scripts/channels.sh
# (NATIVEAUTOUPD1642, issue #1642).
#
# A native host (~/.local/bin/claude -> ~/.local/share/claude/versions/<v>) used
# to skip every update. It is now updated once a day with `claude update`, and
# every run is checked; any miss puts the launcher back and logs FAILED.
#
# What is pinned:
#   1. default (no .env key)         -> follows CLAUDE_NATIVE_AUTOUPDATE_DEFAULT (read from
#                                       channels.sh); off: no update, the SKIPPED line names the switch
#   2. CLAUDE_NATIVE_AUTOUPDATE=0     -> no update
#   3. =1, update succeeds           -> launcher on the new build, OK logged, nothing in
#                                       channels-failures.log, npm never called
#   4. =1, already up to date        -> launcher unchanged, OK logged
#   5. =1, a fresh native stamp      -> not due, no update
#   6. =1, AVX-less host             -> no update
#   7. =1, `claude update` exits 1   -> FAILED logged, launcher unchanged
#   8. =1, launcher moved OUT of the versions dir     -> FAILED, launcher restored
#   9. =1, the new build fails --version              -> FAILED, launcher restored
#  10. =1, an npm-global claude appeared              -> FAILED, launcher restored
#  11. =1, another claude now wins on the PATH        -> FAILED, launcher restored
#  12. the update runs with an EMPTY CLAUDE_CONFIG_DIR and TELEGRAM_STATE_DIR
#      (a child claude that loads the channel plugin takes the bot poller)
#  13. the native update writes its OWN stamp, never $CLAUDE_UPDATE_STAMP (that one
#      means "npm installed after this build" to the relink and the behind-npm note)
#  14. a failed attempt still writes the native stamp (retried tomorrow, not every restart)
#  15. the default is decided in exactly one place in channels.sh
#  16. an unrecognised .env value falls back to the default
#
# The block is extracted from channels.sh exactly as in
# channels-native-install-no-npm.test.sh and run against a throwaway HOME. The
# fake versioned "claude" answers --version and acts out one `update` scenario.
# Nothing touches the real system.
# Negative control: CHANNELS_BIN=<pre-fix channels.sh> makes cases 3-14 fail.
# Run: bash scripts/__tests__/channels-native-autoupdate.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

BLOCK="$(awk '/^CLAUDE_UPDATE_STAMP=/{on=1} /^CLAUDE="\$\(command -v claude\)"/{on=0} on' "$SRC")"
if [ -z "$BLOCK" ]; then
  echo "FAIL: could not extract the install/update block from $SRC"
  exit 1
fi

# System dirs mirrored without `claude` (see channels-native-install-no-npm.test.sh).
SYSBIN="$(mktemp -d)"
trap 'rm -rf "$SYSBIN"' EXIT
for d in /usr/bin /bin; do
  for f in "$d"/*; do
    n="${f##*/}"
    [ "$n" = claude ] && continue
    [ -e "$SYSBIN/$n" ] || ln -s "$f" "$SYSBIN/$n"
  done
done
BASH_BIN="$(command -v bash)"

# make_version <root> <version> [<update-scenario>]
# The fake build prints its version for --version and, for `update`, acts out
# the scenario. It records the env it ran `update` under in <root>/update.env.
make_version() {
  local dir="$1/home/.local/share/claude/versions"
  mkdir -p "$dir"
  cat > "$dir/$2" <<EOF
#!/bin/sh
R="$1"
V="$2"
L="\$R/home/.local/bin/claude"
D="\$R/home/.local/share/claude/versions"
newbuild() {
  printf '#!/bin/sh\necho "\$1 (Claude Code)"\n' > "\$D/\$1"
  chmod +x "\$D/\$1"
}
case "\$1" in
  --version) echo "\$V (Claude Code)"; exit 0 ;;
  update)
    echo "cfg=\$CLAUDE_CONFIG_DIR tg=\$TELEGRAM_STATE_DIR" > "\$R/update.env"
    case "${3:-ok}" in
      ok) newbuild 2.1.312; ln -sfn "\$D/2.1.312" "\$L"; echo "Successfully updated" ;;
      uptodate) echo "Claude Code is up to date (\$V)" ;;
      rcfail) echo "network error"; exit 1 ;;
      escape) mkdir -p "\$R/elsewhere"; printf '#!/bin/sh\necho x\n' > "\$R/elsewhere/claude"
              chmod +x "\$R/elsewhere/claude"; ln -sfn "\$R/elsewhere/claude" "\$L" ;;
      brokennew) printf '#!/bin/sh\nexit 3\n' > "\$D/2.1.312"; chmod +x "\$D/2.1.312"
                 ln -sfn "\$D/2.1.312" "\$L" ;;
      npmcopy) newbuild 2.1.312; ln -sfn "\$D/2.1.312" "\$L"
               mkdir -p "\$R/npmroot/@anthropic-ai/claude-code" ;;
      prunebroken) printf '#!/bin/sh\nexit 3\n' > "\$D/2.1.312"; chmod +x "\$D/2.1.312"
                   ln -sfn "\$D/2.1.312" "\$L"; rm -f "\$D/2.1.169" ;;
      prunenpm) newbuild 2.1.312; ln -sfn "\$D/2.1.312" "\$L"; rm -f "\$D/2.1.169"
                mkdir -p "\$R/npmroot/@anthropic-ai/claude-code" ;;
      pathwin) newbuild 2.1.312; ln -sfn "\$D/2.1.312" "\$L"
               printf '#!/bin/sh\necho 9.9.9\n' > "\$R/stub/claude"; chmod +x "\$R/stub/claude" ;;
    esac
    exit 0 ;;
esac
EOF
  chmod +x "$dir/$2"
}

# run_case <scenario> <env-value|-> [avx_less] [pre-fn]
# Sets ERR, NPM_CALLS, LINK, FAILLOG, UPDENV, NPM_STAMP, NATIVE_STAMP, UPDATED.
run_case() {
  local scen="$1" envv="$2" avx="${3:-0}" pre="${4:-}" root
  root="$(mktemp -d)"
  mkdir -p "$root/home/.local/bin" "$root/stub" "$root/install/store" "$root/npmroot"
  cat > "$root/stub/npm" <<EOF
#!/bin/sh
if [ "\$1" = "root" ]; then echo "$root/npmroot"; exit 0; fi
echo "npm \$*" >> "$root/npm.log"
exit 0
EOF
  chmod +x "$root/stub/npm"
  make_version "$root" 2.1.169 "$scen"
  ln -s "$root/home/.local/share/claude/versions/2.1.169" "$root/home/.local/bin/claude"
  [ "$envv" = "-" ] || printf 'CLAUDE_NATIVE_AUTOUPDATE=%s\n' "$envv" > "$root/install/.env"
  [ -n "$pre" ] && "$pre" "$root"
  ERR="$(HOME="$root/home" PATH="$root/stub:$root/home/.local/bin:$SYSBIN" \
    INSTALL_DIR="$root/install" CLAUDE_PKG="@anthropic-ai/claude-code" AVX_LESS="$avx" \
    "$BASH_BIN" -c "$BLOCK
claude_daily_check_start
wait" 2>&1 >/dev/null)"
  NPM_CALLS="$( { wc -l < "$root/npm.log"; } 2>/dev/null | tr -d ' ')"; NPM_CALLS="${NPM_CALLS:-0}"
  LINK="$(readlink "$root/home/.local/bin/claude" 2>/dev/null)"; LINK="${LINK#$root/home/}"
  FAILLOG="$(cat "$root/install/store/channels-failures.log" 2>/dev/null || true)"
  UPDENV="$(cat "$root/update.env" 2>/dev/null || true)"
  UPDATED=0; [ -e "$root/update.env" ] && UPDATED=1
  NPM_STAMP=0; [ -e "$root/install/store/.claude-update-stamp" ] && NPM_STAMP=1
  NATIVE_STAMP=0; [ -e "$root/install/store/.claude-native-update-stamp" ] && NATIVE_STAMP=1
  UPDENV="${UPDENV//$root/<root>}"
  rm -rf "$root"
}
fresh_native_stamp() { : > "$1/install/store/.claude-native-update-stamp"; }

OLD=".local/share/claude/versions/2.1.169"
NEW=".local/share/claude/versions/2.1.312"

echo "channels.sh guarded native auto-update"

# The expected default is read from channels.sh, so the owner's decision (#1642)
# stays a one-line change there.
DEF="$(grep -E '^CLAUDE_NATIVE_AUTOUPDATE_DEFAULT=' "$SRC" | head -1 | cut -d= -f2)"
case "$DEF" in 0|1) ;; *) fail "channels.sh sets CLAUDE_NATIVE_AUTOUPDATE_DEFAULT to 0 or 1" "0|1" "${DEF:-<missing>}"; DEF=0 ;; esac

run_case ok -
if [ "$DEF" = "0" ]; then
  if [ "$UPDATED" = "0" ]; then pass "default (off): no native update"
  else fail "default (off): no native update" "no update" "update ran"; fi
  case "$ERR" in *"SKIPPED: native install, auto-update off (CLAUDE_NATIVE_AUTOUPDATE)"*)
    pass "default (off): the SKIPPED line names the switch" ;;
    *) fail "default (off): the SKIPPED line names the switch" "SKIPPED ... CLAUDE_NATIVE_AUTOUPDATE" "${ERR:-<empty>}" ;; esac
else
  if [ "$LINK" = "$NEW" ]; then pass "default (on): the native update runs"
  else fail "default (on): the native update runs" "$NEW" "${LINK:-<no link>}"; fi
fi

run_case ok 0
if [ "$UPDATED" = "0" ] && [ "$LINK" = "$OLD" ]; then pass "=0: no native update"
else fail "=0: no native update" "no update, $OLD" "updated=$UPDATED $LINK"; fi

run_case ok garbage
if [ "$UPDATED" = "$DEF" ]; then pass "unrecognised value: falls back to the default ($DEF)"
else fail "unrecognised value: falls back to the default ($DEF)" "updated=$DEF" "updated=$UPDATED"; fi

run_case ok 1
if [ "$LINK" = "$NEW" ]; then pass "=1, update OK: the launcher is on the new build"
else fail "=1, update OK: the launcher is on the new build" "$NEW" "${LINK:-<no link>}"; fi
case "$ERR" in *"claude update OK (native, daily check): 2.1.169 -> 2.1.312"*)
  pass "=1, update OK: OK line names both builds" ;;
  *) fail "=1, update OK: OK line names both builds" "OK ... 2.1.169 -> 2.1.312" "${ERR:-<empty>}" ;; esac
if [ -z "$FAILLOG" ]; then pass "=1, update OK: nothing in channels-failures.log"
else fail "=1, update OK: nothing in channels-failures.log" "<empty>" "$FAILLOG"; fi
if [ "$NPM_CALLS" = "0" ]; then pass "=1, update OK: npm is never asked to install"
else fail "=1, update OK: npm is never asked to install" "0 npm calls" "$NPM_CALLS"; fi
case "$UPDENV" in
  "cfg=<root>/install/store/.claude-native-update-env/config tg=<root>/install/store/.claude-native-update-env/telegram")
    pass "=1: claude update runs with an isolated, empty config dir and telegram state dir" ;;
  *) fail "=1: claude update runs with an isolated, empty config dir and telegram state dir" \
       "cfg=.../config tg=.../telegram" "${UPDENV:-<not run>}" ;; esac
if [ "$NATIVE_STAMP" = "1" ] && [ "$NPM_STAMP" = "0" ]; then
  pass "=1: the native update writes its own stamp, not the npm stamp"
else fail "=1: the native update writes its own stamp, not the npm stamp" "native=1 npm=0" "native=$NATIVE_STAMP npm=$NPM_STAMP"; fi

run_case uptodate 1
if [ "$LINK" = "$OLD" ] && [ -z "$FAILLOG" ]; then pass "=1, up to date: launcher unchanged, no failure"
else fail "=1, up to date: launcher unchanged, no failure" "$OLD, empty log" "$LINK / $FAILLOG"; fi

run_case ok 1 0 fresh_native_stamp
if [ "$UPDATED" = "0" ]; then pass "=1, native stamp younger than a day: not due"
else fail "=1, native stamp younger than a day: not due" "no update" "update ran"; fi

run_case ok 1 1
if [ "$UPDATED" = "0" ]; then pass "=1, AVX-less host: no native update"
else fail "=1, AVX-less host: no native update" "no update" "update ran"; fi

run_case rcfail 1
case "$FAILLOG" in *"claude update FAILED (native, daily check): claude update exited 1: network error"*)
  pass "=1, update exits 1: FAILED in channels-failures.log" ;;
  *) fail "=1, update exits 1: FAILED in channels-failures.log" "FAILED ... exited 1" "${FAILLOG:-<empty>}" ;; esac
if [ "$LINK" = "$OLD" ]; then pass "=1, update exits 1: launcher unchanged"
else fail "=1, update exits 1: launcher unchanged" "$OLD" "$LINK"; fi
if [ "$NATIVE_STAMP" = "1" ]; then pass "=1, failed attempt: the native stamp is written (retry tomorrow)"
else fail "=1, failed attempt: the native stamp is written (retry tomorrow)" "stamp" "none"; fi

check_rollback() {  # check_rollback <scenario> <label> <reason-fragment>
  run_case "$1" 1
  if [ "$LINK" = "$OLD" ]; then pass "=1, $2: launcher restored to the previous build"
  else fail "=1, $2: launcher restored to the previous build" "$OLD" "${LINK:-<no link>}"; fi
  case "$FAILLOG" in *"FAILED (native, daily check): "*"$3"*"launcher restored to 2.1.169"*)
    pass "=1, $2: FAILED names the reason and the restore" ;;
    *) fail "=1, $2: FAILED names the reason and the restore" "$3 ... launcher restored to 2.1.169" "${FAILLOG:-<empty>}" ;; esac
}
check_rollback escape "launcher moved out of the versions dir" "no longer points into"
check_rollback brokennew "new build fails --version" "does not run --version"
check_rollback npmcopy "an npm-global claude appeared" "an npm-global claude appeared (npm copy: absent -> present)"
check_rollback pathwin "another claude wins on the PATH" "claude on the PATH is no longer"

# review #2339: the update installs a broken build AND prunes the previous one.
run_case prunebroken 1
case "$LINK" in
  "$OLD") fail "=1, broken build + previous pruned: no dangling launcher" "not $OLD (it is gone)" "$LINK" ;;
  *) pass "=1, broken build + previous pruned: no dangling launcher back to the pruned build" ;;
esac
case "$FAILLOG" in
  *"launcher restored"*) fail "=1, broken build + previous pruned: the log does not claim a restore" "no 'launcher restored'" "$FAILLOG" ;;
  *"the previous build 2.1.169 is gone or does not run, and NO native build runs"*)
    pass "=1, broken build + previous pruned: the log says no native build runs" ;;
  *) fail "=1, broken build + previous pruned: the log says no native build runs" "NO native build runs" "${FAILLOG:-<empty>}" ;;
esac
# Three older builds that all run: the NEWEST must win (2.1.9 / 2.1.30 / 2.1.100 also trip a
# lexical sort or an ascending scan).
older_build() { make_version "$1" 2.1.9; make_version "$1" 2.1.30; make_version "$1" 2.1.100; }
run_case prunebroken 1 0 older_build
if [ "$LINK" = ".local/share/claude/versions/2.1.100" ]; then
  pass "=1, broken build + previous pruned, an older build runs: launcher set to it"
else fail "=1, broken build + previous pruned, an older build runs: launcher set to it" \
  ".local/share/claude/versions/2.1.100" "${LINK:-<no link>}"; fi
case "$FAILLOG" in *"launcher set to the newest build that runs, 2.1.100"*)
  pass "=1, broken build + previous pruned, an older build runs: the log names it" ;;
  *) fail "=1, broken build + previous pruned, an older build runs: the log names it" "newest build that runs, 2.1.100" "${FAILLOG:-<empty>}" ;; esac
# A working new build, the previous pruned, but an npm copy appeared: stay on the new
# build (it runs), and name where the npm copy is.
run_case prunenpm 1
if [ "$LINK" = "$NEW" ]; then pass "=1, npm copy appeared + previous pruned: launcher stays on the new build that runs"
else fail "=1, npm copy appeared + previous pruned: launcher stays on the new build that runs" "$NEW" "${LINK:-<no link>}"; fi
case "$FAILLOG" in *"the npm copy is still installed at "*"/npmroot/@anthropic-ai/claude-code"*)
  pass "=1, npm copy appeared: the log names where the npm copy is" ;;
  *) fail "=1, npm copy appeared: the log names where the npm copy is" "the npm copy is still installed at .../npmroot/..." "${FAILLOG:-<empty>}" ;; esac

N_DEFAULT="$(grep -c '^CLAUDE_NATIVE_AUTOUPDATE_DEFAULT=' "$SRC")"
N_LITERAL="$(grep -n 'CLAUDE_NATIVE_AUTOUPDATE_DEFAULT' "$SRC" | grep -vc 'CLAUDE_NATIVE_AUTOUPDATE_DEFAULT=\|"\$CLAUDE_NATIVE_AUTOUPDATE_DEFAULT"')"
if [ "$N_DEFAULT" = "1" ] && [ "$N_LITERAL" = "0" ]; then pass "channels.sh: the default is set in exactly one place"
else fail "channels.sh: the default is set in exactly one place" "1 assignment, used only as a value" "$N_DEFAULT assignment(s), $N_LITERAL other mention(s)"; fi

echo "channels.sh guarded native auto-update: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
