#!/bin/bash
# Contract tests for the recipient LIST of scripts/host-restart-watchdog.sh and scripts/fleet-memory-gate.sh (b2e9c0c1).
# Run: bash scripts/__tests__/riasztas-lista.test.sh
#
# Same method as scripts/__tests__/unit-fail-notify.test.sh (615002e1): the REAL scripts are copied into a temp tree
# next to a STUB lib/send-telegram.sh that records every call and fails for the ids in STUB_FAIL_IDS, so no real Telegram
# message is ever sent. TELEGRAM_STATE_DIR and TELEGRAM_ACCESS are pinned into the sandbox, so the access.json fallback
# can only read the test's own (absent) file. The chat ids are made up.
#
# What matters most, per script: the NEGATIVE CONTROL (a bad first recipient must not stop the second) and the RETRY
# (the next run sends ONLY to the recipient that failed; the one already served does not get it twice).

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (varva '$2', kapott '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT

mkdir -p "$BASE/scripts/lib" "$BASE/env" "$BASE/store"
cp "$INSTALL_DIR/scripts/host-restart-watchdog.sh" "$BASE/scripts/host-restart-watchdog.sh"
cp "$INSTALL_DIR/scripts/fleet-memory-gate.sh" "$BASE/scripts/fleet-memory-gate.sh"
cp "$INSTALL_DIR/scripts/lib/alert-recipients.sh" "$BASE/scripts/lib/alert-recipients.sh"   # the REAL resolver
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
STUB_CALLS="$BASE/calls.txt"
calls() { tr '\n' ' ' < "$STUB_CALLS" 2>/dev/null | sed 's/ $//'; }

# ---------------------------------------------------------------- host-restart-watchdog.sh
WD_STATE="$BASE/store/.last-btime"
run_wd() {  # <btime> <chat-id-list> [fail-ids]
  : > "$STUB_CALLS"
  printf 'cpu 1 2 3\nbtime %s\n' "$1" > "$BASE/proc-stat"
  HOSTWD_PROC_STAT="$BASE/proc-stat" MARVEEN_STORE="$BASE/store" MARVEEN_ALERT_CHAT_ID="$2" STUB_FAIL_IDS="${3:-}" \
    STUB_CALLS="$STUB_CALLS" TELEGRAM_ENV="$BASE/env/.env" TELEGRAM_STATE_DIR="$BASE/env" TELEGRAM_ACCESS="$BASE/env/access.json" \
    bash "$BASE/scripts/host-restart-watchdog.sh" > "$BASE/wd.log" 2>&1
}
wd_reset() { rm -f "$WD_STATE" "$WD_STATE.delivered"; run_wd 1000 "111111111,222222222"; }  # baseline, no send

echo "host-restart-watchdog: tobb cimzett"
wd_reset
assert_eq "h0. az alapvonal elso futasa nem kuld" "" "$(calls)"
run_wd 2000 "111111111,222222222"
assert_eq "h1. ket jo cimzett: mindketto egyszer" "111111111 222222222" "$(calls)"
assert_eq "h1. az alapvonal bélyegezve" "2000" "$(tr -dc '0-9' < "$WD_STATE")"
assert_eq "h1. a cimzettenkenti rekord torolve" "nincs" "$([ -f "$WD_STATE.delivered" ] && echo van || echo nincs)"

wd_reset
run_wd 2000 "111111111,222222222" "111111111"
assert_eq "h2. NEGATIV KONTROLL: az elso bukik, a masodik MEGIS kap" "111111111 222222222" "$(calls)"
assert_eq "h2. az alapvonal NEM bélyegezve" "1000" "$(tr -dc '0-9' < "$WD_STATE")"
assert_eq "h2. a rekordban csak a sikeres cimzett" "2000 222222222" "$(cat "$WD_STATE.delivered" 2>/dev/null)"
run_wd 2000 "111111111,222222222"
assert_eq "h3. ujrafutas: CSAK a bukott cimzett kap, a kiszolgalt nem masodszor" "111111111" "$(calls)"
assert_eq "h3. most bélyegezve" "2000" "$(tr -dc '0-9' < "$WD_STATE")"
assert_eq "h3. a rekord torolve" "nincs" "$([ -f "$WD_STATE.delivered" ] && echo van || echo nincs)"
run_wd 2000 "111111111,222222222"
assert_eq "h3b. valtozatlan btime mellett nincs kuldes" "" "$(calls)"

wd_reset
run_wd 3000 " 111111111 ,0,,222222222, "
assert_eq "h4. szokoz, ures elem es a \"0\" kimarad, a zaro vesszo nem hiba" "111111111 222222222" "$(calls)"

wd_reset
run_wd 4000 "333333333"
assert_eq "h5. egy azonosito egyelemu lista: a regi viselkedes" "333333333" "$(calls)"
assert_eq "h5. bélyegezve" "4000" "$(tr -dc '0-9' < "$WD_STATE")"

wd_reset
echo "5000 222222222" > "$WD_STATE.delivered"   # egy MAS boot rekordja
run_wd 6000 "111111111,222222222"
assert_eq "h6. egy korabbi boot rekordja nem szamit: mindketto kap" "111111111 222222222" "$(calls)"

# ---------------------------------------------------------------- fleet-memory-gate.sh
GATE_STAMP="$BASE/store/.fleet-memgate-alert"
printf 'MemTotal:       16000000 kB\nMemAvailable:     400000 kB\n' > "$BASE/meminfo"   # a hard band: alert path
run_gate() {  # <chat-id-list> [fail-ids]
  : > "$STUB_CALLS"
  MEMGATE_PROC_MEMINFO="$BASE/meminfo" MARVEEN_STORE="$BASE/store" MARVEEN_ALERT_CHAT_ID="$1" STUB_FAIL_IDS="${2:-}" \
    STUB_CALLS="$STUB_CALLS" TELEGRAM_ENV="$BASE/env/.env" TELEGRAM_STATE_DIR="$BASE/env" TELEGRAM_ACCESS="$BASE/env/access.json" \
    MARVEEN_MEM_GATE_OBSERVE=1 bash "$BASE/scripts/fleet-memory-gate.sh" check > "$BASE/gate.log" 2>&1
}
gate_reset() { rm -f "$GATE_STAMP" "$GATE_STAMP.delivered"; }

echo "fleet-memory-gate: tobb cimzett"
gate_reset
run_gate "111111111,222222222"
assert_eq "f1. ket jo cimzett: mindketto egyszer" "111111111 222222222" "$(calls)"
assert_eq "f1. a cooldown-bélyeg megirva" "van" "$([ -s "$GATE_STAMP" ] && echo van || echo nincs)"
run_gate "111111111,222222222"
assert_eq "f3. cooldownon belul ujra: nincs kuldes" "" "$(calls)"

gate_reset
run_gate "111111111,222222222" "111111111"
assert_eq "f2. NEGATIV KONTROLL: az elso bukik, a masodik MEGIS kap" "111111111 222222222" "$(calls)"
assert_eq "f2. a cooldown-bélyeg NEM irodik" "nincs" "$([ -s "$GATE_STAMP" ] && echo van || echo nincs)"
run_gate "111111111,222222222"
assert_eq "f2b. ujrafutas: CSAK a bukott cimzett kap" "111111111" "$(calls)"
assert_eq "f2b. most a bélyeg megirva" "van" "$([ -s "$GATE_STAMP" ] && echo van || echo nincs)"

gate_reset
run_gate "0"
assert_eq "f4. csak \"0\": nincs kuldes (a NULLAORFLEET921 or listaban is all)" "" "$(calls)"
assert_eq "f4. es a kihagyas a naploban" "1" "$(grep -c 'no owner chat id resolved' "$BASE/gate.log")"

echo
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
