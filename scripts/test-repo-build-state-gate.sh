#!/usr/bin/env bash
# test-repo-build-state-gate.sh
#
# hu: Bukas-eloallito teszt a `device-registry.sh check --apk` REPO-BUILD-STATE kapujahoz.
#     A 0795cfb commit ota a JokerQ.Android build a `scripts/generate-repo-build-state.sh`-vel
#     egy `assets/repo-build-state.json`-t eget a csomagba -- harom kulccsal (jokerq/quantumae/
#     qcassamhmi), mindegyikben `hash` + `dirty`. A kapu-oldal ennek az allapotnak a FRISS-eseget
#     méri: a telepitendo APK-ban levo hash/dirty MEGEGYEZIK-E a repok MOSTANI allapotaaval.
#
#     KARTYA ELFOGADASI FELTETELE (jokerq-repo-build-state-telepitesi-kapu-20260819):
#       "bukas-eloallitassal igazolt teszt mutatja, hogy egy szandekosan elavult repo-build-state
#        .json-nal a kapu jelez, egy naprakesznel nem."
#
#     A RED fazisban ez a teszt PIROS, mert a kapu meg nem tudja a 3. szekciot (csak a "ket ismert
#     lyuk"-ig megy). A GREEN implementacio utan minden eset zold.
#
# en: Failure-producing test for the repo-build-state gate behind `device-registry.sh check --apk`.
#     RED phase: this script is expected to FAIL until the gate learns to compare the APK's
#     embedded repo-build-state.json against the repos' CURRENT state.
set -uo pipefail

GATE="${GATE_PATH:-/Users/ceo/Marveen/scripts/device-registry.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/rbsg-test.XXXXXX")"
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

# hu: Eldobhato git-repo a RepoBuildState konvencio szerint: JokerQ, QuantumAE, QCassa.MHMI.
make_repo() {
    local d="$1"
    mkdir -p "$d"
    git -C "$d" init -q
    git -C "$d" symbolic-ref HEAD refs/heads/main
    git -C "$d" config user.email "test@example.com"
    git -C "$d" config user.name "Test"
    echo "seed" > "$d/seed.txt"
    git -C "$d" add seed.txt
    git -C "$d" commit -qm init
}

# hu: a build-szam fajl, hogy a versionCode-szekcio is atmenjen (a kapu a korrabb szakaszban
#     mar keri ezt, es most az a fo szuro, nem a repo-state).
write_buildnumber() {
    local d="$1" n="$2"
    printf '%s\n' "$n" > "$d/BuildNumberV2.txt"
    git -C "$d" add BuildNumberV2.txt
    git -C "$d" commit -qm buildszam
}

# hu: A aapt2-stub: a kapu az `$AAPT2` kornyezeti valtozobol olvassa a merot (es kimondja, ha az
#     felul van irva). A versionCode == build-szam kell legyen, hogy az elozo szekcio atmenjen.
make_aapt2_stub() {
    local v="$1"
    # hu: a kapu regex-e `versionCode='([^']*)'` -- az aposztrof font, mert a `dump badging`
    #     kimenetben a mezo idezojelben all.
    cat > "$WORK/aapt2-stub" <<EOS
#!/bin/sh
echo "package: name='foo' versionCode='${v}' versionName='1.0'"
EOS
    chmod +x "$WORK/aapt2-stub"
}

# hu: A 3 repo allapotat meri, es a generate-repo-build-state.sh kimeneti formatumaban irja.
measure_state() {
    # hu: A QCassa.com konvencio szerint a mappak nevei PONTOSAN `JokerQ`, `QuantumAE`, `QCassa.MHMI` --
    #     a kapu ezt a mappingot ismeri. Azert fontos, hogy a tesztben is ez alljon, mert maskulonben
    #     a kapu `KIHAGYVA`-t ir, es a pozitiv kontroll is piros lenne.
    python3 - "$WORK/JokerQ" "$WORK/QuantumAE" "$WORK/QCassa.MHMI" "$1" <<'PY'
import json, os, subprocess, sys
def h(p): return subprocess.check_output(["git","-C",p,"rev-parse","--short=12","HEAD"],text=True).strip()
def d(p): return "true" if subprocess.check_output(["git","-C",p,"status","--porcelain"],text=True).strip() else "false"
out = {
  "jokerq":     {"hash": h(sys.argv[1]), "dirty": d(sys.argv[1])},
  "quantumae":  {"hash": h(sys.argv[2]), "dirty": d(sys.argv[2])},
  "qcassamhmi": {"hash": h(sys.argv[3]), "dirty": d(sys.argv[3])},
}
open(sys.argv[4],"w").write(json.dumps(out, indent=2))
PY
}

# hu: ZIP-et epit, mert az APK csak egy ilyen -- a kiolvasas a zipfile modullal jar.
#     Az AndroidAsset az `assets/repo-build-state.json` utvonlon van (a JokerQ.Android csproj
#     Link: `Assets\repo-build-state.json`; az Android packaging normalizalja).
build_apk() {
    local apk="$1" state_json="$2"
    rm -rf "$WORK/apk-tree"
    mkdir -p "$WORK/apk-tree/assets"
    cp "$state_json" "$WORK/apk-tree/assets/repo-build-state.json"
    (cd "$WORK/apk-tree" && zip -q "$apk" assets/repo-build-state.json)
}

run_case() {
    local name="$1" want_rc="$2" want_out="$3"; shift 3
    local out rc
    out=$(DEVICE_REGISTRY="$REG" AAPT2="$WORK/aapt2-stub" "$GATE" check "$@" 2>&1)
    rc=$?
    if echo "$out" | grep -qF -- "$want_out"; then
        if [ "$rc" = "$want_rc" ]; then
            PASS=$((PASS + 1))
            echo "  OK    $name  (rc=$rc, tartalmazza: $want_out)"
        else
            FAIL=$((FAIL + 1))
            FAILED_NAMES+=("$name")
            echo "  BUKO  $name  -- rc=$rc (vart: $want_rc), DE tartalmazza: $want_out"
            echo "         kimenet:"; echo "$out" | sed 's/^/           /'
        fi
    else
        FAIL=$((FAIL + 1))
        FAILED_NAMES+=("$name")
        echo "  BUKO  $name  -- a kimenet NEM tartalmazza: '$want_out'"
        echo "         teljes kimenet:"; echo "$out" | sed 's/^/           /'
    fi
}

# ----------------------------------------------------------------------------
# Fixture: harom ures repo + JokerQ-n build-szám.
# hu: A mappanevek a QCassa.com konvencio szerintiek -- a kapu mapping-ja erre van felveve.
# ----------------------------------------------------------------------------
JQ="$WORK/JokerQ"
QA="$WORK/QuantumAE"
MH="$WORK/QCassa.MHMI"
make_repo "$JQ"
make_repo "$QA"
make_repo "$MH"
write_buildnumber "$JQ" 100
make_aapt2_stub 100

STATE="$WORK/state-fresh.json"
APK="$WORK/app.apk"

# ----------------------------------------------------------------------------
# (P1) Naprakesz state.json + tiszta fa + egyezo HEAD-ek -> MEHET
#
# hu: A pozitiv kontroll azert fontos, mert ha a kapu egy friss allapotot is jelezne, a megoldas
#     nem hasznalhato. RED-en ez az eset mar at kell menjen (a kapu megenged, mert meg nem
#     nez semmit); GREEN-en is at kell menjen (a kapu helyesen megenged).
# ----------------------------------------------------------------------------
measure_state "$STATE"
build_apk "$APK" "$STATE"
run_case "P1 naprakesz state.json es tiszta fa -> MEHET" 0 "APK: a mert fabol keszult" \
    TESZT-ESZKOZ --repo "$JQ" --repo "$QA" --repo "$MH" --apk "$APK"

# ----------------------------------------------------------------------------
# (F1) Az APK REGI allapotot tartalmaz (a quantumae azota egy uj commitot kapott) -> ALLJ MEG
#
# hu: A RED celja: most a kapu meg csak a versionCode-ot hasonlitja a build-szamhoz, es nem
#     nez az assets/repo-build-state.json-ba. A "MEHET" lesz a dontes -- de a valosagban egy
#     elavult csomag menne at. Ez a RED kimondasa: ezen a ponton a teszt piros.
#
#     A build sorrendje: a quantumae COMMIT ELOTT megmerem az allapotot, BEIROM az APK-ba
#     (mintha egy korabbi build keszult volna), aztan CSAK UTANA csinalok egy uj commitot a
#     quantumae-n. A MOSTANI allapot (commit utan) elter az APK-ban levoitol.
# ----------------------------------------------------------------------------
STATE_OLD="$WORK/state-old.json"
measure_state "$STATE_OLD"
build_apk "$APK" "$STATE_OLD"
echo "extra" > "$QA/extra.txt"
(cd "$QA" && git add extra.txt && git commit -qm quantumae-valtozas)
run_case "F1 quantumae uj commit utan az APK regi state-et tartalmaz -> ALLJ MEG" 1 "REPO-STATE" \
    TESZT-ESZKOZ --repo "$JQ" --repo "$QA" --repo "$MH" --apk "$APK"

# ----------------------------------------------------------------------------
# (F2) PISZKOS fa a MOST -- de az APK-ban a state.json TISZTA-nak irja (stash-elt piszok)
#
# hu: Pont az elfogadasi feltetel egyik formaja: ha a build egy PISZKOS fan keszult, a state
#     `dirty=true`-t eget be. Ha kesobb a piszokot stash-eli az ember, a fa TISZTA lesz, de
#     a state tovabbra is `dirty=true`-t mutat. A MOSTANI fa tisztasaga NEM ELEG bizonyitek --
#     a state kell. Itt a FORDITOTT irany: az APK allitasa szerint tiszta, de MOST a fa piszkos
#     -- egy ujabb, piszkos fan forditott csomag is beepulhetett volna, de a state nem ezt mutatja.
# ----------------------------------------------------------------------------
echo "build-piszok" > "$JQ/szandekos-piszok.txt"
run_case "F2 piszkos JokerQ fa, de az APK allitasa szerint tiszta -> ALLJ MEG" 1 "REPO-STATE" \
    TESZT-ESZKOZ --repo "$JQ" --repo "$QA" --repo "$MH" --apk "$APK"
rm -f "$JQ/szandekos-piszok.txt"

# ----------------------------------------------------------------------------
# (F3) Az APK-bol hianyzik az asset -> ALLJ MEG (fail-closed)
#
# hu: A generator fail-closed: merhetetlen repora nincs kimenet. A kapu is fail-closed: ha
#     a state.json nincs a csomagban, a telepites NEM indulhat -- nem "nincs mit ellenorizni".
# ----------------------------------------------------------------------------
EMPTY_APK="$WORK/empty.apk"
rm -rf "$WORK/empty-tree"
mkdir -p "$WORK/empty-tree/empty"
echo "x" > "$WORK/empty-tree/empty/placeholder.txt"
(cd "$WORK/empty-tree" && zip -q "$EMPTY_APK" empty/placeholder.txt)
run_case "F3 az APK-bol hianyzik a repo-build-state.json -> ALLJ MEG (fail-closed)" 1 "REPO-STATE" \
    TESZT-ESZKOZ --repo "$JQ" --repo "$QA" --repo "$MH" --apk "$EMPTY_APK"

# ----------------------------------------------------------------------------
echo
echo "OSSZESEN: $PASS OK, $FAIL BUKO"
if [ "$FAIL" -gt 0 ]; then
    echo "BUKOTT ESETEK: ${FAILED_NAMES[*]}"
    exit 1
fi
exit 0