#!/bin/bash
# Portability contract for the operator-side ops scripts.
# Run: bash scripts/__tests__/ops-scripts-portable.test.sh
#
# These four scripts were written against one install and carried its values in
# the source: an absolute home path, one tmux session name, one chat id, one
# GitHub slug. Anyone else cloning the repo got scripts that silently watched
# the wrong things. The tests below pin the rule that replaced them -- every
# install-specific value is resolved at runtime -- so the next edit cannot
# quietly bake a local value back in.

set -u

PASS=0; FAIL=0
TMPDIR_BASE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BASE"' EXIT
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS="
scripts/limit-monitor.sh
scripts/pre-modify-backup.sh
scripts/github-pr-monitor.sh
scripts/hooks/telegram-ack.py
"

echo "ops-scripts portability tests"
echo "============================="

# ---------------------------------------------------------------------------
# (a) No install-specific literals anywhere in the sources
# ---------------------------------------------------------------------------
echo ""
echo "(a) No baked-in install values"
# An absolute /home/<user> path, a bare numeric chat id assignment, or a
# hardcoded owner/repo slug are the three shapes that broke portability.
for rel in $SCRIPTS; do
  f="$INSTALL_DIR/$rel"
  [ -f "$f" ] || { fail "$rel exists"; continue; }
  if grep -qE '/home/[a-z]+/' "$f"; then
    fail "$rel: absolute /home path"
  elif grep -qE '^[[:space:]]*(CHAT_ID|ALLOWED_CHAT_ID)=["'"'"']?[0-9]{6,}' "$f"; then
    fail "$rel: hardcoded chat id"
  elif grep -qE '^[[:space:]]*REPO=["'"'"'][A-Za-z0-9_-]+/[A-Za-z0-9_.-]+["'"'"']' "$f"; then
    fail "$rel: hardcoded GitHub slug"
  else
    pass "$rel: no baked-in install values"
  fi
done

# ---------------------------------------------------------------------------
# (b) The session name follows a renamed install
# ---------------------------------------------------------------------------
# A rename changes MAIN_AGENT_ID, and the channels tmux session is named after
# it. A monitor still grepping the old session name reads an empty pane forever
# and reports "healthy" -- the worst failure mode for a guard.
echo ""
echo "(b) limit-monitor follows MAIN_AGENT_ID"
CASE="$TMPDIR_BASE/rename"; mkdir -p "$CASE/scripts" "$CASE/store"
cp "$INSTALL_DIR/scripts/limit-monitor.sh" "$CASE/scripts/"
printf 'MAIN_AGENT_ID=renamedbot\nALLOWED_CHAT_ID=111222333\n' > "$CASE/.env"
OUT="$(cd "$CASE" && bash -x scripts/limit-monitor.sh 2>&1 | grep -E "SESSION=|tmux capture-pane" | head -3)"
case "$OUT" in
  *renamedbot-channels*) pass "session resolves to renamedbot-channels" ;;
  *) fail "session did not follow MAIN_AGENT_ID (got: ${OUT:-empty})" ;;
esac

# ---------------------------------------------------------------------------
# (c) No owner chat -> stay silent, do not guess
# ---------------------------------------------------------------------------
# A fresh install has no ALLOWED_CHAT_ID yet. Alerting somewhere anyway would
# mean sending this install's quota warnings to a stranger's chat.
echo ""
echo "(c) limit-monitor without ALLOWED_CHAT_ID"
CASE="$TMPDIR_BASE/nochat"; mkdir -p "$CASE/scripts" "$CASE/store"
cp "$INSTALL_DIR/scripts/limit-monitor.sh" "$CASE/scripts/"
printf 'MAIN_AGENT_ID=somebot\n' > "$CASE/.env"
(cd "$CASE" && bash scripts/limit-monitor.sh >/dev/null 2>&1)
if grep -q "no ALLOWED_CHAT_ID" "$CASE/store/limit-monitor.log" 2>/dev/null; then
  pass "exits with a logged reason instead of guessing a chat"
else
  fail "no explanatory log line for the missing chat id"
fi

# ---------------------------------------------------------------------------
# (d) pre-modify-backup resolves its own repo root
# ---------------------------------------------------------------------------
# It used to hold one absolute path, so a second checkout backed up the FIRST
# install's database while reporting success.
echo ""
echo "(d) pre-modify-backup uses its own location"
CASE="$TMPDIR_BASE/backup"; mkdir -p "$CASE/scripts" "$CASE/store"
cp "$INSTALL_DIR/scripts/pre-modify-backup.sh" "$CASE/scripts/"
echo "sentinel" > "$CASE/store/.dashboard-token"
(cd "$CASE" && bash scripts/pre-modify-backup.sh testlabel >/dev/null 2>&1)
if find "$CASE/store/backups" -name '.dashboard-token' 2>/dev/null | grep -q .; then
  pass "snapshot landed under its own store/, not another install's"
else
  fail "no snapshot in this checkout's store/backups"
fi

echo ""
echo "======================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
