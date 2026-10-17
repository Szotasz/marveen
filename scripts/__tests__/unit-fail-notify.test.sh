#!/bin/bash
# Contract tests for scripts/unit-fail-notify.sh -- MULTIPLE RECIPIENTS (615002e1).
# Run: bash scripts/__tests__/unit-fail-notify.test.sh
#
# The REAL script is copied into a temp tree next to a STUB lib/send-telegram.sh.
# The script sources its sender by a path relative to its own location, so the copy
# exercises the shipped text without a test hook in production code, and WITHOUT
# sending a single real Telegram message.
#
# The chat ids are made up (never a real account's id in a test fixture). The sandbox is its own install -- its
# .env, its install-scoped channel dir and an empty HOME -- so the runtime fallback (lib/owner-chat.sh through
# lib/alert-recipients.sh, b2e9c0c1) can only ever read the test's own files, never the real channel config.
#
# The case that matters most is the NEGATIVE CONTROL: with a bad recipient first,
# the second recipient must STILL be delivered. Without it a green run would only
# say "it works when everything works" -- which is not what this script is for.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_contains() { if grep -qF -- "$2" <<< "$3"; then pass "$1"; else fail "$1 (nem tartalmazza: '$2')"; fi; }
assert_absent()   { if grep -qF -- "$2" <<< "$3"; then fail "$1 (NEM szabadna tartalmaznia: '$2')"; else pass "$1"; fi; }
assert_eq()       { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (varva '$2', kapott '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$INSTALL_DIR/scripts/unit-fail-notify.sh"
[ -f "$SRC" ] || { echo "nincs meg a szkript: $SRC"; exit 1; }

BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT

# A sandbox tree: the real script + a stub sender + a fake telegram .env.
mkdir -p "$BASE/scripts/lib" "$BASE/env"
cp "$SRC" "$BASE/scripts/unit-fail-notify.sh"
cp "$INSTALL_DIR/scripts/lib/alert-recipients.sh" "$BASE/scripts/lib/alert-recipients.sh"   # the REAL resolver (b2e9c0c1)
cp "$INSTALL_DIR/scripts/lib/owner-chat.sh" "$BASE/scripts/lib/owner-chat.sh"               # and its owner-chat rule
mkdir -p "$BASE/.claude/channels/telegram" "$BASE/home"
printf 'TELEGRAM_BOT_TOKEN="teszt-token"\n' > "$BASE/.claude/channels/telegram/.env"   # the install-scoped state dir
printf 'TELEGRAM_BOT_TOKEN="teszt-token"\n' > "$BASE/env/.env"
cat > "$BASE/scripts/lib/send-telegram.sh" <<'STUB'
# STUB sender. Records every call, and fails for the ids listed in STUB_FAIL_IDS.
send_telegram_message() {
  local _token="$1" _chat="$2" _msg="$3"
  echo "$_chat" >> "$STUB_CALLS"
  case ",${STUB_FAIL_IDS:-}," in
    *",$_chat,"*) echo "stub: sending to $_chat FAILED" >&2; return 1 ;;
  esac
  return 0
}
STUB

# Runs the copied script. Args: <chat-id-list> [fail-ids]  -> prints stderr+stdout.
run_notify() {
  STUB_CALLS="$BASE/calls.txt"; : > "$STUB_CALLS"
  MARVEEN_ALERT_CHAT_ID="$1" STUB_FAIL_IDS="${2:-}" STUB_CALLS="$STUB_CALLS" \
    TELEGRAM_ENV="$BASE/env/.env" TELEGRAM_STATE_DIR="$BASE/env" TELEGRAM_ACCESS="$BASE/env/access.json" HOME="$BASE/home" \
    bash "$BASE/scripts/unit-fail-notify.sh" teszt.service 2>&1
}
calls() { cat "$BASE/calls.txt" 2>/dev/null | tr '\n' ' '; }

echo "unit-fail-notify: tobb cimzett"

# 1) KET CIMZETT, mindketto sikeres
out="$(run_notify "1000000001,1000000002")"
assert_contains "1a. az elso cimzett delivered" "delivered -- recipient 1/2" "$out"
assert_contains "1b. a masodik cimzett delivered" "delivered -- recipient 2/2" "$out"
assert_contains "1c. osszegzo sor" "2/2 recipient(s) delivered, 0 failed" "$out"
assert_eq       "1d. mindketto meg is lett hivva" "1000000001 1000000002 " "$(calls)"
assert_absent   "1e. a teljes chat-id NEM kerul a naploba" "1000000001)" "$out"

# 2) ⛔ NEGATIV KONTROLL: az ELSO cimzett bukik -> a MASODIK akkor is kap
out="$(run_notify "1000000001,1000000002" "1000000001")"
assert_contains "2a. az elso bukasa naplozva" "did NOT deliver -- recipient 1/2" "$out"
assert_contains "2b. a MASODIK ennek ellenere delivered" "delivered -- recipient 2/2" "$out"
assert_contains "2c. osszegzo: 1 sikeres, 1 bukott" "1/2 recipient(s) delivered, 1 failed" "$out"
assert_eq       "2d. a ciklus NEM allt meg az elso bukasnal" "1000000001 1000000002 " "$(calls)"

# 3) EGY cimzett (visszafele kompatibilitas)
out="$(run_notify "1000000001")"
assert_contains "3a. egyetlen id valtozatlanul mukodik" "delivered -- recipient 1/1" "$out"
assert_contains "3b. osszegzo egy cimzettre" "1/1 recipient(s) delivered, 0 failed" "$out"

# 4) SZOKOZ es zaro vesszo a .env-ben nem hiba
out="$(run_notify " 1000000001 , 1000000002 ,")"
assert_contains "4a. a szokozok/zaro vesszo tolerálva (2 cimzett)" "2/2 recipient(s) delivered" "$out"
assert_eq       "4b. a trimmelt id-k mennek ki" "1000000001 1000000002 " "$(calls)"

# 5) URES lista -> nincs kuldes, de MEGNEVEZI a hianyt
out="$(run_notify "")"
assert_contains "5a. a hiany megnevezve" "missing: MARVEEN_ALERT_CHAT_ID" "$out"
assert_eq       "5b. egyetlen kuldes sem tortent" "" "$(calls)"

# 6) A kilepesi kod MINDIG 0 (OnFailure-kezelo sosem kerulhet maga is failed-be)
MARVEEN_ALERT_CHAT_ID="1000000001" STUB_FAIL_IDS="1000000001" STUB_CALLS="$BASE/calls.txt" \
  TELEGRAM_ENV="$BASE/env/.env" TELEGRAM_STATE_DIR="$BASE/env" TELEGRAM_ACCESS="$BASE/env/access.json" \
  bash "$BASE/scripts/unit-fail-notify.sh" teszt.service >/dev/null 2>&1
assert_eq "6a. exit 0 meg teljes bukasnal is" "0" "$?"

# 7-10) A LISTA ES A FUTASIDEJU FELOLDAS EGYUTT (b2e9c0c1: a tartalek a lib/owner-chat.sh szabalya): a
# beallitott lista nyer; ures valtozonal a telepites .env ALLOWED_CHAT_ID-je, kulonben az access.json EGYETLEN
# DM-bejegyzese, tobb bejegyzesnel nincs talalgatas; a "0" a telepito helyorzoje (egyedul es listaban is).
ACC="$BASE/.claude/channels/telegram/access.json"
printf 'ALLOWED_CHAT_ID=0\n' > "$BASE/.env"
printf '{"allowFrom": ["1000000003"]}\n' > "$ACC"
out="$(run_notify "")"
assert_eq       "7a. ures valtozo, helyorzos .env, egyetlen DM-bejegyzes: az kap" "1000000003 " "$(calls)"
assert_contains "7b. osszegzo egy cimzettre" "1/1 recipient(s) delivered, 0 failed" "$out"
printf '{"allowFrom": ["1000000003", "1000000009"]}\n' > "$ACC"
out="$(run_notify "")"
assert_eq       "7c. ket DM-bejegyzes: nincs talalgatas, nincs kuldes (az elso-elem szabaly LEVALT)" "" "$(calls)"
assert_contains "7d. a konyvtar sajat oka a naploban" "refusing to guess" "$out"
printf 'ALLOWED_CHAT_ID=1000000005\n' > "$BASE/.env"
out="$(run_notify "")"
assert_eq       "7e. a telepites .env ALLOWED_CHAT_ID-je all elobb" "1000000005 " "$(calls)"
out="$(run_notify "1000000001,1000000002")"
assert_eq       "8a. beallitott lista: a lista nyer, a feloldas nem fut" "1000000001 1000000002 " "$(calls)"
out="$(run_notify "0")"
assert_eq       "9a. a \"0\" helyorzo: nincs kuldes (a develop szabalya: a feloldas csak ures valtozonal fut)" "" "$(calls)"
assert_contains "9b. a hiany megnevezve" "missing: MARVEEN_ALERT_CHAT_ID" "$out"
out="$(run_notify "0,1000000004")"
assert_eq       "10a. listaban a \"0\" elem kimarad, a tobbi kap" "1000000004 " "$(calls)"
rm -f "$ACC" "$BASE/.env"

echo
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
