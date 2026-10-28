#!/usr/bin/env bash
# EPERM proof for scripts/safe-vitest.sh: inside the same sandbox profile, writes outside the
# allowed roots fail, writes inside succeed, and a loopback listen works. Run from the worktree root:
#   bash scripts/__tests__/safe-vitest.test.sh
# Nothing is created outside the allowed roots unless the sandbox is broken (then the probe
# file is reported and removed by exact path).

set -uo pipefail

# safe-vitest.sh is built on macOS sandbox-exec; without it (Linux CI) the EPERM proof cannot
# be measured here, which is a counted skip, not a pass.
if ! command -v sandbox-exec >/dev/null 2>&1; then
  echo "SKIP (control unmet): sandbox-exec is not available (safe-vitest.sh is macOS-only)"
  exit 77
fi

ROOT="$(git rev-parse --show-toplevel)"
SV="$ROOT/scripts/safe-vitest.sh"
PARENT="$(dirname "$ROOT")"
PARENT_FILE="$PARENT/eperm-probe-$$"
HOME_FILE="$HOME/eperm-probe-$$"
IN_FILE="$ROOT/.eperm-probe-in-$$"
# TMP_DIR is THIS shell's (outer) temp dir; the runner gives the sandbox its own per-run TMPDIR,
# so TMP_DIR must not be writable inside the sandbox.
TMP_DIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
TMP_FILE="$TMP_DIR/eperm-probe-outer-$$"
PRIVTMP_FILE="/private/tmp/eperm-probe-privtmp-$$"
# A real directory with a file in it, created OUTSIDE the sandbox in a fresh mktemp -d that is not
# the sandbox's allowed dir; the sandboxed rmSync must fail and leave it intact.
VICTIM="$(mktemp -d "$TMP_DIR/eperm-victim.XXXXXXXX")"
VICTIM="$(cd "$VICTIM" && pwd -P)"
echo keep > "$VICTIM/file.txt"
fail=0

probe() { "$SV" --probe "$@"; }

# expect_eperm <label> <js>: the js must exit non-zero with EPERM / Operation not permitted
expect_eperm() {
  local label="$1" js="$2" out
  out="$(probe node -e "$js" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | /usr/bin/grep -qE 'EPERM|Operation not permitted'; then
    echo "PASS $label -> $(printf '%s' "$out" | /usr/bin/grep -oE "EPERM[^,]*|Operation not permitted" | head -1)"
  else
    echo "FAIL $label (rc=$rc): $out"; fail=1
  fi
}
expect_ok() {
  local label="$1" js="$2" out
  out="$(probe node -e "$js" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then echo "PASS $label"; else echo "FAIL $label (rc=$rc): $out"; fail=1; fi
}

expect_eperm "(a) write under worktree parent" "require('fs').writeFileSync('$PARENT_FILE','x')"
expect_eperm "(b) write under HOME" "require('fs').writeFileSync('$HOME_FILE','x')"
expect_eperm "(d1) mkdir outside allowed roots" "require('fs').mkdirSync('$PARENT/eperm-probe-dir-$$')"
expect_eperm "(d2) rmSync of an existing real dir outside the allowed roots" "require('fs').rmSync('$VICTIM',{recursive:true,force:true})"
if [ -d "$VICTIM" ] && [ -f "$VICTIM/file.txt" ]; then
  echo "PASS (d2) victim dir and file still exist after the sandboxed rmSync"
else
  echo "FAIL (d2) victim dir or file is gone"; fail=1
fi
expect_eperm "(f) write to /private/tmp" "require('fs').writeFileSync('$PRIVTMP_FILE','x')"
expect_eperm "(g) write to the outer user TMPDIR" "require('fs').writeFileSync('$TMP_FILE','x')"
expect_ok "(c1) write inside worktree" "require('fs').writeFileSync('$IN_FILE','x')"
expect_ok "(h) sandbox os.tmpdir() is its own writable per-run dir, not the outer TMPDIR" "const fs=require('fs'),os=require('os'),path=require('path');const t=fs.realpathSync(os.tmpdir());if(t==='$TMP_DIR'||!t.startsWith('/private/var/folders/'))throw new Error('unexpected tmpdir '+t);fs.writeFileSync(path.join(t,'eperm-probe-own-$$'),'x')"
expect_ok "(e) loopback listen" "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{s.close()});s.on('error',e=>{console.error(e);process.exit(1)})"

# the refusals
( cd "$PARENT" && "$SV" --probe true >/dev/null 2>&1 ) && { echo "FAIL runs outside a worktree root"; fail=1; } || echo "PASS refuses outside a worktree root"
( cd "$ROOT/scripts" && "$SV" --probe true >/dev/null 2>&1 ) && { echo "FAIL runs from a subdirectory"; fail=1; } || echo "PASS refuses from a subdirectory"

# exit code of the sandboxed command is propagated, and the per-run dir is gone afterwards
rc_out="$("$SV" --probe node -e "console.log(require('os').tmpdir());process.exit(7)" 2>&1)"; rc=$?
if [ "$rc" -eq 7 ] && [ ! -e "$rc_out" ]; then echo "PASS exit code propagated, per-run dir removed"; else echo "FAIL exit code/cleanup (rc=$rc, dir=$rc_out)"; fail=1; fi

# cleanup: only exact paths this test created or may have created (the sandbox normally prevents
# the probe files; the per-run sandbox dir removes itself)
for f in "$PARENT_FILE" "$HOME_FILE" "$IN_FILE" "$TMP_FILE" "$PRIVTMP_FILE"; do
  if [ -e "$f" ]; then
    case "$f" in
      "$ROOT"/.eperm-probe-in-*) rm -f -- "$f" ;;
      *) echo "WARN probe file exists outside allowed roots (sandbox leak): $f"; rm -f -- "$f"; fail=1 ;;
    esac
  fi
done
# the victim dir, outside the sandbox, by exact path
case "$VICTIM" in
  "$TMP_DIR"/eperm-victim.?*) rm -rf -- "$VICTIM" ;;
esac

[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILED"
exit "$fail"
