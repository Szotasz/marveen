#!/usr/bin/env bash
# Run vitest inside a write-restricted macOS sandbox.
#
# Why: a test cleanup that deletes a path built from an empty variable
# (join('', '..') === '..') can remove the PARENT of the working directory.
# Under this sandbox every file write outside the worktree, the temp dir and the
# system scratch areas fails with EPERM, so a bad cleanup cannot reach anything
# else. Network is not restricted (tests listen on loopback).
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

tmp_raw="${TMPDIR:-/tmp}"
tmp="$(cd "$tmp_raw" 2>/dev/null && pwd -P)" || die "cannot resolve TMPDIR '$tmp_raw'"
export TMPDIR="$tmp"
# npx/npm write a cache and logs under $HOME by default; keep them in the temp dir
export npm_config_cache="$tmp/safe-vitest-npm-cache"
export npm_config_update_notifier=false

if [ "${1:-}" = "--probe" ]; then
  shift
  [ "$#" -gt 0 ] || die "--probe needs a command"
  exec sandbox-exec -D "WT=$root" -D "TMP=$tmp" -f "$PROFILE" "$@"
fi

exec sandbox-exec -D "WT=$root" -D "TMP=$tmp" -f "$PROFILE" npx --no-install vitest run "$@"
