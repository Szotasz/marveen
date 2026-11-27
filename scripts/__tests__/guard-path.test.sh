#!/bin/bash
# ISSUE3201 (#3201): a guard script launched by a systemd unit must find tmux, claude
# and node even when they live only in a dir the unit's fixed PATH lacks (Homebrew
# on Linux: /home/linuxbrew/.linuxbrew/bin). scripts/lib/guard-path.sh appends the
# standard dirs to PATH; channel-watchdog.sh, stuck-modal-guard.sh and
# channel-keepalive-probe.sh call it before their first lookup.
#
# Hermetic: a throwaway HOME and install copy, stub tmux and claude, and a private
# TMUX_TMPDIR, so a real tmux that a widened PATH may reach has no server to talk to.
#
# Run: bash scripts/__tests__/guard-path.test.sh
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="${GUARD_PATH_LIB:-$REPO/scripts/lib/guard-path.sh}"

FAILED=0
pass(){ echo "  PASS  $*"; }
fail(){ echo "  FAIL  $*"; FAILED=1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/guard-path-XXXX")"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

echo "--- guard_path_widen: appends, keeps the caller's order, no duplicates ---"
out="$(HOME="$TMP/h" PATH="$TMP/stub:/usr/bin:/bin" /bin/bash -c ". \"$LIB\"; guard_path_widen; guard_path_widen; echo \"\$PATH\"")"
case "$out" in "$TMP/stub:/usr/bin:/bin:"*) pass "the caller's PATH stays in front" ;; *) fail "caller's PATH not in front: $out" ;; esac
case ":$out:" in *":/home/linuxbrew/.linuxbrew/bin:"*) pass "the Homebrew-on-Linux bin is on PATH" ;; *) fail "linuxbrew bin missing: $out" ;; esac
case ":$out:" in *":$TMP/h/.local/bin:"*) pass "\$HOME/.local/bin is on PATH" ;; *) fail "HOME/.local/bin missing: $out" ;; esac
dups="$(printf '%s\n' "$out" | tr ':' '\n' | sort | uniq -d)"
[ -z "$dups" ] && pass "no dir twice, even after two calls" || fail "duplicated dirs: $dups"

echo "--- channel-watchdog.sh under a PATH that lacks the tools' dir ---"
# A copy of the install's scripts, so every store/ write lands in the fixture.
INST="$TMP/install"; mkdir -p "$INST/store"; cp -R "$REPO/scripts" "$INST/scripts"
[ -n "${GUARD_PATH_LIB:-}" ] && cp "$GUARD_PATH_LIB" "$INST/scripts/lib/guard-path.sh"
H="$TMP/home"; mkdir -p "$H/.local/bin"
# tmux: has-session fails, so the watchdog stops at gate 1 ("session not present").
printf '#!/bin/sh\n[ "$1" = has-session ] && exit 1\nexit 0\n' > "$H/.local/bin/tmux"
printf '#!/bin/sh\nexit 0\n' > "$H/.local/bin/claude"
chmod +x "$H/.local/bin/tmux" "$H/.local/bin/claude"
mkdir -p "$TMP/tmuxsock"
log="$(HOME="$H" PATH="/usr/bin:/bin" TMUX_TMPDIR="$TMP/tmuxsock" MAIN_AGENT_ID="guardpathprobe" /bin/bash "$INST/scripts/channel-watchdog.sh" 2>&1)"; rc=$?
if printf '%s' "$log" | grep -q "cannot act"; then
  fail "the watchdog gave up although tmux and claude are in \$HOME/.local/bin (rc=$rc): $log"
elif printf '%s' "$log" | grep -q "not present"; then
  pass "found tmux and claude after widening, reached gate 1 (rc=$rc)"
else
  fail "unexpected watchdog output (rc=$rc): $log"
fi

echo "--- a watchdog that cannot act must not look like one with nothing to do ---"
block="$(awk '/^if \[ -z "\$TMUX_BIN" \] \|\| \[ -z "\$CLAUDE" \]; then/{f=1} f{print} f&&/^fi$/{exit}' "$REPO/scripts/channel-watchdog.sh")"
printf '%s\n' "$block" | grep -q 'cannot act' && printf '%s\n' "$block" | grep -qE '^\s*exit [1-9]' \
  && pass "the cannot-act branch exits non-zero (the unit shows as failed)" \
  || fail "the cannot-act branch does not exit non-zero: $block"

echo "--- every unit-launched script widens PATH before it looks a tool up ---"
# The scripts a unit launches: the shipped templates and the units install-linux.sh writes.
scripts="$(grep -ho 'ExecStart=[^ ]*\.sh' "$REPO"/scripts/systemd/*.service "$REPO/install-linux.sh" | sed 's#.*/scripts/#scripts/#' | sort -u)"
[ -n "$scripts" ] && pass "found $(printf '%s\n' "$scripts" | wc -l | tr -d ' ') unit-launched scripts" || fail "no unit-launched script found"
checked=0
for s in $scripts; do
  f="$REPO/$s"; [ -f "$f" ] || { fail "$s: launched by a unit but missing"; continue; }
  first="$(grep -nE 'command -v (tmux|claude|node)\b' "$f" | head -1 | cut -d: -f1)"
  [ -n "$first" ] || continue
  checked=$((checked + 1))
  widen="$(grep -n '^guard_path_widen$' "$f" | head -1 | cut -d: -f1)"
  if [ -n "$widen" ] && [ "$widen" -lt "$first" ]; then
    pass "$s: guard_path_widen (line $widen) before the first lookup (line $first)"
  elif grep -qE '^\s*export PATH="[^"]*/home/linuxbrew/\.linuxbrew/bin' "$f"; then
    pass "$s: sets its own PATH with the Homebrew-on-Linux bin"
  else
    fail "$s: looks up a tool (line $first) without widening PATH first"
  fi
done
[ "$checked" -ge 4 ] && pass "$checked scripts with a tool lookup checked" || fail "only $checked scripts checked"

echo
if [ "$FAILED" -eq 0 ]; then echo "guard-path: ALL PASS"; else echo "guard-path: FAILURES"; fi
exit "$FAILED"
