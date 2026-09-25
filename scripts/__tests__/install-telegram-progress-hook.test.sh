#!/bin/bash
# Contract tests for scripts/install-telegram-progress-hook.sh
# Run: bash scripts/__tests__/install-telegram-progress-hook.test.sh
#
# Verifies that the installer:
#   (a) does NOT source the .env file (no `set -a; . .env` pattern)
#   (b) does NOT fail when .env contains an unquoted value with spaces
#   (c) does NOT execute code from a $(...) value in .env
#   (d) correctly reads SERVICE_ID / BOT_NAME with and without quoting
#   (e) falls back to defaults when .env is absent
#   (f) MAIN_AGENT_ID fallback when SERVICE_ID absent
#   (g) #1305 contract: writes NOTHING under ~/.claude -- no hook copies, no
#       user-global settings.json edit -- and points the watchdog unit at the
#       REPO copy of telegram_progress_watchdog.py
#   (h) provider gate: CHANNEL_PROVIDER=slack -> installs NOTHING and retires
#       any leftover Telegram plumbing (sync-hooks runs every installer)
#   (i) a failing retire (own leftovers in the gate, the other provider's before
#       an install) is printed and reaches the exit code -- never `|| true`'d
#   (j) hermeticity: no unshimmed installer run, and (on a Mac) no testbot job
#       registered with the host's launchd after the suite
# (g) and (h) run once per daemon branch: [Linux] systemd, [Darwin] launchd.
#
# All filesystem operations use a fully isolated temp tree -- the real
# ~/.claude directory and the real INSTALL_DIR are never touched. The full-run
# cases feed the installer a temp .env via MARVEEN_ENV_FILE (the installer's
# test hook) so they do not depend on whatever the checkout's own .env says.
#
# EVERY installer run goes through run_installer, which puts PATH shims for
# launchctl / systemctl / pidof in front. Both service managers act on the
# real user domain whatever $HOME says, and before this only case (g) was
# shimmed: the same gap in the sibling suites registered REAL launchd jobs
# (com.testbot.*-progress-watchdog) from temp plists on a Mac, which outlived
# the run and kept firing against a deleted path. uname is shimmed as well
# (FAKE_UNAME), so the launchd branch AND the systemd branch both run wherever
# the suite does -- a macOS-only defect can no longer hide on Linux, or the
# other way round.

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
assert_exists() { if [ -e "$1" ]; then pass "$2"; else fail "$2 (missing: $1)"; fi; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/install-telegram-progress-hook.sh"

# Belt under the shims: `systemctl --user` talks to the real user manager
# regardless of $HOME, so leave it no reachable manager either.
export DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent-marveen-test"
export XDG_RUNTIME_DIR="$TMP/run"
mkdir -p "$XDG_RUNTIME_DIR"

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
# A shim-log line that means "a watchdog daemon was started".
DAEMON_LOAD_RX='^(launchctl load|systemctl .*enable)'

# The installer runs under /bin/bash when there is one: on macOS that is
# bash 3.2 even when a newer bash comes first in PATH, and it is what
# launchd-started callers get.
if [ -x /bin/bash ]; then SYS_BASH=/bin/bash; else SYS_BASH="$(command -v bash)"; fi

# run_installer <home> <env_file>   -- the ONLY way this suite runs the script.
# FAKE_UNAME (from the caller) picks the daemon branch; default: the host's own.
run_installer() {
  HOME="$1" MARVEEN_ENV_FILE="$2" PATH="$SHIM_BIN:$PATH" \
    FAKE_UNAME="${FAKE_UNAME:-$HOST_UNAME}" "$SYS_BASH" "$SCRIPT" 2>&1
}

# The watchdog daemon files of <provider> on <platform>, as the installer
# writes them for SERVICE_ID=testbot.
daemon_files() { # home platform provider
  if [ "$2" = "Darwin" ]; then
    echo "$1/Library/LaunchAgents/com.testbot.$3-progress-watchdog.plist"
  else
    echo "$1/.config/systemd/user/testbot-$3-progress-watchdog.timer"
    echo "$1/.config/systemd/user/testbot-$3-progress-watchdog.service"
  fi
}
plant_daemon() { # home platform provider
  local f
  daemon_files "$1" "$2" "$3" | while IFS= read -r f; do
    mkdir -p "$(dirname "$f")"; printf 'leftover\n' > "$f"
  done
}
assert_daemon_absent() { # home platform provider label
  local f
  while IFS= read -r f; do
    assert_absent "$f" "$4: $(basename "$f") removed"
  done < <(daemon_files "$1" "$2" "$3")
}

# ---------------------------------------------------------------------------
# (a) Static check: no .env sourcing in the fixed script
# ---------------------------------------------------------------------------
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
# bash 3.2 (the macOS /bin/bash) rejects constructs bash 4+ accepts; a parse
# error there used to surface nowhere, because the script was never run on it.
ERR="$("$SYS_BASH" -n "$SCRIPT" 2>&1)"; EXIT=$?
if [ "$EXIT" -eq 0 ]; then pass "static check: parses under $SYS_BASH"
else fail "static check: $SYS_BASH -n reports a parse error ($ERR)"; fi

# ---------------------------------------------------------------------------
# Helper: run just the read_env + var-assignment block in isolation.
# We extract the function definition from the script and inject an INSTALL_DIR
# pointing to a controlled temp dir, then echo the variables.
# ---------------------------------------------------------------------------
run_env_parse() {
  local install_dir="$1"
  # Extract the read_env function + the 5 lines that follow it (the calls).
  # The function starts with 'read_env()' and ends at the blank line before
  # SERVICE_ID assignment; we grab them all up to BOT_NAME="${BOT_NAME:-Marveen}".
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

# ---------------------------------------------------------------------------
# (b) Unquoted space value: must not crash
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# (c) $(...) value in .env: must NOT execute it
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# (d) Quoted values: both forms are stripped correctly
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# (e) Missing .env -> defaults
# ---------------------------------------------------------------------------
echo ""
echo "(e) Missing .env -> defaults"
CASE="$TMP/case-e"
mkdir -p "$CASE"
# No .env file
OUT="$(run_env_parse "$CASE")"
EXIT=$?
assert_zero "no .env: exits 0"                  $EXIT
assert_eq   "no .env: SERVICE_ID=marveen"  "SERVICE_ID=marveen" "$(echo "$OUT" | grep '^SERVICE_ID=')"
assert_eq   "no .env: BOT_NAME=Marveen"    "BOT_NAME=Marveen"   "$(echo "$OUT" | grep '^BOT_NAME=')"

# ---------------------------------------------------------------------------
# (f) MAIN_AGENT_ID fallback when SERVICE_ID absent
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# (g) Full script (#1305 contract): NO ~/.claude write, watchdog from the repo
# The installer must not copy anything into ~/.claude/hooks and must not touch
# ~/.claude/settings.json -- the settings hooks are repo-shipped in the tracked
# project .claude/settings.json. The only thing it installs is the watchdog
# daemon, whose unit must run the REPO copy of telegram_progress_watchdog.py.
# Runs once per daemon branch (systemd, launchd); the service managers are
# PATH-shimmed, so no real daemon is (un)loaded.
# The .env is handed in via MARVEEN_ENV_FILE (the installer's test hook) with
# CHANNEL_PROVIDER=telegram, so the case depends neither on the checkout's own
# .env nor on a hard-coded /tmp path, and the provider gate lets it through.
# ---------------------------------------------------------------------------
echo ""
echo "(g) Full script: no ~/.claude write, watchdog unit targets the repo"
ENV_G="$TMP/env-telegram"
printf 'SERVICE_ID=testbot
OWNER_NAME=Foo Bar
BOT_NAME=TestBot
CHANNEL_PROVIDER=telegram
' > "$ENV_G"
for PLAT in Linux Darwin; do
  CASE="$TMP/case-g-$PLAT"
  HOME_G="$CASE/home"
  mkdir -p "$HOME_G/.claude/hooks"
  SETTINGS_BEFORE='{"hooks":{"marker":"untouched"}}'
  printf '%s' "$SETTINGS_BEFORE" > "$HOME_G/.claude/settings.json"
  : > "$SHIM_LOG"

  OUT="$(FAKE_UNAME="$PLAT" run_installer "$HOME_G" "$ENV_G")"
  EXIT=$?
  assert_zero "full script [$PLAT]: exits 0 with a spaced OWNER_NAME in .env" $EXIT

  for f in telegram_progress.py telegram_progress_clear.py \
            telegram_progress_reply_clear.py telegram_progress_watchdog.py \
            telegram_fallback_send.py; do
    assert_absent "$HOME_G/.claude/hooks/$f" "full script [$PLAT]: $f NOT copied to ~/.claude/hooks"
  done

  SETTINGS_AFTER="$(cat "$HOME_G/.claude/settings.json")"
  assert_eq "full script [$PLAT]: user-global settings.json untouched" \
            "$SETTINGS_BEFORE" "$SETTINGS_AFTER"

  # The daemon unit (plist on Darwin, systemd service on Linux) must reference
  # the repo watchdog, never a ~/.claude/hooks copy.
  if [ "$PLAT" = "Darwin" ]; then
    UNIT_FILE="$HOME_G/Library/LaunchAgents/com.testbot.telegram-progress-watchdog.plist"
  else
    UNIT_FILE="$HOME_G/.config/systemd/user/testbot-telegram-progress-watchdog.service"
  fi
  if [ -f "$UNIT_FILE" ]; then
    pass "full script [$PLAT]: daemon unit written ($(basename "$UNIT_FILE"))"
    if grep -q "$REPO_ROOT/scripts/hooks/telegram_progress_watchdog.py" "$UNIT_FILE"; then
      pass "full script [$PLAT]: unit runs the REPO watchdog"
    else
      fail "full script [$PLAT]: unit does not reference the repo watchdog path"
    fi
    if grep -q "$HOME_G/.claude/hooks" "$UNIT_FILE"; then
      fail "full script [$PLAT]: unit still references a ~/.claude/hooks copy"
    else
      pass "full script [$PLAT]: unit has no ~/.claude/hooks reference"
    fi
  else
    fail "full script [$PLAT]: no daemon unit file written ($UNIT_FILE)"
  fi
  # The branch under test really ran, and its service manager was the shim:
  # launchd loads the plist; on the systemd branch the pidof probe comes first.
  if [ "$PLAT" = "Darwin" ]; then
    if grep -q "^launchctl load .*com\.testbot\.telegram-progress-watchdog\.plist" "$SHIM_LOG"; then
      pass "full script [$PLAT]: launchctl load went to the shim, not to the host's launchd"
    else
      fail "full script [$PLAT]: no launchctl load reached the shim"
    fi
  else
    if grep -q "^pidof systemd" "$SHIM_LOG"; then
      pass "full script [$PLAT]: the systemd probe went to the shim, not to the host's manager"
    else
      fail "full script [$PLAT]: no pidof probe reached the shim"
    fi
  fi
done

# ---------------------------------------------------------------------------
# (h) Provider gate: CHANNEL_PROVIDER=slack -> nothing installed, leftover
# Telegram plumbing retired. sync-hooks.sh runs this installer on every update
# of a Slack install too (and it runs LAST, after the Slack installer), so
# without the gate every update re-wired telegram_progress*.py and re-enabled
# the Telegram timer next to the live Slack set.
# ---------------------------------------------------------------------------
# Once per daemon branch, with the leftover in that branch's own form: the
# systemd-only version of this case could never pass on a Mac, where the
# launchd branch does not touch unit files.
echo ""
echo "(h) Provider gate: CHANNEL_PROVIDER=slack -> nothing installed, leftover Telegram plumbing retired"
ENV_H="$TMP/env-slack"
printf 'SERVICE_ID=testbot\nBOT_NAME=TestBot\nCHANNEL_PROVIDER=slack\n' > "$ENV_H"
for PLAT in Linux Darwin; do
  CASE="$TMP/case-h-$PLAT"
  HOME_H="$CASE/home"
  mkdir -p "$HOME_H/.claude/hooks"
  cat > "$HOME_H/.claude/settings.json" <<'JSONEOF'
{
  "hooks": {
    "UserPromptSubmit": [
      {"hooks": [
        {"type": "command", "command": "/usr/bin/python3 /h/.claude/hooks/slack_progress.py"},
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
  plant_daemon "$HOME_H" "$PLAT" telegram
  plant_daemon "$HOME_H" "$PLAT" slack
  : > "$SHIM_LOG"
  OUT3="$(FAKE_UNAME="$PLAT" run_installer "$HOME_H" "$ENV_H")"
  EXIT=$?
  assert_zero "provider gate [$PLAT]: exits 0" $EXIT
  assert_absent "$HOME_H/.claude/hooks/telegram_progress.py" "provider gate [$PLAT]: no Telegram hook file copied"
  assert_daemon_absent "$HOME_H" "$PLAT" telegram "provider gate [$PLAT]: leftover Telegram daemon"
  while IFS= read -r f; do
    assert_exists "$f" "provider gate [$PLAT]: the active (Slack) daemon left alone ($(basename "$f"))"
  done < <(daemon_files "$HOME_H" "$PLAT" slack)
  if grep -q 'telegram_progress' "$HOME_H/.claude/settings.json"; then
    fail "provider gate [$PLAT]: leftover Telegram hooks still wired"
  else
    pass "provider gate [$PLAT]: leftover Telegram hooks unwired"
  fi
  if grep -q 'slack_progress\.py' "$HOME_H/.claude/settings.json"; then
    pass "provider gate [$PLAT]: Slack hooks left alone"
  else
    fail "provider gate [$PLAT]: Slack hooks were destroyed"
  fi
  # The gate stands down BEFORE the install step: nothing may be loaded.
  LOADED="$(grep -E "$DAEMON_LOAD_RX" "$SHIM_LOG" | head -1)"
  if [ -n "$LOADED" ]; then
    fail "provider gate [$PLAT]: a daemon was (re)loaded ($LOADED)"
  else
    pass "provider gate [$PLAT]: no daemon loaded or enabled"
  fi
done

# ---------------------------------------------------------------------------
# (i) A failing retire is reported and reaches the exit code. The retire script
# used to be called with `|| true`. On macOS it could not even be parsed
# (bash 3.2), and that error -- plus the cleanup that never happened --
# appeared nowhere: the gate's "retire leftovers and exit 0" branch was a
# silent no-op. A user-global settings.json that is not JSON makes the retire
# fail for real, on every platform.
# ---------------------------------------------------------------------------
echo ""
echo "(i) A failing retire is reported and reaches the exit code -- never swallowed"
if grep -nE 'retire-progress-watchdog\.sh.*\|\|[[:space:]]*true' "$SCRIPT" >/dev/null; then
  fail "static check: the retire script is still called with '|| true'"
else
  pass "static check: no retire call is silenced with '|| true'"
fi

# Gate branch (CHANNEL_PROVIDER=slack): the retire is the branch's whole job.
CASE="$TMP/case-i-gate"
HOME_I="$CASE/home"
mkdir -p "$HOME_I/.claude"
printf '{ this is not json' > "$HOME_I/.claude/settings.json"
OUT4="$(run_installer "$HOME_I" "$ENV_H")"
EXIT=$?
if [ "$EXIT" -ne 0 ]; then pass "failing retire (gate): installer exits non-zero"
else fail "failing retire (gate): installer exited 0 -- the failure was swallowed"; fi
case "$OUT4" in
  *"retire-progress-watchdog.sh telegram FAILED (exit "*) pass "failing retire (gate): reported, with the exit code" ;;
  *) fail "failing retire (gate): nothing reported (got: $OUT4)" ;;
esac

# Active provider (CHANNEL_PROVIDER=telegram): the cross-retire of Slack fails.
# Never fatal -- the Telegram watchdog must still be installed -- but reported,
# and the installer's exit code says the end state is not clean.
CASE="$TMP/case-i-active"
HOME_I="$CASE/home"
mkdir -p "$HOME_I/.claude"
printf '{ this is not json' > "$HOME_I/.claude/settings.json"
OUT5="$(run_installer "$HOME_I" "$ENV_G")"
EXIT=$?
if [ "$EXIT" -ne 0 ]; then pass "failing retire (active): installer exits non-zero"
else fail "failing retire (active): installer exited 0 -- the failure was swallowed"; fi
case "$OUT5" in
  *"retire-progress-watchdog.sh slack FAILED (exit "*) pass "failing retire (active): reported, with the exit code" ;;
  *) fail "failing retire (active): nothing reported (got: $OUT5)" ;;
esac
UNIT_I="$(find "$HOME_I/Library/LaunchAgents" "$HOME_I/.config/systemd/user" \
          -type f \( -name '*.plist' -o -name '*.service' \) 2>/dev/null | head -1)"
if [ -n "$UNIT_I" ]; then pass "failing retire (active): the Telegram watchdog unit is still installed (never fatal)"
else fail "failing retire (active): the failed retire blocked the install"; fi
case "$OUT5" in
  *"both providers' progress machinery may be live"*) pass "failing retire (active): the end-of-run summary repeats it" ;;
  *) fail "failing retire (active): no end-of-run summary (got: $OUT5)" ;;
esac

# ---------------------------------------------------------------------------
# (j) Hermeticity: the suite never reaches the host's service manager.
# ---------------------------------------------------------------------------
echo ""
echo "(j) Hermeticity: the suite never reaches the host's service manager"
# Static: no case starts the script directly. run_installer is the one shimmed
# entry point; a new case written the old way would, on a Mac, register a real
# launchd job from a temp plist again.
DIRECT_RUNS="$(grep -cE 'bash +"\$SCRIPT"' "$0" || true)"
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

# ---------------------------------------------------------------------------
echo ""
echo "===================================================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
