#!/usr/bin/env bash
# QCassa.com elsobbseg-kapu -- MERI a heti keret plafonjat, amig a QCassa-munka szabadon huzhato.
#
# Kimenet: "fut"    (rc=0) -- a QCassa.com alatti munka mehet
#          "PLAFON" (rc=1) -- allj vissza a munkakorlatozasra: csak Jozsi/Zoli kozvetlen feladata megy
# Indoklas a masodik soron, STDERR-en.
#
# A KILEPESI KOD HORDOZ JELET, ES EZ SZANDEKOS: a legkezenfekvobb hivasi alak
#   if bash qcassa-priority-gate.sh; then <munka>; fi
# igy HELYESEN viselkedik. Az elso valtozat mindket kimenetre 0-t adott, tehat ez a hivas
# plafon felett is dolgozott volna. (Az ordog merte ki, 2026-08-13.)
#
# MIERT LETEZIK (Jozsi, 2026-08-13 22:34):
#   "A QCassa.com mappaban minden projekt elsobbseget elvez 85%-ig. Ha holnap Zoli nem ir delutan
#   5-ig, akkor 100%-ig." A maradek keret Zolie es Jozsie -- azt nem ejuk fel.
#
#   ES AMIERT SCRIPT, NEM SZABALY-MONDAT: egy szazalekos kuszob, ami CSAK a CLAUDE.md-ben all,
#   minden fej EMLEKEZETEN mulik -- es a flottaban tobbszor bizonyitottan epp az ilyen kuszob
#   csuszik at nemán.
#
# EZ NEM HELYETTESITI A FAGYASZTAS-KAPUT. Ket kulon kerdes, ket kulon script:
#   scripts/quota-gate.sh           -> "van-e KEZI fagyasztas?"   (ha FAGYASZTVA: MINDEN all)
#   scripts/qcassa-priority-gate.sh -> "a plafon alatt vagyunk-e?" (ha PLAFON: csak Jozsi/Zoli)
# A sorrend: eloszor a fagyasztas-kapu, utana ez.
#
# FAIL-CLOSED: ha a meres hianyzik, olvashatatlan, ERTELMEZHETETLEN vagy ELAVULT, "PLAFON" a valasz.
# Egy kimaradt QCassa-kor olcso; egy felelt tartalek, amikor Zoli irna, nem az.
#
# 🛑 A HIBAOSZTALY, AMI AZ ELSo VALTOZATOT MEGFEKTETTE -- HAT FAIL-OPEN AG EGY GYOKERBoL:
#   a kapu TIPUS- ES TARTOMANY-ELLENoRZES NELKUL HASONLITOTT. Ha a `>=` nem-veges vagy nem-szam
#   erteket kap, a Python CSENDBEN False-t ad, tehat "fut" lesz belole. Igy ment at NaN, `true`
#   (Pythonban True == 1), negativ szazalek, NaN plafon (99%-nal is!), es -- a legrosszabb --
#   a JOVoBELI idobelyeg: `kor = most - measured_at` NEGATIV, tehat SOHA nem avul el, es a
#   10 napos adat frissnek latszik. Egy elcsuszott orajel eleg hozza, szandek nelkul.
#   EZERT VAN EGY KOZPONTI ERVENYESITo, NEM HAT FOLT: egy hianyzo ellenorzes hat helyen latszott.
#
# Onteszt (5/e -- a kaput bukas-eloallitassal kell igazolni, nem feltetelezessel):
#   bash /Users/ceo/Marveen/scripts/qcassa-priority-gate.sh --self-test

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS_FILE="${QUOTA_STATUS_FILE:-$REPO_ROOT/store/quota-status.json}"
CEILING_FILE="${QUOTA_CEILING_FILE:-$REPO_ROOT/store/quota-ceiling.json}"
MAX_AGE_SEC="${QUOTA_MAX_AGE_SEC:-21600}"   # 6 ora
MAX_SKEW_SEC="${QUOTA_MAX_SKEW_SEC:-120}"   # engedett orajel-elteres a jovo iranyaba

evaluate() {
  QG_STATUS="$1" QG_CEILING="$2" QG_MAXAGE="$3" QG_MAXSKEW="${4:-120}" python3 - <<'PYEOF'
import json, os, sys, time


def plafon(msg):
    """hu: A kapu EGYETLEN elutasito kijarata. STDOUT-ra mindig "PLAFON" kerul, rc=1.
    <br />
    en: The gate's ONLY refusing exit. STDOUT always carries "PLAFON", rc=1.
    """
    print("PLAFON")
    print(msg, file=sys.stderr)
    sys.exit(1)


def szam(value):
    """hu: Veges szamma alakit, vagy None-t ad. A bool NEM szam: Pythonban a bool az int
        ALOSZTALYA, tehat `isinstance(True, int)` igaz es `True == 1` -- egy `true` ertek
        igy 85 ala esne es NEMAN atengedne a kaput.
    <br />
    en: Converts to a finite number or returns None. A bool is NOT a number: in Python bool
        subclasses int, so a `true` value would fall below 85 and silently open the gate.
    """
    if isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float('inf'), float('-inf')):   # NaN / +-Inf
        return None
    return f


def main():
    status_path  = os.environ['QG_STATUS']
    ceiling_path = os.environ['QG_CEILING']
    max_age      = float(os.environ['QG_MAXAGE'])
    max_skew     = float(os.environ['QG_MAXSKEW'])

    # A plafon: kulon fajl, hogy a gazda dontese ALLITHATO legyen a script atirasa nelkul.
    # Ha nincs fajl, a 85 az alapertelmezes -- ez a kimondott szabaly, nem talalgatas.
    ceiling = 85.0
    try:
        with open(ceiling_path) as fh:
            ceiling = szam(json.load(fh)['seven_day_ceiling'])
    except FileNotFoundError:
        pass
    except Exception as exc:
        plafon(f"a plafon-fajl serult vagy hianyos ({exc}) -- fail-closed")

    if ceiling is None or not (0.0 <= ceiling <= 100.0):
        plafon("a plafon erteke nem ertelmezheto szazalek (0-100) -- fail-closed")

    try:
        with open(status_path) as fh:
            d = json.load(fh)
    except Exception as exc:
        plafon(f"a keret-meres nem olvashato ({exc}) -- fail-closed")

    # Ervenyes JSON, ami NEM objektum (lista, szam, null, string): a `.get()` AttributeError-t
    # dobna, es a Traceback URES stdout-tal jarna -- aki a KIMENETET olvassa, atmenne rajta.
    if not isinstance(d, dict):
        plafon(f"a keret-meres nem objektum ({type(d).__name__}) -- fail-closed")

    used        = szam(d.get('seven_day_used_percentage'))
    measured_at = szam(d.get('measured_at'))

    if used is None or not (0.0 <= used <= 100.0):
        plafon("a heti felhasznalas nem ertelmezheto szazalek (0-100) -- fail-closed")

    if measured_at is None:
        plafon("a meres idobelyege nem ertelmezheto -- fail-closed")

    kor = time.time() - measured_at

    # JOVoBELI IDoBELYEG: a negativ kor SOHA nem lepne tul a max_age-et, tehat egy tetszolegesen
    # regi adat frissnek latszana. Kis orajel-elteres megengedett, azon tul fail-closed.
    if kor < -max_skew:
        plafon(f"a meres idobelyege a JOVoBEN van ({-kor/3600:.1f} oraval) -- "
               f"fail-closed, az elavulas igy nem merheto")

    if kor > max_age:
        plafon(f"a keret-meres {kor/3600:.1f} oras (max {max_age/3600:.0f}) -- fail-closed, "
               f"futtass egy kort barmelyik fejen, az frissiti")

    if used >= ceiling:
        plafon(f"heti felhasznalas {used:.0f}% >= plafon {ceiling:.0f}% -- "
               f"csak Jozsi/Zoli kozvetlen feladata megy")

    print("fut")
    print(f"heti felhasznalas {used:.0f}%, plafon {ceiling:.0f}% ({ceiling-used:.0f} pont szabad)",
          file=sys.stderr)


# 🛑 A SZERZoDES: a STDOUT SOHA nem ures. Barmilyen varatlan kivetel PLAFON-na valik.
# A `plafon()` SystemExit-et dob, ami NEM Exception -- tehat ez a blokk nem nyeli el.
# (Az ordog merte ki, hogy egy nem-objektum status-fajl Tracebacket es URES stdout-ot adott:
#  rc szerint fail-closed volt, de aki a KIMENETET olvassa, atment rajta.)
try:
    main()
except Exception as exc:
    plafon(f"varatlan hiba a kapuban ({type(exc).__name__}: {exc}) -- fail-closed")
PYEOF
}

if [ "${1:-}" = "--self-test" ]; then
  # 5/e: NEM feltetelezzuk, hogy mukodik -- ELoALLITJUK a hibat, amit el kell kapnia.
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  fail=0

  check() {  # nev, elvart_kimenet, elvart_rc, statusfajl, plafonfajl, [maxage]
    local nev="$1" vart="$2" vart_rc="$3" st="$4" ce="$5" age="${6:-21600}"
    local ki rc
    ki="$(evaluate "$st" "$ce" "$age" 2>/dev/null)"; rc=$?
    if [ "$ki" = "$vart" ] && [ "$rc" = "$vart_rc" ]; then
      echo "  OK    $nev -> $ki (rc=$rc)"
    else
      echo "  BUKIK $nev -> vart:$vart/rc$vart_rc kapott:${ki:-<URES>}/rc$rc"; fail=1
    fi
  }

  # A status-fajl eloallitasa TETSZoLEGES ertekkel -- a nem-szam eseteket is kell tudni irni.
  mk() {  # fajl, szazalek_json, kor_masodpercben
    python3 -c "
import json, sys, time
raw = sys.argv[2]
val = json.loads(raw) if raw != 'NAN' else float('nan')
json.dump({'seven_day_used_percentage': val,
           'measured_at': int(time.time()) - int(sys.argv[3])}, open(sys.argv[1], 'w'))" "$@"
  }

  echo '{"seven_day_ceiling": 85}' > "$TMP/ceil85.json"

  echo "-- alap (a POZITIV KONTROLL az elso: ha ez bukik, a tobbi sor ertektelen) --"
  mk "$TMP/alatta.json"  56 60;  check "56% a 85-os plafon ALATT"       "fut"    0 "$TMP/alatta.json"  "$TMP/ceil85.json"
  mk "$TMP/pont.json"    85 60;  check "pontosan 85% (a hatar zart)"    "PLAFON" 1 "$TMP/pont.json"    "$TMP/ceil85.json"
  mk "$TMP/felette.json" 91 60;  check "91% a plafon FOLOTT"            "PLAFON" 1 "$TMP/felette.json" "$TMP/ceil85.json"

  echo '{"seven_day_ceiling": 100}' > "$TMP/ceil100.json"
  check "91% a 100-as plafonnal (a plafon-fajlt tenyleg olvassa)" "fut" 0 "$TMP/felette.json" "$TMP/ceil100.json"

  echo "-- az ordog hat FAIL-OPEN aga (2026-08-13): mind 'fut'-ot adott, PLAFON kellett volna --"
  mk "$TMP/nan.json"  NAN  60;   check "szazalek NaN"                   "PLAFON" 1 "$TMP/nan.json"  "$TMP/ceil85.json"
  mk "$TMP/bool.json" true 60;   check "szazalek true (bool == 1)"      "PLAFON" 1 "$TMP/bool.json" "$TMP/ceil85.json"
  mk "$TMP/neg.json"  -5   60;   check "szazalek negativ (-5)"          "PLAFON" 1 "$TMP/neg.json"  "$TMP/ceil85.json"
  mk "$TMP/jovo.json" 20   -86400
  check "JOVoBELI idobelyeg (a kor negativ -> sosem avul)"              "PLAFON" 1 "$TMP/jovo.json" "$TMP/ceil85.json"
  python3 -c "import json,sys; json.dump({'seven_day_used_percentage':20,'measured_at':float('nan')}, open(sys.argv[1],'w'))" "$TMP/tsnan.json"
  check "measured_at NaN"                                              "PLAFON" 1 "$TMP/tsnan.json" "$TMP/ceil85.json"
  python3 -c "import json,sys; json.dump({'seven_day_ceiling':float('nan')}, open(sys.argv[1],'w'))" "$TMP/ceilnan.json"
  mk "$TMP/k99.json" 99 60
  check "plafon NaN, 99% felhasznalas"                                 "PLAFON" 1 "$TMP/k99.json" "$TMP/ceilnan.json"

  echo "-- az ordog ket URES-KIMENET aga: Traceback helyett PLAFON kell --"
  mk "$TMP/str.json" '"91"' 60;  check "szazalek string \"91\""         "PLAFON" 1 "$TMP/str.json" "$TMP/ceil85.json"
  python3 -c "import json,sys; json.dump({'seven_day_used_percentage':20,'measured_at':'tegnap'}, open(sys.argv[1],'w'))" "$TMP/tsstr.json"
  check "measured_at string"                                           "PLAFON" 1 "$TMP/tsstr.json" "$TMP/ceil85.json"

  echo "-- elavulas es serult bemenet --"
  mk "$TMP/regi.json" 20 30000;  check "8,3 oras meres (elavult)"       "PLAFON" 1 "$TMP/regi.json" "$TMP/ceil85.json"
  mk "$TMP/skew.json" 20 -60;    check "60 mp orajel-elteres (meg belefer)" "fut" 0 "$TMP/skew.json" "$TMP/ceil85.json"
  echo 'ez nem json' > "$TMP/rossz.json"
  check "serult meres"                                                 "PLAFON" 1 "$TMP/rossz.json" "$TMP/ceil85.json"
  check "nem letezo meres"                                             "PLAFON" 1 "$TMP/nincs.json" "$TMP/ceil85.json"
  python3 -c "import json,sys; json.dump({'measured_at':0}, open(sys.argv[1],'w'))" "$TMP/hianyos.json"
  check "meres szazalek NELKUL"                                        "PLAFON" 1 "$TMP/hianyos.json" "$TMP/ceil85.json"

  echo "-- nem-objektum status-fajl es a catch-all (az ordog leletei az ELES fajlon) --"
  for alak in '[1,2,3]' '42' 'null' '"szoveg"'; do
    printf '%s' "$alak" > "$TMP/nemobj.json"
    check "status-fajl nem objektum: $alak" "PLAFON" 1 "$TMP/nemobj.json" "$TMP/ceil85.json"
  done
  # A catch-all: romlott max_age -> a float() dobna, es az elso valtozat URES stdout-ot adott.
  check "romlott QUOTA_MAX_AGE_SEC (catch-all)" "PLAFON" 1 "$TMP/alatta.json" "$TMP/ceil85.json" "abc"

  echo "-- a plafon-fajl --"
  check "nincs plafon-fajl -> 85 az alap, 56% atmegy"                  "fut"    0 "$TMP/alatta.json"  "$TMP/nincs-ceil.json"
  check "nincs plafon-fajl -> 85 az alap, 91% elbukik"                 "PLAFON" 1 "$TMP/felette.json" "$TMP/nincs-ceil.json"
  echo 'romlott' > "$TMP/ceilrossz.json"
  check "serult plafon-fajl"                                           "PLAFON" 1 "$TMP/alatta.json" "$TMP/ceilrossz.json"
  echo '{"seven_day_ceiling": -1}' > "$TMP/ceilneg.json"
  check "negativ plafon"                                               "PLAFON" 1 "$TMP/alatta.json" "$TMP/ceilneg.json"
  echo '{"seven_day_ceiling": "85"}' > "$TMP/ceilstr.json"
  check "plafon string \"85\" (szamma alakithato -> ervenyes)"          "fut"    0 "$TMP/alatta.json" "$TMP/ceilstr.json"
  echo '{"masmezo": 85}' > "$TMP/ceilhianyos.json"
  check "plafon-fajl a MEZo nelkul"                                    "PLAFON" 1 "$TMP/alatta.json" "$TMP/ceilhianyos.json"

  [ "$fail" = 0 ] && echo "onteszt: MIND ZOLD" || echo "onteszt: VAN BUKO SOR"
  exit "$fail"
fi

evaluate "$STATUS_FILE" "$CEILING_FILE" "$MAX_AGE_SEC" "$MAX_SKEW_SEC"
