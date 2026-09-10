#!/bin/bash
# Contract tests for scripts/retire-progress-watchdog.sh
# Run: bash scripts/__tests__/retire-progress-watchdog.test.sh
#
# Verifies:
#   (a) removes ONLY the named provider's progress hooks from settings.json
#   (b) leaves unrelated hooks and non-hook settings untouched
#   (c) prunes groups left empty, so re-installs do not stack dead matchers
#   (d) --dry-run changes nothing on disk
#   (e) refuses to retire the ACTIVE CHANNEL_PROVIDER without --force
#   (f) removes the systemd unit files
#   (g) idempotent: a second run is a clean no-op, exit 0
#   (h) rejects an unknown provider argument
#
# All filesystem operations use an isolated temp HOME. The systemd branch is
# neutralised (bogus DBUS/XDG_RUNTIME_DIR) because `systemctl --user` talks to
# the real user manager regardless of $HOME -- without this, the test would
# disable the developer's actual timer.

set -u

PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_zero()    { if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1 (exit=$2)"; fi; }
assert_nonzero() { if [ "$2" -ne 0 ]; then pass "$1"; else fail "$1 (expected non-zero exit)"; fi; }
assert_grep()    { if grep -q "$2" "$3"; then pass "$1"; else fail "$1 (pattern '$2' not in $3)"; fi; }
assert_no_grep() { if grep -q "$2" "$3"; then fail "$1 (pattern '$2' still in $3)"; else pass "$1"; fi; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/retire-progress-watchdog.sh"

# Neutralise systemctl: no reachable user manager -> the script skips the
# disable call but still removes the unit files.
export DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent-marveen-test"
export XDG_RUNTIME_DIR="$TMP/run"
mkdir -p "$XDG_RUNTIME_DIR"

# SERVICE_ID comes from the repo .env; fall back to the same default the
# script uses so the unit-name assertions match on a bare checkout.
SERVICE_ID="$(grep -E '^SERVICE_ID=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')"
if [ -z "$SERVICE_ID" ]; then
  SERVICE_ID="$(grep -E '^MAIN_AGENT_ID=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')"
fi
SERVICE_ID="${SERVICE_ID:-marveen}"
ACTIVE_PROVIDER="$(grep -E '^CHANNEL_PROVIDER=' "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')"
ACTIVE_PROVIDER="${ACTIVE_PROVIDER:-}"

make_home() {
  local home="$1"
  mkdir -p "$home/.claude" "$home/.config/systemd/user"
  cat > "$home/.claude/settings.json" <<'JSONEOF'
{
  "permissions": {"allow": ["Bash(ls:*)"]},
  "hooks": {
    "UserPromptSubmit": [
      {"hooks": [
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/unrelated.py"},
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/telegram_progress.py"},
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/slack_progress.py"}
      ]}
    ],
    "Stop": [
      {"hooks": [{"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/telegram_progress_clear.py"}]}
    ],
    "PostToolUse": [
      {"matcher": "telegram.*reply",
       "hooks": [{"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/telegram_progress_reply_clear.py"}]}
    ]
  }
}
JSONEOF
}

echo ""
echo "(a-c) Retires telegram: only its hooks go, empty groups pruned"
H="$TMP/case-a"; make_home "$H"
OUT="$(HOME="$H" bash "$SCRIPT" telegram 2>&1)"; EXIT=$?
assert_zero    "retire telegram: exits 0" $EXIT
assert_no_grep "telegram_progress hooks removed"     'telegram_progress' "$H/.claude/settings.json"
assert_grep    "slack_progress hook preserved"       'slack_progress'    "$H/.claude/settings.json"
assert_grep    "unrelated hook preserved"            'unrelated\.py'     "$H/.claude/settings.json"
assert_grep    "non-hook settings preserved"         'Bash(ls:\*)'       "$H/.claude/settings.json"
# Stop had ONLY the telegram hook -> the whole event key must be gone, not
# left as an empty list that later installs would append beside.
if python3 -c "
import json,sys
h=json.load(open('$H/.claude/settings.json'))['hooks']
sys.exit(0 if 'Stop' not in h and 'PostToolUse' not in h else 1)"; then
  pass "emptied event keys pruned (Stop, PostToolUse)"
else
  fail "emptied event keys NOT pruned"
fi

echo ""
echo "(d) --dry-run changes nothing"
H="$TMP/case-d"; make_home "$H"
BEFORE="$(md5sum < "$H/.claude/settings.json")"
OUT="$(HOME="$H" bash "$SCRIPT" telegram --dry-run 2>&1)"; EXIT=$?
AFTER="$(md5sum < "$H/.claude/settings.json")"
assert_zero "dry-run: exits 0" $EXIT
if [ "$BEFORE" = "$AFTER" ]; then pass "dry-run: settings.json untouched"
else fail "dry-run: settings.json was modified"; fi
case "$OUT" in
  *"[dry-run]"*) pass "dry-run: announces the pending change" ;;
  *) fail "dry-run: no [dry-run] marker in output" ;;
esac

echo ""
echo "(e) Refuses to retire the active provider without --force"
if [ -n "$ACTIVE_PROVIDER" ]; then
  H="$TMP/case-e"; make_home "$H"
  OUT="$(HOME="$H" bash "$SCRIPT" "$ACTIVE_PROVIDER" 2>&1)"; EXIT=$?
  assert_nonzero "active provider ($ACTIVE_PROVIDER): refused" $EXIT
  case "$OUT" in
    *"Refusing to retire"*) pass "active provider: explains why" ;;
    *) fail "active provider: no explanation in output" ;;
  esac
  OUT="$(HOME="$H" bash "$SCRIPT" "$ACTIVE_PROVIDER" --force 2>&1)"; EXIT=$?
  assert_zero "active provider + --force: proceeds" $EXIT
else
  echo "  SKIP: no CHANNEL_PROVIDER in .env"
fi

echo ""
echo "(f) Removes the systemd unit files"
H="$TMP/case-f"; make_home "$H"
UNIT_DIR="$H/.config/systemd/user"
SVC="${SERVICE_ID}-telegram-progress-watchdog"
touch "$UNIT_DIR/$SVC.timer" "$UNIT_DIR/$SVC.service"
OUT="$(HOME="$H" bash "$SCRIPT" telegram 2>&1)"; EXIT=$?
assert_zero "unit removal: exits 0" $EXIT
if [ ! -e "$UNIT_DIR/$SVC.timer" ] && [ ! -e "$UNIT_DIR/$SVC.service" ]; then
  pass "unit removal: .timer and .service deleted"
else
  fail "unit removal: unit files survived"
fi

echo ""
echo "(g) Idempotent: second run is a clean no-op"
OUT="$(HOME="$H" bash "$SCRIPT" telegram 2>&1)"; EXIT=$?
assert_zero "re-run: exits 0" $EXIT
case "$OUT" in
  *"already clean"*) pass "re-run: reports nothing to retire" ;;
  *) fail "re-run: did not report a clean state (got: $OUT)" ;;
esac

echo ""
echo "(h) Rejects an unknown provider"
H="$TMP/case-h"; make_home "$H"
OUT="$(HOME="$H" bash "$SCRIPT" carrierpigeon 2>&1)"; EXIT=$?
assert_nonzero "unknown provider: non-zero exit" $EXIT
assert_no_grep "unknown provider: settings.json untouched" 'carrierpigeon' "$H/.claude/settings.json"

echo ""
echo "===================================================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
