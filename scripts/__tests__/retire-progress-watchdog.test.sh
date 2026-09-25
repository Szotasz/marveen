#!/bin/bash
# Contract tests for scripts/retire-progress-watchdog.sh
# Run: bash scripts/__tests__/retire-progress-watchdog.test.sh
#
# Verifies:
#   (0) the script parses under the SYSTEM bash (/bin/bash -- bash 3.2 on
#       macOS) and keeps its command substitutions free of here-documents
#   (a) removes ONLY the named provider's progress hooks from settings.json
#   (b) leaves unrelated hooks and non-hook settings untouched
#   (c) prunes groups left empty, so re-installs do not stack dead matchers
#   (d) --dry-run changes nothing on disk
#   (e) refuses to retire the ACTIVE CHANNEL_PROVIDER without --force
#   (f) removes the watchdog daemon: the systemd unit files (Linux branch) AND
#       the launchd plist (macOS branch) -- both on every platform
#   (g) idempotent: a second run is a clean no-op, exit 0
#   (h) rejects an unknown provider argument
#   (i) a settings.json the helper cannot read fails LOUDLY, not silently
#
# Hermetic on every platform:
#   - isolated temp HOME, and a temp .env handed in via MARVEEN_ENV_FILE (the
#     script's test hook), so nothing depends on the checkout's own .env;
#   - launchctl / systemctl / pidof are PATH-shimmed for EVERY run. Both
#     service managers act on the real user domain regardless of $HOME, so an
#     unshimmed run (un)loads real jobs on the developer's box;
#   - uname is shimmed too (FAKE_UNAME), so BOTH daemon branches are exercised
#     wherever the suite runs. The launchd branch used to be reachable only on
#     a Mac and the systemd one only on Linux -- which is how a script that
#     could not even be parsed on macOS shipped with a green suite;
#   - the script runs under /bin/bash when there is one: that is what its
#     shebang names, and on macOS it is bash 3.2 even when a newer bash comes
#     first in PATH.

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

if [ -x /bin/bash ]; then SYS_BASH=/bin/bash; else SYS_BASH="$(command -v bash)"; fi

# Belt under the shims: no reachable user manager even if one were bypassed.
export DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent-marveen-test"
export XDG_RUNTIME_DIR="$TMP/run"
mkdir -p "$XDG_RUNTIME_DIR"

# --- PATH shims: they only log their argv, and fail like an absent manager ---
SHIM_BIN="$TMP/shim-bin"; SHIM_LOG="$TMP/shim-calls.log"
mkdir -p "$SHIM_BIN"; : > "$SHIM_LOG"
for stub in launchctl systemctl pidof; do
  printf '#!/bin/bash\necho "%s $*" >> "%s"\nexit 1\n' "$stub" "$SHIM_LOG" > "$SHIM_BIN/$stub"
  chmod +x "$SHIM_BIN/$stub"
done
printf '#!/bin/bash\necho "${FAKE_UNAME:-Linux}"\n' > "$SHIM_BIN/uname"
chmod +x "$SHIM_BIN/uname"

# No CHANNEL_PROVIDER here: the active-provider guard is case (e)'s subject.
SERVICE_ID="testbot"
ENV_FILE="$TMP/env"
printf 'SERVICE_ID=%s\nBOT_NAME=TestBot\n' "$SERVICE_ID" > "$ENV_FILE"

# run_retire <home> [script args...]   (FAKE_UNAME / ENV_FILE read from the caller)
run_retire() {
  local home="$1"; shift
  HOME="$home" MARVEEN_ENV_FILE="$ENV_FILE" PATH="$SHIM_BIN:$PATH" \
    FAKE_UNAME="${FAKE_UNAME:-Linux}" "$SYS_BASH" "$SCRIPT" "$@" 2>&1
}

make_home() {
  local home="$1"
  mkdir -p "$home/.claude" "$home/.config/systemd/user" "$home/Library/LaunchAgents"
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
echo "(0) Parses under the system bash; no here-document inside a command substitution"
# bash 3.2 (macOS /bin/bash) does not skip a here-document body while scanning
# "$( ... )" for its closing paren: one apostrophe in an embedded Python block
# made the whole script unparseable there, and the installers' `|| true` turned
# that into a silent no-op. `bash -n` catches it only where bash IS 3.2, so the
# static lint below keeps the construct out on every platform.
SYS_BASH_VERSION="$("$SYS_BASH" -c 'echo $BASH_VERSION')"
ERR="$("$SYS_BASH" -n "$SCRIPT" 2>&1)"; EXIT=$?
if [ "$EXIT" -eq 0 ]; then pass "$SYS_BASH -n: the script parses (bash $SYS_BASH_VERSION)"
else fail "$SYS_BASH -n: parse error under bash $SYS_BASH_VERSION ($ERR)"; fi
HEREDOC_IN_SUBST='\$\([^)]*<<'
HIT="$(grep -nE "$HEREDOC_IN_SUBST" "$SCRIPT" | head -1)"
if [ -n "$HIT" ]; then
  fail "static check: a here-document opens inside a command substitution ($HIT)"
else
  pass "static check: no here-document inside a command substitution"
fi

echo ""
echo "(a-c) Retires telegram: only its hooks go, empty groups pruned"
H="$TMP/case-a"; make_home "$H"
OUT="$(run_retire "$H" telegram)"; EXIT=$?
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
# The helper's stdout contract reaches the operator: one line per removed hook.
case "$OUT" in
  *"  - UserPromptSubmit: "*"telegram_progress.py"*) pass "removed hooks are listed (REMOVED lines reach the output)" ;;
  *) fail "removed hooks are not listed in the output (got: $OUT)" ;;
esac
case "$OUT" in
  *"Unwired 3 telegram progress hook(s)"*) pass "removed hooks are counted (COUNT line parsed)" ;;
  *) fail "no 'Unwired 3 ...' summary in the output (got: $OUT)" ;;
esac

echo ""
echo "(d) --dry-run changes nothing"
H="$TMP/case-d"; make_home "$H"
# cksum, not md5sum: macOS ships no md5sum, and a missing tool made BEFORE and
# AFTER both empty -- a comparison that could never fail.
BEFORE="$(cksum < "$H/.claude/settings.json")"
OUT="$(run_retire "$H" telegram --dry-run)"; EXIT=$?
AFTER="$(cksum < "$H/.claude/settings.json")"
assert_zero "dry-run: exits 0" $EXIT
if [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ]; then pass "dry-run: settings.json untouched"
else fail "dry-run: settings.json was modified (or no checksum: '$BEFORE')"; fi
case "$OUT" in
  *"[dry-run]"*) pass "dry-run: announces the pending change" ;;
  *) fail "dry-run: no [dry-run] marker in output" ;;
esac

echo ""
echo "(e) Refuses to retire the active provider without --force"
ENV_ACTIVE="$TMP/env-active"
printf 'SERVICE_ID=%s\nCHANNEL_PROVIDER=slack\n' "$SERVICE_ID" > "$ENV_ACTIVE"
H="$TMP/case-e"; make_home "$H"
OUT="$(ENV_FILE="$ENV_ACTIVE" run_retire "$H" slack)"; EXIT=$?
assert_nonzero "active provider (slack): refused" $EXIT
case "$OUT" in
  *"Refusing to retire"*) pass "active provider: explains why" ;;
  *) fail "active provider: no explanation in output" ;;
esac
assert_grep "active provider: refused run left the hooks wired" 'slack_progress' "$H/.claude/settings.json"
OUT="$(ENV_FILE="$ENV_ACTIVE" run_retire "$H" slack --force)"; EXIT=$?
assert_zero "active provider + --force: proceeds" $EXIT
assert_no_grep "active provider + --force: hooks unwired" 'slack_progress' "$H/.claude/settings.json"

echo ""
echo "(f) Removes the systemd unit files (Linux branch)"
H="$TMP/case-f"; make_home "$H"
UNIT_DIR="$H/.config/systemd/user"
SVC="${SERVICE_ID}-telegram-progress-watchdog"
touch "$UNIT_DIR/$SVC.timer" "$UNIT_DIR/$SVC.service"
OUT="$(FAKE_UNAME=Linux run_retire "$H" telegram)"; EXIT=$?
assert_zero "unit removal: exits 0" $EXIT
if [ ! -e "$UNIT_DIR/$SVC.timer" ] && [ ! -e "$UNIT_DIR/$SVC.service" ]; then
  pass "unit removal: .timer and .service deleted"
else
  fail "unit removal: unit files survived"
fi

echo ""
echo "(g) Idempotent: second run is a clean no-op"
OUT="$(FAKE_UNAME=Linux run_retire "$H" telegram)"; EXIT=$?
assert_zero "re-run: exits 0" $EXIT
case "$OUT" in
  *"already clean"*) pass "re-run: reports nothing to retire" ;;
  *) fail "re-run: did not report a clean state (got: $OUT)" ;;
esac

echo ""
echo "(f-mac) Removes the launchd plist (macOS branch)"
H="$TMP/case-f-mac"; make_home "$H"
LABEL="com.${SERVICE_ID}.telegram-progress-watchdog"
PLIST="$H/Library/LaunchAgents/$LABEL.plist"
OTHER_PLIST="$H/Library/LaunchAgents/com.${SERVICE_ID}.slack-progress-watchdog.plist"
printf '<plist/>\n' > "$PLIST"
printf '<plist/>\n' > "$OTHER_PLIST"
: > "$SHIM_LOG"
OUT="$(FAKE_UNAME=Darwin run_retire "$H" telegram)"; EXIT=$?
assert_zero "plist removal: exits 0" $EXIT
if [ ! -e "$PLIST" ]; then pass "plist removal: $LABEL.plist deleted"
else fail "plist removal: the plist survived"; fi
if [ -e "$OTHER_PLIST" ]; then pass "plist removal: the other provider's plist left alone"
else fail "plist removal: the other provider's plist was deleted too"; fi
# The job is unloaded before its plist goes -- and through the shim, which is
# the proof that this suite never reached the host's real launchd.
assert_grep "plist removal: launchctl unload called on the plist" \
            "^launchctl unload .*$LABEL\.plist" "$SHIM_LOG"
assert_no_grep "plist removal: telegram hooks unwired on this branch too" \
               'telegram_progress' "$H/.claude/settings.json"
OUT="$(FAKE_UNAME=Darwin run_retire "$H" telegram)"; EXIT=$?
assert_zero "plist removal re-run: exits 0" $EXIT
case "$OUT" in
  *"already clean"*) pass "plist removal re-run: reports nothing to retire" ;;
  *) fail "plist removal re-run: did not report a clean state (got: $OUT)" ;;
esac

echo ""
echo "(h) Rejects an unknown provider"
H="$TMP/case-h"; make_home "$H"
OUT="$(run_retire "$H" carrierpigeon)"; EXIT=$?
assert_nonzero "unknown provider: non-zero exit" $EXIT
assert_no_grep "unknown provider: settings.json untouched" 'carrierpigeon' "$H/.claude/settings.json"

echo ""
echo "(i) An unreadable settings.json fails loudly"
# The callers report a non-zero retire; that only helps if a failed unwire
# IS non-zero and says what it could not do.
H="$TMP/case-i"; make_home "$H"
printf '{ this is not json' > "$H/.claude/settings.json"
OUT="$(run_retire "$H" telegram)"; EXIT=$?
assert_nonzero "corrupt settings.json: non-zero exit" $EXIT
case "$OUT" in
  *"Could not unwire"*) pass "corrupt settings.json: says what failed" ;;
  *) fail "corrupt settings.json: no explanation in output (got: $OUT)" ;;
esac

echo ""
echo "===================================================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
