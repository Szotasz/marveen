#!/bin/bash
# hu: Bukas-eloallito teszt a `device-registry.sh check --repo` munkafa-kapuhoz.
#     A kapu azt meri, hogy a telepitendo APK forrasa MEGEGYEZIK-E a HEAD-del --
#     a gazda kikotese ("csak main agba behuzott kodot szabad telepiteni") ugyanis
#     a COMMITRA vonatkozik, az APK viszont a MUNKAFABOL fordul.
#     A kapu sajat magat nem igazolhatja, ezert minden eset ELoALLITOTT repo-allapoton
#     mer, es a POZITIV KONTROLL (amit at KELL engednie) is benne van.
# en: Failure-producing test suite for the `device-registry.sh check --repo` working-tree gate.
#     Every case runs against a purpose-built git state; positive controls are part of the suite.

set -uo pipefail

GATE="${GATE_PATH:-/Users/ceo/Marveen/scripts/device-registry.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/drrg-test.XXXXXX")"
PASS=0
FAIL=0
FAILED_NAMES=()

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if [ ! -x "$GATE" ]; then
    echo "HIBA: a kapu nem futtathato: $GATE" >&2
    exit 1
fi

REG="$WORK/devices.json"
cat > "$REG" <<'JSON'
{
  "devices": [
    {
      "id": "TESZT-ESZKOZ",
      "model": "Teszt A36",
      "owner_projects": ["JokerQ"],
      "owner_source": "teszt-fixture",
      "data_policy": "free",
      "install_policy": "allowed-from-main",
      "install_policy_source": "teszt-fixture",
      "last_installs": []
    }
  ]
}
JSON

REPO="$WORK/repo"

# hu: Tiszta kiindulo repo: `Proj/` (a forditando projekt) es `Other/` (mas terulet),
#     `main` agon, egy .gitignore-ral, ami az `obj/`-t kizarja.
make_repo() {
    rm -rf "$REPO"
    mkdir -p "$REPO/Proj" "$REPO/Other"
    git -C "$REPO" init -q .
    # hu: A `git init -b` nem all rendelkezesre minden verzioban -- a szimbolikus
    #     referencia beallitasa mukodik meg-nem-szuletett HEAD-en is.
    git -C "$REPO" symbolic-ref HEAD refs/heads/main
    printf 'obj/\n' > "$REPO/.gitignore"
    echo "eredeti" > "$REPO/Proj/App.cs"
    echo "eredeti" > "$REPO/Other/Doc.md"
    git -C "$REPO" add -A
    git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init
}

# hu: Egy eset lefuttatasa. $1=nev, $2=elvart exit, $3=elvart reszlet a kimenetben
#     (ures = nem vizsgaljuk), tovabbi argumentumok = a kapu argumentumai.
run_case() {
    local name="$1" expected="$2" needle="$3"; shift 3
    local out actual

    out=$(DEVICE_REGISTRY="$REG" AAPT2="${STUB:-}" "$GATE" "$@" 2>&1)
    actual=$?

    local why=""
    [ "$actual" -ne "$expected" ] && why="vart exit $expected, kapott $actual"
    if [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF "$needle"; then
        why="${why:+$why; }hianyzik a kimenetbol: '$needle'"
    fi
    # hu: A ZARO VERDIKT-SOR MINDEN UTON KOTELEZo -- aki gepiesen olvassa
    #     (`grep "==> VERDIKT"`), ne kapjon ures kimenetet egyetlen agon sem.
    if ! printf '%s' "$out" | grep -q '==> VERDIKT'; then
        why="${why:+$why; }nincs zaro VERDIKT-sor"
    fi

    if [ -z "$why" ]; then
        PASS=$((PASS + 1))
        printf '  ok    %-56s (exit %d)\n' "$name" "$actual"
    else
        FAIL=$((FAIL + 1))
        FAILED_NAMES+=("$name")
        printf '  BUKIK %-56s %s\n' "$name" "$why"
    fi
}

echo "== device-registry.sh check --repo (munkafa-kapu) =="

# ---------------------------------------------------------------- P: pozitiv kontroll
make_repo
# 🛑 P1 ATIRVA 2026-08-15 -- A REGI ALAK A FAIL-OPENT ZARTA TESZTBE.
#    A regi eset azt varta el, hogy `--repo` NELKUL a kapu exit 0-t adjon ("atmegy, de kimondja,
#    hogy nem mert"). A kimondas ott is volt -- de a ZARO SOR `MEHET`-et irt, es a gepies hivo
#    (`if bash gate.sh; then telepit; fi`) EZT olvassa, nem a magyarazatot. Vagyis a kapu a
#    legveszelyesebb esetre -- meretlen munkafa + eles eszkoz -- TELEPITESI ENGEDELYT adott.
#    Az ordog sajat mercéje szerint: "egy kapu, ami tul sokat mond, javitando; egy kapu, ami
#    ATENGED, blokkolo."
#    AZ UJ SZEMANTIKA: a verdikt a TELEPITESRoL szol. `--repo` nelkul a munkafa nem mert, tehat
#    telepiteni nem szabad -> exit 1. A tulajdonos-adatok ettol fuggetlenul OLVASHATOK a kimenetben,
#    es a read-only eszkoz-meres (appops, sm, logcat) az ALLJ MEG mellett is mehet.
run_case "P1 --repo NELKUL: ALLJ MEG (a munkafa nem mert)" 1 "MUNKAFA: NEM MERVE" \
    check TESZT-ESZKOZ
run_case "P1/b --repo NELKUL a verdikt NEM olvashato engedelykent" 1 "TELEPITENI NEM SZABAD" \
    check TESZT-ESZKOZ
run_case "P2 tiszta fa, main agon -> MEHET" 0 "MUNKAFA: tiszta" \
    check TESZT-ESZKOZ --repo "$REPO"

# ---------------------------------------------------------------- F: piszkos munkafa
make_repo
echo "modositva" > "$REPO/Proj/App.cs"
run_case "F1 modositott tracked fajl -> ALLJ MEG" 1 "MUNKAFA: PISZKOS" \
    check TESZT-ESZKOZ --repo "$REPO"

make_repo
echo "uj" > "$REPO/Proj/Uj.cs"
run_case "F2 nyomon nem kovetett UJ fajl -> ALLJ MEG" 1 "MUNKAFA: PISZKOS" \
    check TESZT-ESZKOZ --repo "$REPO"

make_repo
echo "modositva" > "$REPO/Proj/App.cs"
git -C "$REPO" add Proj/App.cs
run_case "F3 staged, de nem commitolt -> ALLJ MEG" 1 "MUNKAFA: PISZKOS" \
    check TESZT-ESZKOZ --repo "$REPO"

# ---------------------------------------------------------------- hatokor-szukites
make_repo
echo "modositva" > "$REPO/Other/Doc.md"
run_case "P3 --path Proj, a valtozas MASHOL van -> MEHET" 0 "MUNKAFA: tiszta" \
    check TESZT-ESZKOZ --repo "$REPO" --path Proj
run_case "F4 ugyanaz --path NELKUL -> ALLJ MEG" 1 "MUNKAFA: PISZKOS" \
    check TESZT-ESZKOZ --repo "$REPO"

make_repo
echo "modositva" > "$REPO/Proj/App.cs"
run_case "F5 --path Proj, a valtozas OTT van -> ALLJ MEG" 1 "MUNKAFA: PISZKOS" \
    check TESZT-ESZKOZ --repo "$REPO" --path Proj

# hu: A gitignore-olt build-kimenet NEM piszok. Ha az blokkolna, a kaput megkerulnek.
make_repo
mkdir -p "$REPO/Proj/obj"; echo "buildkimenet" > "$REPO/Proj/obj/App.dll"
run_case "P4 gitignore-olt build-kimenet -> MEHET" 0 "MUNKAFA: tiszta" \
    check TESZT-ESZKOZ --repo "$REPO"

# ---------------------------------------------------------------- ag-ellenorzes
# hu: A KIKOTES NEM AZ AG NEVE, HANEM A BEHUZOTTSAG (az ordog atmerese, 2026-08-14).
#     Egy azonos csucsu feature-agon a kod BENNE VAN a `main`-ben -- ott az ALLJ MEG hamis
#     pozitiv lenne, es a fej egy `--branch`-csel amugy is feloldana. A valodi meres a
#     `merge-base --is-ancestor`.
make_repo
git -C "$REPO" checkout -q -b feature-x
run_case "F6 azonos csucsu feature-ag -> MEHET (a kod BENNE van a main-ben)" 0 "BEHUZVA" \
    check TESZT-ESZKOZ --repo "$REPO"
# hu: A cel-ag felulirhato -- de a kimenet MONDJA KI, hogy nem az alapertelmezes futott.
#     Egy kapu, amit a hivo atallithat, csak akkor kapu, ha az atallitas LATSZIK.
run_case "P5 --branch felulirja a cel-agat, es ez KIIRODIK" 0 "CEL-AG FELULIRVA" \
    check TESZT-ESZKOZ --repo "$REPO" --branch feature-x

# ---------------------------------------------------------------- fail-closed
make_repo
mkdir -p "$WORK/nemrepo"
run_case "F7 --repo nem git-repo -> ALLJ MEG (fail-closed)" 1 "MUNKAFA: NEM MERHETo" \
    check TESZT-ESZKOZ --repo "$WORK/nemrepo"
run_case "F8 --repo nem letezo ut -> ALLJ MEG (fail-closed)" 1 "MUNKAFA: NEM MERHETo" \
    check TESZT-ESZKOZ --repo "$WORK/nincs-ilyen"

# hu: Az eszkoz-verdikt NEM irhato felul a tiszta munkafaval. Ismeretlen eszkoz
#     tiszta fan is ALLJ MEG -- a ket kerdes fuggetlen.
run_case "F9 ismeretlen eszkoz + tiszta fa -> ALLJ MEG" 1 "" \
    check NINCS-ILYEN-ESZKOZ --repo "$REPO"

# hu: A hianyzo argumentum HANGOS hiba legyen, ne nema atengedes.
run_case "F10 --repo ertek nelkul -> hasznalati hiba" 2 "" \
    check TESZT-ESZKOZ --repo

# ================================================================================================
# hu: TOBB-REPOS FORDITAS. Az ordog merte ki eles fan: a JokerQ APK HAROM kulon git-repobol
#     fordul (JokerQ + QuantumAE + QCassa.MHMI, `ProjectReference`-szel behuzva). Egy EGY repot
#     mero kapu ilyenkor `MEHET`-et ad, mikozben egy commitolatlan fajl beepul a csomagba --
#     SZO SZERINT a kartya sajat hibaosztalya, csak egy repo-hatarral arrebb tolva.
# ================================================================================================
REPO2="$WORK/repo2"

# hu: `repo` egy `ProjectReference`-szel a `repo2`-re. A hivatkozas REPON KIVULRE mutat.
make_repo_pair() {
    make_repo
    rm -rf "$REPO2"
    mkdir -p "$REPO2/Lib"
    git -C "$REPO2" init -q .
    git -C "$REPO2" symbolic-ref HEAD refs/heads/main
    echo "eredeti" > "$REPO2/Lib/Lib.cs"
    printf '<Project Sdk="Microsoft.NET.Sdk"></Project>\n' > "$REPO2/Lib/Lib.csproj"
    git -C "$REPO2" add -A
    git -C "$REPO2" -c user.email=t@t -c user.name=t commit -qm init
    printf '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <ProjectReference Include="..\\..\\repo2\\Lib\\Lib.csproj" />\n  </ItemGroup>\n</Project>\n' > "$REPO/Proj/Proj.csproj"
    git -C "$REPO" add -A
    git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm csproj
}

make_repo_pair
run_case "R1 ket repo megadva, mindketto tiszta -> MEHET" 0 "MUNKAFA: tiszta" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2"

echo "modositva" > "$REPO2/Lib/Lib.cs"
run_case "R2 a MASODIK repo piszkos -> ALLJ MEG" 1 "MUNKAFA: PISZKOS" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2"

# hu: EZ A DISZKRIMINALO ESET. Ha a kapu csak az UTOLSO `--repo`-t merne (a naiv alak),
#     itt `MEHET`-et adna: az utolso repo tiszta, az ELSo piszkos.
make_repo_pair
echo "modositva" > "$REPO/Proj/App.cs"
run_case "R2b az ELSo repo piszkos, a masodik tiszta -> ALLJ MEG" 1 "MUNKAFA: PISZKOS" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2"

# hu: EZ AZ ORDOG LELETE. A `repo` tiszta, a `repo2` piszkos ES beepul -- de csak a `repo`-t merjuk.
#     A regi kapu itt `MEHET`-et adott. Fail-closed: a MERETLEN fuggoseg maga a blokkolo.
run_case "R3 csak az EGYIK repo merve, de kifele hivatkozik -> ALLJ MEG" 1 "MERETLEN FUGGoSEG" \
    check TESZT-ESZKOZ --repo "$REPO"

make_repo_pair
run_case "R4 tiszta parnal is ALLJ MEG, ha csak az egyiket merjuk" 1 "MERETLEN FUGGoSEG" \
    check TESZT-ESZKOZ --repo "$REPO"

# ================================================================================================
# hu: AZ AG NEVE NEM A KIKOTES. A gazda kikotese az, hogy a kod BE LEGYEN HUZVA a `main`-be --
#     ezt a `merge-base --is-ancestor` meri, nem az ag NEVE. Egy be nem olvasztott feature-agon
#     a nev-egyezes hamis zoldet adna.
# ================================================================================================
make_repo
git -C "$REPO" checkout -q -b feature-x
echo "uj funkcio" > "$REPO/Proj/Uj.cs"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm "feature"
run_case "A1 be NEM olvasztott feature-ag, tiszta fa -> ALLJ MEG" 1 "NINCS BEHUZVA" \
    check TESZT-ESZKOZ --repo "$REPO"

git -C "$REPO" checkout -q main
git -C "$REPO" -c user.email=t@t -c user.name=t merge -q --no-ff -m "merge" feature-x
git -C "$REPO" checkout -q feature-x
run_case "A2 ugyanaz az ag, MIUTAN beolvadt a main-be -> MEHET" 0 "BEHUZVA" \
    check TESZT-ESZKOZ --repo "$REPO"

make_repo
run_case "A3 nem letezo cel-ag -> ALLJ MEG (fail-closed)" 1 "" \
    check TESZT-ESZKOZ --repo "$REPO" --branch nincs-ilyen-ag

# hu: A `--branch` NEM barmi, amit a `rev-parse` felold -- CSAK AG (az ordog X5b/X5c esete).
#     A `--is-ancestor HEAD HEAD` trivialisan igaz, tehat egyetlen szoval kikapcsolhato lenne az
#     egesz ellenorzes, es a "CEL-AG FELULIRVA" sor szabalyos agnev-felulirasnak latszana.
make_repo
git -C "$REPO" checkout -q -b feature-y
echo "uj" > "$REPO/Proj/Uj.cs"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm "feature"
run_case "A4 --branch HEAD nem kapcsolhatja ki az ellenorzest" 1 "" \
    check TESZT-ESZKOZ --repo "$REPO" --branch HEAD
SHA=$(git -C "$REPO" rev-parse HEAD)
run_case "A5 --branch <commit-hash> sem kapcsolhatja ki" 1 "" \
    check TESZT-ESZKOZ --repo "$REPO" --branch "$SHA"

# ================================================================================================
# hu: A `--path` GLOBALIS MINDEN `--repo`-RA -- es ahol EGYETLEN nyomon kovetett fajlt sem illeszt,
#     ott a szukites ertelmetlen. A regi alak ilyenkor "tiszta"-t irt, es ezzel HITELESITETTE egy
#     meg nem mert repo allapotat. Eles fan az ordog allitotta elo: harom repo, `--path src/JokerQ`
#     -> mind a harom "tiszta", mikozben a QuantumAE-ban 9 commitolatlan bejegyzes allt.
# ================================================================================================
make_repo_pair
echo "modositva" > "$REPO2/Lib/Lib.cs"
run_case "X5 a pathspec az egyik repoban 0 kovetett fajlt illeszt -> ALLJ MEG" 1 "NEM MERT" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --path Proj

# ================================================================================================
# hu: A `ProjectReference` FELISMERESE -- harom XML-legalis alakra vak volt a soronkenti grep,
#     es a vaksag NEMA (a nem feloldhato ut csendben `continue`-t kapott = fail-open).
# ================================================================================================
ref_case() {  # $1 = a Proj.csproj tartalma
    make_repo_pair
    printf '%s' "$1" > "$REPO/Proj/Proj.csproj"
    git -C "$REPO" add -A
    git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm ref
}

ref_case '<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference Include="$(LibRoot)\Lib\Lib.csproj" />
  </ItemGroup>
</Project>
'
run_case "X8 MSBuild property az utban: NEM feloldhato -> ALLJ MEG (nem nema atugras)" 1 "NEM FELOLDHATO" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2"

ref_case "<Project Sdk=\"Microsoft.NET.Sdk\">
  <ItemGroup>
    <ProjectReference Include='..\\..\\repo2\\Lib\\Lib.csproj' />
  </ItemGroup>
</Project>
"
run_case "X9 EGYSZERES idezojeles Include -> a kapu LATJA" 1 "MERETLEN FUGGoSEG" \
    check TESZT-ESZKOZ --repo "$REPO"

ref_case '<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <ProjectReference
        Include="..\..\repo2\Lib\Lib.csproj" />
  </ItemGroup>
</Project>
'
run_case "X10 TOBBSOROS ProjectReference -> a kapu LATJA" 1 "MERETLEN FUGGoSEG" \
    check TESZT-ESZKOZ --repo "$REPO"

# hu: FALS POZITIV IRANY: a kikommentezett hivatkozas NEM lelet. Egy kapu, ami zajt termel,
#     par nap alatt kikerul a sorbol.
ref_case '<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <!-- <ProjectReference Include="..\..\repo2\Lib\Lib.csproj" /> -->
  </ItemGroup>
</Project>
'
run_case "X11 KIKOMMENTEZETT hivatkozas NEM lelet -> MEHET" 0 "hivatkozas feloldva" \
    check TESZT-ESZKOZ --repo "$REPO"

# ================================================================================================
# hu: A KAPU EDDIG A FAT MERTE, NEM A TELEPITENDo CSOMAGOT (az ordog 1. lelete, szerkezeti).
#     A kartya tezise szerint az APK a MUNKAFABOL fordul -- de a `check` a fa MOSTANI allapotarol
#     mond iteletet, az `adb install` viszont egy KONKRET FAJLT tolt fel, aminek az ideje
#     tetszolegesen regi. Eles fan nyolc alairt APK all, 07-27-toL 08-14-ig.
# ================================================================================================
# hu: 🛑 AZ MTIME-ALAPU OSSZEVETES KIESETT, MERT KET IRANYBAN ADOTT HAMIS ZOLDET (ordog, 3. atmeres).
#     Bajtra AZONOS APK-t `cp`-vel masolva a kapu "a mert fabol keszult"-et irt a masolatra es
#     "NEM AZ"-t az eredetire -- pedig ugyanaz a fajl. Ez PONTOSAN a szallitasi ut (FTP -> letoltes
#     -> telepites), es a kapu EGYETLEN olyan aga volt, ahol a teves meres a MEHET irANYba visz.
#     A forditott irany is all: uj forras-tartalom REGI mtime-mal (`mv`, `cp -p`, `tar -x`, `unzip`,
#     `rsync --times`, `git stash pop`) -> a kapu igazolta volna egy elavult csomagot.
#     A KOZOS GYOKER: az mtime NEM a tartalom tulajdonsaga.
#     A HELYES ALAK MERVE VAN: az `aapt2 dump badging` a `versionCode`-ot A CSOMAG MANIFESTJEBoL
#     olvassa -- masolas, letoltes, `touch` nem irja at. Mert pelda: a fan levo APK 771, a
#     `BuildNumberV2.txt` 773 -> a csomag bizonyithatoan NEM a mai fabol keszult.
APK="$WORK/app.apk"
: > "$APK"
STUB="$WORK/aapt2-stub"

make_aapt2() {   # $1 = a visszaadott versionCode ("" = a stub hibaval lep ki)
    if [ -z "$1" ]; then
        printf '#!/bin/sh\nexit 1\n' > "$STUB"
    else
        printf '#!/bin/sh\necho "package: name=%s versionCode=%s versionName=%s"\n' \
               "'com.teszt'" "'$1'" "'1.0.0'" > "$STUB"
    fi
    chmod +x "$STUB"
}

make_repo
echo "771" > "$REPO/BuildNumberV2.txt"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm build
make_aapt2 771
run_case "V1 a csomag versionCode-ja EGYEZIK a fa build-szamaval -> MEHET" 0 "APK: a mert fabol keszult" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK"

# hu: A DISZKRIMINALO ESET AZ MTIME-ALAK ELLEN: ugyanaz a csomag, KET kulonbozo mtime-mal,
#     UGYANAZT a verdiktet kell adnia. A regi alak itt ket kulonbozot adott.
touch -t 200001010000 "$APK"
run_case "V1b ugyanaz a csomag REGI mtime-mal -> UGYANAZ a verdikt (az mtime nem szamit)" 0 "APK: a mert fabol keszult" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK"
touch -t 203001010000 "$APK"

make_aapt2 770
run_case "V2 a versionCode ELTER a fa build-szamatol -> ALLJ MEG" 1 "NEM AZ, AMIBoL EZ A CSOMAG KESZULT" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK"
touch -t 200001010000 "$APK"
run_case "V2b ugyanez UJABB mtime-mal is ALLJ MEG (az mtime nem menti meg)" 1 "NEM AZ, AMIBoL EZ A CSOMAG KESZULT" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK"

make_aapt2 771
run_case "V3 --apk NELKUL: atmegy, DE kimondja hogy nem mert" 0 "APK: NEM MERVE" \
    check TESZT-ESZKOZ --repo "$REPO"

run_case "V4 --apk nem letezo fajl -> ALLJ MEG (fail-closed)" 1 "" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$WORK/nincs-ilyen.apk"

make_aapt2 ""
run_case "V5 az aapt2 nem ad valaszt -> NEM MERHETo (fail-closed)" 1 "NEM MERHETo" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK"

# hu: Ha nincs build-szam fajl az APP-REPOBAN, a kapu NE talaljon ki egyet. Fail-closed.
make_aapt2 771
make_repo_pair
run_case "V6 nincs BuildNumberV2.txt az app-repoban -> NEM MERHETo" 1 "NEM MERHETo" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK"

echo "999" > "$WORK/sajat-build.txt"
run_case "V7 --buildfile felulirja, es az elteres ALLJ MEG-et ad" 1 "NEM AZ, AMIBoL EZ A CSOMAG KESZULT" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK" --buildfile "$WORK/sajat-build.txt"
echo "771" > "$WORK/sajat-build.txt"
run_case "V8 --buildfile egyezo ertekkel -> MEHET" 0 "APK: a mert fabol keszult" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK" --buildfile "$WORK/sajat-build.txt"

# hu: A MERo FELULIRHATO A HIVO ALTAL -- ES AZ ATALLITASNAK LATSZANIA KELL (ordog 4. atmerese).
#     Egy 97-es versionCode-u APK-ra `AAPT2=<sajat szkript>`-tel a kapu 100-at olvasott, MEHET-et adott,
#     es a kimenetben SEMMI nem jelezte, hogy nem a rendszer aapt2-je futott. Ugyanaz a hibaosztaly,
#     mint a `--branch`-nel (`CEL-AG FELULIRVA`).
make_repo
echo "771" > "$REPO/BuildNumberV2.txt"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm build
make_aapt2 771
run_case "W1 az AAPT2 felulirasa KIIRODIK" 0 "MERo FELULIRVA" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK"
echo "771" > "$WORK/sajat-build.txt"
run_case "W2 a --buildfile felulirasa KIIRODIK" 0 "BUILD-SZAM FORRASA FELULIRVA" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK" --buildfile "$WORK/sajat-build.txt"

# hu: KETToS URES: a `versionCode='([^']*)'` az URES stringet is illeszti, es ket ures string EGYENLo
#     -- a kapu "a mert fabol keszult"-et irt ures zarojelekkel, exit 0. (ordog)
make_aapt2 ""
printf '#!/bin/sh\necho "package: name=%s versionCode=%s"\n' "'com.teszt'" "''" > "$STUB"; chmod +x "$STUB"
run_case "W3 URES versionCode -> NEM MERHETo (nem 'egyezik')" 1 "NEM MERHETo" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK"
make_aapt2 771
: > "$WORK/ures-build.txt"
run_case "W4 URES build-szam fajl -> NEM MERHETo" 1 "NEM MERHETo" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK" --buildfile "$WORK/ures-build.txt"

# hu: A HATAR KIMONDASA KOTELEZo: a `versionCode` CSAK az app-repot azonositja. Merve (ordog):
#     a JokerQ `versionCode`-ja a SAJAT `BuildNumberV2.txt`-jebol ered, tehat a QuantumAE es a
#     QCassa.MHMI valtozasai -- amik BEEPULNEK -- semmilyen modon nem jelennek meg benne.
#     A `MUNKAFA: tiszta` sor emellett all, es egyutt ugy olvasodik, mintha a HAROM repo egyutt
#     lenne igazolva a csomaghoz. Ugyanaz a hitelesites-hatas, mint a regi "Hatokor:" sornal.
run_case "W5 a hatar KI VAN MONDVA (csak az app-repot azonositja)" 0 "CSAK az app-repot azonositja" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK"

# hu: TOBB mert repoban is all build-szam fajl (merve: MIND AZ OTBEN). A kapu az ELSo `--repo`-t
#     hasznalja app-repokent -- ezt KI KELL MONDANI, mert a helyes sorrend a hivon mulik.
make_repo_pair
echo "771" > "$REPO/BuildNumberV2.txt"; echo "999" > "$REPO2/BuildNumberV2.txt"
git -C "$REPO" add -A; git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm b1
git -C "$REPO2" add -A; git -C "$REPO2" -c user.email=t@t -c user.name=t commit -qm b2
# hu: Az eset NEM blokkolast mer (mindket fa tiszta, a versionCode egyezik az ELSo repoval),
#     hanem azt, hogy a kapu KIMONDJA, melyik repot vette app-repokent ES hogy volt masik jelolt.
run_case "W6 tobb repoban van build-szam -> a kapu KIMONDJA, melyiket hasznalta" 0 "FIGYELEM: 1 mert repoban" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK"

# hu: 🛑 AZ `APK-HATAR` SZOVEG NEM ALLITHAT BEEGETETT SZAMOT (ordog 5. atmerese) -- ez a SAJAT
#     szabalyunk a sajat kimenetunkon. A kapu egy MERESRE hivatkozott ("a QuantumAE 16 commitja"),
#     aminek a targya a hivo padjan NINCS IS JELEN, es minden futasnal kiirodott. A szam a merese
#     pillanataban igaz volt, de a szoveg TULEL -- ez az ELAVULO alak, a masodik a harombol.
#     A helyes: MERJE MEG FUTASKOR, hany commit tortent a tobbi mert repoban az app-repo
#     build-szamanak UTOLSO valtozasa ota. Ez PONT a kockazat merteket adja, es ha 0, a kapu
#     kimondhatja, hogy MA nincs ablak.
make_repo_pair
echo "771" > "$REPO/BuildNumberV2.txt"; git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm build
make_aapt2 771
run_case "H1 az APK-HATAR MERT szamot ad (nem beegetettet)" 0 "commit a build-szam utolso valtozasa ota" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK"

# hu: 🛑 A SZAM MERT, DE A BELoLE VONT KOVETKEZTETES NEM LEHET EROSEBB A MERESNEL (ordog 6. atmerese).
#     A kapu azt allitotta, hogy a valtozas "NEM latszik ... pedig BEEPUL az APK-ba" -- holott a kapu
#     NEM tudhatja, benne van-e: az APK keszitesi idejet SZANDEKOSAN elejtettuk (az mtime-lyuk miatt).
#     Bukas-eloallitas: build-szam 10:00, fuggoseg-commit 10:30, APK 11:00 -> a commit BENNE VAN.
#     Az irany konzervativ (tulbecsul, NEM hamis zold), de a kapu igy olyat allit, amit nem mert --
#     es a zaj a kapu MEGKERULESEHEZ vezet.
run_case "H1b a kovetkeztetes NEM erosebb a meresnel" 0 "NEM igazolja, hogy ezek benne vannak-e" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK"

# hu: NEGATIV ELLENoRZES -- a tulallito mondat NEM lehet a kimenetben.
out_h1c=$(DEVICE_REGISTRY="$REG" AAPT2="$STUB" "$GATE" check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK" 2>&1)
if printf '%s' "$out_h1c" | grep -qF "pedig BEEPUL az APK-ba"; then
    FAIL=$((FAIL+1)); FAILED_NAMES+=("H1c"); printf '  BUKIK %-56s tulallito mondat a kimenetben\n' "H1c nincs 'pedig BEEPUL' allitas"
else
    PASS=$((PASS+1)); printf '  ok    %-56s (negativ ellenorzes)\n' "H1c nincs 'pedig BEEPUL' allitas"
fi

# hu: REPON KIVULI `--buildfile` -> a futaskori meres nem fut. A kapu SAJAT elve szerint (MERo
#     FELULIRVA, CEL-AG FELULIRVA) ezt is KI KELL MONDANI -- kulonben a hianyzo szam ugy olvasodik,
#     mintha nem lenne mit merni.
echo "771" > "$WORK/kulso-build.txt"
run_case "H6 repon KIVULI --buildfile -> a kapu kimondja, hogy a meres NEM FUT" 0 "a futaskori meres NEM FUT" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK" --buildfile "$WORK/kulso-build.txt"
# hu: NEGATIV ELLENoRZES -- amit a kimenetnek NEM szabad tartalmaznia. A `run_case` a JELENLETET
#     meri, ezert ez kulon sor.
out_h2=$(DEVICE_REGISTRY="$REG" AAPT2="$STUB" "$GATE" check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK" 2>&1)
if printf '%s' "$out_h2" | grep -qF "16 commitja"; then
    FAIL=$((FAIL+1)); FAILED_NAMES+=("H2"); printf '  BUKIK %-56s beegetett szam a kimenetben\n' "H2 nincs beegetett '16 commitja' szoveg"
else
    PASS=$((PASS+1)); printf '  ok    %-56s (negativ ellenorzes)\n' "H2 nincs beegetett '16 commitja' szoveg"
fi

# hu: A `--buildfile` agon a FIGYELEM-sor ELVESZETT -- pont akkor nema, amikor a hivo KEZZEL
#     valasztott, tehat ott a legnagyobb a tevedes eselye.
echo "999" > "$REPO2/BuildNumberV2.txt"; git -C "$REPO2" add -A
git -C "$REPO2" -c user.email=t@t -c user.name=t commit -qm b2
echo "771" > "$WORK/kezi-build.txt"
run_case "H3 --buildfile mellett is KIIRODIK a FIGYELEM (tobb jelolt)" 0 "FIGYELEM" \
    check TESZT-ESZKOZ --repo "$REPO" --repo "$REPO2" --apk "$APK" --buildfile "$WORK/kezi-build.txt"

# hu: A `not want` / `not got` az URESET fogja, a SZEMETET nem. Eles alak: egy `--buildfile`, ami
#     veletlenul egy README-re vagy merge-konfliktusos fajlra mutat.
printf 'nem-szam\n' > "$WORK/szemet-build.txt"
make_aapt2 771
run_case "H4 NEM SZAM build-szam -> NEM MERHETo (nem 'egyezik')" 1 "NEM MERHETo" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK" --buildfile "$WORK/szemet-build.txt"
printf '#!/bin/sh\necho "package: versionCode=%s"\n' "'nem-szam'" > "$STUB"; chmod +x "$STUB"
echo "771" > "$WORK/kezi-build.txt"
run_case "H5 NEM SZAM versionCode -> NEM MERHETo" 1 "NEM MERHETo" \
    check TESZT-ESZKOZ --repo "$REPO" --apk "$APK" --buildfile "$WORK/kezi-build.txt"
make_aapt2 771

# ================================================================================================
# hu: A `ProjectReference` ALLHAT `Directory.Build.props`-BAN ES `.targets`-BEN IS -- a `.csproj`-ra
#     szukitett bejaras ott VAK (ordog 4. lelete). Ma nem tuzel (19 props/targets a QCassa.com fan,
#     egyikben sincs ilyen), de a jelzes a DARABSZAM -- es az csak akkor ved, ha a NEM NEZETT
#     fajlokat is szamolja.
# ================================================================================================
# hu: 🛑 A FIXTURE-BEN NEM LEHET MAS KULSo HIVATKOZAS, KULONBEN A TESZT ROSSZ OKBOL MEGY AT.
#     Az elso valtozat `make_repo_pair`-t hasznalt, aminek a `Proj.csproj`-ja MAR tartalmaz egy
#     kifele mutato hivatkozast -- igy a `.csproj`-ra szukitett (MUTALT) bejaras is megtalalta,
#     es a teszt zold maradt. A mutacios igazolas (N4) fogta meg: a hash valtozott, a keszlet
#     megis zold -- vagyis a teszt NEM azt merte, amire irtam.
make_repo
mkdir -p "$WORK/kulso"
printf '<Project Sdk="Microsoft.NET.Sdk"></Project>\n' > "$WORK/kulso/Kulso.csproj"
printf '<Project>\n  <ItemGroup>\n    <ProjectReference Include="..\\kulso\\Kulso.csproj" />\n  </ItemGroup>\n</Project>\n' > "$REPO/Directory.Build.props"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm props
run_case "P6 CSAK Directory.Build.props-ban allo hivatkozas -> a kapu LATJA" 1 "MERETLEN FUGGoSEG" \
    check TESZT-ESZKOZ --repo "$REPO"

echo
echo "osszesen: $((PASS + FAIL)) eset, PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -gt 0 ]; then
    printf 'bukott esetek: %s\n' "${FAILED_NAMES[*]}"
    exit 1
fi
exit 0
