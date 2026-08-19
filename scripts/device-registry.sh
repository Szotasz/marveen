#!/usr/bin/env bash
# ESZKOZ-NYILVANTARTAS -- Jozsi kerese, 2026-08-09.
# "minden projektnek meg van a sajat teszt eszkoze(i). Ha nem talalod a nyilvantartast,
#  akkor elobb kerdezz, es a hatterben legyen errol egy nyilvantartasotok"
#
# HASZNALAT (TELEPITES ELoTT KOTELEZo):
#   device-registry.sh check <id> [--repo <ut>]... [--path <alut>]... [--branch <nev>]
#                                 [--apk <ut>] [--buildfile <ut>]
#         -> szabad-e telepiteni; exit 1 ha KERDEZNI kell
#      --repo      ISMETELHEТo. Az APK tobb repobol is fordulhat (a JokerQ HAROMbol) -- ha egy
#                  `ProjectReference` EGYIK megadott repoban sincs benne, az MERETLEN FUGGoSEG.
#                  Az ELSo `--repo` az APP-REPO (onnan jon a build-szam).
#      --path      a munkafa-meres szukitese. Ahol EGYETLEN nyomon kovetett fajlt sem illeszt,
#                  az NEM "tiszta", hanem NEM MERT -> ALLJ MEG.
#      --branch    a cel-ag (alap: `main`). CSAK ag lehet -- a `merge-base --is-ancestor` meri,
#                  hogy a kod BE VAN-E HUZVA, nem az ag NEVET.
#      --apk       a telepitendo csomag. A `versionCode`-ot (a csomag MANIFESTJEBoL) veti ossze a fa
#                  build-szamaval. NEM az mtime-ot -- azt minden masolas atirja.
#      --buildfile ha a build-szam nem az app-repo `BuildNumberV2.txt`-jeben all.
#   device-registry.sh list                                    -> minden eszkoz, egy sor
#   device-registry.sh show <id>                               -> teljes bejegyzes
#   device-registry.sh record <id> <agent> <package> <build>   -> telepites rogzitese (UTANA)
#   device-registry.sh online                                  -> a MOST csatlakozott eszkozok
#
# A `check` exit-kodja a lenyeg: 0 = mehet, 1 = ALLJ MEG es kerdezz.
#
# 🛑 A VERDIKT HATOKORE -- MI ESIK ALA ES MI NEM (kimondva 2026-08-14, az avalonia kerdesere,
#    mert addig ketfelekeppen volt olvashato):
#      ALA ESIK (exit 1 -> allj meg):  telepites, ujratelepites, torles, gyari visszaallitas,
#                                      adat-torles, es minden, ami az eszkoz ALLAPOTAT valtoztatja.
#      NEM ESIK ALA (szabadon mehet):  READ-ONLY meres -- `appops get`, `sm list-volumes`,
#                                      `pm list packages`, `dumpsys`, `logcat -d`, `getprop`.
#    INDOK: a nyilvantartas azt vedi, hogy egy MASIK vonal munkaja ne irodjon felul. Egy olvasas
#    semmit nem ir felul -- viszont gyakran EPP AZ donti el, kell-e egyaltalan telepiteni.
#    Egy tulterjesztett tiltas itt NEM biztonsagos irany: attol nem lesz kevesebb telepites,
#    csak MERETLENEBB.
set -uo pipefail
REG="${DEVICE_REGISTRY:-/Users/ceo/Marveen/store/devices.json}"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"

[ -f "$REG" ] || { echo "HIBA: nincs nyilvantartas: $REG" >&2; exit 2; }

cmd="${1:-list}"; shift || true

case "$cmd" in
  list)
    python3 - "$REG" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for x in d["devices"]:
    p=", ".join(x["owner_projects"]) or "ISMERETLEN"
    print(f'{x["id"]:<20} | {p:<28} | adat: {x["data_policy"]:<9} | {x["model"]}')
PY
    ;;
  show)
    python3 - "$REG" "${1:?kell egy id}" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); q=sys.argv[2].lower()
for x in d["devices"]:
    if q in json.dumps(x).lower():
        print(json.dumps(x,indent=2,ensure_ascii=False)); break
else: print("nincs ilyen eszkoz a nyilvantartasban:",sys.argv[2])
PY
    ;;
  check)
    # AZ IP NEM AZONOSITO: a WiFi-ADB cim es port ujrainduláskor VALTOZIK. Ha a kapott cim nincs a
    # nyilvantartasban, MEG NEM biztos, hogy ismeretlen eszkoz -- eloszor kerdezzuk meg a keszulektol
    # a SOROZATSZAMAT (az allando), es azzal keressunk ujra. Fail-closed marad: ha az adb sem tud
    # valaszt adni, tovabbra is "NINCS a nyilvantartasban" + exit 1.
    # hu: ARGUMENTUM-BONTAS. A `--repo` a MUNKAFA-KAPU: a gazda kikotese ("csak `main` agba behuzott
    #     kodot szabad telepiteni") a COMMITRA vonatkozik, az APK viszont a MUNKAFABOL fordul.
    #     A kapu NEM tudja, MELYIK projekt fordul -- ezt a hivonak kell megadnia.
    DEV_ID=""; WANT_BRANCH="main"; HAS_PATH=0; PATHSPECS=(); REPOS=(); HAS_REPO=0
    APK_PATH=""; HAS_APK=0; BUILDFILE=""
    # hu: A hasznalati hiba is VERDIKTTEL zarul. Enelkul, aki gepiesen olvassa
    #     (`grep "==> VERDIKT"`), egy elgepelt kapcsolora URES kimenetet kapna -- es az ures
    #     kimenet nem verdikt. Ugyanaz a lyuk, ami 2026-08-14-ig az ismeretlen-eszkoz agon allt.
    usage_stop() {
      echo "*** ALLJ MEG *** $1"
      echo "  ==> VERDIKT: ALLJ MEG. Hasznalati hiba -- a kapu NEM mert semmit."
      exit 2
    }
    while [ $# -gt 0 ]; do
      case "$1" in
        --repo)   [ $# -ge 2 ] || usage_stop "a --repo ertek nelkul all (kell egy repo-ut)."
                  REPOS+=("$2"); HAS_REPO=1; shift 2 ;;
        --path)   [ $# -ge 2 ] || usage_stop "a --path ertek nelkul all (kell egy projekt-alut)."
                  PATHSPECS+=("$2"); HAS_PATH=1; shift 2 ;;
        --branch) [ $# -ge 2 ] || usage_stop "a --branch ertek nelkul all (kell egy ag-nev)."
                  WANT_BRANCH="$2"; shift 2 ;;
        --apk)    [ $# -ge 2 ] || usage_stop "a --apk ertek nelkul all (kell egy csomag-ut)."
                  APK_PATH="$2"; HAS_APK=1; shift 2 ;;
        --buildfile) [ $# -ge 2 ] || usage_stop "a --buildfile ertek nelkul all (kell egy fajl-ut)."
                  BUILDFILE="$2"; shift 2 ;;
        -*)       usage_stop "ismeretlen kapcsolo: $1" ;;
        *)        [ -z "$DEV_ID" ] || usage_stop "egyszerre EGY eszkozt lehet ellenorizni ($DEV_ID es $1)."
                  DEV_ID="$1"; shift ;;
      esac
    done
    [ -n "$DEV_ID" ] || usage_stop "kell egy eszkoz-id/serial/ip."

    RESOLVED=""
    case "$DEV_ID" in
      *.*.*.*|*:*)
        if [ -x "$ADB" ]; then
          RESOLVED=$("$ADB" -s "$DEV_ID" shell getprop ro.serialno 2>/dev/null | tr -d '\r\n')
        fi ;;
    esac

    # hu: A MUNKAFA MERESE. Fail-closed: ha a fa allapota nem merheto, az ALLJ MEG -- nem
    #     "nem tudjuk, tehat mehet". A gitignore-olt build-kimenet (obj/, bin/) NEM piszok:
    #     a `--porcelain` eleve nem mutatja, es ha mutatna, a kaput par nap alatt kikerulnek.
    # hu: A MERES KULON SEGEDBEN FUT (`device-registry-repo-gate.py`) -- indok a fajl fejleceben.
    #     A kimenete a JELENTES, a kilepesi kodja a BLOKKOL / NEM BLOKKOL.
    GATE_PY="$(cd "$(dirname "$0")" && pwd -P)/device-registry-repo-gate.py"
    [ -f "$GATE_PY" ] || { echo "*** ALLJ MEG *** hianyzik a mero: $GATE_PY"
                           echo "  ==> VERDIKT: ALLJ MEG. A kapu merEs nelkul nem ad iteletet."; exit 2; }
    PATHSCOPE="(teljes repo)"
    [ "$HAS_PATH" -eq 1 ] && PATHSCOPE=$(IFS=,; echo "${PATHSPECS[*]}")
    REPO_REPORT=$(python3 "$GATE_PY" "$WANT_BRANCH" "$APK_PATH" "$HAS_APK" "$HAS_REPO" "$BUILDFILE" \
                          "${#PATHSPECS[@]}" ${PATHSPECS+"${PATHSPECS[@]}"} ${REPOS+"${REPOS[@]}"})
    GATE_BAD=$?
    REPO_STATE=$([ "$GATE_BAD" -eq 0 ] && echo ok || echo blocked)

    python3 - "$REG" "$DEV_ID" "$RESOLVED" \
                     "$REPO_STATE" "$REPO_REPORT" "$GATE_BAD" "$WANT_BRANCH" "$PATHSCOPE" \
                     "$([ "$HAS_REPO" -eq 1 ] && echo yes || echo no)" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); q=sys.argv[2].lower()
resolved=(sys.argv[3] if len(sys.argv)>3 else "").strip()
hit=next((x for x in d["devices"] if q in json.dumps(x).lower()), None)
if not hit and resolved:
    hit=next((x for x in d["devices"] if resolved.lower() in json.dumps(x).lower()), None)
    if hit:
        print(f'*** CIM-VALTOZAS: a(z) {sys.argv[2]} nincs a nyilvantartasban, DE a keszulek sorozatszama')
        print(f'    ({resolved}) IGEN -> {hit["id"]}. A WiFi-ADB cim/port ujrainduláskor valtozik, ezert')
        print(f'    az IP NEM azonosito. A nyilvantartasban tarolt cim elavult -- frissitsd, ha maradando.\n')
if not hit:
    print(f"*** ALLJ MEG *** '{sys.argv[2]}' NINCS a nyilvantartasban.")
    if resolved:
        print(f"    (A keszulek sorozatszama {resolved} -- ez sincs a listaban.)")
    else:
        print("    (A sorozatszamot sem sikerult lekerdezni: nem csatlakozik, vagy nem IP-t adtal meg.)")
    print("Ez pontosan az az eset, amirol Jozsi beszelt: ha nem talalod, ELOBB KERDEZZ, ne telepits.")
    # hu: A ZARO VERDIKT-SOR ITT IS KELL. Az avalonia merte ki (2026-08-14): a zaro sor azert
    #     szuletett, hogy legyen EGY hely, amit olvasni kell -- de az ISMERETLEN eszkoz agan
    #     hianyzott. Aki gepiesen olvassa (`grep "==> VERDIKT"`), pont a legveszelyesebb esetre
    #     kapott URES kimenetet, es az ures kimenet nem verdikt. Az exit-kod helyes volt, tehat a
    #     kar korlatozott -- de egy kapu, aminek a kimenete ket kulonbozo alakban jelenik meg,
    #     ugyanugy ket iranyba olvashato.
    print("  ==> VERDIKT: ALLJ MEG. Ismeretlen eszkoz -- kerdezz, mielott barmit teszel.")
    sys.exit(1)
bad=False
proj=hit["owner_projects"]
print(f'{hit["id"]} ({hit["model"]})')
print(f'  projekt(ek): {", ".join(proj) if proj else "ISMERETLEN"}   [{hit["owner_source"]}]')
print(f'  adat-politika: {hit["data_policy"]}')
if hit.get("known_state"): print(f'  utolso mert allapot: {hit["known_state"]}')
for w in hit.get("warnings",[]): print(f'  !! {w}')
for pp in hit.get("protected_packages",[]):
    print(f'  !!!! VEDETT CSOMAG: {pp["package"]}'); print(f'       {pp["rule"]}'); bad=True
li=hit.get("last_installs",[])
print(f'  rogzitett telepitesek: {len(li)}' + (f' -- utolso: {li[-1]["at"]} / {li[-1]["agent"]} / {li[-1]["package"]}' if li else ' (NEM azt jelenti, hogy nem volt)'))
if not proj:
    print("  -> ALLJ MEG: nem tudjuk, kie az eszkoz. KERDEZZ."); bad=True
if len(proj)>1:
    print("  -> ALLJ MEG: TOBB projekt hasznalja FELVALTVA. Egyeztess, mielott felulirod."); bad=True
# hu: A VERDIKT KET KULON KERDESRE VALASZOL, MERT A GAZDA IS KULON DONT ROLUK:
#     TELEPITES  -> install_policy   |   TORLES / gyari visszaallitas -> data_policy
#     2026-08-14-ig a ketto EGY mezon allt, ezert egy eszkoz, amin ELo ADAT van (torles tilos),
#     de a telepites engedelyezett, egyszerre kapta meg a feloldast a szovegben es az ALLJ MEG-et
#     a verdiktben. A kapu tehat KET ELLENTMONDO dolgot mondott egyszerre -- rosszabb, mint ha
#     hallgatna: aki a verdiktet nezi, nem telepit; aki a szoveget olvassa, atlepi a kaput, es
#     SOHA nem derul ki, melyikuk ertette felre. (Az avalonia merte ki.)
ip = hit.get("install_policy")
if hit["data_policy"]=="not-present":
    print("  -> ALLJ MEG: EZ AZ ESZKOZ NINCS A HELYSZINEN. Ha megis valaszol valami ezen a cimen, az NEM ez a keszulek."); bad=True
elif ip in ("allowed","allowed-from-main"):
    extra = " -- DE CSAK a `main` agba behuzott kodbol" if ip=="allowed-from-main" else ""
    print(f'  -> TELEPITES SZABAD{extra}. Forras: {hit.get("install_policy_source","(nincs megadva)")}')
    if hit["data_policy"]!="free":
        print("  !! DE A TORLES ES A GYARI VISSZAALLITAS TOVABBRA IS TILOS kerdes nelkul (data_policy: "
              + hit["data_policy"] + ").")
elif hit["data_policy"]!="free":
    print("  -> ALLJ MEG: nem igazolt, hogy szabadon ujratelepitheto. Torles/gyari visszaallitas TILOS kerdes nelkul."); bad=True

# hu: MUNKAFA-KAPU -- A GAZDA KIKOTESE A COMMITRA SZOL, AZ APK VISZONT A MUNKAFABOL FORDUL.
#     A ketto KULON uton jar:  commit <- amit teteles pathspec-kel hozzaadtal
#                              APK    <- ami a LEMEZEN van a forditas pillanataban
#     Vagyis a commit lehet tiszta ES a telepitett csomag megis tartalmazhat egy MASIK fej felig kesz
#     munkajat -- a build-szam ilyenkor HAZUDIK: azt allitja, hogy a HEAD tartalma megy fel.
#     (2026-08-14: egy fej forditasa kozben ket idegen fajl modosult a fan; a forditas fel perccel
#     korabban zarult le, tehat NEM kerult bele. Ez IDoZITES volt, nem vedelem.)
repo_state  = sys.argv[4] if len(sys.argv) > 4 else "notmeasured"
repo_report = sys.argv[5] if len(sys.argv) > 5 else ""
gate_bad    = (sys.argv[6] if len(sys.argv) > 6 else "0") == "1"
want_branch = sys.argv[7] if len(sys.argv) > 7 else "main"
pathscope   = sys.argv[8] if len(sys.argv) > 8 else "(teljes repo)"
has_repo    = (sys.argv[9] if len(sys.argv) > 9 else "no") == "yes"

if not has_repo:
    # hu: 🛑 A NEM-MERES NEM ELEG KIMONDANI -- A VERDIKTNEK IS KOVETNIE KELL (javitva 2026-08-15).
    #     A korabbi alak kiirta, hogy "MUNKAFA: NEM MERVE", majd a zaro sorban `MEHET`-et adott,
    #     exit 0-val. A gepies hivo (`if bash gate.sh; then telepit; fi`) a KILEPESI KODOT olvassa,
    #     nem a magyarazatot -- vagyis a kapu pont a legveszelyesebb esetre (meretlen munkafa +
    #     ELES eszkoz) adott telepitesi engedelyt. Egy kapu, ami atenged, blokkolo.
    #     A VERDIKT A TELEPITESRoL SZOL: merés nelkul nincs engedely.
    #     AMI EZZEL NEM TILOS: a fenti tulajdonos-adatok OLVASHATOK, es a read-only eszkoz-meres
    #     (appops get, sm list-volumes, logcat) az ALLJ MEG mellett is mehet -- a verdikt a
    #     TELEPITESRE es a TORLESRE vonatkozik.
    print("  MUNKAFA: NEM MERVE -- `--repo <ut>` nelkul a kapu NEM tudja, hogy a telepitendo csomag")
    print("           a HEAD-bol fordul-e. A gazda kikotese szerint csak `main`-be behuzott kodot")
    print("           szabad eles eszkozre tenni, tehat meres nelkul TELEPITENI NEM SZABAD.")
    print("             device-registry.sh check <id> --repo <repo-ut> [--repo <masik>]... [--path <alut>]")
    print("           A fenti tulajdonos-adatok ettol fuggetlenul ervenyesek, es a read-only")
    print("           eszkoz-meres (appops, sm, logcat) mehet -- csak a TELEPITES es a TORLES all.")
    bad = True
else:
    # hu: A JELENTES SOROK SZERINT KESZ (repoankent), mert TOBB repot merunk: egy osszevont
    #     "tiszta" szo elrejtene, hogy melyik repo mit adott.
    for l in repo_report.splitlines():
        if l.strip():
            print(l)
    if want_branch != "main":
        # hu: A cel-ag FELULIRHATO, de az atallitasnak LATSZANIA kell. Egy kapu, amit a hivo
        #     csendben athangolhat, nem kapu -- a `--branch` igy legalabb nyomot hagy a kimenetben.
        print(f"  CEL-AG FELULIRVA: a hivo `{want_branch}`-t adott meg a `main` helyett.")
    if repo_state == "dirty":
        print("           A forditas a LEMEZEN levo allapotbol keszul, nem a commitbol. Commitold vagy")
        print("           stash-eld a kulonbseget -- vagy ha MAS fej munkaja, egyeztess vele --, majd merd ujra.")
    if gate_bad:
        bad = True

# hu: ZARO VERDIKT -- EGY sor, ami eldonti a kerdest. Enelkul a kimenetben egymas mellett
#     allhat "TELEPITES SZABAD" (a gazda engedelyezte) es "ALLJ MEG" (mert pl. tobb projekt
#     hasznalja az eszkozt), es az olvaso arra a sorra epit, amelyiket eloszor meglatja.
#     A ket allitas nem ellentmondas -- kulon dolgokrol szolnak --, de a kapunak KI KELL MONDANIA,
#     melyik nyer. Egy kapu, ami ket iranyba olvashato, nem kapu.
if bad:
    print("  ==> VERDIKT: ALLJ MEG. A fenti ok(ok) FELULIRJAK a telepites-engedelyt is -- kerdezz, mielott barmit teszel.")
else:
    print("  ==> VERDIKT: MEHET (a fenti kikotesekkel).")
sys.exit(1 if bad else 0)
PY
    ;;
  record)
    id="${1:?id}"; agent="${2:?agent}"; pkg="${3:?package}"; build="${4:?build}"

    # hu: *** A ROGZITES BIZONYITEKRA MEGY, NEM A HIVO ALLITASARA. ***
    #     MERT ESET (2026-08-14): az `adb install` a `more than one device/emulator` hibaval
    #     ELUTASITOTT, a `record` viszont ugyanabban a parancs-blokkban allt, feltetel nelkul -- igy
    #     egy MEG NEM TORTENT telepites kerult a `last_installs`-ba. A celzott ujraprobalassal a
    #     bejegyzes utolag igazza valt, tehat kar nem keletkezett, DE az szerencse volt, nem eljaras.
    #     A `last_installs` az EGYETLEN hely, ahol utolag latszik, mi ment fel egy ELES eszkozre:
    #     egy nyilvantartas, ami a hivo fegyelmen mulik, nem nyilvantartas.
    #     A BIZONYITEK a keszuleken TENYLEGESEN futo build szama, a csomag-kezelotol kerdezve.
    # en: *** RECORDING RUNS ON EVIDENCE, NOT ON THE CALLER'S CLAIM. ***
    #     MEASURED CASE (2026-08-14): `adb install` refused with `more than one device/emulator`
    #     while `record` sat next to it unconditionally -- so a deployment that never happened was
    #     written into `last_installs`. The targeted retry made the entry true after the fact: luck,
    #     not procedure. `last_installs` is the ONLY place showing afterwards what went onto a LIVE
    #     device; a registry that depends on the caller's discipline is not a registry.
    #     The evidence is the build number ACTUALLY running on the device, asked from the package
    #     manager.
    #
    # hu: A probat a hivo felulirhatja (`DEVICE_VERSION_PROBE`) -- ez teszi a kaput teszthetove
    #     eszkoz nelkul. Az alapertelmezett ut a SOROZATSZAM alapjan valaszt transportot, mert
    #     UGYANAZ a keszulek egyszerre latszhat IP-cimen ES mDNS-neven (merve 2026-08-14), es
    #     ilyenkor a cel nelkuli `adb` `more than one device`-szal elutasit.
    # en: The probe is overridable (`DEVICE_VERSION_PROBE`), which makes the gate testable without a
    #     device. The default path picks a transport BY SERIAL, because the SAME device can appear
    #     both by IP and by mDNS name (measured 2026-08-14), and an untargeted `adb` then refuses
    #     with `more than one device`.
    # hu: *** A FELULIRHATOSAG NEM HIBA -- A NYOMTALANSAG AZ. *** A proba felulirhato, mert enelkul a
    #     kapu eszkoz nelkul nem lenne teszteheto. DE a felulirt meres NEM allithatja magat
    #     keszulek-meresnek: ugy a nyilvantartasba HAMIS meres kerulne, amit a `measured_version_code`
    #     mezo meg hitelesit is -- rosszabb, mint a javitas elotti allapot, ahol a bejegyzes
    #     MERETLEN volt (itt MERTNEK LATSZANA).
    #     A JELZES NEM UZENET-SZINTu, HANEM A MEZo NEVEBEN AL: a nyilvantartast UTOLAG olvassak,
    #     amikor mar senki nem tudja, milyen kornyezeti valtozoval futott a parancs. Egy uzenetet az
    #     utolagos olvaso sosem lat.
    # en: *** OVERRIDABILITY IS NOT THE DEFECT -- TRACELESSNESS IS. *** The probe is overridable
    #     because otherwise the gate could not be tested without a device. But an overridden
    #     measurement must not present itself as a device measurement: the registry would then carry
    #     a FALSE measurement authenticated by `measured_version_code` -- worse than before the fix,
    #     where the entry was merely UNMEASURED (here it would LOOK measured).
    #     THE TRACE LIVES IN THE FIELD NAME, not in a message: the registry is read LATER, when
    #     nobody knows which environment variable the command ran with.
    probe_kind="keszulek"

    if [ -n "${DEVICE_VERSION_PROBE:-}" ]; then
      probe_kind="injektalt"
      echo "MERo FELULIRVA: DEVICE_VERSION_PROBE -- a bejegyzes NEM keszulek-meresnek szamit." >&2
      probe_out="$(eval "$DEVICE_VERSION_PROBE" 2>/dev/null)"; probe_rc=$?
    else
      [ -x "$ADB" ] || { echo "*** NEM ROGZITVE *** nincs adb itt: $ADB -- a telepites NEM MERHEТo." >&2; exit 2; }

      serial="$(python3 - "$REG" "$id" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); q=sys.argv[2].lower()
hit=next((x for x in d["devices"] if q in json.dumps(x).lower()), None)
print((hit or {}).get("serial") or (hit or {}).get("id") or "")
PY
)"

      # hu: A transport-nevet AWK bontja ki, nem `${line%% *}`. *** Merve 2026-08-14: az `adb devices`
      #     TABBAL valaszt el, nem szokozzel *** -- a szokoz-alapu bontas az EGESZ sort adta vissza
      #     transport-nevkent (`192.168.1.160:40651<TAB>device`), es az `adb -s <ilyen>` termeszetesen
      #     nem talalt eszkozt. A hiba NEM latszott a teszt-keszleten, mert az injektalt probat
      #     hasznal -- ezt az agat csak eles eszkozon lehet merni.
      # en: The transport name is split by AWK, not `${line%% *}`. *** Measured 2026-08-14: `adb
      #     devices` separates with a TAB, not a space *** -- space-based splitting returned the
      #     WHOLE line as the transport name, and `adb -s <that>` naturally found no device. The
      #     defect was invisible to the test suite, which injects its probe -- this branch can only
      #     be measured on a live device.
      transport=""
      while read -r t; do
        [ -z "$t" ] && continue
        if [ "$("$ADB" -s "$t" shell getprop ro.serialno 2>/dev/null | tr -d '\r\n')" = "$serial" ]; then
          transport="$t"
          break
        fi
      done < <("$ADB" devices 2>/dev/null | tail -n +2 | awk 'NF {print $1}')

      if [ -z "$transport" ]; then
        echo "*** NEM ROGZITVE *** nincs csatlakozott eszkoz $serial sorozatszammal -- a telepites NEM MERHEТo." >&2
        exit 2
      fi

      probe_out="$("$ADB" -s "$transport" shell dumpsys package "$pkg" 2>/dev/null)"; probe_rc=$?
    fi

    if [ "$probe_rc" -ne 0 ]; then
      echo "*** NEM ROGZITVE *** a keszulek-lekerdezes elbukott -- a telepites NEM MERHEТo (fail-closed)." >&2
      exit 2
    fi

    measured="$(printf '%s\n' "$probe_out" | sed -n 's/.*versionCode=\([0-9][0-9]*\).*/\1/p' | head -1)"

    if [ -z "$measured" ]; then
      # hu: A parancs LEFUTOTT, de nincs benne versionCode. Ez MAS, mint a bukas: itt a lekerdezes
      #     sikeresnek latszik, es egy ures eredmenyt konnyu "nincs elteres"-nek olvasni.
      # en: The command RAN but carries no versionCode. Different from failing: the query looks
      #     successful, and an empty result is easily read as "no mismatch".
      echo "*** NEM ROGZITVE *** a lekerdezes nem adott versionCode-ot -- a telepites NEM MERHEТo (fail-closed)." >&2
      exit 2
    fi

    if [ "$measured" != "$build" ]; then
      echo "*** NEM ROGZITVE *** a keszuleken build $measured fut, a rogzitendo pedig $build." >&2
      echo "  A telepites vagy nem tortent meg, vagy mas eszkozre ment. A nyilvantartas VALTOZATLAN." >&2
      exit 1
    fi

    # hu: 🛑 ZAROLAS -- az utana kovetkezo olvas-modosit-ir ciklus (json.load -> append ->
    #     json.dump) ZAROLAS NELKUL last-write-wins bejegyzes-vesztest okoz egyideju hivasnal
    #     (kartya #830, ordog bukas-eloallitasa: 20 egyideju, egyenkent ervenyes hivasbol csak
    #     10 bejegyzes maradt -- a JSON epen marad, a hiba NEM latszik). Ugyanaz a minta, mint a
    #     `tg-seq.sh`-ban: mkdir POSIX-on ATOMI, ezert zarnak jo -- ezen a gepen (macOS) NINCS
    #     flock. Fail-closed: ha a zar nem szerezheto meg, INKABB NE IRJON.
    # en: LOCKING -- the following read-modify-write cycle (json.load -> append -> json.dump)
    #     causes silent last-write-wins entry loss under concurrent calls without a lock. Same
    #     pattern as `tg-seq.sh`: mkdir is POSIX-atomic; this machine (macOS) has no flock.
    #     Fail-closed: if the lock can't be acquired, refuse to write.
    LOCKDIR="${REG}.lockdir"
    TURELEM_MP=10
    __lock_start=$(date +%s)
    until mkdir "$LOCKDIR" 2>/dev/null; do
      if [ $(( $(date +%s) - __lock_start )) -ge "$TURELEM_MP" ]; then
        echo "*** NEM ROGZITVE *** a zarat ${TURELEM_MP} mp alatt nem sikerult megszerezni." >&2
        echo "  ha a zar beragadt, oldd fel KEZZEL:  rmdir '$LOCKDIR'" >&2
        exit 2
      fi
      sleep 0.05
    done
    trap '__rc=$?; rmdir "$LOCKDIR" 2>/dev/null || true; exit $__rc' EXIT

    python3 - "$REG" "$id" "$agent" "$pkg" "$build" "$(date '+%Y-%m-%d %H:%M:%S')" "$measured" "$probe_kind" <<'PY'
import json,sys
reg,id_,agent,pkg,build,now,measured,kind=sys.argv[1:9]
d=json.load(open(reg)); q=id_.lower()
hit=next((x for x in d["devices"] if q in json.dumps(x).lower()), None)
if not hit: print("nincs ilyen eszkoz:",id_); sys.exit(1)
# hu: A szam bekerul, DE A MEZo NEVE MONDJA MEG, HONNAN JON. Keszulek-meresnel
#     `measured_version_code`, injektalt probanal `injected_version_code` -- utobbi NEM bizonyitek,
#     es a hianyzo `measured_*` mezo maga a jelzes. Egy `source`-ba rejtett megjegyzest az utolagos
#     olvaso atlapozna; egy hianyzo mezot nem.
# en: The number goes in, BUT THE FIELD NAME SAYS WHERE IT CAME FROM. `measured_version_code` for a
#     device measurement, `injected_version_code` for an injected probe -- the latter is NOT
#     evidence, and the absent `measured_*` field is the signal itself. A note buried in `source`
#     would be skimmed over; a missing field cannot be.
entry={"agent":agent,"at":now,"package":pkg,"build":build,"ok":True}

if kind=="keszulek":
    entry["source"]="device-registry.sh record"
    entry["measured_version_code"]=measured
else:
    entry["source"]="device-registry.sh record (INJEKTALT proba: DEVICE_VERSION_PROBE -- NEM keszulek-meres)"
    entry["injected_version_code"]=measured

hit.setdefault("last_installs",[]).append(entry)
json.dump(d,open(reg,"w"),indent=2,ensure_ascii=False); open(reg,"a").write("\n")
forras="a keszuleken merve" if kind=="keszulek" else "INJEKTALT probabol, NEM keszulek-meres"
print(f'rogzitve: {hit["id"]} <- {agent} / {pkg} / build {build} / {now} ({forras}: {measured})')
PY
    ;;
  online)
    [ -x "$ADB" ] || { echo "HIBA: nincs adb itt: $ADB" >&2; exit 2; }
    # FIGYELEM: az adb NINCS a nem-interaktiv shell PATH-jaban -- ezert megy teljes uton.
    "$ADB" devices -l
    ;;
  *) echo "ismeretlen parancs: $cmd (list|show|check|record|online)" >&2; exit 2 ;;
esac
