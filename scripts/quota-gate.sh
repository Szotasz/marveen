#!/usr/bin/env bash
# Kvota-fagyasztas kapu -- EGYETLEN igazsag-forras minden utemezett feladatnak.
#
# Kimenet: "FAGYASZTVA" vagy "fut" (plusz indoklas a masodik soron, ha lejart).
#
# MIERT LETEZIK (2026-08-08, sajat hiba):
#   A regi, SKILL.md-kbe MASOLT egysoros CSAK az `active` mezot nezte, a `resets_at`-ot NEM.
#   Ezert a fagyasztas TULELTE a sajat lejaratat: a reset 14:00-kor megvolt, es a heartbeatek
#   14:52-kor MEG MINDIG kileptek. A lejarati ido vegig ott allt a fajlban -- senki nem olvasta.
#   Jozsinak kellett szolnia ("14:50 van!!!").
#
#   Ez ugyanaz a hibaosztaly, amit aznap egesz nap masokban kerestunk: EGY JELZES, AMI A SAJAT
#   HATOKOREN (itt: ervenyessegi idejen) KIVUL IS ALLITJA MAGAT. A "zold, mert nem neztem oda".
#
#   ES AMIERT SCRIPT LETT BELoLE, NEM JAVITOTT EGYSOROS: a regi valtozat HAT SKILL.md-be volt
#   MASOLVA. Hat masodpeldany = hat hely, ahol szet tud csuszni, es ahol a javitas kimaradhat.
#   Innentol a logika EGY helyen el; a SKILL.md-k csak hivjak.
#
# Hasznalat a SKILL.md-kben:
#   bash /Users/ceo/Marveen/scripts/quota-gate.sh
#
# Onteszt (5/e -- a kaput bukas-eloallitassal kell igazolni, nem feltetelezessel):
#   bash /Users/ceo/Marveen/scripts/quota-gate.sh --self-test

set -uo pipefail

GATE_FILE="${QUOTA_GATE_FILE:-/Users/ceo/Marveen/store/quota-freeze.json}"

evaluate() {
  QUOTA_GATE_FILE="$1" python3 - <<'PYEOF'
import json, os, sys, datetime

path = os.environ['QUOTA_GATE_FILE']

# FAIL-CLOSED: ha a fajl olvashatatlan vagy serult, FAGYASZTVA-t mondunk. Egy kimaradt
# heartbeat-kor olcso; egy fagyasztas alatt elegetett keret nem az.
try:
    with open(path) as fh:
        d = json.load(fh)
except Exception as exc:
    print("FAGYASZTVA")
    print(f"a kapu-fajl nem olvashato ({exc}) -- fail-closed", file=sys.stderr)
    sys.exit(0)

if not d.get('active'):
    print("fut")
    sys.exit(0)

# --- A LENYEGI RESZ, AMI A REGI EGYSORESBoL HIANYZOTT: lejart-e mar? ---
resets_at = (d.get('resets_at') or '').strip()
activated = d.get('activated_at')

if not resets_at or not activated:
    # Nincs mihez merni -> marad a fagyasztas, de MONDJUK KI, hogy nem tudtuk ellenorizni.
    print("FAGYASZTVA")
    print("figyelem: nincs resets_at vagy activated_at -- a lejarat NEM ellenorizheto", file=sys.stderr)
    sys.exit(0)

DAYS = {'mon':0, 'tue':1, 'wed':2, 'thu':3, 'fri':4, 'sat':5, 'sun':6}
parts = resets_at.split()

try:
    weekday = DAYS[parts[0][:3].lower()]
    hh, mm = (int(x) for x in parts[1].split(':'))
except Exception:
    print("FAGYASZTVA")
    print(f"figyelem: a resets_at ('{resets_at}') nem ertelmezheto -- a lejarat NEM ellenorizheto",
          file=sys.stderr)
    sys.exit(0)

start = datetime.datetime.fromtimestamp(activated)
# Az aktivalas UTANI elso ilyen napu idopont. A 0 nap elorelepes is jo, ha az ido meg hatravan.
delta = (weekday - start.weekday()) % 7
reset = (start + datetime.timedelta(days=delta)).replace(hour=hh, minute=mm, second=0, microsecond=0)

if reset <= start:
    reset += datetime.timedelta(days=7)

now = datetime.datetime.now()

if now >= reset:
    print("fut")
    print(f"a fagyasztas LEJART: a reset ({reset:%Y-%m-%d %H:%M}) mar elmult, most {now:%Y-%m-%d %H:%M} van.",
          file=sys.stderr)
    print("az active mezo MEG MINDIG true -- allitsd false-ra, es szolj a gazdanak.", file=sys.stderr)
    sys.exit(0)

print("FAGYASZTVA")
hatra = reset - now
print(f"lejarat: {reset:%Y-%m-%d %H:%M} ({hatra.seconds // 3600} ora {hatra.seconds % 3600 // 60} perc mulva)",
      file=sys.stderr)
PYEOF
}

if [ "${1:-}" = "--self-test" ]; then
  # 5/e: NEM feltetelezzuk, hogy mukodik -- ELoALLITJUK a hibat, amit el kell kapnia.
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  fail=0

  check() {  # nev, elvart, kapott
    if [ "$2" = "$3" ]; then echo "  OK    $1 -> $3"; else echo "  BUKIK $1 -> vart:$2 kapott:$3"; fail=1; fi
  }

  # A BUKAS, AMI MA ELESBEN MEGTORTENT: aktiv fagyasztas, LEJART resettel.
  # A regi egysoros erre FAGYASZTVA-t mondott. Ha ez a sor zold, a javitas ervenyes.
  python3 - "$TMP/lejart.json" <<'PY'
import json, sys, time, datetime
# aktivalas: 2 nappal ezelott; reset: az azt koveto szombat 14:00 -- ha ma mar tulvagyunk rajta, lejart
start = datetime.datetime.now() - datetime.timedelta(days=9)
json.dump({"active": True, "activated_at": int(start.timestamp()), "resets_at": "Sat 14:00"},
          open(sys.argv[1], 'w'))
PY
  check "aktiv + LEJART reset (a mai eles bukas)" "fut" "$(evaluate "$TMP/lejart.json" 2>/dev/null)"

  # Ellen-proba: aktiv, de a reset MEG HATRAVAN -> maradjon FAGYASZTVA.
  # Enelkul a "fut" johetne abbol is, hogy a script mindenre fut-ot mond.
  python3 - "$TMP/el.json" <<'PY'
import json, sys, datetime
start = datetime.datetime.now() - datetime.timedelta(minutes=5)
nap = ['mon','tue','wed','thu','fri','sat','sun'][(datetime.datetime.now() + datetime.timedelta(days=3)).weekday()]
json.dump({"active": True, "activated_at": int(start.timestamp()),
           "resets_at": f"{nap.capitalize()} {datetime.datetime.now():%H}:00"}, open(sys.argv[1], 'w'))
PY
  check "aktiv + reset MEG HATRAVAN" "FAGYASZTVA" "$(evaluate "$TMP/el.json" 2>/dev/null)"

  echo '{"active": false}' > "$TMP/ki.json"
  check "kikapcsolt kapu" "fut" "$(evaluate "$TMP/ki.json" 2>/dev/null)"

  # A HIBAKEZELo AG -- a legritkabban futo ut, ezert kotelezo merni (5/e).
  echo 'ez nem json' > "$TMP/rossz.json"
  check "serult fajl (fail-closed)" "FAGYASZTVA" "$(evaluate "$TMP/rossz.json" 2>/dev/null)"
  check "nem letezo fajl (fail-closed)" "FAGYASZTVA" "$(evaluate "$TMP/nincs.json" 2>/dev/null)"

  python3 -c "import json,sys; json.dump({'active':True}, open(sys.argv[1],'w'))" "$TMP/hianyos.json"
  check "aktiv, de NINCS resets_at" "FAGYASZTVA" "$(evaluate "$TMP/hianyos.json" 2>/dev/null)"

  [ "$fail" = 0 ] && echo "onteszt: MIND ZOLD" || echo "onteszt: VAN BUKO SOR"
  exit "$fail"
fi

evaluate "$GATE_FILE"
