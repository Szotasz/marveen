#!/bin/bash
# hu: Bukas-eloallito teszt a `device-registry.sh record` alparancshoz.
#
#     MIERT LETEZIK: 2026-08-14-en az `adb install` a `more than one device/emulator` hibaval
#     ELUTASITOTT, a `record` viszont ugyanabban a parancs-blokkban allt, FELTETEL NELKUL -- igy egy
#     MEG NEM TORTENT telepites kerult a `last_installs`-ba. A celzott ujraprobalassal a bejegyzes
#     utolag igazza valt, tehat kar nem keletkezett, DE az szerencse volt, nem eljaras.
#
#     A `last_installs` az EGYETLEN hely, ahol utolag latszik, mi ment fel egy ELES eszkozre. Egy
#     nyilvantartas, ami a hivo fegyelmen mulik, nem nyilvantartas -- a MERT tartalom dontson, ne az
#     allitas.
#
#     MINDEN ESET ELDOBHATO MASOLATON MER, es a POZITIV KONTROLL (amit at KELL engednie) resze a
#     keszletnek: egy kapu, ami mindent elutasit, nem kapu.
#
#     ES MINDEN ESET A FAJL TARTALMAT IS MERI, nem csak a kilepesi kodot -- a `record` dolga az IRAS,
#     tehat egy "elutasitott" verdikt semmit nem er, ha kozben mar irt.
#
# en: Failure-producing test suite for the `device-registry.sh record` subcommand. Every case runs on
#     a throwaway copy, the positive control is part of the suite, and every case asserts the FILE
#     CONTENT as well as the exit code -- a refusing verdict is worthless if it wrote anyway.
#
# Hasznalat / Usage:  bash scripts/test-device-registry-record.sh
# Kilepesi kod:       0 = minden eset atment, 1 = van bukott eset

set -uo pipefail

SCRIPT="${SCRIPT_PATH:-/Users/ceo/Marveen/scripts/device-registry.sh}"
SOURCE_REG="${SOURCE_REGISTRY:-/Users/ceo/Marveen/store/devices.json}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/drr-test.XXXXXX")"
PASS=0
FAIL=0
FAILED_NAMES=()

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

[ -f "$SCRIPT" ] || { echo "HIBA: nincs script: $SCRIPT" >&2; exit 1; }
[ -f "$SOURCE_REG" ] || { echo "HIBA: nincs nyilvantartas: $SOURCE_REG" >&2; exit 1; }

# hu: A teszt-eszkoz azonositoja es a rogzitendo build. A szam ONKENYES -- a lenyeg, hogy a
#     probaval EGYEZZEN vagy ELTERJEN, eset szerint.
# en: The test device id and the build to record. The number is arbitrary -- what matters is whether
#     it MATCHES the probe or not, per case.
DEVICE_ID="RZCY50N599X"
PACKAGE="com.QCassa.JokerQ"

# hu: Hany bejegyzes all a teszt-eszkozon a masolatban. Ehhez kepest merunk.
# en: How many entries the test device has in the copy. We measure against this.
installs_count() {
  python3 - "$1" "$DEVICE_ID" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
q = sys.argv[2].lower()
hit = next((x for x in d["devices"] if q in json.dumps(x).lower()), None)
print(len(hit.get("last_installs", [])) if hit else -1)
PY
}

# hu: Egy eset. $1=nev, $2=elvart eredmeny (rogzit|elutasit), $3=a probe parancsa, $4=build-szam
# en: One case. $1=name, $2=expected (rogzit|elutasit), $3=probe command, $4=build number
run_case() {
  local name="$1" expected="$2" probe="$3" build="$4"
  local reg="$WORK/devices-$RANDOM.json"
  local before after rc out

  cp "$SOURCE_REG" "$reg"
  before="$(installs_count "$reg")"

  out=$(DEVICE_REGISTRY="$reg" DEVICE_VERSION_PROBE="$probe" \
        bash "$SCRIPT" record "$DEVICE_ID" avalonia "$PACKAGE" "$build" 2>&1)
  rc=$?

  after="$(installs_count "$reg")"

  local ok=1

  if [ "$expected" = "rogzit" ]; then
    [ "$rc" -eq 0 ] || ok=0
    [ "$after" -eq $((before + 1)) ] || ok=0
  elif [ "$expected" = "injektalt-nyom" ]; then
    # hu: Rogzit, DE a bejegyzes NEM allithatja, hogy a keszuleken merte. A `measured_version_code`
    #     mezo HIANYA a bizonyitek -- egy `source`-ba rejtett megjegyzest az utolagos olvaso
    #     atlapozna, a hianyzo mezot nem.
    # en: It records, BUT the entry must not claim a device measurement. The ABSENCE of
    #     `measured_version_code` is the evidence -- a note buried in `source` would be skimmed
    #     over; a missing field cannot be.
    [ "$rc" -eq 0 ] || ok=0
    [ "$after" -eq $((before + 1)) ] || ok=0

    local fields
    fields=$(python3 - "$reg" "$DEVICE_ID" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
q = sys.argv[2].lower()
hit = next((x for x in d["devices"] if q in json.dumps(x).lower()), None)
e = (hit or {}).get("last_installs", [{}])[-1]
print("MEASURED" if "measured_version_code" in e else "-",
      "INJECTED" if "injected_version_code" in e else "-",
      "SRCJELZES" if "injekt" in (e.get("source") or "").lower() else "-")
PY
)
    case "$fields" in
      "- INJECTED SRCJELZES") : ;;
      *) ok=0; out="$out | a bejegyzes mezoi: $fields" ;;
    esac
  else
    [ "$rc" -ne 0 ] || ok=0
    # hu: A LENYEGI allitas: elutasitaskor a fajl VALTOZATLAN. Enelkul egy "elutasitva" uzenet
    #     mellett is bekerulhetne a bejegyzes.
    # en: THE core assertion: on refusal the file is UNCHANGED. Without it the entry could still
    #     land alongside a "refused" message.
    [ "$after" -eq "$before" ] || ok=0
  fi

  if [ "$ok" -eq 1 ]; then
    PASS=$((PASS + 1))
    printf '  [OK]   %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$name")
    printf '  [BUKO] %s\n' "$name"
    printf '         elvart=%s  exit=%s  bejegyzesek: %s -> %s\n' "$expected" "$rc" "$before" "$after"
    printf '         kimenet: %s\n' "$(echo "$out" | head -3 | tr '\n' ' ')"
  fi
}

echo "device-registry.sh record -- bukas-eloallito teszt"
echo "  script:        $SCRIPT"
echo "  forras-masolat: $SOURCE_REG (csak olvasva, minden eset sajat masolaton fut)"
echo

# hu: 1. POZITIV KONTROLL. Enelkul a tobbi eset egy olyan scripten is teljesulne, ami MINDENT
#     elutasit -- es az nem kapu, hanem leallas.
# en: 1. POSITIVE CONTROL. Without it the other cases would also hold for a script that refuses
#     EVERYTHING -- which is not a gate but a shutdown.
run_case "egyezo versionCode -> ROGZIT (pozitiv kontroll)" \
         rogzit "echo versionCode=774" 774

# hu: 2. A MERT ESET: a keszuleken MAS build all, mint amit rogziteni akarunk. Pontosan ez tortent
#     2026-08-14-en, csak ott a szam veletlenul utolag egyezett.
# en: 2. THE MEASURED CASE: the device carries a different build from the one being recorded.
run_case "eltero versionCode -> ELUTASIT, es NEM ir" \
         elutasit "echo versionCode=771" 774

# hu: 3. NEM MERHETo -- a proba elbukik (nincs adb, nincs csomag, nem elerheto eszkoz).
#     FAIL-CLOSED: a meres kudarca NEM engedely.
# en: 3. NOT MEASURABLE -- the probe fails. FAIL-CLOSED: a failed measurement is not a permission.
run_case "a proba BUKIK -> NEM MERHEТo -> elutasit" \
         elutasit "false" 774

# hu: 4. A proba lefut, de a kimenetben NINCS versionCode. Ez MAS, mint a bukas: itt a parancs
#     sikeresnek latszik. A ket eset kulon meredo, mert a kimenet-alapu feldolgozas epp ilyenkor
#     ad csendben ures eredmenyt -- es egy ures eredmenyt konnyu "nincs elteres"-nek olvasni.
# en: 4. The probe runs but its output carries NO versionCode. Different from failing: here the
#     command looks successful. Output-driven parsing yields a silent empty result exactly here.
run_case "a proba kimenete ertelmezhetetlen -> elutasit" \
         elutasit "echo semmi-ertelmes-nincs-itt" 774

# hu: 5. A proba TOBB sort ad, koztuk a helyeset -- a valodi `dumpsys` is igy mukodik.
#     Ez POZITIV KONTROLL a feldolgozasra: ha ez bukna, a kapu a VALODI bemeneten allna meg.
# en: 5. The probe returns MULTIPLE lines including the right one -- as the real `dumpsys` does.
#     A POSITIVE CONTROL for the parsing: were this to fail, the gate would stop on REAL input.
run_case "tobbsoros dumpsys-szeru kimenet -> ROGZIT (pozitiv kontroll)" \
         rogzit "printf 'Package [com.QCassa.JokerQ]\n    versionCode=774 minSdk=35 targetSdk=36\n    versionName=1.0.0-debug\n'" 774

# hu: 6. AZ INJEKTALT PROBA NYOMOT HAGY A BEJEGYZESBEN.
#     MERT ESET (marveen atmerese, 2026-08-14): a `DEVICE_VERSION_PROBE` ELES uton is mukodik, es a
#     kimenet azt allitotta, hogy "a keszuleken merve", holott injektalt szkriptbol jott. Igy a
#     nyilvantartasba HAMIS meres kerulhetett volna, amit a `measured_version_code` mezo meg
#     HITELESIT is. *** Ez rosszabb a javitas elotti allapotnal: ott a bejegyzes MERETLEN volt, itt
#     MERTNEK LATSZO. ***
#     A FELULIRHATOSAG NEM HIBA -- a NYOMTALANSAG az. A jelzes ezert nem uzenet-szintu: a MEZo NEVE
#     mondja meg, mi az. Egy uzenetet a nyilvantartas utolagos olvasoja sosem latja.
# en: 6. THE INJECTED PROBE LEAVES A TRACE IN THE ENTRY. Measured during review: `DEVICE_VERSION_PROBE`
#     works on the live path too, and the output claimed "measured on the device" while coming from
#     an injected script -- a false measurement that `measured_version_code` would then authenticate.
#     Worse than before the fix: unmeasured then, LOOKING MEASURED now. Overridability is not the
#     defect; tracelessness is. The FIELD NAME states it, because a message is never seen by whoever
#     reads the registry later.
run_case "injektalt proba -> a bejegyzes NEM allit keszulek-merest" \
         injektalt-nyom "echo versionCode=774" 774

# hu: 7. EGYIDEJUSEG: N parhuzamos, EGYENKENT ERVENYES hivas UGYANARRA az eszkozre. A `record`
#     zarolas nelkuli olvas-modosit-ir ciklusa last-write-wins bejegyzes-vesztest okoz -- a JSON
#     epen marad, tehat a hiba NEM latszik, csak a bejegyzesek szama kevesebb a varhatonal.
#     (kartya #830, ordog bukas-eloallitasa: 20 parhuzamos hivasbol csak 10 bejegyzes maradt)
# en: 7. CONCURRENCY: N parallel, INDIVIDUALLY VALID calls on the SAME device. The `record`
#     read-modify-write cycle causes silent last-write-wins entry loss without a lock -- the JSON
#     stays valid, only the entry count falls short.
run_concurrent_case() {
  local name="$1" n="$2"
  local reg="$WORK/devices-concurrent-$RANDOM.json"
  cp "$SOURCE_REG" "$reg"
  local before after
  before="$(installs_count "$reg")"

  local pids=() i
  for i in $(seq 1 "$n"); do
    (
      build=$((9000 + i))
      DEVICE_REGISTRY="$reg" DEVICE_VERSION_PROBE="echo versionCode=$build" \
        bash "$SCRIPT" record "$DEVICE_ID" avalonia "$PACKAGE" "$build" >/dev/null 2>&1
    ) &
    pids+=("$!")
  done
  local pid
  for pid in "${pids[@]}"; do wait "$pid"; done

  after="$(installs_count "$reg")"

  if [ "$after" -eq "$((before + n))" ]; then
    PASS=$((PASS + 1))
    printf '  [OK]   %s (bejegyzesek: %s -> %s)\n' "$name" "$before" "$after"
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$name")
    printf '  [BUKO] %s\n' "$name"
    printf '         elvart bejegyzes-szam=%s  kapott=%s  (before=%s, n=%s)\n' \
           "$((before + n))" "$after" "$before" "$n"
  fi
}

run_concurrent_case "20 parhuzamos, egyenkent ervenyes record -> mind a 20 bejegyzes megmarad" 20

echo
echo "Osszegzes: $PASS atment, $FAIL bukott"

if [ "$FAIL" -gt 0 ]; then
  printf 'Bukott esetek: %s\n' "${FAILED_NAMES[*]}"
  exit 1
fi

# hu: AMIT EZ A KESZLET NEM MER, ES KI KELL MONDANI: a TRANSPORT kivalasztasat (melyik `-s` erteket
#     kapja az adb) es magat az adb-hivast. A probat a teszt INJEKTALJA, tehat az alapertelmezett
#     ut (`adb devices` -> sorozatszam-egyeztetes -> `dumpsys`) eszkoz nelkul nem merheto.
#
#     *** ES EZ NEM ELMELETI HATAR: 2026-08-14-en PONT ITT VOLT EGY HIBA, amit ez a keszlet
#     ZOLDEN ATENGEDETT. *** A transport-nevet `${line%% *}` bontotta ki, az `adb devices` viszont
#     TABBAL valaszt el -- igy az EGESZ sor lett a transport-nev, es az eles ut MINDEN hivasra
#     "nincs csatlakozott eszkoz"-t adott. Az 5 eset kozben vegig zold volt.
#     A hiba ugy derult ki, hogy a keszletet KOVEToEN, csatlakozott eszkozon, eldobhato masolaton
#     lefuttattam mind a harom agat -- es az elso rogton elbukott.
#
#     KOTELEZo LEPES A KESZLET UTAN, ha az eszkoz elerheto (a szamot a keszulekhez igazitva):
#       cp store/devices.json /tmp/reg-proba.json
#       DEVICE_REGISTRY=/tmp/reg-proba.json bash scripts/device-registry.sh record <id> <agent> <pkg> <a keszuleken FUTO build>   # -> rogzit
#       DEVICE_REGISTRY=/tmp/reg-proba.json bash scripts/device-registry.sh record <id> <agent> <pkg> 999                          # -> elutasit
#       DEVICE_REGISTRY=/tmp/reg-proba.json bash scripts/device-registry.sh record <id> <agent> com.nincs.ilyen <build>            # -> NEM MERHEТo
#
# en: WHAT THIS SUITE DOES NOT MEASURE: transport selection and the adb call itself. The probe is
#     INJECTED, so the default path cannot be measured without a device.
#     *** AND THAT LIMIT IS NOT THEORETICAL: on 2026-08-14 a defect sat EXACTLY there and this suite
#     passed it GREEN. *** The transport name was split with `${line%% *}` while `adb devices`
#     separates with a TAB, so the WHOLE line became the transport name and the live path answered
#     "no connected device" for every call. It surfaced only by running all three branches on a
#     connected device, on a throwaway copy, AFTER the suite was green.
echo
echo "NEM MERT RESZ: a transport-kivalasztas es a valodi adb-hivas (a probat a teszt injektalja)."
echo "  -> Ha az eszkoz elerheto, futtasd le az eles utat is eldobhato masolaton (lasd a fajl vegen)."
exit 0
