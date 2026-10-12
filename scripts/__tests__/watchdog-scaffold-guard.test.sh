#!/bin/bash
# Contract tests for scripts/watchdog.sh half-scaffolded-agent guard.
#
# Regression origin: the dashboard wizard creates the agent directory first
# and only then generates CLAUDE.md / SOUL.md through an LLM call. On a live
# install that call took over five minutes. The watchdog ticks every few
# minutes, saw the fresh directory as "an agent that should be running", and
# started the session roughly three minutes before CLAUDE.md was written. The
# agent came up with no identity, no rules and no persona, and stayed that
# way: Claude Code reads CLAUDE.md at startup, so nothing short of a restart
# could fix it. From the outside it looks like the creation failed.
#
# Driven through `watchdog.sh --check-scaffolded <dir>`, which evaluates the
# predicate and exits before touching tmux, the dashboard API or the log -- so
# these run from fixtures with no live agent.
# Run: bash scripts/__tests__/watchdog-scaffold-guard.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to
# confirm it actually fails on the bug.
WATCHDOG="${WATCHDOG_BIN:-$INSTALL_DIR/scripts/watchdog.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# $1 = fixture name, $2.. = files to create inside it
make_agent() {
  local dir="$TMP/$1"; shift
  mkdir -p "$dir"
  local f
  for f in "$@"; do printf 'x' > "$dir/$f"; done
  echo "$dir"
}

# $1 = label, $2 = agent dir, $3 = expected output line
expect_check() {
  local got
  got=$(bash "$WATCHDOG" --check-scaffolded "$2" 2>&1)
  if [ "$got" = "$3" ]; then pass "$1"; else fail "$1" "$got"; fi
}

echo "watchdog half-scaffolded-agent guard tests"

# The finished agent: both personality files present, safe to start.
expect_check "complete agent is startable" \
  "$(make_agent complete CLAUDE.md SOUL.md)" "scaffolded=yes"

# The incident itself: the wizard has made the directory, the LLM call is still
# running. Starting here is what produced the identity-less live session.
expect_check "bare directory mid-generation is NOT startable" \
  "$(make_agent bare)" "scaffolded=no"

# CLAUDE.md lands first in the handler (Promise.all resolves both, but a partial
# write or a failed SOUL.md fallback can leave exactly this state). Personality
# is incomplete, so it still must not start.
expect_check "CLAUDE.md alone is NOT startable" \
  "$(make_agent claude-only CLAUDE.md)" "scaffolded=no"

expect_check "SOUL.md alone is NOT startable" \
  "$(make_agent soul-only SOUL.md)" "scaffolded=no"

# A directory that does not exist at all must not report ready either -- the
# loop iterates a glob, but a deleted agent mid-tick must not resurrect.
expect_check "missing directory is NOT startable" \
  "$TMP/does-not-exist" "scaffolded=no"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
