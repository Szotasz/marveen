#!/usr/bin/env bash
# INSTALLDIRTYTREE1103: fail when package-lock.json is not in npm's canonical form.
#
# Why: a fresh `npm install` (the macOS installer's step until this PR, and the
# npm ci -> npm install fallback on every platform) rewrites a non-canonical lock,
# so the customer's tree comes up dirty and every later update goes down the
# stash path. Measured on marveen2, 11-03: #1251 hand-edited the lock and dropped
# better-sqlite3's "hasInstallScript": true; a fresh install added it back (+1 line).
#
# How: a FRESH install into an empty directory, the only shape that reproduces
# it. `npm install --package-lock-only` and an install over an existing
# node_modules both report "up to date" and leave the lock as it is (measured,
# 11-03), so neither can catch this. --ignore-scripts keeps it fast; the flag is
# derived from the package manifest, not from running the script (measured: the
# --ignore-scripts install added the same line).
#
# Usage: bash scripts/check-lockfile-canonical.sh [repo-root]
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lockcheck.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$WORK/"
cp "$WORK/package-lock.json" "$WORK/package-lock.tracked.json"
if ! (cd "$WORK" && npm install --ignore-scripts --no-audit --no-fund --loglevel error >/dev/null); then
  echo "check-lockfile-canonical: npm install failed in $WORK, cannot judge the lock" >&2
  exit 2
fi
if diff -u "$WORK/package-lock.tracked.json" "$WORK/package-lock.json"; then
  echo "check-lockfile-canonical: package-lock.json is canonical"
  exit 0
fi
echo "check-lockfile-canonical: a fresh npm install rewrites package-lock.json (diff above)." >&2
echo "Fix: commit the rewritten lock, e.g. rm -rf node_modules && npm install, then commit package-lock.json." >&2
exit 1
