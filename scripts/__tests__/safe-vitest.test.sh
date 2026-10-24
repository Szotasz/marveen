#!/usr/bin/env bash
# EPERM proof for scripts/safe-vitest.sh: inside the same sandbox profile, writes outside the
# allowed roots fail, writes inside succeed, and a loopback listen works. Run from the worktree root:
#   bash scripts/__tests__/safe-vitest.test.sh
# Nothing is created outside the allowed roots unless the sandbox is broken (then the probe
# file is reported and removed by exact path).

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SV="$ROOT/scripts/safe-vitest.sh"
PARENT="$(dirname "$ROOT")"
PARENT_FILE="$PARENT/eperm-probe-$$"
HOME_FILE="$HOME/eperm-probe-$$"
IN_FILE="$ROOT/.eperm-probe-in-$$"
TMP_DIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
TMP_FILE="$TMP_DIR/eperm-probe-tmp-$$"
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
expect_eperm "(d2) rmSync write-class op outside (mkdir+rm in HOME)" "const fs=require('fs');const d='$HOME/eperm-probe-rm-$$';fs.mkdirSync(d);fs.rmSync(d,{recursive:true})"
expect_ok "(c1) write inside worktree" "require('fs').writeFileSync('$IN_FILE','x')"
expect_ok "(c2) write into os.tmpdir()" "const fs=require('fs'),os=require('os');fs.writeFileSync(require('path').join(os.tmpdir(),'eperm-probe-tmp2-$$'),'x')"
expect_ok "(e) loopback listen" "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{s.close()});s.on('error',e=>{console.error(e);process.exit(1)})"

# the refusals
( cd "$PARENT" && "$SV" --probe true >/dev/null 2>&1 ) && { echo "FAIL runs outside a worktree root"; fail=1; } || echo "PASS refuses outside a worktree root"
( cd "$ROOT/scripts" && "$SV" --probe true >/dev/null 2>&1 ) && { echo "FAIL runs from a subdirectory"; fail=1; } || echo "PASS refuses from a subdirectory"

# cleanup: only exact files this test may have created (the sandbox normally prevents the first four)
for f in "$PARENT_FILE" "$HOME_FILE" "$IN_FILE" "$TMP_FILE" "$TMP_DIR/eperm-probe-tmp2-$$"; do
  if [ -e "$f" ]; then
    case "$f" in
      "$ROOT"/*|"$TMP_DIR"/*) rm -f -- "$f" ;;
      *) echo "WARN probe file exists outside allowed roots, left in place for manual review: $f (sandbox leak)"; fail=1 ;;
    esac
  fi
done

[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILED"
exit "$fail"
