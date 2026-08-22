#!/usr/bin/env bash
# hu: A KARTYA-KIOSZTAS KAPU merooeszkoze. A kiosztas harom kotelezo lepese (kapu-ellenorzes,
#     mereskapu, friss ablak) MA az en emlekezetemen mul -- es a 2026-08-15-i eset megmutatta,
#     hogy az emlekezet felulirja a gazda dontesét is. Ez a teszt azt meri, hogy a szkript
#     MEGALL ott, ahol megallnia kell, es hogy a friss ablak a kartya-hataron TENYLEG elindul.
#
# en: Measuring harness for the card-dispatch gate.
#
# 🛑 IZOLACIO: a szkript ELES agat merjuk. Nincs DRY_RUN es nincs kulon teszt-agu kod --
#    a `curl` binaris cserelodik le a PATH elejen egy naplozo/valaszolo peldanyra. Amit a
#    szkript futtat, az sorrol sorra ugyanaz a kod, mint elesben.
#
# 🛑 T7 A MUTACIO-ESET: a szkript egy masolatabol KIVESSZUK a friss-ablak hivast, es elvarjuk,
#    hogy a T5 VISSZAJOJJON (bukjon). Ha a mutans is zold, a T5 vak -- nem a kapu jo.
#
# EXIT: 0 = minden eset a vart eredmenyt adta | 1 = legalabb egy eset elter

set -uo pipefail

CDir="$(cd "$(dirname "$0")" && pwd)"
CScript="$CDir/kartya-kiosztas.sh"

FTmp=$(mktemp -d "${TMPDIR:-/tmp}/kartya-kiosztas-teszt.XXXXXX")
trap 'rm -rf "$FTmp"' EXIT

FPass=0
FFail=0

# ── A hamis curl: naplozza a hivast, es a teszt-eset altal elokeszitett valaszt adja ──────────
# A valaszokat a $FTmp/valasz/<kulcs> fajlok tartalmazzak; a napló a $FTmp/hivasok.
make_mock_curl() {
  mkdir -p "$FTmp/bin" "$FTmp/valasz" "$FTmp/hibakod"
  # Az uzenet-kuldot is a PATH-on csereljuk le: a szkript a sajat konyvtarabol hivja, ezert a
  # KIOSZTAS_MSG_CMD valtozon keresztul mutatunk ra. A naplo `MSG:` sorral kulonbozteti meg.
  cat > "$FTmp/bin/agent-msg-mock.sh" <<'MSGEOF'
#!/usr/bin/env bash
echo "MSG: $*" >> "$MOCK_DIR/hivasok"
echo "OK id=9999"
MSGEOF
  chmod +x "$FTmp/bin/agent-msg-mock.sh"
  cat > "$FTmp/bin/curl" <<'MOCKEOF'
#!/usr/bin/env bash
# Naplozza a teljes hivast, majd az URL alapjan valaszol.
FLog="$MOCK_DIR/hivasok"
FMethod=GET
FUrl=""
FData=""
FPrev=""

for arg in "$@"; do
  case "$FPrev" in
    -X) FMethod="$arg" ;;
    -d) FData="$arg" ;;
  esac

  case "$arg" in
    http*) FUrl="$arg" ;;
  esac

  FPrev="$arg"
done

echo "$FMethod $FUrl $FData" >> "$FLog"

# A valasz-fajl kulcsa az URL utolso ket szegmense, / helyett _
FKey=$(echo "$FUrl" | sed 's|.*/api/||; s|[/?=&]|_|g')

if [ -f "$MOCK_DIR/valasz/$FKey" ]; then
  cat "$MOCK_DIR/valasz/$FKey"
else
  echo '{"ok":true}'
fi

# A `-w '%{http_code}'` kimenetet a valodi curl a torzs UTAN irja ki. A teszt-esetek ezzel
# allitanak elo HTTP-hibat (K2: a szkript nem nezte a valasz-kodot, es hibas restart utan is move-olt).
for arg in "$@"; do
  if [ "$arg" = "%{http_code}" ]; then
    if [ -f "$MOCK_DIR/hibakod/$FKey" ]; then cat "$MOCK_DIR/hibakod/$FKey"; else printf '200'; fi
  fi
done
MOCKEOF
  chmod +x "$FTmp/bin/curl"
}

# hu: egy teszt-eset elokeszitese -- kapuk, kartya-lista, kommentek.
# A kapukat ugyanugy szkript-masolattal helyettesitjuk (a PATH-on), nem kodagakkal.
setup_case() {
  local quota="$1"      # "fut" vagy "FAGYASZTVA"
  local plafon="$2"     # "fut" vagy "PLAFON"
  local cards_json="$3"
  local comments_json="$4"

  rm -rf "$FTmp/bin" "$FTmp/valasz" "$FTmp/hibakod" "$FTmp/hivasok"
  make_mock_curl

  cat > "$FTmp/bin/quota-gate.sh" <<EOF
#!/usr/bin/env bash
echo "$quota"
[ "$quota" = "fut" ] && exit 0 || exit 1
EOF

  cat > "$FTmp/bin/qcassa-priority-gate.sh" <<EOF
#!/usr/bin/env bash
echo "$plafon"
[ "$plafon" = "fut" ] && exit 0 || exit 1
EOF

  chmod +x "$FTmp/bin/quota-gate.sh" "$FTmp/bin/qcassa-priority-gate.sh"

  printf '%s' "$cards_json"    > "$FTmp/valasz/kanban"
  printf '%s' "$comments_json" > "$FTmp/valasz/kanban_K1_comments"

  : > "$FTmp/hivasok"
}

run_script() {
  local script="${1:-$CScript}"
  shift || true

  MOCK_DIR="$FTmp" \
  KIOSZTAS_GATE_DIR="$FTmp/bin" \
  KIOSZTAS_TOKEN="teszt-token" \
  KIOSZTAS_MSG_CMD="$FTmp/bin/agent-msg-mock.sh" \
  PATH="$FTmp/bin:$PATH" \
    bash "$script" "$@" >"$FTmp/kimenet" 2>&1
  echo $?
}

check() {
  local nev="$1"
  local vart="$2"
  local kapott="$3"

  if [ "$vart" = "$kapott" ]; then
    echo "  ✅ $nev"
    FPass=$((FPass + 1))
  else
    echo "  ❌ $nev -- vart: [$vart], kapott: [$kapott]"
    FFail=$((FFail + 1))
  fi
}

# 🛑 A `grep -c ... || echo 0` KET SORT ir ki: a grep MINDIG kiirja a szamot (0-t is), csak a
#    kilepesi kodja nem-0 talalat nelkul -- az `|| echo 0` tehat MELLE ir, nem helyette.
#    Igy minden osszevetes "0\n0"-val bukott. A helyes alak a hozzarendeles-utani fallback.
hivas_szam() {
  local n
  n=$(grep -c "$1" "$FTmp/hivasok" 2>/dev/null) || n=0
  echo "${n:-0}"
}

# ── Kartya-keszletek ──────────────────────────────────────────────────────────────────────────
# K1: mert, planned kartya (hosszu leiras). K2: a fej MASIK, in_progress kartyaja.
CCardsOk='[{"id":"K1","status":"planned","assignee":"","title":"Teszt kartya","description":"'"$(printf 'x%.0s' {1..250})"'"}]'
CCardsMeretlen='[{"id":"K1","status":"planned","assignee":"","title":"Teszt kartya","description":"rovid"}]'
CCardsFoglalt='[{"id":"K1","status":"planned","assignee":"","title":"Teszt kartya","description":"'"$(printf 'x%.0s' {1..250})"'"},{"id":"K2","status":"in_progress","assignee":"akka","title":"Mar fut"}]'
CCommentsVan='[{"id":1,"author":"kutato","content":"a meres"}]'
CCommentsNincs='[]'

echo "── T1: kvota-fagyasztas -> MEGALL, semmit nem csinal ──────────────────────────"
setup_case "FAGYASZTVA" "fut" "$CCardsOk" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka)
check "T1 kilepesi kod nem 0" "nem0" "$([ "$rc" != "0" ] && echo nem0 || echo 0)"
check "T1 nincs restart-hivas" "0" "$(hivas_szam 'restart')"
check "T1 nincs move-hivas"    "0" "$(hivas_szam 'move')"

echo "── T2: plafon -> MEGALL ───────────────────────────────────────────────────────"
setup_case "fut" "PLAFON" "$CCardsOk" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka)
check "T2 kilepesi kod nem 0" "nem0" "$([ "$rc" != "0" ] && echo nem0 || echo 0)"
check "T2 nincs move-hivas"   "0" "$(hivas_szam 'move')"

echo "── T3: a fej MAR dolgozik egy masik kartyan -> MEGALL ─────────────────────────"
setup_case "fut" "fut" "$CCardsFoglalt" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka)
check "T3 kilepesi kod nem 0" "nem0" "$([ "$rc" != "0" ] && echo nem0 || echo 0)"
check "T3 nincs restart"      "0" "$(hivas_szam 'restart')"
check "T3 nincs move"         "0" "$(hivas_szam 'move')"

echo "── T4: a kartyan NINCS meres (rovid leiras, nulla komment) -> MEGALL ──────────"
setup_case "fut" "fut" "$CCardsMeretlen" "$CCommentsNincs"
rc=$(run_script "$CScript" K1 akka)
check "T4 kilepesi kod nem 0" "nem0" "$([ "$rc" != "0" ] && echo nem0 || echo 0)"
check "T4 nincs move"         "0" "$(hivas_szam 'move')"

echo "── T5: minden rendben -> FRISS ABLAK, majd move ───────────────────────────────"
setup_case "fut" "fut" "$CCardsOk" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka)
check "T5 kilepesi kod 0"        "0" "$rc"
check "T5 VAN restart-hivas"     "1" "$(hivas_szam 'restart')"
check "T5 a restart fresh:true"  "van" "$(grep 'restart' "$FTmp/hivasok" | grep -c 'fresh' >/dev/null && echo van || echo nincs)"
check "T5 VAN move-hivas"        "1" "$(hivas_szam 'move')"
# A sorrend nem kozombos: a move dispatchel, tehat a friss ablaknak MAR allnia kell.
FRestartSor=$(grep -n 'restart' "$FTmp/hivasok" | head -1 | cut -d: -f1)
FMoveSor=$(grep -n 'move' "$FTmp/hivasok" | head -1 | cut -d: -f1)
check "T5 a restart a move ELoTT" "elotte" "$([ -n "$FRestartSor" ] && [ -n "$FMoveSor" ] && [ "$FRestartSor" -lt "$FMoveSor" ] && echo elotte || echo nem)"

echo "── T6: --folytatas -> NINCS friss ablak, de a move megy ───────────────────────"
setup_case "fut" "fut" "$CCardsOk" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka --folytatas)
check "T6 kilepesi kod 0"    "0" "$rc"
check "T6 NINCS restart"     "0" "$(hivas_szam 'restart')"
check "T6 VAN move"          "1" "$(hivas_szam 'move')"

echo "── T9 (K1): MAR DISPATCHELT kartya -> a szkriptnek MAGANAK kell kikuldenie ────"
# 🛑 AZ ORDOG ATMERESEBoL (2026-08-15, `098cf4e1`): a move CSAK ELoSZOR ebreszt fejet --
#    `kanban.ts:86  if (!card || card.dispatched_at) return`. Egy MAR egyszer kiadott kartyan
#    (eles DB-ben ma 41 ilyen all nyitva) a lanc ez volt: restart --fresh (a fej kontextusa ELVESZ)
#    -> move -> a dispatch NEMAN elmarad -> a szkript "kiosztva"-t ir. A fej ures ablakban ul,
#    feladat nelkul. *** Pontosan az a kar, aminek megelozesere a szkript keszult. ***
CCardsDispatched='[{"id":"K1","status":"waiting","assignee":"","title":"Teszt kartya","dispatched_at":1786700000,"description":"'"$(printf 'x%.0s' {1..250})"'"}]'
setup_case "fut" "fut" "$CCardsDispatched" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka)
check "T9 kilepesi kod 0"                 "0" "$rc"
check "T9 VAN restart"                    "1" "$(hivas_szam 'restart')"
check "T9 VAN move"                       "1" "$(hivas_szam 'move')"
check "T9 a szkript MAGA kuldte ki"       "1" "$(hivas_szam 'MSG:')"

echo "── T10 (K1/b): ELSo kiadas, NULLA komment -> a move dispatchel, nincs sajat kuldes ─"
# 🛑 AZ ESET PONTOSITVA a K6-javitas utan: eredetileg komment-es kartyaval futott, es a K6
#    (komment -> kulon figyelmezteto uzenet) miatt bukott. A ketto NEM ellentmondas: a K6-uzenet
#    nem a feladat MEGISMETLESE, hanem egy jelzes arrol, hogy a lenyeg a kommentekben van.
#    A T10 celja szukebb: az ELSo KIADAS agan ne menjen ki MASODIK FELADAT-uzenet -- ezt tisztan
#    nulla kommenttel lehet merni.
setup_case "fut" "fut" "$CCardsOk" "$CCommentsNincs"
rc=$(run_script "$CScript" K1 akka)
check "T10 kilepesi kod 0"                "0" "$rc"
check "T10 NINCS sajat kuldes (nem duplaz)" "0" "$(hivas_szam 'MSG:')"

echo "── T11 (K2): a restart HIBAJA utan TILOS move-olni ────────────────────────────"
# Bukas-eloallitas: nem letezo fej neve -> a restart vegpont 404-et ad. A regi szkript a valaszt
# `> /dev/null`-ba dobta es a kilepesi kodot sem nezte -> MEGIS dispatchelt, rc=0, "kiosztva".
setup_case "fut" "fut" "$CCardsOk" "$CCommentsVan"
printf '%s' '{"error":"Agent not found"}' > "$FTmp/valasz/agents_akkka_restart"
printf '%s' '404' > "$FTmp/hibakod/agents_akkka_restart"
rc=$(run_script "$CScript" K1 akkka)
check "T11 kilepesi kod nem 0" "nem0" "$([ "$rc" != "0" ] && echo nem0 || echo 0)"
check "T11 NINCS move a hibas restart utan" "0" "$(hivas_szam 'move')"

echo "── T12 (K3): a foglaltsag-kapu NE legyen betuhu ───────────────────────────────"
# A dispatch `.trim().toLowerCase()`-szel parosit (kanban-dispatch.ts:29-31). Ha a kapu betuhu,
# egy "Akka" vagy "akka " assignee-vel FUTO munkat nem vesz eszre -> restart --fresh megoli.
CCardsFoglaltNagybetu='[{"id":"K1","status":"planned","assignee":"","title":"Teszt","description":"'"$(printf 'x%.0s' {1..250})"'"},{"id":"K2","status":"in_progress","assignee":"Akka ","title":"Mar fut"}]'
setup_case "fut" "fut" "$CCardsFoglaltNagybetu" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka)
check "T12 kilepesi kod nem 0" "nem0" "$([ "$rc" != "0" ] && echo nem0 || echo 0)"
check "T12 NINCS restart (a futo munka megmarad)" "0" "$(hivas_szam 'restart')"

echo "── T16 (KRITIKUS): a cel-fej `marveen` -> MEGALL, mert a sajat sessiont olne meg ─"
# 🛑 AZ ORDOG MASODIK ATMERESEBoL (2026-08-15, `c731ef74`): a `POST /api/agents/marveen/restart`
#    NEM a sub-agens utat jarja -- `agents.ts:1806` -> `isMainChannelsAgent` -> `hardRestartMarveenChannels()`,
#    vagyis a FoAGENS SAJAT sessionjet inditja ujra, a muvelet KOZEPEN. Az assignee ekkor MAR at van
#    allitva, a move SOHA nem fut le, es a kartya fel-atallt allapotban marad.
#    NEM ELMELETI: elesben all `marveen` assignee-ju `in_progress` kartya.
setup_case "fut" "fut" "$CCardsOk" "$CCommentsVan"
rc=$(run_script "$CScript" K1 marveen)
check "T16 kilepesi kod nem 0" "nem0" "$([ "$rc" != "0" ] && echo nem0 || echo 0)"
check "T16 NINCS restart"      "0" "$(hivas_szam 'restart')"
check "T16 NINCS assignee-iras" "0" "$(hivas_szam 'PUT')"

echo "── T17 (K6 javitva): van KOMMENT -> uzenet, fuggetlenul a leiras hosszatol ────"
# Az elso alak a LEIRAS HOSSZAT merte (`<200`), nem a komment letet. Merve az eles tablan:
# 202 nyitott kartyan all >=200 karakteres leiras ES komment (808 komment osszesen) -- egyik sem
# valtott volna ki uzenetet, holott epp azokon all a legtobb meres. A K6-uzenet 5 kartyan tudott
# volna tuzelni. A feltetel tehat: VAN-E KOMMENT.
setup_case "fut" "fut" "$CCardsOk" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka)
check "T17 kilepesi kod 0"                     "0" "$rc"
check "T17 hosszu leiras + komment -> VAN uzenet" "1" "$(hivas_szam 'MSG:')"

echo "── T18: NINCS komment -> nincs felesleges uzenet ──────────────────────────────"
CCardsHosszu='[{"id":"K1","status":"planned","assignee":"","title":"Teszt","description":"'"$(printf 'x%.0s' {1..250})"'"}]'
setup_case "fut" "fut" "$CCardsHosszu" "$CCommentsNincs"
rc=$(run_script "$CScript" K1 akka)
check "T18 kilepesi kod 0"        "0" "$rc"
check "T18 NINCS uzenet"          "0" "$(hivas_szam 'MSG:')"

echo "── T19 (K2/b): a --folytatas ag SE legyen nema ────────────────────────────────"
# A move UTAN a szkript semmit nem mert vissza. A dispatch NEGY okbol maradhat el, es HAROM nem is
# allitja be a `dispatched_at`-ot -- tehat nyomot sem hagy. A `--folytatas` agon ez elesben
# "kiosztva"-t adott UZENET NELKUL. Amig a move utani visszameres nincs bekotve, ezen az agon a
# szkript MAGA kuld -- igy nincs nema eset.
setup_case "fut" "fut" "$CCardsOk" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka --folytatas)
check "T19 kilepesi kod 0"     "0" "$rc"
check "T19 NINCS restart"      "0" "$(hivas_szam 'restart')"
check "T19 VAN sajat kuldes"   "1" "$(hivas_szam 'MSG:')"

echo "── T13 (K7): a kapu 'fut'-ot ir, de rc=1 -> a kilepesi kod is szamit ──────────"
# A qcassa-priority-gate.sh sajat szerzodese (a fejlec 8-12. sora) kimondja, hogy a kilepesi kod
# JELET HORDOZ -- az elso alak viszont csak a stdout elso szavat nezte, tehat a szerzodes fele
# nem volt ervenyesitve. Ma a ket jel egyezik, kar nincs; a kapu megis atengedne egy szetcsuszast.
setup_case "fut" "fut" "$CCardsOk" "$CCommentsVan"
cat > "$FTmp/bin/qcassa-priority-gate.sh" <<'EOF'
#!/usr/bin/env bash
echo "fut"
exit 1
EOF
chmod +x "$FTmp/bin/qcassa-priority-gate.sh"
rc=$(run_script "$CScript" K1 akka)
check "T13 kilepesi kod nem 0" "nem0" "$([ "$rc" != "0" ] && echo nem0 || echo 0)"
check "T13 nincs move"         "0" "$(hivas_szam 'move')"

echo "── T14 (K8): HIANYZO kapu -> az indoklas ne 'fagyasztas' legyen ───────────────"
setup_case "fut" "fut" "$CCardsOk" "$CCommentsVan"
rm -f "$FTmp/bin/quota-gate.sh"
rc=$(run_script "$CScript" K1 akka)
check "T14 kilepesi kod nem 0" "nem0" "$([ "$rc" != "0" ] && echo nem0 || echo 0)"
check "T14 az indoklas a HIANYT mondja ki" "van" \
  "$(grep -qi 'nem letezik\|nem futtathato\|hianyzik' "$FTmp/kimenet" && echo van || echo nincs)"
check "T14 NEM allitja, hogy fagyasztas van" "nincs" \
  "$(grep -qi 'fagyaszt' "$FTmp/kimenet" && echo van || echo nincs)"

echo "── T15 (K6): komment-agon atment kartya -> a fej ertesul a kommentekrol ───────"
# A dispatch-uzenet CSAK a cimet es a leirast viszi (kanban.ts:95) -- a KOMMENTEKET nem.
# A mereskapu viszont a komment LETEZESEVEL engedi at a kartyat: a szkript sajat indoklasa
# ("a folytatashoz kello tudas a KARTYAN van") olyan csatornara epul, amit a friss ablak nem lat.
setup_case "fut" "fut" "$CCardsMeretlen" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka)
check "T15 kilepesi kod 0"                  "0" "$rc"
check "T15 a fej KULON uzenetet kap a kommentekrol" "1" "$(hivas_szam 'MSG:')"

echo "── T8: ELES MERETU kanban-lista -> nem szabad E2BIG-be futni ──────────────────"
# 🛑 EZ AZ ESET ELES BUKASBOL SZULETETT (2026-08-15, az elso hasznalatkor):
#    a szkript a teljes kanban-listat KORNYEZETI VALTOZOBAN adta at a python3-nak, es az eles
#    tabla ~400 kartyaval azonnal "Argument list too long"-ot adott. A T1-T7 mind zold volt --
#    mert mind PARBESZEDNYI listaval futott. A hatokor volt a vak folt, nem a logika.
#    ES A MEROPAD ELSo ALAKJA IS VAK VOLT: 400 kartyaval 299 kB-ot allitott elo, az ARG_MAX
#    viszont 1,05 MB, a VALOS lista pedig 1,56 MB. A T8 igy ZOLDET adott a javitatlan szkriptre.
#    Ezert a meret nem beegetett szam, hanem a rendszer sajat korlatjabol szarmazik.
FArgMax=$(getconf ARG_MAX)
FNagyLista=$(FCel=$((FArgMax * 3 / 2)) python3 -c "
import json, os
cel = int(os.environ['FCel'])
kartyak = []
meret = 2
while meret < cel:
    k = {'id': f'X{len(kartyak)}', 'status': 'done', 'assignee': 'senki',
         'title': 'toltelek' * 20, 'description': 'y' * 500}
    kartyak.append(k)
    meret += len(json.dumps(k)) + 1
kartyak.append({'id': 'K1', 'status': 'planned', 'assignee': '', 'title': 'Teszt kartya',
                'description': 'x' * 250})
print(json.dumps(kartyak))
")
check "T8 a lista tenyleg ARG_MAX FOLOTT van" "folotte" \
  "$([ "${#FNagyLista}" -gt "$FArgMax" ] && echo folotte || echo "alatta(${#FNagyLista}/$FArgMax)")"
setup_case "fut" "fut" "$FNagyLista" "$CCommentsVan"
rc=$(run_script "$CScript" K1 akka)
check "T8 kilepesi kod 0 (nincs E2BIG)" "0" "$rc"
check "T8 VAN move-hivas"               "1" "$(hivas_szam 'move')"

echo "── T7 (MUTACIO): a friss-ablak hivas kivetele -> a T5 BUKJON vissza ───────────"
CMutans="$FTmp/kartya-kiosztas-mutans.sh"
sed 's|^\([[:space:]]*\)friss_ablak |\1: friss_ablak |' "$CScript" > "$CMutans"
chmod +x "$CMutans"
if cmp -s "$CScript" "$CMutans"; then
  echo "  ❌ T7 a mutacio NEM valtoztatott a szkripten -- a minta elavult, a T7 vak"
  FFail=$((FFail + 1))
else
  setup_case "fut" "fut" "$CCardsOk" "$CCommentsVan"
  rc=$(run_script "$CMutans" K1 akka)
  check "T7 a mutansnal NINCS restart (a T5 visszajon)" "0" "$(hivas_szam 'restart')"
fi

echo
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "  ✅ $FPass  ❌ $FFail"
[ "$FFail" -eq 0 ] || exit 1
