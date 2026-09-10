#!/bin/bash
# Contract tests for scripts/install-slack-progress-hook.sh
# Run: bash scripts/__tests__/install-slack-progress-hook.test.sh
#
# Mirrors scripts/__tests__/install-telegram-progress-hook.test.sh. Verifies:
#   (a) does NOT source the .env file (no `set -a; . .env` pattern)
#   (b) does NOT fail when .env contains an unquoted value with spaces
#   (c) does NOT execute code from a $(...) value in .env
#   (d) correctly reads SERVICE_ID / BOT_NAME with and without quoting
#   (e) falls back to defaults when .env is absent
#   (f) MAIN_AGENT_ID fallback when SERVICE_ID absent
#   (g) copies hook files to the destination + patches settings.json with the
#       PostToolUse matcher (core behaviour preserved)
#
# All filesystem operations use a fully isolated temp tree -- the real
# ~/.claude directory and the real INSTALL_DIR are never touched.

set -u

PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"
  else fail "$1 (expected '$2', got '$3')"; fi
}
assert_zero()   { if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1 (exit=$2)"; fi; }
assert_absent() { if [ ! -e "$1" ]; then pass "$2"; else fail "$2 (should not exist: $1)"; fi; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/install-slack-progress-hook.sh"

echo ""
echo "(a) Static check: .env must NOT be sourced"
if grep -qE '^\s*(set\s+-a|source\s+.*\.env|\.\s+.*\.env)' "$SCRIPT"; then
  fail "static check: script still sources the .env (set -a / source / . .env pattern found)"
else
  pass "static check: no .env sourcing found"
fi
if grep -q 'read_env' "$SCRIPT"; then
  pass "static check: read_env function present"
else
  fail "static check: read_env function missing"
fi

run_env_parse() {
  local install_dir="$1"
  local func_block
  func_block="$(sed -n '/^read_env()/,/^BOT_NAME=.*Marveen/p' "$SCRIPT")"
  bash -c "
    set -euo pipefail
    INSTALL_DIR='$install_dir'
    $func_block
    echo \"SERVICE_ID=\$SERVICE_ID\"
    echo \"BOT_NAME=\$BOT_NAME\"
  " 2>&1
}

echo ""
echo "(b) Unquoted space value in .env"
CASE="$TMP/case-b"
mkdir -p "$CASE"
cat > "$CASE/.env" <<'EOF'
SERVICE_ID=mysvc
OWNER_NAME=Foo Bar
BOT_NAME=MyBot
EOF
OUT="$(run_env_parse "$CASE")"
EXIT=$?
assert_zero "unquoted space: exits 0"             $EXIT
assert_eq   "unquoted space: SERVICE_ID correct"  "SERVICE_ID=mysvc" "$(echo "$OUT" | grep '^SERVICE_ID=')"
assert_eq   "unquoted space: BOT_NAME correct"    "BOT_NAME=MyBot"   "$(echo "$OUT" | grep '^BOT_NAME=')"

echo ""
echo "(c) \$(...) command substitution in .env -- no execution"
CANARY="$TMP/canary"
CASE="$TMP/case-c"
mkdir -p "$CASE"
cat > "$CASE/.env" <<EOF
SERVICE_ID=safe
DANGER_KEY=\$(touch "$CANARY")
BOT_NAME=SafeBot
EOF
OUT="$(run_env_parse "$CASE")"
EXIT=$?
assert_zero "cmd-injection: exits 0"              $EXIT
assert_eq   "cmd-injection: SERVICE_ID correct"   "SERVICE_ID=safe"  "$(echo "$OUT" | grep '^SERVICE_ID=')"
assert_eq   "cmd-injection: BOT_NAME correct"     "BOT_NAME=SafeBot" "$(echo "$OUT" | grep '^BOT_NAME=')"
assert_absent "$CANARY" "cmd-injection: canary NOT created"

echo ""
echo "(d) Quoted values in .env"
CASE="$TMP/case-d"
mkdir -p "$CASE"
cat > "$CASE/.env" <<'EOF'
SERVICE_ID="double-quoted"
BOT_NAME='single-quoted'
EOF
OUT="$(run_env_parse "$CASE")"
EXIT=$?
assert_zero "quoted: exits 0"                       $EXIT
assert_eq   "quoted: double-quote stripped"  "SERVICE_ID=double-quoted" "$(echo "$OUT" | grep '^SERVICE_ID=')"
assert_eq   "quoted: single-quote stripped"  "BOT_NAME=single-quoted"   "$(echo "$OUT" | grep '^BOT_NAME=')"

echo ""
echo "(e) Missing .env -> defaults"
CASE="$TMP/case-e"
mkdir -p "$CASE"
OUT="$(run_env_parse "$CASE")"
EXIT=$?
assert_zero "no .env: exits 0"                  $EXIT
assert_eq   "no .env: SERVICE_ID=marveen"  "SERVICE_ID=marveen" "$(echo "$OUT" | grep '^SERVICE_ID=')"
assert_eq   "no .env: BOT_NAME=Marveen"    "BOT_NAME=Marveen"   "$(echo "$OUT" | grep '^BOT_NAME=')"

echo ""
echo "(f) MAIN_AGENT_ID fallback"
CASE="$TMP/case-f"
mkdir -p "$CASE"
cat > "$CASE/.env" <<'EOF'
MAIN_AGENT_ID=myagent
BOT_NAME=MyBot
EOF
OUT="$(run_env_parse "$CASE")"
EXIT=$?
assert_zero "MAIN_AGENT_ID fallback: exits 0"                           $EXIT
assert_eq   "MAIN_AGENT_ID fallback: SERVICE_ID resolves to myagent" \
            "SERVICE_ID=myagent" "$(echo "$OUT" | grep '^SERVICE_ID=')"

echo ""
echo "(g) Full script: hooks copied + PostToolUse matcher patched"
CASE="$TMP/case-g"
HOME_G="$CASE/home"
mkdir -p "$HOME_G/.claude/hooks"
echo '{"hooks":{}}' > "$HOME_G/.claude/settings.json"

OUT2="$(HOME="$HOME_G" bash "$SCRIPT" 2>&1)"
EXIT=$?
assert_zero "full script: exits 0" $EXIT
for f in slack_progress.py slack_progress_clear.py \
          slack_progress_reply_clear.py slack_progress_watchdog.py; do
  if [ -f "$HOME_G/.claude/hooks/$f" ]; then pass "full script: $f copied"
  else fail "full script: $f NOT copied"; fi
done
# The default matcher is the LOOSE regex "slack.*reply" (see the header comment
# in the installer): it matches mcp__plugin_slack-channel_slack__reply whatever
# the exact plugin id turns out to be. This assertion used to demand the old
# literal tool name and so failed against every current install.
if grep -q 'slack\.\*reply' "$HOME_G/.claude/settings.json"; then
  pass "full script: PostToolUse matcher patched into settings.json"
else
  fail "full script: PostToolUse matcher missing from settings.json"
fi

echo ""
echo "(h) SLACK_REPLY_TOOL_MATCHER override is honored"
CASE="$TMP/case-h"
HOME_H="$CASE/home"
mkdir -p "$HOME_H/.claude/hooks"
echo '{"hooks":{}}' > "$HOME_H/.claude/settings.json"
OUT3="$(HOME="$HOME_H" SLACK_REPLY_TOOL_MATCHER='mcp__plugin.custom.custom__reply' bash "$SCRIPT" 2>&1)"
EXIT=$?
assert_zero "matcher override: exits 0" $EXIT
if grep -q 'mcp__plugin.custom.custom__reply' "$HOME_H/.claude/settings.json"; then
  pass "matcher override: custom matcher present in settings.json"
else
  fail "matcher override: custom matcher missing from settings.json"
fi

echo ""
echo "(i) Installing Slack retires the Telegram progress hooks"
# Only the active provider's progress plumbing may stay wired -- otherwise the
# dead provider's hooks run on every turn forever. No fake systemd unit is
# planted here on purpose: `systemctl --user` talks to the real user manager
# regardless of \$HOME, so a unit-removal test belongs in the retire script's
# own test (which neutralises the systemd branch).
CASE="$TMP/case-i"
HOME_I="$CASE/home"
mkdir -p "$HOME_I/.claude/hooks"
cat > "$HOME_I/.claude/settings.json" <<'JSONEOF'
{
  "hooks": {
    "UserPromptSubmit": [
      {"hooks": [
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/unrelated.py"},
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/telegram_progress.py"}
      ]}
    ],
    "PostToolUse": [
      {"matcher": "telegram.*reply",
       "hooks": [{"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/telegram_progress_reply_clear.py"}]}
    ]
  }
}
JSONEOF
OUT4="$(HOME="$HOME_I" bash "$SCRIPT" 2>&1)"
EXIT=$?
assert_zero "retire-on-install: exits 0" $EXIT
if grep -q 'telegram_progress' "$HOME_I/.claude/settings.json"; then
  fail "retire-on-install: telegram hooks still wired"
else
  pass "retire-on-install: telegram hooks unwired"
fi
if grep -q 'slack_progress\.py' "$HOME_I/.claude/settings.json"; then
  pass "retire-on-install: slack hooks wired"
else
  fail "retire-on-install: slack hooks missing"
fi
if grep -q 'unrelated\.py' "$HOME_I/.claude/settings.json"; then
  pass "retire-on-install: unrelated hook preserved"
else
  fail "retire-on-install: unrelated hook was destroyed"
fi

echo ""
echo "===================================================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
