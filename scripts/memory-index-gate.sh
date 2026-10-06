#!/bin/bash
# MEMORY.md index-meret preCheck gate (ba717314 kartya, (a) pont).
#
# A PROBLEMA, AMIT MER:
# A kozos memoria-index (`projects` symlink -> MINDEN agens ugyanazt olvassa) a
# betoltesi limit folott CSENDBEN CSONKUL. A hook figyelmeztetese CSAK IRASKOR
# jelenik meg; aki csak OLVASSA az indexet, annak a csonkolas NEMA -- napokig
# dolgozhat hianyos memoriaval anelkul, hogy barmi jelezne.
# Mert kar: 2026-08-27-en ot kulon eset egy napon, kozottuk egy tanulsag, amit
# HARMADSZOR irtunk le, mert a bejegyzes a lathatatlan reszben allt.
#
# EZERT a kuszob SZANDEKOSAN a limit ALATT van, tartalekkal:
#   HARD  = 24400 B  -- e folott a vege MAR NEM toltodik be (nema adatvesztes)
#   WARN  = 20000 B  -- itt ebresztunk, hogy legyen ido vagni ELOTTE
#   CEL   = 17100 B  -- a hook sajat celertek, nem limit
#
# A MASODIK MERES: EGY FORRO SOR HOSSZA (LINEWARN = 800 B).
# A meret-kuszob csak akkor szol, amikor MAR vagni kell. Egy nap alatt negyszer
# lepte at a WARN-t, mindannyiszor korrekt vagas utan -- tehat nem a vagas
# minosege a baj, hanem hogy a forro sorok TULNONEK, es par ora alatt visszahizik
# a lap. Ez a meres a KIUGRO sort mutatja meg, amig meg olcso rovidteni.
#
# MIERT A HOSSZ, ES NEM A TARTALOM: a "tartalmaz-e mert reszletet" osztalyozast
# kimertek 24 pillanatkepen (1630 sor): 115 teves riasztas (7,1%), szinte mind
# HUB-MUTATO, aminek a horgony-mondataban ott a kulcsszam -- vagyis EPP A JO
# sorok. A szigoritott valtozat 1630 sorbol 1-et talalt, azt is tevesen. Az az ut
# LEZARVA; nyelvi osztalyozas itt nincs.
#
# MIERT 800: a forro sorok eloszlasa (n=313) p50=373, p75=530, p90=669, p95=896,
# p99=1773, atlag=434, max=5104. A 800 tehat a felso 5-6%, definicio szerint a
# KIUGRO, nem a szokas. A 600 minden hetedik sorra szolna (ki fogjak kapcsolni),
# a 2000 pedig a mert 1773-as sort mar atengedne.
# A mintaban ugyanaz a bullet tobb pillanatkepben is szerepel, tehat a hosszu,
# sokaig allo sorok tulsulyozottak -- ez a 800-at INKABB ovatossa teszi.
#
# A HARMADIK MERES: A LOGO HIVATKOZAS (2026-09-18).
# A meret-kuszob a lap VEGET vedi, mert a limit folott a vege csonkul. Ugyanez a
# nema hibaosztaly masik alakja: a sor ott all az indexben, de a CEL-fajl nincs a
# lemezen. A tudas nincs mogotte, es semmi nem jelzi -- evekig igy allhat.
# ELO ESET: az index 90. sora egy sosem letezett lapra mutatott; egy ember
# visszameresebol derult ki, nem meroből.
# A szamot a scripts/memory-index-linkcheck.py adja (index + a hubok, amikre az
# index mutat). Miert kulon fajl: a jelolt-szures (proza, kod-blokk, link-szoveg)
# az, amitol ez a mero nem hazudik, es azt kulon kell tudni tesztelni.
#
# Protokoll (schedule-runner preCheck):
#   stdout "SKIP" -> a runner NEM ebreszti az LLM-et (a meret rendben)
#   stdout ures   -> ebresztes (vagni kell, vagy a gate maga romlott el)
#
# FAIL-OPEN: ha nem tudjuk MEGMERNI, nem allithatjuk, hogy rendben van -> ebresztunk.
# De a state-fajlba beirjuk az OKOT, hogy az ebresztes ne legyen nema.
set +e
# A telepites gyokere a SAJAT helyebol, nem beirva. Ket okbol: egy beirt ut
# NEMAN rossz lenne egy masik telepitesen (a kapu az ures/nem letezo indexre
# fail-open ebreszt, tehat minden futasnal zajt adna, nem hibat), es a kovetett fan
# ez a konvencio -- merve: nulla fajl tartalmaz abszolut home utat.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
# A projekt-slug ugyanugy szarmaztatva, ahogy a memory-link-audit.py teszi: a
# config-fa a gyoker utjabol kepzi a nevet, "/" es "." helyere "-"-t irva.
SLUG="$(printf '%s' "$DIR" | tr '/.' '--')"
# Az utvonal felulirhato, hogy a kapu MERHETO legyen elo index erintese nelkul
# (a bizonyitas backup-pillanatkepeken fut, nem a mukodo lapon).
IDX="${MEMORY_INDEX_PATH:-$DIR/.channels-config/projects/$SLUG/memory/MEMORY.md}"
STATE="${MEMORY_INDEX_STATE:-$DIR/store/memory-index-state.json}"
# Ugyanugy felulirhato, mint az index utja: a fail-open ag CSAK igy merheto
# (egy szandekosan elszallo ellenorzore mutatva).
LINKCHECK="${MEMORY_LINKCHECK_BIN:-$DIR/scripts/memory-index-linkcheck.py}"
HARD=24400
WARN=20000
LINEWARN=800
# A forro szekcio hatara. ALAKI feltetelezes: mind a 24 vizsgalt pillanatkepben
# megvolt, de ha egy nap atirjak a fejlecet, a kapu NE riasszon es NE haljon el --
# olyankor a sor-meres kimarad, es ezt a state-fajl kimondja.
# MERVE, es nem ugy, ahogy a spec feltetelezte: a fejlec EGY kettoskereszttel all
# ("# Téma-hubok"), mind a 24 pillanatkepben. A ketkettoskeresztes minta NULLA
# talalatot ad -- azzal a kapu az EGESZ lapot forronak latna, es a hatar nema
# modon nem letezne. Ezert 1-2 kettoskereszt engedve.
HOTEND='^#{1,2} Téma-hubok'

if [ "$1" = "--selftest" ]; then
  echo "index: $IDX"
  [ -f "$IDX" ] && echo "letezik: igen, $(wc -c < "$IDX" | tr -d ' ') B" || echo "letezik: NEM -- a gate mindig ebreszteni fogna"
  echo "kuszobok: WARN=$WARN HARD=$HARD LINEWARN=$LINEWARN"
  echo "link-ellenorzo: $LINKCHECK"
  if [ -f "$IDX" ] && [ -f "$LINKCHECK" ] && command -v python3 >/dev/null 2>&1; then
    echo "link-meres: $(python3 "$LINKCHECK" "$IDX" 2>&1)"
  else
    echo "link-meres: NEM futtathato (hianyzik az index, a szkript vagy a python3) -- a gate ebreszteni fog"
  fi
  echo "state: $STATE"
  cat "$STATE" 2>/dev/null
  exit 0
fi

# FAIL-OPEN AGAK: a state-et hibauzenetre cserelik, tehat a futo maximum (es vele
# a `since`) ELVESZIK. Ez szandekos: nem tudunk merni, tehat nem allithatunk
# semmit a csucsrol sem. A kovetkezo sikeres futas ujraindul, es a `since` KI IS
# MONDJA, hogy mikortol szamol -- enelkul a restart nema lenne.
if [ ! -f "$IDX" ]; then
  printf '{"measured_at":%s,"error":"index nem talalhato","path":"%s"}\n' "$(date +%s)" "$IDX" > "$STATE" 2>/dev/null
  exit 0   # WAKE -- nem tudunk merni, tehat nem allithatjuk hogy rendben van
fi

SIZE="$(wc -c < "$IDX" 2>/dev/null | tr -d ' ')"
case "$SIZE" in ''|*[!0-9]*)
  printf '{"measured_at":%s,"error":"a meres nem adott szamot"}\n' "$(date +%s)" > "$STATE" 2>/dev/null
  exit 0 ;;   # WAKE
esac

# A csucsertek megorzese: enelkul egy kozben megtortent vagas eltakarna, hogy a
# meret atlepte-e a hatart.
#
# HATOKOR -- ITT ALLT KORABBAN "a nap folyaman", ES AZ TEVES VOLT: ebben a
# scriptben NINCS napi reset (nincs `date +%F` osszevetes, nincs `rm`, es a
# state-fajlra rajta kivul senki nem ir). A `max_seen` tehat a STATE-FAJL
# ELETTARTAMANAK maximuma. 2026-08-29: a "napi" megfogalmazas miatt egy elozo
# esti csucs aznapikent lett bejelentve, es helyesbiteni kellett -- a szam nem
# hazudott, csak nem arra valaszolt, amit kerdeztek tole.
#
# EZERT harom mezo all itt egy helyett, mert egy futo aggregatum ennyi nelkul
# megvalaszolhatatlan:
#   max_seen     -- az ERTEK
#   max_seen_at  -- MIKOR allt elo a csucs. NEM azonos a `measured_at`-tel: az a
#                   LEGUTOBBI meres ideje, es epp a ketto kozelsege sugallta az
#                   osszetartozast, ami a teves bejelenteshez vezetett.
#   since        -- MIKORTOL szamol a maximum (a nullpont). Kell, mert a futo
#                   maximum a state-fajlbol jon: ha az hianyzik vagy a fail-open
#                   ag felulirta, a szamolas NULLAROL indul ujra, es enelkul ez
#                   a restart lathatatlan (merve: egy 43 085 B-os regi pillanatkep
#                   BOVEN a 24 408-as "maximum" folott allt).
# --- JSON-olvasas jq NELKUL IS (MEMIDXJQ924) ------------------------------
# A `jq` nem minden telepitesen van fent -- a Debian-alapu kepek jellemzoen nem
# hozzak, es ezen a gepen sincs. Puszta `2>/dev/null` mogott ez a fajl CSENDBEN
# ures erteket kapott volna minden mezore: a futo maximum nullarol indul, az
# oroklott idok elvesznek, a link-meres pedig "nem adott szamot" agra esik.
# Az utobbi meg fail-safe (ebreszt), az elso ketto viszont NEM: egy elveszett
# `max_seen` ugyanaz a nema adatvesztes, ami ellen ez a kapu keszult.
# python3 mar ma is kotelezo fuggoseg (a hookok arra epulnek), tehat mindig van
# tartalek olvaso. Ugyanaz a minta, ami a scripts/channels.sh-ban all a
# settings.json model-mezojere, es ugyanabbol az okbol.
#
# _json_get <mezo> <alapertelmezes> [json]   -- a JSON-t a STDIN-en varja.
# Az alapertelmezes a jq `//` szemantikajat koveti: akkor lep eletbe, ha a mezo
# hianyzik, `null` vagy `false`. Az ures sztring NEM ilyen, azt a jq is
# atengedi -- a fallback is.
_json_get() {
  if command -v jq >/dev/null 2>&1; then
    if [ "${3:-}" = json ]; then jq -c ".${1} // ${2}" 2>/dev/null
    else jq -r ".${1} // ${2}" 2>/dev/null; fi
    return 0
  fi
  _JF="$1" _JD="$2" _JM="${3:-}" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
v = d.get(os.environ["_JF"])
if v is None or v is False:          # a jq `//` pontosan ezekre lep
    d_ = os.environ["_JD"]
    print("" if d_ == "empty" else d_)
elif isinstance(v, (dict, list)):    # `-c` es `-r` is JSON-t ad tomb/objektumra
    print(json.dumps(v, separators=(",", ":"), ensure_ascii=False))
elif v is True:
    print("true")
else:
    print(v)
' 2>/dev/null
}

PREVMAX="$(_json_get max_seen 0 < "$STATE")"
case "$PREVMAX" in ''|null|*[!0-9]*) PREVMAX=0 ;; esac
# Az orokolt idok. Ha van oroklott csucs, de ido nem allt mellette (a mezok
# bevezetese ELOTT irt state), akkor az ido ISMERETLEN -- es ismeretlent nem
# talalunk ki: `null` megy be, nem a mostani ora. Egy kitalalt idobelyeg
# ugyanazt a tevedest adna vissza, csak datummal megtamogatva, ami rosszabb.
PREVMAXAT="$(_json_get max_seen_at empty < "$STATE")"
case "$PREVMAXAT" in ''|null|*[!0-9]*) PREVMAXAT=null ;; esac
PREVSINCE="$(_json_get since empty < "$STATE")"
case "$PREVSINCE" in ''|null|*[!0-9]*) PREVSINCE=null ;; esac
NOW="$(date +%s)"
if [ "$PREVMAX" = 0 ]; then
  # Nincs oroklott csucs (nincs state, vagy a fail-open ag irta felul): a futo
  # maximum ITT ES MOST indul, tehat mindket ido ISMERT.
  MAX=$SIZE; MAXAT=$NOW; SINCE=$NOW
elif [ "$SIZE" -gt "$PREVMAX" ]; then
  # UJ CSUCS: csak ilyenkor mozdul a `max_seen_at`. A nullpont valtozatlan --
  # a maximum ugyanabban a sorozatban nott, nem ujraindult.
  MAX=$SIZE; MAXAT=$NOW; SINCE=$PREVSINCE
else
  # A csucs all: az IDEJE is all. Ez a lenyeg -- igy latszik, hogy REGI.
  MAX=$PREVMAX; MAXAT=$PREVMAXAT; SINCE=$PREVSINCE
fi
OVERHARD=false; [ "$SIZE" -gt "$HARD" ] && OVERHARD=true

# A forro szekcio sorai. LC_ALL=C, mert BAJTOT merunk: az ekezetes szoveg
# karakterben rovidebb, mint amennyi helyet a betoltesi limitbol elvesz.
HOTSTATS="$(LC_ALL=C awk -v lim="$LINEWARN" -v hotend="$HOTEND" '
  BEGIN { hot = 1; seen = 0; n = 0; over = 0; longest = 0 }
  $0 ~ hotend { if (hot) { hot = 0; seen = 1 } }
  hot && length($0) > 0 {
    n++
    if (length($0) > longest) longest = length($0)
    if (length($0) > lim) over++
  }
  END { printf "%d %d %d %d", seen, n, over, longest }
' "$IDX" 2>/dev/null)"

# FAIL-SOFT a sor-meresre: ha nem adott szamnegyest, a MERET-iteletet nem
# ronthatja el -- de a state kimondja, hogy ez a fele nem futott le.
LINENOTE='"hot_scan":"ok"'
OVERLINES=0
case "$HOTSTATS" in
  [01]' '[0-9]*' '[0-9]*' '[0-9]*)
    set -- $HOTSTATS
    HOTSEEN=$1; HOTLINES=$2; OVERLINES=$3; LONGEST=$4
    if [ "$HOTSEEN" = "0" ]; then
      # Nincs "Tema-hubok" fejlec: a hatar ismeretlen, tehat NEM allitunk semmit
      # a forro sorokrol. Ez nem hiba es nem riasztas.
      OVERLINES=0
      LINENOTE='"hot_scan":"nincs hatar-fejlec, a sor-meres kimaradt"'
    else
      LINENOTE="$(printf '"hot_scan":"ok","hot_lines":%s,"long_lines":%s,"longest_line":%s,"line_warn":%s' \
        "$HOTLINES" "$OVERLINES" "$LONGEST" "$LINEWARN")"
    fi ;;
  *)
    OVERLINES=0
    LINENOTE='"hot_scan":"a sor-meres nem adott szamot"' ;;
esac

# A logo hivatkozasok. JELOLTET kerunk es a lemezen nezetjuk meg (a szures a
# szkriptben all) -- egy nem letezo hibaval eloallni ugyanaz a kar, mint egy
# letezot elhallgatni.
# FAIL-OPEN, ahogy a meret-agakon: ha nem tudjuk MEGMERNI, nem allithatjuk, hogy
# rendben van. Az ok a state-fajlba megy, hogy az ebresztes ne legyen nema.
MISSINGLINKS=0
LINKWAKE=0
LINKNOTE='"link_scan":"ok"'
LINKERR=""
if [ ! -f "$LINKCHECK" ]; then
  LINKERR="a link-ellenorzo nem talalhato"
elif ! command -v python3 >/dev/null 2>&1; then
  LINKERR="nincs python3, a link-meres nem futott le"
else
  LCOUT="$(python3 "$LINKCHECK" "$IDX" 2>/dev/null)"
  LCRC=$?
  # `missing` az EGYEDI hianyzo cel (egy lyuk = egy sor), az elofordulas csak
  # kontextus mellette: egy negy helyrol hivatkozott hianyzo lap EGY lyuk, es
  # negykent jelentve tobb bajnak latszana, mint amennyi. (Merve 2026-09-18:
  # ugyanazon a lapon 43 elofordulas / 27 egyedi cel -- mindketto helyes szam,
  # de mas kerdesre valaszol.)
  LCMISS="$(printf '%s' "$LCOUT" | _json_get missing empty)"
  LCMISSOCC="$(printf '%s' "$LCOUT" | _json_get missing_occurrences 0)"
  LCUNIQ="$(printf '%s' "$LCOUT" | _json_get unique_targets 0)"
  LCCHECKED="$(printf '%s' "$LCOUT" | _json_get links_checked empty)"
  LCFILES="$(printf '%s' "$LCOUT" | _json_get files_scanned empty)"
  LCLIST="$(printf '%s' "$LCOUT" | _json_get missing_list '[]' json)"
  if [ "$LCRC" != 0 ]; then
    LINKERR="$(printf '%s' "$LCOUT" | _json_get error empty)"
    [ -n "$LINKERR" ] || LINKERR="a link-ellenorzo hibaval allt le (rc=$LCRC)"
  else
    # Ures-ellenorzes ELOSZOR: hianyzo mezo es nem-szam ugyanaz a hiba, de a
    # `''*` minta MINDENRE illeszkedne, tehat a ketto kulon all.
    if [ -z "$LCMISS" ] || [ -z "$LCCHECKED" ] || [ -z "$LCFILES" ]; then
      LINKERR="a link-meres nem adott szamot"
    else
      case "$LCMISS$LCCHECKED$LCFILES" in
        *[!0-9]*) LINKERR="a link-meres nem adott szamot" ;;
        *) MISSINGLINKS="$LCMISS" ;;
      esac
    fi
  fi
fi
if [ -n "$LINKERR" ]; then
  LINKWAKE=1
  # A state-fajl JSON: az ok idezojel es soremeles nelkul megy bele.
  LINKERR="$(printf '%s' "$LINKERR" | tr -d '"\\' | tr '\n' ' ')"
  LINKNOTE="$(printf '"link_scan":"%s"' "$LINKERR")"
else
  [ -n "$LCLIST" ] || LCLIST='[]'
  case "$LCMISSOCC$LCUNIQ" in *[!0-9]*) LCMISSOCC=0; LCUNIQ=0 ;; esac
  LINKNOTE="$(printf '"link_scan":"ok","link_files":%s,"links_checked":%s,"unique_targets":%s,"missing_links":%s,"missing_occurrences":%s,"missing_list":%s' \
    "$LCFILES" "$LCCHECKED" "$LCUNIQ" "$LCMISS" "$LCMISSOCC" "$LCLIST")"
fi

printf '{"measured_at":%s,"size":%s,"max_seen":%s,"max_seen_at":%s,"since":%s,"warn":%s,"hard":%s,"over_hard":%s,%s,%s}\n' \
  "$NOW" "$SIZE" "$MAX" "$MAXAT" "$SINCE" "$WARN" "$HARD" "$OVERHARD" "$LINENOTE" "$LINKNOTE" > "$STATE" 2>/dev/null

[ "$SIZE" -ge "$WARN" ] && exit 0   # WAKE -- vagni kell
# FIGYELMEZTETES, nem tiltas: a hosszu forro sor nem hiba, csak dragabb, mint
# amennyit egy nyitott szal er. Az ebresztes az egyetlen csatorna, amin szolni
# tudunk; az OKOT a state-fajl hordozza, hogy ne legyen nema.
[ "$OVERLINES" -gt 0 ] && exit 0    # WAKE -- van kiugro forro sor
# A logo hivatkozas ugyanaz a nema kar, mint a csonkolas: a sor all, a tudas
# nincs mogotte. Es ha maga a meres szallt el, az sem lehet csend.
[ "$MISSINGLINKS" -gt 0 ] 2>/dev/null && exit 0   # WAKE -- van logo hivatkozas
[ "$LINKWAKE" = 1 ] && exit 0       # WAKE -- a link-meres nem futott le
echo SKIP
