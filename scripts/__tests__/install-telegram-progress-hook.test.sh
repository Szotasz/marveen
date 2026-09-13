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
#   (f) copies hook files to the destination (core behaviour preserved)
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
SCRIPT="$REPO_ROOT/scripts/install-telegram-progress-hook.sh"

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
# launchctl/systemctl/pidof are stubbed via PATH so no real daemon is (un)loaded.
# ---------------------------------------------------------------------------
echo ""
echo "(g) Full script: no ~/.claude write, watchdog unit targets the repo"
CASE="$TMP/case-g"
HOME_G="$CASE/home"
BIN_G="$CASE/bin"
mkdir -p "$HOME_G/.claude/hooks" "$BIN_G"
for stub in launchctl systemctl pidof; do
  printf '#!/bin/bash\nexit 1\n' > "$BIN_G/$stub"
  chmod +x "$BIN_G/$stub"
done
SETTINGS_BEFORE='{"hooks":{"marker":"untouched"}}'
printf '%s' "$SETTINGS_BEFORE" > "$HOME_G/.claude/settings.json"

OUT="$(HOME="$HOME_G" PATH="$BIN_G:$PATH" bash "$SCRIPT" 2>&1)"
EXIT=$?
assert_zero "full script: exits 0" $EXIT

for f in telegram_progress.py telegram_progress_clear.py \
          telegram_progress_reply_clear.py telegram_progress_watchdog.py \
          telegram_fallback_send.py; do
  assert_absent "$HOME_G/.claude/hooks/$f" "full script: $f NOT copied to ~/.claude/hooks"
done

SETTINGS_AFTER="$(cat "$HOME_G/.claude/settings.json")"
assert_eq "full script: user-global settings.json untouched" \
          "$SETTINGS_BEFORE" "$SETTINGS_AFTER"

# The daemon unit (plist on Darwin, systemd service on Linux) must reference
# the repo watchdog, never a ~/.claude/hooks copy.
UNIT_FILE="$(find "$HOME_G/Library/LaunchAgents" "$HOME_G/.config/systemd/user" \
             -type f \( -name '*.plist' -o -name '*.service' \) 2>/dev/null | head -1)"
if [ -n "$UNIT_FILE" ]; then
  pass "full script: daemon unit written ($(basename "$UNIT_FILE"))"
  if grep -q "$REPO_ROOT/scripts/hooks/telegram_progress_watchdog.py" "$UNIT_FILE"; then
    pass "full script: unit runs the REPO watchdog"
  else
    fail "full script: unit does not reference the repo watchdog path"
  fi
  if grep -q "$HOME_G/.claude/hooks" "$UNIT_FILE"; then
    fail "full script: unit still references a ~/.claude/hooks copy"
  else
    pass "full script: unit has no ~/.claude/hooks reference"
  fi
else
  fail "full script: no daemon unit file written"
fi

# ---------------------------------------------------------------------------
echo ""
echo "===================================================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
