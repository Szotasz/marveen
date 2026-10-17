#!/bin/bash
# Contract tests for scripts/lib/alert-recipients.sh, the one recipient resolution of unit-fail-notify.sh,
# host-restart-watchdog.sh and fleet-memory-gate.sh (b2e9c0c1; the lead's decisions of 2026-09-27 21:21Z, 21:32Z
# and 21:38Z: the fallback is lib/owner-chat.sh resolve_owner_chat_id).
# Run: bash scripts/__tests__/alert-recipients.test.sh
#
# The negative test the decisions ask for:
#   (a) empty list AND no owner chat (placeholder .env with a missing, unreadable, empty or ambiguous access.json):
#       the resolver returns non-zero, no message goes out, and the no-recipient line -- with the owner-chat
#       library's own reason, verbatim -- is in $MARVEEN_STORE/alert-recipients.log;
#   (b) meanwhile the three scripts keep their own exit codes: 0, 0, and the gate's allow/block decision (0/10),
#       which a missing recipient never changes;
#   (c) with a set list the fallback recipient gets nothing, and there is no fallback line;
#   (d) a fallback send writes the fallback line to the log file.
# The sandbox is its own install -- its .env, its install-scoped channel dir, an empty HOME -- because owner-chat.sh
# reads the install .env and the MAIN install's channel dir by design (it ignores TELEGRAM_STATE_DIR). The REAL
# scripts and libraries run next to a STUB lib/send-telegram.sh that only records calls: nothing is ever sent.
# The chat ids are made up.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (varva '$2', kapott '$3')"; fi; }
assert_contains() { if grep -qF -- "$2" <<< "$3"; then pass "$1"; else fail "$1 (nem tartalmazza: '$2')"; fi; }
assert_absent() { if grep -qF -- "$2" <<< "$3"; then fail "$1 (NEM szabadna tartalmaznia: '$2')"; else pass "$1"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT

CHAN="$BASE/.claude/channels/telegram"
mkdir -p "$BASE/scripts/lib" "$BASE/store" "$BASE/home" "$CHAN"
for f in unit-fail-notify.sh host-restart-watchdog.sh fleet-memory-gate.sh; do
  cp "$INSTALL_DIR/scripts/$f" "$BASE/scripts/$f"
done
cp "$INSTALL_DIR/scripts/lib/alert-recipients.sh" "$INSTALL_DIR/scripts/lib/owner-chat.sh" "$BASE/scripts/lib/"
printf 'TELEGRAM_BOT_TOKEN="teszt-token"\n' > "$CHAN/.env"
cat > "$BASE/scripts/lib/send-telegram.sh" <<'STUB'
# STUB sender: records every call, never sends.
send_telegram_message() { echo "$2" >> "$STUB_CALLS"; return 0; }
STUB
STUB_CALLS="$BASE/calls.txt"
ACCESS="$CHAN/access.json"
ALOG="$BASE/store/alert-recipients.log"
calls() { tr '\n' ' ' < "$STUB_CALLS" 2>/dev/null | sed 's/ $//'; }
alog() { cat "$ALOG" 2>/dev/null; }
# reset <install .env body or "-" for none> <access.json body or "-" for none>
reset() {
  : > "$STUB_CALLS"; : > "$BASE/res.log"
  rm -f "$ALOG" "$BASE/.env" "$ACCESS" "$BASE/store/.last-btime" "$BASE/store/.last-btime.delivered" \
    "$BASE/store/.fleet-memgate-alert" "$BASE/store/.fleet-memgate-alert.delivered" "$BASE/store/.fleet-safe-mode"
  [ "$1" = "-" ] || printf '%s\n' "$1" > "$BASE/.env"
  [ "$2" = "-" ] || printf '%s' "$2" > "$ACCESS"
}
# every run: no inherited channel variables, the sandbox HOME
clean_env() { env -u TELEGRAM_STATE_DIR -u TELEGRAM_ENV -u TELEGRAM_ACCESS HOME="$BASE/home" "$@"; }

# ---------------------------------------------------------------- the resolver itself
# resolve <list>  -> "<rc>|<source>|<ids>" ; the resolver's own log lines go to $BASE/res.log
resolve() {
  clean_env MARVEEN_ALERT_CHAT_ID="$1" bash -c '
    B="$1"; . "$B/scripts/lib/alert-recipients.sh"
    l() { echo "$*" >> "$B/res.log"; }   # inside l, $1 is the message, so the dir is captured first
    alert_resolve_recipients "$B/.env" l "$B/store"; rc=$?
    echo "$rc|$ALERT_RECIPIENT_SOURCE|${ALERT_CHAT_IDS[*]+${ALERT_CHAT_IDS[*]}}"' _ "$BASE"
}

echo "a kozos feloldo (tartalek: lib/owner-chat.sh)"
reset 'ALLOWED_CHAT_ID=0' -
assert_eq "a1. ures lista, helyorzos .env, NINCS access.json: rc 1, nincs cimzett" "1|none|" "$(resolve "")"
assert_contains "a1. a hiany-sor a naplofajlban, a konyvtar sajat okaval" "no-recipient (MARVEEN_ALERT_CHAT_ID empty; no owner chat: .env placeholder/empty and no readable access.json)" "$(alog)"
assert_contains "a1. es a szkript naplojaban" "ALERT HAS NO RECIPIENT" "$(cat "$BASE/res.log")"

reset 'ALLOWED_CHAT_ID=0' '{"allowFrom": []}'
assert_eq "a2. ures allowFrom: rc 1" "1|none|" "$(resolve "")"
assert_contains "a2. az ok: nincs DM-bejegyzes" "has no DM entry" "$(alog)"

reset 'ALLOWED_CHAT_ID=0' '{"allowFrom": ["1000000003",'
assert_eq "a3. olvashatatlan access.json: rc 1" "1|none|" "$(resolve "")"

reset 'ALLOWED_CHAT_ID=0' '{"allowFrom": ["1000000003", "1000000009"]}'
assert_eq "a4. KET DM-bejegyzes: nincs talalgatas, rc 1 (az elso-elem szabaly LEVALT)" "1|none|" "$(resolve "")"
assert_contains "a4. az ok szo szerint" "access.json has 2 DM entries, refusing to guess" "$(alog)"

reset - '{"allowFrom": ["1000000003"]}'
assert_eq "a5. nincs telepitesi .env: rc 1" "1|none|" "$(resolve "")"
assert_contains "a5. az ok szo szerint" "no owner chat: env file not found: $BASE/.env" "$(alog)"

reset 'ALLOWED_CHAT_ID=0' '{"allowFrom": ["-1001234567890"]}'
assert_eq "a6. csak csoport-azonosito: rc 1 (csoport soha)" "1|none|" "$(resolve "")"

reset 'ALLOWED_CHAT_ID=0' '{"allowFrom": ["1000000003"]}'
assert_eq "d1. helyorzos .env, egyetlen DM-bejegyzes: az a tartalek" "0|fallback|1000000003" "$(resolve "")"
assert_contains "d1. a tartalek-sor a naplofajlban, utolso 4 jeggyel" "fallback ...0003" "$(alog)"
assert_absent "d1. a teljes azonosito NEM kerul a naplofajlba" "1000000003" "$(alog)"
assert_absent "d1. es a szkript naplojaba sem" "1000000003" "$(cat "$BASE/res.log")"
assert_eq "d1. esemenyenkent egy sor" "1" "$(alog | wc -l | tr -d ' ')"

reset 'ALLOWED_CHAT_ID=1000000005' '{"allowFrom": ["1000000003", "1000000009"]}'
assert_eq "d2. a telepites .env ALLOWED_CHAT_ID-je all elobb" "0|fallback|1000000005" "$(resolve "")"

reset 'ALLOWED_CHAT_ID=0' '{"allowFrom": ["0", "1000000009"]}'
assert_eq "d3. a \"0\" bejegyzes nem szamit: az egyetlen valodi DM-bejegyzes a tartalek" "0|fallback|1000000009" "$(resolve "")"

reset 'ALLOWED_CHAT_ID=1000000005' '{"allowFrom": ["1000000003"]}'
assert_eq "c1. beallitott lista: a lista nyer" "0|list|1000000001 1000000002" "$(resolve "1000000001,1000000002")"
assert_eq "c1. beallitott listanal nincs naplosor (se tartalek, se hiany)" "" "$(alog)"

reset 'ALLOWED_CHAT_ID=1000000005' '{"allowFrom": ["1000000003"]}'
assert_eq "c2. beallitott, de hasznalhatatlan lista (\"0\"): nincs tartalek, rc 1" "1|none|" "$(resolve "0")"
assert_contains "c2. a hiany-sor megnevezi, hogy a lista be van allitva" "no-recipient (MARVEEN_ALERT_CHAT_ID set, no usable id)" "$(alog)"

reset 'ALLOWED_CHAT_ID=0' '{"allowFrom": ["1000000003"]}'
: > "$BASE/nem-konyvtar"   # a FILE where the store dir would be: the append must fail
clean_env MARVEEN_ALERT_CHAT_ID="" bash -c 'B="$1"; . "$B/scripts/lib/alert-recipients.sh"; l() { echo "$*" >> "$B/res.log"; }
  alert_resolve_recipients "$B/.env" l "$B/nem-konyvtar"' _ "$BASE" > /dev/null 2>&1
assert_contains "e1. ha a naplofajl nem irhato, a szkript naplojaban all" "could not append to $BASE/nem-konyvtar/alert-recipients.log" "$(cat "$BASE/res.log")"

reset 'ALLOWED_CHAT_ID=0' '{"allowFrom": ["1000000003"]}'
mv "$BASE/scripts/lib/owner-chat.sh" "$BASE/owner-chat.sh.felre"
assert_eq "e2. hianyzo owner-chat konyvtar: nincs cimzett, rc 1" "1|none|" "$(resolve "")"
assert_contains "e2. es ezt kimondja" "the owner-chat library ($BASE/scripts/lib/owner-chat.sh) could not be loaded" "$(alog)"
mv "$BASE/owner-chat.sh.felre" "$BASE/scripts/lib/owner-chat.sh"

# ---------------------------------------------------------------- unit-fail-notify.sh
run_ufn() {  # <list>
  : > "$STUB_CALLS"
  clean_env MARVEEN_ALERT_CHAT_ID="$1" STUB_CALLS="$STUB_CALLS" MARVEEN_STORE="$BASE/store" \
    bash "$BASE/scripts/unit-fail-notify.sh" teszt.service 2>&1
}
echo "unit-fail-notify.sh"
reset 'ALLOWED_CHAT_ID=0' -
out="$(run_ufn "")"; rc=$?
assert_eq "u-a. ures lista, nincs tulajdonosi chat: nincs kuldes" "" "$(calls)"
assert_eq "u-b. a folyamat-kod valtozatlanul 0" "0" "$rc"
assert_contains "u-a. a hiany-sor a naplofajlban, a szkript nevevel" "unit-fail-notify.sh no-recipient" "$(alog)"
assert_contains "u-a. es a szkript naplojaban" "ALERT HAS NO RECIPIENT" "$out"
reset 'ALLOWED_CHAT_ID=1000000005' -
out="$(run_ufn "")"
assert_eq "u-d. ures lista: a tartalek (a tulajdonosi chat) kapja" "1000000005" "$(calls)"
assert_contains "u-d. a kuldes-sor tartalekkent jeloli" "delivered -- FALLBACK recipient (owner chat, lib/owner-chat.sh) 1/1 (...0005)" "$out"
assert_contains "u-d. a tartalek-sor a naplofajlban" "unit-fail-notify.sh fallback ...0005" "$(alog)"
reset 'ALLOWED_CHAT_ID=1000000005' -
out="$(run_ufn "1000000001")"
assert_eq "u-c. beallitott lista: a tartalek nem kap" "1000000001" "$(calls)"
assert_absent "u-c. nincs tartalek-jeloles" "FALLBACK" "$out"
assert_eq "u-c. nincs naplosor" "" "$(alog)"

# ---------------------------------------------------------------- host-restart-watchdog.sh
run_wd() {  # <btime> <list>
  : > "$STUB_CALLS"
  printf 'cpu 1 2 3\nbtime %s\n' "$1" > "$BASE/proc-stat"
  clean_env HOSTWD_PROC_STAT="$BASE/proc-stat" MARVEEN_STORE="$BASE/store" MARVEEN_ALERT_CHAT_ID="$2" STUB_CALLS="$STUB_CALLS" \
    bash "$BASE/scripts/host-restart-watchdog.sh" 2>&1
}
echo "host-restart-watchdog.sh"
reset 'ALLOWED_CHAT_ID=0' -; run_wd 1000 "" > /dev/null   # baseline
out="$(run_wd 2000 "")"; rc=$?
assert_eq "h-a. ures lista, nincs tulajdonosi chat: nincs kuldes" "" "$(calls)"
assert_eq "h-b. a folyamat-kod valtozatlanul 0" "0" "$rc"
assert_contains "h-a. a hiany-sor a naplofajlban" "host-restart-watchdog.sh no-recipient" "$(alog)"
reset 'ALLOWED_CHAT_ID=1000000005' -; run_wd 1000 "" > /dev/null
out="$(run_wd 2000 "")"
assert_eq "h-d. ures lista: a tartalek kapja" "1000000005" "$(calls)"
assert_contains "h-d. a kuldes-sor tartalekkent jeloli" "Telegram sent -- FALLBACK recipient (owner chat, lib/owner-chat.sh) 1/1 (...0005)" "$out"
assert_contains "h-d. a tartalek-sor a naplofajlban" "host-restart-watchdog.sh fallback ...0005" "$(alog)"
reset 'ALLOWED_CHAT_ID=1000000005' -; run_wd 1000 "" > /dev/null
out="$(run_wd 2000 "1000000001")"
assert_eq "h-c. beallitott lista: a tartalek nem kap" "1000000001" "$(calls)"
assert_eq "h-c. nincs naplosor" "" "$(alog)"

# ---------------------------------------------------------------- fleet-memory-gate.sh
# The gate's exit code is its allow/block decision: 10 in the hard and warn band for a non-core agent, 0 for a core
# agent outside the hard band. The cap is set out of reach, so the host's own agent count cannot decide.
printf 'MemTotal:       16000000 kB\nMemAvailable:     400000 kB\n' > "$BASE/meminfo-hard"
printf 'MemTotal:       16000000 kB\nMemAvailable:    2400000 kB\n' > "$BASE/meminfo-warn"
printf 'MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\n' > "$BASE/meminfo-ok"
run_gate() {  # <meminfo> <list> <agent>
  : > "$STUB_CALLS"
  clean_env MEMGATE_PROC_MEMINFO="$BASE/$1" MARVEEN_STORE="$BASE/store" MARVEEN_ALERT_CHAT_ID="$2" STUB_CALLS="$STUB_CALLS" \
    MARVEEN_AGENT_CAP=1000 MARVEEN_CORE_AGENTS=tesztmag bash "$BASE/scripts/fleet-memory-gate.sh" --check "$3" > "$BASE/gate.out" 2>&1
}
echo "fleet-memory-gate.sh"
reset 'ALLOWED_CHAT_ID=0' -; run_gate meminfo-hard "" tesztagens; rc=$?
assert_eq "g-b. hard sav, nincs cimzett: a dontes TILT (10)" "10" "$rc"
assert_eq "g-a. nincs kuldes" "" "$(calls)"
assert_contains "g-a. a hiany-sor a naplofajlban" "fleet-memory-gate.sh no-recipient" "$(alog)"
reset 'ALLOWED_CHAT_ID=0' -; run_gate meminfo-hard "1000000001" tesztagens; rc=$?
assert_eq "g-b. KONTROLL: hard sav, beallitott listaval ugyanaz a dontes (10)" "10" "$rc"
assert_eq "g-b. KONTROLL: es a riasztas ki is ment" "1000000001" "$(calls)"
reset 'ALLOWED_CHAT_ID=0' -; run_gate meminfo-warn "" tesztagens; rc=$?
assert_eq "g-b. warn sav, nincs cimzett: TILT (10)" "10" "$rc"
reset 'ALLOWED_CHAT_ID=0' -; run_gate meminfo-warn "" tesztmag; rc=$?
assert_eq "g-b. warn sav, core agens, nincs cimzett: ENGED (0)" "0" "$rc"
reset 'ALLOWED_CHAT_ID=0' -; run_gate meminfo-ok "" tesztagens; rc=$?
assert_eq "g-b. nyugodt sav, nincs cimzett: ENGED (0), riasztas sincs" "0|" "$rc|$(calls)"
reset 'ALLOWED_CHAT_ID=1000000005' -; run_gate meminfo-hard "" tesztagens
assert_eq "g-d. ures lista: a tartalek kapja" "1000000005" "$(calls)"
assert_contains "g-d. a kuldes-sor tartalekkent jeloli" "Telegram sent [hard] -- FALLBACK recipient (owner chat, lib/owner-chat.sh) 1/1 (...0005)" "$(cat "$BASE/gate.out")"
assert_contains "g-d. a tartalek-sor a naplofajlban" "fleet-memory-gate.sh fallback ...0005" "$(alog)"
reset 'ALLOWED_CHAT_ID=1000000005' -; run_gate meminfo-hard "1000000001" tesztagens
assert_eq "g-c. beallitott lista: a tartalek nem kap" "1000000001" "$(calls)"
assert_eq "g-c. nincs naplosor" "" "$(alog)"
reset 'ALLOWED_CHAT_ID=1000000005' -; run_gate meminfo-hard "" tesztagens; run_gate meminfo-hard "" tesztagens
assert_eq "g-e. cooldownon belul nincs uj kuldes es nincs uj tartalek-sor" "|1" "$(calls)|$(alog | wc -l | tr -d ' ')"

echo
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
