#!/usr/bin/env bash
# NULLAORFLEET921 -- a "0" installer placeholder must never be treated as a chat.
#
# WHY THIS FILE EXISTS, STATED HONESTLY: the guard added alongside this test is
# DEFENCE IN DEPTH, not a live bug fix. Measured on 2026-09-22 before writing it:
# no path puts a "0" into fleet-memory-gate's CHAT_ID today -- nothing in the repo
# sets MARVEEN_ALERT_CHAT_ID (no unit, no plist, no installer line), the placeholder
# lands in ALLOWED_CHAT_ID which this script never reads, and no shipped installer
# version ever seeded access.json's allowFrom from CHAT_ID (107 historical versions,
# 0 hits, positive control passed).
#
# What the measurement DID show is that the value would not fail safely: "0" takes
# the same path as a real chat id, so the send is attempted, fails, and is retried
# on every run, because a failed send deliberately never stamps the cooldown.
#
# Run:  bash scripts/__tests__/nullaor-memgate.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAILS=0; DB=0

check() { DB=$((DB+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/nullaor.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

mkdir -p "$SANDBOX/store" "$SANDBOX/bin" "$SANDBOX/home"
# The gate runs from a COPIED install (b2e9c0c1): since its fallback is lib/owner-chat.sh, which reads the install
# .env and the MAIN install's channel dir by design, a run from $ROOT would read whatever install the checkout is.
INST="$SANDBOX/inst"
mkdir -p "$INST/scripts/lib" "$INST/.claude/channels/telegram"
cp "$ROOT/scripts/fleet-memory-gate.sh" "$INST/scripts/"
cp "$ROOT/scripts/lib/alert-recipients.sh" "$ROOT/scripts/lib/owner-chat.sh" "$ROOT/scripts/lib/send-telegram.sh" "$INST/scripts/lib/"
printf 'ALLOWED_CHAT_ID=0\n' > "$INST/.env"   # the installer's placeholder: the fallback then reads access.json
# A token must be present, otherwise the run stops before the send for an unrelated
# reason and every case would look the same.
printf 'TELEGRAM_BOT_TOKEN=123456:TESZT-TOKEN\n' > "$INST/.claude/channels/telegram/.env"
# Memory well past the hard band, so an alert is always attempted.
printf 'MemTotal:       16000000 kB\nMemAvailable:     400000 kB\n' > "$SANDBOX/meminfo"

# curl stub: nothing leaves the machine, and the call is RECORDED.
cat > "$SANDBOX/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${STUB_ARGS_FILE:-/dev/null}"
echo '{"ok":true,"result":{"message_id":1}}'
STUB
chmod +x "$SANDBOX/bin/curl"

# run_gate <chat-id-env> <access.json body>  -> prints the gate's log lines
run_gate() {
  local chat="$1" access="${2:-}"
  : > "$SANDBOX/args.txt"
  rm -f "$SANDBOX/store/.fleet-memgate-alert"
  if [ -n "$access" ]; then printf '%s' "$access" > "$INST/.claude/channels/telegram/access.json"
  else rm -f "$INST/.claude/channels/telegram/access.json"; fi
  env -u TELEGRAM_STATE_DIR -u TELEGRAM_ENV -u TELEGRAM_ACCESS \
      PATH="$SANDBOX/bin:$PATH" \
      HOME="$SANDBOX/home" \
      STUB_ARGS_FILE="$SANDBOX/args.txt" \
      MEMGATE_PROC_MEMINFO="$SANDBOX/meminfo" \
      MARVEEN_STORE="$SANDBOX/store" \
      MARVEEN_ALERT_CHAT_ID="$chat" \
      MARVEEN_MEM_GATE_OBSERVE=1 \
      bash "$INST/scripts/fleet-memory-gate.sh" check >/dev/null 2>"$SANDBOX/log.txt"
  cat "$SANDBOX/log.txt"
}

sent_chat_ids() { grep -Eo 'chat_id=[^&[:space:]]+' "$SANDBOX/args.txt" 2>/dev/null | sort -u | tr '\n' ' '; }

# 1. POSITIVE CONTROL FIRST: without it, every "nothing was sent" below would also
#    be green with the whole send path broken.
out="$(run_gate 999888777)"
check "1 a valodi chat-id-re MEGY a kuldes (pozitiv kontroll)" \
  "$(grep -q 'chat_id=999888777' "$SANDBOX/args.txt" && echo 0 || echo 1)" \
  "kuldott chat-id-k: $(sent_chat_ids) | log: $out"

# 2. the guard itself, env path
out="$(run_gate 0)"
check "2 a '0' placeholder NEM megy ki kuldeskent (env ut)" \
  "$([ -s "$SANDBOX/args.txt" ] && echo 1 || echo 0)" \
  "kuldott chat-id-k: $(sent_chat_ids)"
check "3 es a kihagyas MEG IS JELENIK a logban, nem nemul el" \
  "$(grep -q 'no owner chat id resolved' <<<"$out" && echo 0 || echo 1)" \
  "log: $out"

# 4. the OTHER resolution path: access.json. A "0" can only get here from a foreign
#    writer, which is exactly the case a guard is for.
out="$(run_gate "" '{"allowFrom":["0"]}')"
check "4 a '0' az access.json-bol SEM megy ki" \
  "$([ -s "$SANDBOX/args.txt" ] && echo 1 || echo 0)" \
  "kuldott chat-id-k: $(sent_chat_ids)"

# 5. a real id from access.json still goes: the guard must not empty the path
out="$(run_gate "" '{"allowFrom":["555444333"]}')"
check "5 valodi access.json-beli id tovabbra is MEGY" \
  "$(grep -q 'chat_id=555444333' "$SANDBOX/args.txt" && echo 0 || echo 1)" \
  "kuldott chat-id-k: $(sent_chat_ids) | log: $out"

# 6. the three surfaces cannot diverge on the guard again: since b2e9c0c1 none of them carries a copy of its own,
#    all three resolve through lib/alert-recipients.sh, and that one copy drops the "0" (1-5 above measure it).
mismatch=0
for f in scripts/fleet-memory-gate.sh scripts/host-restart-watchdog.sh scripts/unit-fail-notify.sh; do
  { grep -qF 'lib/alert-recipients.sh' "$ROOT/$f" && grep -qF 'alert_resolve_recipients ' "$ROOT/$f"; } \
    || { mismatch=1; echo "    nem a kozos feloldot hivja: $f"; }
  if grep -qF 'MARVEEN_ALERT_CHAT_ID:-' "$ROOT/$f"; then mismatch=1; echo "    sajat MARVEEN_ALERT_CHAT_ID-olvasas maradt: $f"; fi
done
grep -qF '"$id" != "0"' "$ROOT/scripts/lib/alert-recipients.sh" || { mismatch=1; echo "    a kozos feloldobol hianyzik a \"0\"-or"; }
check "6 mindharom felulet a kozos feloldot hivja, es abban all a '0'-or" "$mismatch"

echo ""
echo "nullaor-memgate: $((DB-FAILS))/$DB"
[ "$FAILS" -eq 0 ] || exit 1
