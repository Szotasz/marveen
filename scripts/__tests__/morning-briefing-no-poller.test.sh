#!/bin/bash
# MORNINGPOLLER1770 (#1770): the morning briefing's model call must not start a
# channel plugin. Its plugin server takes the single Telegram getUpdates slot
# (bot.pid) from the live channel session, and the bot goes deaf until a
# watchdog restart.
#
# Measured before the fix (2026-10-07, real claude 2.1.292, sandboxed config
# with the host's user-scope enabledPlugins {telegram:true} and a dummy token):
# the old call shape (--channels ... -p) AND a bare `claude -p` both spawned the
# telegram plugin and wrote bot.pid; with the --settings overlay below the
# plugin did not start. This test pins what the script hands the model call:
#   1. no --channels;
#   2. a --settings overlay that turns EVERY channel plugin id off (the ids are
#      read from src/web/plugin-ids.ts, so a new provider cannot slip past);
#   3. no bot token in the environment, although the install .env (which the
#      script exports) and the caller both carry one;
#   4. every channel state dir is an empty dir, not the install's.
# Run: bash scripts/__tests__/morning-briefing-no-poller.test.sh

set -u
unset TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DIR="$TMP/inst"
mkdir -p "$DIR/scripts/lib" "$DIR/store" "$DIR/bin" "$DIR/.claude/channels/telegram"
cp "$REPO/scripts/morning-briefing.sh" "$DIR/scripts/"
cp "$REPO/scripts/lib/owner-chat.sh" "$REPO/scripts/lib/send-telegram.sh" "$DIR/scripts/lib/"
printf 'ALLOWED_CHAT_ID=1234\nTELEGRAM_BOT_TOKEN=tok-from-dotenv\nSLACK_BOT_TOKEN=slack-tok-from-dotenv\n' > "$DIR/.env"
printf 'TELEGRAM_BOT_TOKEN=tok-from-statedir\n' > "$DIR/.claude/channels/telegram/.env"

# The stub records what a real claude would get, then refuses (no sentinel), so
# nothing is delivered and no Bot API is needed.
cat > "$DIR/bin/claude" <<'STUB'
#!/bin/bash
OUT="$(dirname "$0")/../store"
printf '%s\n' "$@" > "$OUT/argv"
env | grep -E '^(TELEGRAM_BOT_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|DISCORD_BOT_TOKEN)=' > "$OUT/tokens"
for v in TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR; do
  d="$(printenv "$v")"
  printf '%s=%s files=[%s]\n' "$v" "$d" "$( [ -n "$d" ] && [ -d "$d" ] && ls -A "$d" | tr '\n' ' ')" >> "$OUT/statedirs"
done
echo "stub: not sending"
STUB
chmod +x "$DIR/bin/claude"

# The caller's own environment carries a token too (a sub-agent shell, a unit).
HOME="$DIR" CLAUDE_BIN="$DIR/bin/claude" TELEGRAM_BOT_TOKEN=tok-from-caller \
  bash "$DIR/scripts/morning-briefing.sh" >/dev/null 2>&1

echo "morning-briefing: the model call starts no channel plugin"

if [ ! -f "$DIR/store/argv" ]; then
  fail "the model call ran at all (no argv recorded)"
  echo; echo "PASS=$PASS FAIL=$FAIL"; exit 1
fi

if grep -qx -- '--channels' "$DIR/store/argv"; then fail "no --channels in the model call"; else pass "no --channels in the model call"; fi

OVERLAY_CHECK="$(python3 - "$DIR/store/argv" "$REPO/src/web/plugin-ids.ts" <<'PY'
import json, re, sys
argv = open(sys.argv[1], encoding="utf-8").read().split("\n")
ids = re.findall(r"'([a-z0-9-]+@[a-z0-9-]+)'", open(sys.argv[2], encoding="utf-8").read())
if "--settings" not in argv:
    print("NO --settings"); sys.exit()
try:
    ov = json.loads(argv[argv.index("--settings") + 1])
except Exception as e:
    print("UNPARSEABLE " + str(e)); sys.exit()
ep = ov.get("enabledPlugins", {})
missing = [i for i in ids if ep.get(i) is not False]
print("OK %d" % len(ids) if ids and not missing else "MISSING " + ",".join(missing or ["<no ids read>"]))
PY
)"
case "$OVERLAY_CHECK" in
  "OK "*) pass "--settings overlay turns every channel plugin id off ($OVERLAY_CHECK)" ;;
  *) fail "--settings overlay turns every channel plugin id off ($OVERLAY_CHECK)" ;;
esac

if [ -s "$DIR/store/tokens" ]; then fail "no bot token reaches the model call (got: $(cut -d= -f1 "$DIR/store/tokens" | tr '\n' ' '))"; else pass "no bot token reaches the model call (.env, caller and state dir all carried one)"; fi

BAD_SD="$(grep -v 'files=\[\]$' "$DIR/store/statedirs" | grep -v '^[A-Z_]*= files' || true)"
if [ -n "$BAD_SD" ] || grep -q "$DIR/.claude/channels" "$DIR/store/statedirs" || [ "$(grep -c '=/' "$DIR/store/statedirs")" -ne 5 ]; then
  fail "every channel state dir is an empty dir, not the install's ($(tr '\n' ' ' < "$DIR/store/statedirs"))"
else
  pass "every channel state dir is an empty dir, not the install's"
fi

if grep -qiE 'reply tool|chat_id' "$DIR/store/argv"; then fail "the prompt no longer asks the run to send (reply tool / chat_id)"; else pass "the prompt no longer asks the run to send (reply tool / chat_id)"; fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
