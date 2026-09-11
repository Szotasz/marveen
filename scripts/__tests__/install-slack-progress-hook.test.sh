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
#   (h) SLACK_REPLY_TOOL_MATCHER override is honored
#   (i) installing Slack retires the Telegram progress hooks
#   (j) provider gate: CHANNEL_PROVIDER=telegram -> installs NOTHING and
#       retires any leftover Slack hooks (sync-hooks runs every installer)
#   (k) provider gate: missing / unknown CHANNEL_PROVIDER resolves to telegram
#
# All filesystem operations use a fully isolated temp tree -- the real
# ~/.claude directory and the real INSTALL_DIR are never touched. The full-run
# cases feed the installer a temp .env via MARVEEN_ENV_FILE (the installer's
# test hook) so they do not depend on whatever the checkout's own .env says.

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

# Neutralise systemctl for the full-run cases: `systemctl --user` talks to the
# real user manager regardless of $HOME, so with no reachable manager the
# installer only writes unit files and never enables a timer on the dev box.
export DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent-marveen-test"
export XDG_RUNTIME_DIR="$TMP/run"
mkdir -p "$XDG_RUNTIME_DIR"

# A temp .env that makes Slack the active provider for the full-run cases.
ENV_SLACK="$TMP/env-slack"
printf 'SERVICE_ID=testbot\nBOT_NAME=TestBot\nCHANNEL_PROVIDER=slack\n' > "$ENV_SLACK"

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

OUT2="$(HOME="$HOME_G" MARVEEN_ENV_FILE="$ENV_SLACK" bash "$SCRIPT" 2>&1)"
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
OUT3="$(HOME="$HOME_H" MARVEEN_ENV_FILE="$ENV_SLACK" SLACK_REPLY_TOOL_MATCHER='mcp__plugin.custom.custom__reply' bash "$SCRIPT" 2>&1)"
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
OUT4="$(HOME="$HOME_I" MARVEEN_ENV_FILE="$ENV_SLACK" bash "$SCRIPT" 2>&1)"
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
echo "(j) Provider gate: CHANNEL_PROVIDER=telegram -> nothing installed, leftover Slack plumbing retired"
# sync-hooks.sh runs this installer on every update of a Telegram install too.
# It must not wire Slack hooks or write a Slack timer there, and it must clean
# up any Slack plumbing an earlier (ungated) update left behind.
CASE="$TMP/case-j"
HOME_J="$CASE/home"
mkdir -p "$HOME_J/.claude/hooks" "$HOME_J/.config/systemd/user"
cat > "$HOME_J/.claude/settings.json" <<'JSONEOF'
{
  "hooks": {
    "UserPromptSubmit": [
      {"hooks": [
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/telegram_progress.py"},
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/slack_progress.py"}
      ]}
    ],
    "PostToolUse": [
      {"matcher": "slack.*reply",
       "hooks": [{"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/slack_progress_reply_clear.py"}]}
    ]
  }
}
JSONEOF
printf '[Timer]\n' > "$HOME_J/.config/systemd/user/testbot-slack-progress-watchdog.timer"
printf '[Service]\n' > "$HOME_J/.config/systemd/user/testbot-slack-progress-watchdog.service"
ENV_TG="$TMP/env-telegram"
printf 'SERVICE_ID=testbot\nBOT_NAME=TestBot\nCHANNEL_PROVIDER=telegram\n' > "$ENV_TG"
OUT5="$(HOME="$HOME_J" MARVEEN_ENV_FILE="$ENV_TG" bash "$SCRIPT" 2>&1)"
EXIT=$?
assert_zero "provider gate: exits 0" $EXIT
assert_absent "$HOME_J/.claude/hooks/slack_progress.py" "provider gate: no Slack hook file copied"
assert_absent "$HOME_J/.config/systemd/user/testbot-slack-progress-watchdog.timer" "provider gate: leftover Slack timer removed"
assert_absent "$HOME_J/.config/systemd/user/testbot-slack-progress-watchdog.service" "provider gate: leftover Slack service removed"
if grep -q 'slack_progress' "$HOME_J/.claude/settings.json"; then
  fail "provider gate: leftover Slack hooks still wired"
else
  pass "provider gate: leftover Slack hooks unwired"
fi
if grep -q 'telegram_progress\.py' "$HOME_J/.claude/settings.json"; then
  pass "provider gate: Telegram hooks left alone"
else
  fail "provider gate: Telegram hooks were destroyed"
fi

echo ""
echo "(k) Provider gate: missing / unknown CHANNEL_PROVIDER resolves to telegram"
# Mirrors src/channel-provider.ts: an empty or unrecognised value means the
# install runs on Telegram, so the Slack installer must stand down.
for label in "missing" "none" "Slack"; do
  CASE="$TMP/case-k-$label"
  HOME_K="$CASE/home"
  mkdir -p "$HOME_K/.claude/hooks"
  echo '{"hooks":{}}' > "$HOME_K/.claude/settings.json"
  ENV_K="$CASE/env"
  if [ "$label" = "missing" ]; then
    printf 'SERVICE_ID=testbot\n' > "$ENV_K"
  else
    printf 'SERVICE_ID=testbot\nCHANNEL_PROVIDER=%s\n' "$label" > "$ENV_K"
  fi
  OUT6="$(HOME="$HOME_K" MARVEEN_ENV_FILE="$ENV_K" bash "$SCRIPT" 2>&1)"
  EXIT=$?
  assert_zero "provider gate ($label): exits 0" $EXIT
  assert_absent "$HOME_K/.claude/hooks/slack_progress.py" "provider gate ($label): no Slack hook file copied"
  if grep -q 'slack_progress' "$HOME_K/.claude/settings.json"; then
    fail "provider gate ($label): Slack hooks wired"
  else
    pass "provider gate ($label): Slack hooks not wired"
  fi
done

echo ""
echo "===================================================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
