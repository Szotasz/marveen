#!/bin/bash
# ENVPARK912: the legacy-channel-dir migration block in scripts/channels.sh must
# never park the .env it is standing on.
#
# Regression origin (2026-09-12): ~/.claude/channels/telegram is a SYMLINK into
# the install-scoped $MAIN_CHAN_DIR on a migrated install. The gate was a STRING
# comparison, so the two paths "differed" while naming the same directory; the
# else-branch then moved that directory's own live .env to .env.legacy-<epoch>
# on every channels.sh start. The plugin came up with "TELEGRAM_BOT_TOKEN
# required" and the main agent went mute on Telegram with no error anywhere:
# three parked byte-identical copies in one day (05:00, 13:03, 13:10) and an
# 05:03-13:26 outage behind 139 consecutive keepalive WARNs.
#
# Two gates are under test and they cover different shapes:
#   1. resolved-path comparison  -> symlinked legacy DIRECTORY;
#   2. `-ef` before the mv       -> symlinked/hardlinked .env FILE, where the
#      directories genuinely differ but the file does not.
# Both assert the .env STAYS PUT, not merely that nothing errored -- the buggy
# version exits 0 while destroying the token.
#
# The block is extracted from the real script and run in a sandboxed $HOME, so
# the test reads the shipped source rather than a copy of it that can drift.
# CHANNELS_BIN points the suite at a deliberately-old channels.sh to confirm it
# actually goes red on the bug (measured: see the PR).
# Run: bash scripts/__tests__/channels-legacy-env-park.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNELS="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

echo "channels.sh legacy .env parking (ENVPARK912)"
echo "  source under test: $CHANNELS"

# --- extract the migration block ---------------------------------------------
# From the LEGACY_CHAN_DIR assignment to the first column-0 `fi`. A silently
# empty or wrong extraction would make every case below pass for free, so the
# snippet is itself asserted before anything runs.
SNIPPET="$(mktemp -t envpark912-snippet)"
trap 'rm -f "$SNIPPET"' EXIT
awk '/^LEGACY_CHAN_DIR=/{inblock=1} inblock{print} inblock && /^fi$/{exit}' "$CHANNELS" > "$SNIPPET"

if [ ! -s "$SNIPPET" ]; then
  fail "extraction: migration block found" "non-empty snippet" "empty (anchors moved?)"
elif ! grep -q 'MAIN_CHAN_DIR' "$SNIPPET" || ! grep -q '\.env\.legacy-' "$SNIPPET"; then
  fail "extraction: migration block found" "snippet with the parking mv" "$(head -1 "$SNIPPET")"
else
  pass "extraction: migration block found ($(wc -l < "$SNIPPET" | tr -d ' ') lines)"
fi

TOKEN='TELEGRAM_BOT_TOKEN=123456:live-token'

# Runs the extracted block against a sandbox $HOME. Never touches the real one.
# $1 = sandbox root, $2 = MAIN_CHAN_DIR
run_block() {
  ( HOME="$1/home" CHANNEL_PROVIDER=telegram MAIN_CHAN_DIR="$2" \
    bash "$SNIPPET" >/dev/null 2>&1 )
}

new_box() { mktemp -d -t envpark912-box; }
# Deletes only what new_box created: the mktemp template has to be in the name.
drop_box() { case "$1" in *envpark912-box*) rm -rf "$1" ;; esac; }

# --- case 1: symlinked legacy DIRECTORY (the measured outage) -----------------
box="$(new_box)"
main="$box/install/.claude/channels/telegram"
mkdir -p "$main" "$box/home/.claude/channels"
printf '%s\n' "$TOKEN" > "$main/.env"
ln -s "$main" "$box/home/.claude/channels/telegram"
run_block "$box" "$main"
if [ -f "$main/.env" ] && grep -q 'live-token' "$main/.env"; then
  pass "symlinked legacy dir: the live .env stays in place"
else
  fail "symlinked legacy dir: the live .env stays in place" "readable .env with the token" \
       "$(ls -A "$main" | tr '\n' ' ')"
fi
if [ -z "$(find "$main" -maxdepth 1 -name '.env.legacy-*' -print -quit)" ]; then
  pass "symlinked legacy dir: no .env.legacy-* copy is born"
else
  fail "symlinked legacy dir: no .env.legacy-* copy is born" "none" \
       "$(find "$main" -maxdepth 1 -name '.env.legacy-*' -exec basename {} \; | tr '\n' ' ')"
fi
drop_box "$box"

# --- case 2a: distinct dirs, main/.env is a SYMLINK to the legacy file --------
# The resolved-dir gate does NOT save this one: the directories really differ.
# Only the `-ef` gate does. Pre-fix the mv moves the real file out from under
# the symlink and main/.env is left dangling.
box="$(new_box)"
main="$box/install/.claude/channels/telegram"
legacy="$box/home/.claude/channels/telegram"
mkdir -p "$main" "$legacy"
printf '%s\n' "$TOKEN" > "$legacy/.env"
ln -s "$legacy/.env" "$main/.env"
run_block "$box" "$main"
if [ -f "$main/.env" ] && grep -q 'live-token' "$main/.env" 2>/dev/null; then
  pass "symlinked .env file: the token stays readable through main/.env"
else
  fail "symlinked .env file: the token stays readable through main/.env" \
       "readable token" "dangling or missing"
fi
drop_box "$box"

# --- case 2b: distinct dirs, the two .env files are HARDLINKED ----------------
box="$(new_box)"
main="$box/install/.claude/channels/telegram"
legacy="$box/home/.claude/channels/telegram"
mkdir -p "$main" "$legacy"
printf '%s\n' "$TOKEN" > "$main/.env"
ln "$main/.env" "$legacy/.env"
run_block "$box" "$main"
if [ -f "$main/.env" ] && [ -f "$legacy/.env" ] \
   && [ -z "$(find "$main" -maxdepth 1 -name '.env.legacy-*' -print -quit)" ]; then
  pass "hardlinked .env file: nothing is parked, both names survive"
else
  fail "hardlinked .env file: nothing is parked, both names survive" "no park, both names" \
       "main=[$(ls -A "$main" | tr '\n' ' ')] legacy=[$(ls -A "$legacy" | tr '\n' ' ')]"
fi
drop_box "$box"

# --- case 3: NEGATIVE CONTROL -- two genuinely separate .env files ------------
# The #915 behaviour this fix must NOT weaken: a real shared-path token still
# has to be parked, or the hijack window #915 closed reopens.
box="$(new_box)"
main="$box/install/.claude/channels/telegram"
legacy="$box/home/.claude/channels/telegram"
mkdir -p "$main" "$legacy"
printf '%s\n' "$TOKEN" > "$main/.env"
printf '%s\n' 'TELEGRAM_BOT_TOKEN=999:stale-shared-token' > "$legacy/.env"
run_block "$box" "$main"
parked="$(find "$main" -maxdepth 1 -name '.env.legacy-*' -print -quit)"
if [ -n "$parked" ] && grep -q 'stale-shared-token' "$parked" \
   && [ ! -f "$legacy/.env" ] && grep -q 'live-token' "$main/.env"; then
  pass "separate .env files: the stale shared token is still parked (#915 kept)"
else
  fail "separate .env files: the stale shared token is still parked (#915 kept)" \
       "legacy parked, main untouched" \
       "parked=[$parked] legacy=[$(ls -A "$legacy" | tr '\n' ' ')]"
fi
drop_box "$box"

# --- case 4: unmigrated install still migrates -------------------------------
# The resolve helper must not break the one path that is supposed to move data.
box="$(new_box)"
main="$box/install/.claude/channels/telegram"
legacy="$box/home/.claude/channels/telegram"
mkdir -p "$legacy" "$box/install/.claude/channels"
printf '%s\n' "$TOKEN" > "$legacy/.env"
printf '%s\n' '{"allowFrom":["<owner-chat-id>"]}' > "$legacy/access.json"
run_block "$box" "$main"
if [ -f "$main/.env" ] && grep -q 'live-token' "$main/.env" && [ -f "$main/access.json" ]; then
  pass "unmigrated install: the whole legacy dir still migrates"
else
  fail "unmigrated install: the whole legacy dir still migrates" \
       "token + access.json install-scoped" "$(ls -A "$main" 2>/dev/null | tr '\n' ' ')"
fi
drop_box "$box"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
