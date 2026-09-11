#!/bin/bash
# Contract test for the provider gate across BOTH progress-hook installers, run
# the way scripts/sync-hooks.sh runs them on every update: every
# install-*-progress-hook.sh, in glob order (slack first, telegram last).
# Run: bash scripts/__tests__/sync-hooks-provider-gate.test.sh
#
# The bug this locks: each installer used to wire its own hooks + timer
# unconditionally and only the cross-retire was guarded by the active-provider
# check, so on a Slack install every update ended with BOTH providers live --
# the Telegram installer (running last) re-wired telegram_progress*.py and
# re-enabled its timer right after the Slack installer had retired them. The
# mirror image churned every Telegram install (Slack timer created + enabled,
# then torn down again, a settings.json.bak-retire-slack left behind each time).
#
# Asserts, for CHANNEL_PROVIDER=slack and =telegram:
#   - after the glob-ordered run only the active provider's hooks are wired
#     and only its watchdog units exist, whatever the order;
#   - a second run (the next update) is a no-op: identical settings.json, no
#     retire backup left behind;
#   - an unrelated hook survives every pass.
#
# Hermetic: temp HOME, temp .env via MARVEEN_ENV_FILE (the installers' test
# hook), systemctl neutralised so nothing on the dev box is enabled/disabled.

set -u

PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_zero()   { if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1 (exit=$2)"; fi; }
assert_exists() { if [ -e "$1" ]; then pass "$2"; else fail "$2 (missing: $1)"; fi; }
assert_absent() { if [ ! -e "$1" ]; then pass "$2"; else fail "$2 (should not exist: $1)"; fi; }
assert_grep()    { if grep -q "$2" "$3"; then pass "$1"; else fail "$1 (pattern '$2' not in $3)"; fi; }
assert_no_grep() { if grep -q "$2" "$3"; then fail "$1 (pattern '$2' still in $3)"; else pass "$1"; fi; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS="$REPO_ROOT/scripts"

# `systemctl --user` talks to the real user manager regardless of $HOME.
export DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent-marveen-test"
export XDG_RUNTIME_DIR="$TMP/run"
mkdir -p "$XDG_RUNTIME_DIR"

UNITS_REL=".config/systemd/user"
PLIST_REL="Library/LaunchAgents"

# Same loop as sync-hooks.sh, restricted to the two progress installers so the
# unrelated install-*-hook.sh scripts (git guard, secret gate, ...) stay out.
run_sync() { # home env_file
  local home="$1" env_file="$2" rc=0 installer
  for installer in "$SCRIPTS"/install-*-progress-hook.sh; do
    [ -e "$installer" ] || continue
    HOME="$home" MARVEEN_ENV_FILE="$env_file" bash "$installer" >/dev/null 2>&1 || rc=1
  done
  return $rc
}

# Seed a HOME that looks like an install after an UNGATED update: both hook
# sets wired and both providers' units present.
seed_home() { # home
  local home="$1"
  mkdir -p "$home/.claude/hooks" "$home/$UNITS_REL" "$home/$PLIST_REL"
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
      {"hooks": [
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/telegram_progress_clear.py"},
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/slack_progress_clear.py"}
      ]}
    ],
    "PostToolUse": [
      {"matcher": "telegram.*reply",
       "hooks": [{"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/telegram_progress_reply_clear.py"}]},
      {"matcher": "slack.*reply",
       "hooks": [{"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/slack_progress_reply_clear.py"}]}
    ]
  }
}
JSONEOF
  for prov in telegram slack; do
    printf '[Timer]\n' > "$home/$UNITS_REL/testbot-$prov-progress-watchdog.timer"
    printf '[Service]\n' > "$home/$UNITS_REL/testbot-$prov-progress-watchdog.service"
    printf '<plist/>\n' > "$home/$PLIST_REL/com.testbot.$prov-progress-watchdog.plist"
  done
}

# The watchdog unit the installer writes on THIS platform.
unit_of() { # home provider
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "$1/$PLIST_REL/com.testbot.$2-progress-watchdog.plist"
  else
    echo "$1/$UNITS_REL/testbot-$2-progress-watchdog.timer"
  fi
}

# Since #1305 (ISSUE1305HOOKSCOPE) the Telegram installer no longer writes the
# user-global settings.json and no longer copies hook files into
# ~/.claude/hooks -- its three settings hooks are repo-shipped in the tracked
# project .claude/settings.json. The Slack installer still does both. What this
# test is about (the provider gate) is identical either way; only the
# user-global surface an active installer is expected to create differs.
writes_user_global() { [ "$1" != "telegram" ]; }

check_end_state() { # label home active inactive
  local label="$1" home="$2" active="$3" inactive="$4"
  local settings="$home/.claude/settings.json"
  if writes_user_global "$active"; then
    assert_grep   "$label: ${active} UserPromptSubmit hook wired" "${active}_progress.py"           "$settings"
    assert_grep   "$label: ${active} Stop hook wired"             "${active}_progress_clear.py"     "$settings"
    assert_grep   "$label: ${active} PostToolUse hook wired"      "${active}_progress_reply_clear"  "$settings"
    assert_exists "$home/.claude/hooks/${active}_progress.py"     "$label: ${active} hook files installed"
  else
    # Repo-shipped hooks: the installer must leave the seeded user-global
    # entries of its own provider exactly as they were (it neither adds nor
    # removes them) and must copy nothing into ~/.claude/hooks.
    assert_absent "$home/.claude/hooks/${active}_progress.py"                   "$label: ${active} hook files NOT copied (repo-shipped since #1305)"
  fi
  assert_no_grep "$label: no ${inactive} hooks wired"            "${inactive}_progress"            "$settings"
  assert_grep    "$label: unrelated hook preserved"              "unrelated.py"                    "$settings"
  assert_exists "$(unit_of "$home" "$active")"   "$label: ${active} watchdog unit present"
  assert_absent "$(unit_of "$home" "$inactive")" "$label: ${inactive} watchdog unit gone"
  assert_absent "$home/$UNITS_REL/testbot-$inactive-progress-watchdog.service" "$label: ${inactive} service unit gone"
  # Every ${inactive}_progress* entry must be gone, but the count of the
  # active provider's entries must be exactly 3 -- one per event, no
  # duplicates stacked by re-runs.
  if writes_user_global "$active"; then
    local n
    n="$(grep -o "${active}_progress[a-z_]*\.py" "$settings" | sort -u | wc -l | tr -d ' ')"
    if [ "$n" = "3" ]; then pass "$label: exactly 3 distinct ${active} hook entries"
    else fail "$label: expected 3 distinct ${active} hook entries, got $n"; fi
  fi
}

for ACTIVE in slack telegram; do
  if [ "$ACTIVE" = "slack" ]; then INACTIVE=telegram; else INACTIVE=slack; fi
  echo ""
  echo "== CHANNEL_PROVIDER=$ACTIVE: glob-ordered sync of both installers"
  HOME_X="$TMP/home-$ACTIVE"
  seed_home "$HOME_X"
  ENV_X="$TMP/env-$ACTIVE"
  printf 'SERVICE_ID=testbot\nBOT_NAME=TestBot\nCHANNEL_PROVIDER=%s\n' "$ACTIVE" > "$ENV_X"

  run_sync "$HOME_X" "$ENV_X"
  assert_zero "$ACTIVE: first sync exits 0" $?
  check_end_state "$ACTIVE/1st" "$HOME_X" "$ACTIVE" "$INACTIVE"

  echo "-- second sync (the next update) must be a no-op"
  cp "$HOME_X/.claude/settings.json" "$TMP/settings-$ACTIVE-after1.json"
  rm -f "$HOME_X"/.claude/settings.json.bak-retire-*
  run_sync "$HOME_X" "$ENV_X"
  assert_zero "$ACTIVE: second sync exits 0" $?
  check_end_state "$ACTIVE/2nd" "$HOME_X" "$ACTIVE" "$INACTIVE"
  if cmp -s "$HOME_X/.claude/settings.json" "$TMP/settings-$ACTIVE-after1.json"; then
    pass "$ACTIVE: settings.json byte-identical after the second sync"
  else
    fail "$ACTIVE: settings.json changed on the second sync"
  fi
  if ls "$HOME_X"/.claude/settings.json.bak-retire-* >/dev/null 2>&1; then
    fail "$ACTIVE: second sync left a retire backup behind ($(ls "$HOME_X"/.claude/settings.json.bak-retire-* | xargs -n1 basename | tr '\n' ' '))"
  else
    pass "$ACTIVE: second sync left no retire backup behind"
  fi
done

echo ""
echo "== Reverse order (telegram installer first, then slack) gives the same end state"
# The gate must make the outcome independent of glob order.
HOME_R="$TMP/home-reverse"
seed_home "$HOME_R"
ENV_R="$TMP/env-reverse"
printf 'SERVICE_ID=testbot\nBOT_NAME=TestBot\nCHANNEL_PROVIDER=slack\n' > "$ENV_R"
rc=0
for name in install-telegram-progress-hook.sh install-slack-progress-hook.sh; do
  HOME="$HOME_R" MARVEEN_ENV_FILE="$ENV_R" bash "$SCRIPTS/$name" >/dev/null 2>&1 || rc=1
done
assert_zero "reverse: both installers exit 0" $rc
check_end_state "reverse" "$HOME_R" "slack" "telegram"

echo ""
echo "===================================================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
