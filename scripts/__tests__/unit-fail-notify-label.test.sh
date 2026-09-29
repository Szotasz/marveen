#!/bin/bash
# Contract tests for scripts/unit-fail-notify.sh -- the PER-UNIT LABEL AND REASON (9318442d).
# Run: bash scripts/__tests__/unit-fail-notify-label.test.sh
#
# The measured defect: a guard whose alert IS its OnFailure (exit non-zero on a new problem, e.g. a telephone-path
# guard logging "<guard>: ⛔ PROBLEMA:<leg>") reached the owners as "Marveen app-crash: ... FAILED", without the problem,
# and with a label that says the opposite of what happened. The markers are the ones the guards of one install really
# print (measured 2026-09-29 in their scripts): "PROBLEMA:" anywhere in the line, and "RIASZTAS" / "RIASZTÁS".
# The acceptance, each a case below:
#   - a guard's run (exit-code) with a marker line is an "őr-jelzés" with that line as the reason, never "app-crash";
#   - NEGATIVE: the guard's OWN error (no marker line in that run) still arrives as a failure, with systemd's reason,
#     and so does a run killed by a signal even if it printed a marker;
#   - the line is taken from the FAILED run only (its InvocationID): an earlier run's marker never labels a failure.
#
# Hermetic: the REAL script is copied into a temp tree next to a STUB sender that records the text; systemctl and
# journalctl are PATH shims that answer from the test's variables and log how they were asked. No real unit, no real
# journal, no Telegram. The chat id is made up.

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
mkdir -p "$BASE/scripts/lib" "$BASE/env" "$BASE/home" "$BASE/shim" "$BASE/nosys"
cp "$SRC" "$BASE/scripts/unit-fail-notify.sh"
cp "$INSTALL_DIR/scripts/lib/alert-recipients.sh" "$BASE/scripts/lib/alert-recipients.sh"
cp "$INSTALL_DIR/scripts/lib/owner-chat.sh" "$BASE/scripts/lib/owner-chat.sh"
printf 'TELEGRAM_BOT_TOKEN="teszt-token"\n' > "$BASE/env/.env"
cat > "$BASE/scripts/lib/send-telegram.sh" <<'STUB'
# STUB sender: records every text it is asked to send.
send_telegram_message() { printf '%s\n----\n' "$3" >> "$STUB_MSGS"; return 0; }
STUB

# systemctl shim: `systemctl <--user|--system> show -p <Prop> --value <unit>`, answered for the scope in STUB_SCOPE.
cat > "$BASE/shim/systemctl" <<'SHIM'
#!/bin/bash
echo "$*" >> "$STUB_LOG"
scope="$1"; prop="$4"
case "$scope" in --user) s=user ;; --system) s=system ;; *) s=other ;; esac
if [ "$prop" = LoadState ]; then [ "$s" = "${STUB_SCOPE:-none}" ] && echo loaded || echo not-found; exit 0; fi
[ "$s" = "${STUB_SCOPE:-none}" ] || exit 0
case "$prop" in
  InvocationID) echo "${STUB_INV:-}" ;;
  Result) echo "${STUB_RESULT:-}" ;;
  ExecMainStatus) echo "${STUB_STATUS:-}" ;;
  Description) echo "${STUB_DESC:-}" ;;
esac
SHIM
# journalctl shim: the journal is STUB_JOURNAL ("<invocation-id>|<line>" rows, every run of the unit). Asked by
# invocation id it gives that run's lines; asked by unit (-u) it gives every run's lines, as the real journal does.
cat > "$BASE/shim/journalctl" <<'SHIM'
#!/bin/bash
echo "journalctl $*" >> "$STUB_LOG"
id=""; unit=""
while [ $# -gt 0 ]; do
  case "$1" in _SYSTEMD_INVOCATION_ID=*) id="${1#_SYSTEMD_INVOCATION_ID=}" ;; -u) unit="$2"; shift ;; esac
  shift
done
if [ -n "$id" ]; then printf '%s\n' "${STUB_JOURNAL:-}" | grep -F -- "${id}|" | cut -d'|' -f2-
elif [ -n "$unit" ]; then printf '%s\n' "${STUB_JOURNAL:-}" | cut -d'|' -f2-
fi
exit 0
SHIM
chmod +x "$BASE/shim/systemctl" "$BASE/shim/journalctl"
# A PATH without systemctl and journalctl: every other command of the system, by symlink.
for d in /usr/local/bin /usr/bin /bin; do
  for f in "$d"/*; do
    n="$(basename "$f")"
    case "$n" in systemctl|journalctl) continue ;; esac
    [ -e "$BASE/nosys/$n" ] || ln -s "$f" "$BASE/nosys/$n" 2>/dev/null
  done
done
[ -e "$BASE/nosys/systemctl" ] && { echo "a systemctl nelkuli PATH-ban megis van systemctl"; exit 1; }

# run [PATH-prefix-dir]; the STUB_* variables of the caller shape the unit and its journal.
run() {
  export STUB_MSGS="$BASE/msgs.txt" STUB_LOG="$BASE/log.txt"; : > "$STUB_MSGS"; : > "$STUB_LOG"
  local p="$BASE/shim:$PATH"; [ "${1:-}" = nosys ] && p="$BASE/nosys"
  PATH="$p" MARVEEN_ALERT_CHAT_ID="1000000001" TELEGRAM_ENV="$BASE/env/.env" TELEGRAM_STATE_DIR="$BASE/env" \
    TELEGRAM_ACCESS="$BASE/env/access.json" HOME="$BASE/home" bash "$BASE/scripts/unit-fail-notify.sh" teszt-or.service 2>&1
}
msg() { cat "$BASE/msgs.txt" 2>/dev/null; }

echo "unit-fail-notify: egysegenkenti cimke es ok"

# 1) A guard's run ending with PROBLEMA: "őr-jelzés", that line as the reason; an EARLIER run's PROBLEMA is not used.
export STUB_SCOPE=user STUB_INV=inv-2 STUB_RESULT=exit-code STUB_STATUS=1 STUB_DESC="Teszt-or (proba): regisztracio + bejovo ut"
export STUB_JOURNAL=$'inv-1|teszt-or: ⛔ PROBLEMA:regi-lab\ninv-2|teszt-or: indul\ninv-2|teszt-or: ⛔ PROBLEMA:bejovo-ut'
out="$(run)"; rc=$?
m="$(msg)"
assert_contains "1a. or-jelzes a cimke" "Marveen őr-jelzés: a(z) teszt-or.service (Teszt-or (proba): regisztracio + bejovo ut) problémát jelez" "$m"
assert_contains "1b. az ok a bukott futas PROBLEMA-sora (a valodi alak: nem a sor elejen)" "Ok: teszt-or: ⛔ PROBLEMA:bejovo-ut" "$m"
assert_absent   "1c. NEM app-crash" "app-crash" "$m"
assert_absent   "1d. a korabbi futas sora nem kerul bele" "regi-lab" "$m"
assert_contains "1e. a naplo a bukott futas azonositojaval kerdezve" "journalctl --user _SYSTEMD_INVOCATION_ID=inv-2 -o cat --no-pager" "$(cat "$BASE/log.txt")"
assert_contains "1f. a kuldes megtortent" "delivered -- recipient 1/1" "$out"
assert_eq       "1g. exit 0 (az OnFailure-kezelo sosem failed)" "0" "$rc"

# 2) NEGATIVE: the guard's OWN error (no PROBLEMA line in its run) is still a failure, with systemd's reason.
export STUB_INV=inv-3 STUB_STATUS=2 STUB_JOURNAL=$'inv-2|teszt-or: ⛔ PROBLEMA:bejovo-ut\ninv-3|hiba: az allapotfajl nem olvashato'
out="$(run)"
m="$(msg)"
assert_contains "2a. a sajat hiba app-crash-kent megy" "Marveen app-crash: a(z) teszt-or.service (Teszt-or (proba): regisztracio + bejovo ut) unit FAILED" "$m"
assert_contains "2b. a systemd oka" "Ok (systemd): kilépési kód 2" "$m"
assert_absent   "2c. NEM or-jelzes" "őr-jelzés" "$m"
assert_absent   "2d. a korabbi futas PROBLEMA-sora nem cimkezi" "PROBLEMA" "$m"
assert_contains "2e. a kuldes megtortent" "delivered -- recipient 1/1" "$out"

# 3) A crash by signal after an earlier guard signal: the reason is the signal, not the old PROBLEMA.
export STUB_INV=inv-4 STUB_RESULT=signal STUB_STATUS=9 STUB_JOURNAL=$'inv-2|teszt-or: ⛔ PROBLEMA:bejovo-ut\ninv-4|teszt-or: indul'
run >/dev/null; m="$(msg)"
assert_contains "3a. jelzessel leallt: app-crash" "Marveen app-crash" "$m"
assert_contains "3b. az ok a jelzes" "Ok (systemd): jelzés 9 (signal)" "$m"
assert_absent   "3c. a regi PROBLEMA nem kerul bele" "PROBLEMA" "$m"

# 4) A system unit: the user manager does not know it, the system manager does; the same rule applies there.
export STUB_SCOPE=system STUB_INV=inv-5 STUB_RESULT=exit-code STUB_STATUS=1 STUB_DESC="" STUB_JOURNAL=$'inv-5|PROBLEMA:regisztracio'
run >/dev/null; m="$(msg)"
assert_contains "4a. rendszer-unit: or-jelzes" "Marveen őr-jelzés: a(z) teszt-or.service problémát jelez" "$m"
assert_contains "4b. rendszer-unit: a --system naplo" "journalctl --system _SYSTEMD_INVOCATION_ID=inv-5" "$(cat "$BASE/log.txt")"
assert_absent   "4c. ures leiras mellett nincs ures zarojel" "service ()" "$m"

# 5) CONTROL: a unit neither manager knows (the old behaviour of every failure): today's text, no reason line.
export STUB_SCOPE=none
run >/dev/null; m="$(msg)"
assert_contains "5a. ismeretlen unit: a mai szoveg" "Marveen app-crash: a(z) teszt-or.service unit FAILED állapotba került" "$m"
assert_absent   "5b. nincs ok-sor" "Ok (systemd)" "$m"

# 6) CONTROL: no systemctl and no journalctl on the PATH at all: today's text, and still sent.
out="$(run nosys)"; rc=$?
m="$(msg)"
assert_contains "6a. systemd nelkul: a mai szoveg" "Marveen app-crash: a(z) teszt-or.service unit FAILED állapotba került" "$m"
assert_contains "6b. es a kuldes megtortent" "delivered -- recipient 1/1" "$out"
assert_eq       "6c. exit 0" "0" "$rc"

# 7) The PROBLEMA line is someone's output: control characters out, one line, bounded length.
export STUB_SCOPE=user STUB_INV=inv-6 STUB_RESULT=exit-code STUB_STATUS=1 STUB_DESC="Teszt-or"
export STUB_JOURNAL="inv-6|PROBLEMA:"$'\033'"[31mpiros"$'\033'"[0m $(printf 'x%.0s' $(seq 1 400))"
run >/dev/null; m="$(msg)"
assert_absent   "7a. nincs ESC a szovegben" $'\033' "$m"
assert_contains "7b. a lathato resz megmarad" "Ok: PROBLEMA:[31mpiros[0m x" "$m"
okline="$(grep -E '^Ok: ' <<< "$m" | head -1)"
assert_eq       "7c. az ok-sor legfeljebb 300 karakter (a 'Ok: ' elotaggal 304)" "304" "${#okline}"

# 8) The other marker the guards use, with the accent: "RIASZTÁS".
export STUB_SCOPE=user STUB_INV=inv-7 STUB_RESULT=exit-code STUB_STATUS=1 STUB_DESC="Teszt-eletjel"
export STUB_JOURNAL=$'inv-7|[TESZT-ÉLETJEL] RIASZTÁS, egy ugynok: nem valaszol'
run >/dev/null; m="$(msg)"
assert_contains "8a. RIASZTÁS: or-jelzes" "Marveen őr-jelzés: a(z) teszt-or.service (Teszt-eletjel) problémát jelez" "$m"
assert_contains "8b. az ok a RIASZTÁS-sor" "Ok: [TESZT-ÉLETJEL] RIASZTÁS, egy ugynok: nem valaszol" "$m"

# 9) And without the accent: "RIASZTAS".
export STUB_INV=inv-8 STUB_JOURNAL=$'inv-8|MENTES-RIASZTAS (teszt): a mentes kimaradt'
run >/dev/null; m="$(msg)"
assert_contains "9a. RIASZTAS: or-jelzes, az ok a sor" "Ok: MENTES-RIASZTAS (teszt): a mentes kimaradt" "$m"
assert_absent   "9b. NEM app-crash" "app-crash" "$m"

# 10) NEGATIVE: a run killed by a signal is a crash even if it printed a marker before it.
export STUB_INV=inv-9 STUB_RESULT=signal STUB_STATUS=9 STUB_JOURNAL=$'inv-9|teszt-or: ⛔ PROBLEMA:bejovo-ut'
run >/dev/null; m="$(msg)"
assert_contains "10a. jelzessel leallt: app-crash" "Marveen app-crash" "$m"
assert_contains "10b. az ok a jelzes" "Ok (systemd): jelzés 9 (signal)" "$m"
assert_absent   "10c. NEM or-jelzes" "őr-jelzés" "$m"

# 11) The cooldown line of a guard ("PROBLEMA, de azonos allapot ...": no colon, no alert) is not a marker.
export STUB_INV=inv-10 STUB_RESULT=exit-code STUB_STATUS=1 STUB_JOURNAL=$'inv-10|teszt-or: PROBLEMA, de azonos allapot 30 percen belul -- nem riasztok ujra'
run >/dev/null; m="$(msg)"
assert_contains "11a. a lehulesi sor nem jeloles: app-crash" "Marveen app-crash" "$m"
assert_absent   "11b. NEM or-jelzes" "őr-jelzés" "$m"

echo
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
