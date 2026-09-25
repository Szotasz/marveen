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
# The whole scenario runs once per daemon branch -- [Linux] systemd units,
# [Darwin] launchd plists -- on whatever platform the suite runs on.
#
# Hermetic: temp HOME, temp .env via MARVEEN_ENV_FILE (the installers' test
# hook), and EVERY installer run goes through run_installer, which puts PATH
# shims for launchctl / systemctl / pidof in front. Both service managers act
# on the real user domain whatever $HOME says: unshimmed, this suite registered
# two REAL launchd jobs on a Mac (com.testbot.slack-progress-watchdog and
# com.testbot.telegram-progress-watchdog) from its temp plists, and they
# outlived the run, firing every 60s against a deleted path. uname is shimmed
# as well (FAKE_UNAME), which is what lets both branches run everywhere.

set -u

PASS=0; FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_zero()   { if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1 (exit=$2)"; fi; }
assert_eq()     { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_exists() { if [ -e "$1" ]; then pass "$2"; else fail "$2 (missing: $1)"; fi; }
assert_absent() { if [ ! -e "$1" ]; then pass "$2"; else fail "$2 (should not exist: $1)"; fi; }
assert_grep()    { if grep -q "$2" "$3"; then pass "$1"; else fail "$1 (pattern '$2' not in $3)"; fi; }
assert_no_grep() { if grep -q "$2" "$3"; then fail "$1 (pattern '$2' still in $3)"; else pass "$1"; fi; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS="$REPO_ROOT/scripts"

# Belt under the shims: `systemctl --user` talks to the real user manager
# regardless of $HOME, so leave it no reachable manager either.
export DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent-marveen-test"
export XDG_RUNTIME_DIR="$TMP/run"
mkdir -p "$XDG_RUNTIME_DIR"

UNITS_REL=".config/systemd/user"
PLIST_REL="Library/LaunchAgents"

# --- PATH shims: they only log their argv, and fail like an absent manager ---
HOST_UNAME="$(uname -s)"
SHIM_BIN="$TMP/shim-bin"; SHIM_LOG="$TMP/shim-calls.log"
mkdir -p "$SHIM_BIN"; : > "$SHIM_LOG"
for stub in launchctl systemctl pidof; do
  printf '#!/bin/bash\necho "%s $*" >> "%s"\nexit 1\n' "$stub" "$SHIM_LOG" > "$SHIM_BIN/$stub"
  chmod +x "$SHIM_BIN/$stub"
done
printf '#!/bin/bash\necho "${FAKE_UNAME:-Linux}"\n' > "$SHIM_BIN/uname"
chmod +x "$SHIM_BIN/uname"

# The installers run under /bin/bash when there is one: on macOS that is
# bash 3.2 even when a newer bash comes first in PATH.
if [ -x /bin/bash ]; then SYS_BASH=/bin/bash; else SYS_BASH="$(command -v bash)"; fi

# run_installer <installer> <home> <env_file>   -- the ONLY way this suite
# runs an installer. PLAT (Linux|Darwin, set by the scenario loop) picks the
# daemon branch.
run_installer() {
  HOME="$2" MARVEEN_ENV_FILE="$3" PATH="$SHIM_BIN:$PATH" FAKE_UNAME="$PLAT" \
    "$SYS_BASH" "$1" >/dev/null 2>&1
}

# Same loop as sync-hooks.sh, restricted to the two progress installers so the
# unrelated install-*-hook.sh scripts (git guard, secret gate, ...) stay out.
run_sync() { # home env_file
  local home="$1" env_file="$2" rc=0 installer
  for installer in "$SCRIPTS"/install-*-progress-hook.sh; do
    [ -e "$installer" ] || continue
    run_installer "$installer" "$home" "$env_file" || rc=1
  done
  return $rc
}

# Seed a HOME that looks like an install after an UNGATED update: both hook
# sets wired and both providers' units present. The wired entries are pre-#1305
# user-global leftovers now; the active provider's three must survive untouched
# (only the retire script removes entries, and only the inactive provider's).
SEEDED_ACTIVE_ENTRIES=3
seed_home() { # home
  local home="$1"
  mkdir -p "$home/.claude/hooks"
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
  # Both providers' daemons, in the form THIS branch uses. A Mac has no
  # systemd units and a Linux box no plists; seeding the foreign form too made
  # the "service unit gone" assertion unpassable on macOS, where the launchd
  # branch never touches unit files.
  local prov f
  for prov in telegram slack; do
    units_of "$home" "$prov" | while IFS= read -r f; do
      mkdir -p "$(dirname "$f")"; printf 'leftover\n' > "$f"
    done
  done
}

# The watchdog daemon files of a provider on the branch under test ($PLAT).
units_of() { # home provider
  if [ "$PLAT" = "Darwin" ]; then
    echo "$1/$PLIST_REL/com.testbot.$2-progress-watchdog.plist"
  else
    echo "$1/$UNITS_REL/testbot-$2-progress-watchdog.timer"
    echo "$1/$UNITS_REL/testbot-$2-progress-watchdog.service"
  fi
}

# Since #1305 (ISSUE1305HOOKSCOPE) neither installer writes the user-global
# settings.json and neither copies hook files into ~/.claude/hooks -- the three
# settings hooks of both providers are repo-shipped in the tracked project
# .claude/settings.json. What is left for an installer to create, and therefore
# what the provider gate has to gate, is the watchdog daemon unit; what it has
# to clean up is the retired provider's unit plus any pre-#1305 user-global
# leftovers.
check_end_state() { # label home active inactive
  local label="$1" home="$2" active="$3" inactive="$4"
  local settings="$home/.claude/settings.json"
  # Repo-shipped hooks: the active installer copies nothing into
  # ~/.claude/hooks and leaves the seeded user-global entries of its own
  # provider exactly as they were -- it neither adds nor removes them.
  assert_absent "$home/.claude/hooks/${active}_progress.py"                 "$label: ${active} hook files NOT copied (repo-shipped since #1305)"
  assert_grep   "$label: ${active} pre-#1305 user-global entry left alone"                 "${active}_progress.py" "$settings"
  assert_no_grep "$label: no ${inactive} hooks wired"            "${inactive}_progress"            "$settings"
  assert_grep    "$label: unrelated hook preserved"              "unrelated.py"                    "$settings"
  local f
  while IFS= read -r f; do
    assert_exists "$f" "$label: ${active} watchdog present ($(basename "$f"))"
  done < <(units_of "$home" "$active")
  while IFS= read -r f; do
    assert_absent "$f" "$label: ${inactive} watchdog gone ($(basename "$f"))"
  done < <(units_of "$home" "$inactive")
  # Every ${inactive}_progress* entry must be gone, but the count of the
  # active provider's entries must be exactly 3 -- one per event, no
  # duplicates stacked by re-runs.
  # No installer may stack duplicate entries on a re-run; the seeded
  # user-global set must stay exactly as many as seed_home planted.
  local n
  n="$(grep -o "${active}_progress[a-z_]*\.py" "$settings" | sort -u | wc -l | tr -d ' ')"
  if [ "$n" = "$SEEDED_ACTIVE_ENTRIES" ]; then pass "$label: no duplicate ${active} hook entries stacked"
  else fail "$label: expected $SEEDED_ACTIVE_ENTRIES distinct ${active} hook entries, got $n"; fi
}

for PLAT in Linux Darwin; do
  echo ""
  echo "######## daemon branch: $PLAT ########"
  for ACTIVE in slack telegram; do
    if [ "$ACTIVE" = "slack" ]; then INACTIVE=telegram; else INACTIVE=slack; fi
    echo ""
    echo "== [$PLAT] CHANNEL_PROVIDER=$ACTIVE: glob-ordered sync of both installers"
    HOME_X="$TMP/home-$PLAT-$ACTIVE"
    seed_home "$HOME_X"
    ENV_X="$TMP/env-$ACTIVE"
    printf 'SERVICE_ID=testbot\nBOT_NAME=TestBot\nCHANNEL_PROVIDER=%s\n' "$ACTIVE" > "$ENV_X"

    run_sync "$HOME_X" "$ENV_X"
    assert_zero "[$PLAT] $ACTIVE: first sync exits 0" $?
    check_end_state "[$PLAT] $ACTIVE/1st" "$HOME_X" "$ACTIVE" "$INACTIVE"

    echo "-- second sync (the next update) must be a no-op"
    cp "$HOME_X/.claude/settings.json" "$TMP/settings-$PLAT-$ACTIVE-after1.json"
    rm -f "$HOME_X"/.claude/settings.json.bak-retire-*
    run_sync "$HOME_X" "$ENV_X"
    assert_zero "[$PLAT] $ACTIVE: second sync exits 0" $?
    check_end_state "[$PLAT] $ACTIVE/2nd" "$HOME_X" "$ACTIVE" "$INACTIVE"
    if cmp -s "$HOME_X/.claude/settings.json" "$TMP/settings-$PLAT-$ACTIVE-after1.json"; then
      pass "[$PLAT] $ACTIVE: settings.json byte-identical after the second sync"
    else
      fail "[$PLAT] $ACTIVE: settings.json changed on the second sync"
    fi
    if ls "$HOME_X"/.claude/settings.json.bak-retire-* >/dev/null 2>&1; then
      fail "[$PLAT] $ACTIVE: second sync left a retire backup behind ($(ls "$HOME_X"/.claude/settings.json.bak-retire-* | xargs -n1 basename | tr '\n' ' '))"
    else
      pass "[$PLAT] $ACTIVE: second sync left no retire backup behind"
    fi
  done

  echo ""
  echo "== [$PLAT] Reverse order (telegram installer first, then slack) gives the same end state"
  # The gate must make the outcome independent of glob order.
  HOME_R="$TMP/home-$PLAT-reverse"
  seed_home "$HOME_R"
  ENV_R="$TMP/env-reverse"
  printf 'SERVICE_ID=testbot\nBOT_NAME=TestBot\nCHANNEL_PROVIDER=slack\n' > "$ENV_R"
  rc=0
  for name in install-telegram-progress-hook.sh install-slack-progress-hook.sh; do
    run_installer "$SCRIPTS/$name" "$HOME_R" "$ENV_R" || rc=1
  done
  assert_zero "[$PLAT] reverse: both installers exit 0" $rc
  check_end_state "[$PLAT] reverse" "$HOME_R" "slack" "telegram"
done

echo ""
echo "== Hermeticity: the suite never reaches the host's service manager"
# The launchd branch did load a plist and the systemd branch did probe for a
# manager -- and both calls landed in the shim log, not on the host.
if grep -q '^launchctl load .*com\.testbot\.' "$SHIM_LOG"; then
  pass "launchd branch: launchctl load went to the shim"
else
  fail "launchd branch: no launchctl load reached the shim"
fi
if grep -q '^pidof systemd' "$SHIM_LOG"; then
  pass "systemd branch: the manager probe went to the shim"
else
  fail "systemd branch: no pidof probe reached the shim"
fi
# Static: no installer is started outside run_installer. A run written the old
# way would, on a Mac, register a real launchd job from a temp plist again.
DIRECT_RUNS="$(grep -cE 'bash +"\$(SCRIPTS|installer)' "$0" || true)"
assert_eq "static check: no unshimmed installer run in this suite" "0" "$DIRECT_RUNS"
# Measured, where there is a launchd to leak into (the review's acceptance
# check): nothing labelled testbot may be registered with it.
if [ "$HOST_UNAME" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  LEAKED="$(launchctl list 2>/dev/null | grep testbot || true)"
  if [ -z "$LEAKED" ]; then pass "host launchd: no testbot job registered"
  else fail "host launchd: a testbot job is registered -- remove it with 'launchctl remove <label>' ($LEAKED)"; fi
else
  echo "  SKIP: no host launchd here (uname=$HOST_UNAME)"
fi

echo ""
echo "===================================================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
