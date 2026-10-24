#!/usr/bin/env bash
# Run vitest inside a write-restricted macOS sandbox.
#
# Why: a test cleanup that deletes a path built from an empty variable
# (join('', '..') === '..') can remove the PARENT of the working directory.
# Under this sandbox every file write outside the worktree, a private per-run
# temp dir and /dev fails with EPERM, so a bad cleanup cannot reach anything
# else. Network is not restricted (tests listen on loopback).
#
# The per-run temp dir is created here with mktemp -d under the user's own
# DARWIN_USER_TEMP_DIR (never taken from the caller's TMPDIR, which is not
# trusted), exported as TMPDIR, and removed again on exit.
#
# Usage:  scripts/safe-vitest.sh [vitest args...]      runs: npx vitest run "$@"
#         scripts/safe-vitest.sh --probe <cmd> [args]  runs <cmd> in the same sandbox
#                                                      (used by safe-vitest.test.sh)
# Must be started from the root of a git worktree that is NOT under /Volumes.

set -euo pipefail

PROFILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/safe-vitest.sb"

die() { echo "safe-vitest: $*" >&2; exit 2; }

[ "$(uname -s)" = "Darwin" ] || die "macOS sandbox-exec is required"
command -v sandbox-exec >/dev/null 2>&1 || die "sandbox-exec not found"
[ -f "$PROFILE" ] || die "missing profile $PROFILE"

top="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git work tree"
root="$(cd "$top" && pwd -P)"
cwd="$(pwd -P)"
[ "$cwd" = "$root" ] || die "run from the worktree root ($root), not $cwd"
[ -e "$root/.git" ] || die "$root has no .git entry"
case "$root" in
  /Volumes|/Volumes/*) die "refusing to run under /Volumes ($root)" ;;
esac
[ "$root" != "/" ] || die "refusing to run at /"

user_tmp_raw="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)" || die "getconf DARWIN_USER_TEMP_DIR failed"
user_tmp="$(cd "$user_tmp_raw" 2>/dev/null && pwd -P)" || die "cannot resolve DARWIN_USER_TEMP_DIR '$user_tmp_raw'"
case "$user_tmp" in
  /private/var/folders/?*/?*/T|/private/var/folders/?*/?*/T/*) ;;
  *) die "user temp dir '$user_tmp' is not under /private/var/folders/" ;;
esac

run="$(mktemp -d "$user_tmp/safe-vitest.XXXXXXXX")" || die "mktemp -d failed"
run="$(cd "$run" && pwd -P)"
case "$run" in
  /private/var/folders/*/safe-vitest.?*) ;;
  *) die "unexpected per-run dir '$run'" ;;
esac

child=""
cleanup() {
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
  # exactly the directory created above, nothing derived from the environment
  case "$run" in
    /private/var/folders/*/safe-vitest.?*) rm -rf -- "$run" ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export TMPDIR="$run"
# npx/npm write a cache and logs under $HOME by default; keep them in the per-run dir
export npm_config_cache="$run/npm-cache"
export npm_config_update_notifier=false

if [ "${1:-}" = "--probe" ]; then
  shift
  [ "$#" -gt 0 ] || die "--probe needs a command"
  cmd=("$@")
else
  cmd=(npx --no-install vitest run "$@")
fi

set +e
sandbox-exec -D "WT=$root" -D "RUN=$run" -f "$PROFILE" "${cmd[@]}" <&0 &
child=$!
wait "$child"
rc=$?
child=""
exit "$rc"
