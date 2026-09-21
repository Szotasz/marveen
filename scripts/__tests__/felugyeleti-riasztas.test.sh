#!/usr/bin/env bash
# A FELUGYELETI ES RIASZTASI UT KET OSSZEJATSZO HIBAJA (ZAKARFELUGY921).
#
# Kulso bejelentes (Webtoday Kft., 2026-09-21, v1.38.0, Linux + systemd), utana
# sajat meres elo Linux + systemd 255 kornyezetben:
#
#  BUG 1 -- a frissites-finalizert SIGHUP olte meg a stop.sh es a start.sh KOZOTT.
#    A `systemd-run --user --scope` sajat cgroupot ad, de a VEZERLO TERMINALT NEM
#    veszi el; a stop.sh `tmux kill-session`-je epp azt a pty-t szunteti meg. Merve,
#    A/B-ben, egy pty-sessionben, pozitiv kontrollal: a hangup utan a sima gyerek ES
#    a csupasz `systemd-run --scope` gyerek is eltunt, a `setsid systemd-run --scope`
#    gyerek viszont tovabb futott -- es tovabbra is sajat scope-cgroupban ult.
#    KOVETKEZMENY a bejelentonel: a szolgaltatasok a unitjaikon KIVUL jottek vissza,
#    tehat a Restart= es az OnFailure= tobbe nem vonatkozott rajuk, ket napig, nemán.
#
#  BUG 2 -- az OnFailure-ertesito keptelen volt kuldeni. A unitok beegetett
#    `Environment=TELEGRAM_ENV=$HOME/...` sora elnyomta a script SAJAT, helyes
#    feloldasat (a migralt telepitesen az a konyvtar mar ures), a
#    MARVEEN_ALERT_CHAT_ID-t pedig SEMMI nem allitotta be.
#
# A KETTO EGYUTT a rossz: az elso leveszi a Restart=-ot, a masodik elnemitja azt az
# ertesitest, ami szolt volna rola. Kivulrol semmi nem latszik.
#
# Run:  bash scripts/__tests__/felugyeleti-riasztas.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAILS=0
DB=0
SKIPS=0

check() { DB=$((DB+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }
skip()  { SKIPS=$((SKIPS+1)); echo "SKIP  $1  -- $2"; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/felugyelet.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

# ---------------------------------------------------------------------------
# BUG 2 -- a feloldas VISELKEDESE, nem a forrasszovege
# ---------------------------------------------------------------------------
# Hamis telepites: INSTALL-SCOPED csatorna-allapot, URES legacy $HOME -- pontosan az
# az alak, amin a bejelento hibaja elsult.
mk_install() {  # mk_install <access.json tartalom>
  local d="$1" acc="$2"
  mkdir -p "$d/scripts/lib" "$d/.claude/channels/telegram" "$d/home/.claude/channels/telegram"
  cp "$ROOT/scripts/unit-fail-notify.sh" "$d/scripts/"
  cp "$ROOT/scripts/lib/send-telegram.sh" "$d/scripts/lib/"
  printf 'TELEGRAM_BOT_TOKEN=123456:TESZT-TOKEN\n' > "$d/.claude/channels/telegram/.env"
  printf '%s' "$acc" > "$d/.claude/channels/telegram/access.json"
}

# curl-STUB: semmi nem megy ki a halozatra, es RÖGZITI, milyen chat-id-vel hivtak.
mk_curl_stub() {
  local d="$1"
  mkdir -p "$d/bin"
  cat > "$d/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${STUB_ARGS_FILE:-/dev/null}"
echo '{"ok":true,"result":{"message_id":1}}'
exit 0
STUB
  chmod +x "$d/bin/curl"
}

# A KORNYEZETET KI KELL TAKARITANI, ES EZ NEM ELOVIGYAZATOSSAG: az elso futasnal a
# fejlesztoi hejban exportalt TELEGRAM_STATE_DIR miatt a teszt az ELO telepites
# csatorna-allapotat olvasta (valodi token, valodi access.json), es a "sikeres"
# esetek a VALODI chat-id-vel lettek zoldek -- vagyis nem azt mertek, amit allitottak.
# A curl-stub fogta meg, hogy ebbol ne legyen kimeno uzenet. Ezert megy minden futas
# `env -u`-val: a szandekos felulbiralast a hivo adja hozza, minden mast kizarunk.
run_notify() {  # run_notify <install-dir> [env assignments...]
  local d="$1"; shift
  ( cd "$d" && env -u TELEGRAM_STATE_DIR -u TELEGRAM_ENV -u TELEGRAM_ACCESS -u MARVEEN_ALERT_CHAT_ID \
      PATH="$d/bin:$PATH" HOME="$d/home" STUB_ARGS_FILE="$d/curl-args.txt" \
      "$@" bash "$d/scripts/unit-fail-notify.sh" teszt.service ) 2>&1
}

A="$SANDBOX/a"; mk_install "$A" '{"dmPolicy":"allowlist","allowFrom":["111222333"]}'; mk_curl_stub "$A"
out="$(run_notify "$A")"
check "1 token+chat feloldva a BEEGETETT TELEGRAM_ENV nelkul (kezbesitve)" \
  "$(grep -q 'notice delivered' <<<"$out" && echo 0 || echo 1)" "$(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
check "1 a feloldott chat-id ment ki (nem mas)" \
  "$(grep -q '111222333' "$A/curl-args.txt" 2>/dev/null && echo 0 || echo 1)"

# A "0" a telepito placeholder-e, NEM chat: ezt nem szabad kikuldeni.
B="$SANDBOX/b"; mk_install "$B" '{"dmPolicy":"allowlist","allowFrom":["0"]}'; mk_curl_stub "$B"
out="$(run_notify "$B")"
check "2 a '0' placeholder NEM szamit chatnek (nem megy ki semmi)" \
  "$(grep -q 'no Telegram sent' <<<"$out" && echo 0 || echo 1)" "$(printf '%s' "$out" | tail -1)"
check "2 a hianyt NEVESITI a naplo" \
  "$(grep -q 'MARVEEN_ALERT_CHAT_ID' <<<"$out" && echo 0 || echo 1)"

# A KIMONDOTT felulbiralas TOVABBRA IS nyer -- ezt nem vettuk el.
C="$SANDBOX/c"; mk_install "$C" '{"dmPolicy":"allowlist","allowFrom":["111222333"]}'; mk_curl_stub "$C"
out="$(run_notify "$C" MARVEEN_ALERT_CHAT_ID=999888777)"
check "3 a MARVEEN_ALERT_CHAT_ID felulbiralas ervenyes" \
  "$(grep -q '999888777' "$C/curl-args.txt" 2>/dev/null && echo 0 || echo 1)"

# Ha NINCS access.json es nincs override: nema marad, de NEVESITVE.
D="$SANDBOX/d"; mk_install "$D" ''; rm -f "$D/.claude/channels/telegram/access.json"; mk_curl_stub "$D"
out="$(run_notify "$D")"
check "4 access.json nelkul nem talal ki chatet, es ezt kimondja" \
  "$(grep -q 'no Telegram sent' <<<"$out" && echo 0 || echo 1)"

# ---------------------------------------------------------------------------
# BUG 2 -- a SZALLITOTT unitokban NINCS beegetett ut
# ---------------------------------------------------------------------------
n="$(grep -rl 'Environment=TELEGRAM_ENV' "$ROOT/install-linux.sh" "$ROOT/scripts/systemd/" 2>/dev/null | wc -l | tr -d ' ')"
check "5 egyetlen szallitott unit sem egeti be a TELEGRAM_ENV-et (fajlok: $n)" "$([ "$n" = "0" ] && echo 0 || echo 1)"
# POZITIV KONTROLL a fenti nullara: a valtozo MAGA tovabbra is olvasott override.
m="$(grep -l 'TELEGRAM_ENV' "$ROOT/scripts/unit-fail-notify.sh" "$ROOT/scripts/host-restart-watchdog.sh" 2>/dev/null | wc -l | tr -d ' ')"
check "5 POZITIV KONTROLL: a TELEGRAM_ENV override tovabbra is olvasott (fajlok: $m)" "$([ "$m" = "2" ] && echo 0 || echo 1)"

# ---------------------------------------------------------------------------
# BUG 1 -- a TERMINAL-LEVALASZTAS VISELKEDESE, stubolt systemd-run-nal
# ---------------------------------------------------------------------------
# A stub ugyanugy exec-eli a parancsot, mint a valodi `systemd-run --scope`, es
# ugyanugy NEM valaszt le terminalt -- tehat a kulonbseget KIZAROLAG a setsid adja.
if ! command -v setsid >/dev/null 2>&1; then
  skip "6 terminal-levalasztas viselkedes-teszt" "ezen a gepen nincs setsid (macOS); a CI Linuxon futtatja"
else
  P="$SANDBOX/pty"; mkdir -p "$P/bin"
  cat > "$P/bin/systemd-run" <<'STUB'
#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done
exec "$@"
STUB
  chmod +x "$P/bin/systemd-run"
  cat > "$P/gyerek.sh" <<'CH'
#!/usr/bin/env bash
echo $$ > "$2/pid-$1"
while :; do date +%s%N >> "$2/hb-$1"; sleep 0.2; done
CH
  cat > "$P/inner.sh" <<'IN'
#!/usr/bin/env bash
P="$1"; export PATH="$P/bin:$PATH"
# A MAI (javitas elotti) alak: systemd-run setsid NELKUL
systemd-run --user --scope --collect --quiet bash "$P/gyerek.sh" regi "$P" &
# A JAVITOTT alak: setsid a systemd-run ELOTT
setsid systemd-run --user --scope --collect --quiet bash "$P/gyerek.sh" uj "$P" &
sleep 1.5; echo kesz > "$P/ready"; sleep 120
IN
  python3 - "$P" <<'PY'
import os, pty, sys, time, fcntl, termios, threading, select
P = sys.argv[1]
master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.setsid(); fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave,0); os.dup2(slave,1); os.dup2(slave,2); os.close(master); os.close(slave)
    os.execv("/bin/bash", ["bash", os.path.join(P,"inner.sh"), P])
os.close(slave)
# A drain-szal NEM blokkolhat az os.read-en: akkor a master fd a close() utan is
# nyitva maradna, a hangup SOSEM tortenne meg, es a proba "semmi nem hal meg"-et
# mutatna -- hamis felmentes. (Ebbe a fixtura-hibaba egyszer mar belefutottunk.)
stop = threading.Event()
def drain():
    while not stop.is_set():
        r,_,_ = select.select([master],[],[],0.2)
        if r:
            try:
                if not os.read(master, 4096): break
            except OSError: break
t = threading.Thread(target=drain); t.start()
for _ in range(100):
    if os.path.exists(os.path.join(P,"ready")): break
    time.sleep(0.2)
stop.set(); t.join(); os.close(master)
# A PILLANATKEP A HANGUP UTAN KESZUL, NEM ELOTTE. Elobb keszitve a meg elo, de
# mar halalra itelt gyerek a pillanatkep es a tenyleges halala KOZOTT meg irt
# nehany sort, es ettol a "mar nem ir" allitas idozites-fuggoen pirosodott
# (Linuxon el is bukott). Igy a mero ablaka olyan, amiben egy halott folyamat
# BIZTOSAN nem nohet.
time.sleep(2)
for n in ("regi","uj"):
    open(os.path.join(P, f"hb0-{n}"), "w").write(open(os.path.join(P, f"hb-{n}")).read())
time.sleep(2)
PY
  el() { local n="$1"; local p; p="$(cat "$P/pid-$n" 2>/dev/null)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
  nott() { local n="$1"; [ "$(wc -l < "$P/hb-$n")" -gt "$(wc -l < "$P/hb0-$n")" ]; }
  # POZITIV KONTROLL: ha a REGI alak sem hal meg, a fixtura rossz -- nem az allitas.
  check "6 POZITIV KONTROLL: a javitas ELOTTI alak a hangupon MEGHAL" \
    "$(el regi && echo 1 || echo 0)"
  check "6 a javitott (setsid) alak TULELI a hangupot" "$(el uj && echo 0 || echo 1)"
  check "6 es TOVABB IS DOLGOZIK (a heartbeat no a hangup utan)" "$(nott uj && echo 0 || echo 1)"
  check "6 a javitas elotti alak NEM ir tobbet" "$(nott regi && echo 1 || echo 0)"
  kill -9 "$(cat "$P/pid-uj" 2>/dev/null)" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# BUG 1 -- a szallitott update.sh alakja
# ---------------------------------------------------------------------------
U="$(cat "$ROOT/update.sh")"
check "7 a systemd-ag setsid-del inditja a finalizert" \
  "$(grep -q 'setsid systemd-run --user --scope' <<<"$U" && echo 0 || echo 1)"
# A DARABSZAM-KUSZOB TUL LAZA VOLT: egyetlen redirect kivetele MEGSEM pirosodott
# (zold mutans). Most az INDITO sorokat szamoljuk, es MINDEGYIKNEK naplóznia kell.
# KET SZAMOT VETUNK OSSZE, ES EZ SZANDEKOS: az INDITO helyek szama es a NAPLO-REDIRECTEK
# szama. Az elso valtozat sor-alapon szamolt, es a folytatott sorok miatt alulmert; a
# masodik osszehuzta a sorokat, es akkor a `||` fallback EGY sorba kerult az elsodlegessel,
# tehat egy kivett redirect MEGSEM latszott (zold mutans). A darabszam-egyezes mindkettot
# elkapja: ha barmelyik indito elveszti a naplózast, a ket szam eltavolodik.
indit="$(grep -c 'bash "\$FINALIZE_SCRIPT" "\${FINALIZE_ARGS\[@\]}"' <<<"$U")"
naploz="$(grep -c '>> "\$FINALIZE_LOG" 2>&1' <<<"$U")"
check "7 MINDEN finalizer-indito a naplóba ir (indito: $indit, redirect: $naploz)" \
  "$([ "$indit" -gt 0 ] && [ "$indit" = "$naploz" ] && echo 0 || echo 1)"
check "7 egyetlen indito sem dobja el a kimenetet (/dev/null)" \
  "$(grep 'FINALIZE_SCRIPT" "\${FINALIZE_ARGS\[@\]}"' <<<"$U" | grep -q '> /dev/null 2>&1' && echo 1 || echo 0)"
# A GENERALT FINALIZERT FUTTATJUK, NEM A FORRASAT OLVASSUK. A puszta `grep _unit_drift`
# gyenge volt: a HIVAS kivetele (a fuggvenyt a helyen hagyva) MEGSEM pirosodott.
F="$SANDBOX/fin"; mkdir -p "$F/store" "$F/scripts" "$F/bin"
python3 - "$ROOT/update.sh" "$F/finalize.sh" <<'EXTRACT'
import sys
src = open(sys.argv[1], encoding='utf-8').read()
i = src.index("cat > \"$FINALIZE_SCRIPT\" <<'FINALIZE_EOF'")
j = src.index("\nFINALIZE_EOF\n", i)
open(sys.argv[2], 'w', encoding='utf-8').write(src[i:j].split('\n', 1)[1] + '\n')
EXTRACT
printf 'MAIN_AGENT_ID=teszt\n' > "$F/.env"
printf '#!/usr/bin/env bash\nexit 0\n' > "$F/scripts/stop.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$F/scripts/start.sh"
chmod +x "$F/scripts/stop.sh" "$F/scripts/start.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$F/bin/curl"          # _health: a port valaszol
printf '#!/usr/bin/env bash\nexit 0\n' > "$F/bin/pidof"         # systemd fut
cat > "$F/bin/systemctl" <<'SC'
#!/usr/bin/env bash
# cat -> a unit letezik; is-enabled -> igen; is-active -> a DRIFT_ACTIVE dönti el
case "${1:-}" in
  cat) exit 0 ;;
  is-enabled) exit 0 ;;
  is-active) [ "${DRIFT_ACTIVE:-1}" = "1" ] && exit 0 || exit 3 ;;
esac
exit 0
SC
chmod +x "$F/bin/curl" "$F/bin/pidof" "$F/bin/systemctl"
fin_run() {  # fin_run <DRIFT_ACTIVE>
  ( cd "$F" && env PATH="$F/bin:$PATH" DRIFT_ACTIVE="$1" \
      bash "$F/finalize.sh" "$F" "" "" 3420 "$F/store/res.json" "$F/store/built" "" "" 0 ) 2>&1
}
out="$(fin_run 0)"; rc_drift=$?
check "7 a finalizer KIMONDJA, ha egy enabled unit nem active" \
  "$(grep -q 'NEM active unit' <<<"$out" && echo 0 || echo 1)" "$(printf '%s' "$out" | tail -1)"
check "7 a drift a RESULT-ba is bekerul, nem csak a stderr-re" \
  "$(grep -q 'felugyelet nem ervenyes' "$F/store/res.json" 2>/dev/null && echo 0 || echo 1)"
check "7 a drift JELENT, nem buktat (exit 0 marad)" "$([ "$rc_drift" = "0" ] && echo 0 || echo 1)" "rc=$rc_drift"
out="$(fin_run 1)"
check "7 ha minden unit active, NINCS drift-uzenet (nincs hamis riasztas)" \
  "$(grep -q 'NEM active unit' <<<"$out" && echo 1 || echo 0)"

echo
[ "$SKIPS" -gt 0 ] && echo "($SKIPS eset kihagyva -- lasd a SKIP sorokat)"
if [ "$FAILS" -gt 0 ]; then echo "$FAILS FAILED a $DB allitasbol" >&2; exit 1; fi
echo "OK: $DB allitas, mind zold."
