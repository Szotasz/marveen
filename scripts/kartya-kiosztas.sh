#!/usr/bin/env bash
# hu: KARTYA-KIOSZTAS KAPU -- egyetlen belepesi pont a kanban-kartya kiadasara.
#
# Hasznalat:
#   bash scripts/kartya-kiosztas.sh <kartya-id> <fej> [--folytatas]
#
# Kimenet: "kiosztva" (rc=0) | "MEGALLT" + indoklas STDERR-en (rc!=0)
#
# 🛑 MIERT SCRIPT, NEM SZABALY-MONDAT (Jozsi, 2026-08-15):
#   A kiosztas harom kotelezo lepese -- kapu-ellenorzes, meres a kartyan, friss ablak -- eddig
#   az en emlekezetemen mult, es 2026-08-15 hajnalan bizonyitottan felulirtam vele a gazda
#   dontesét (sajat 95%-os kuszob a 100%-os plafon fole -> het ora flotta-allas). Ami csak
#   prozaban all, elavul; ez a szkript ugyanaz a lepes, csak nem lehet elfelejteni.
#
# 🛑 A FRISS ABLAK CELJA A KOLTSEG, A KIKOTESE A KARTYA:
#   Minden forduló a TELJES addigi kontextussal megy, tehat egy telitett ablakban minden
#   tool-hivas tobbszorosebe kerul. A friss ablak viszont CSAK akkor sporol, ha a folytatashoz
#   kello tudas a KARTYAN van -- kulonben a fej amneziasan indul es ujra felderiti, amit tudott.
#   Ezert a mereskapu (4. lepes) NEM kenyelmi ellenorzes, hanem a takarekossag feltetele.
#
# 🛑 A FUTO MUNKAT NEM SZAKITJUK FELBE: ha a fejnek MAR van in_progress kartyaja, a szkript
#   MEGALL. A valtas a kartya-hataron van, nem a megitelesemen.
#
# FAIL-CLOSED: minden ismeretlen, olvashatatlan vagy ertelmezhetetlen allapotra MEGALL.
#
# Onteszt (a kaput bukas-eloallitassal kell igazolni, nem feltetelezessel):
#   bash scripts/test-kartya-kiosztas.sh

set -uo pipefail

CDir="$(cd "$(dirname "$0")" && pwd)"
CGateDir="${KIOSZTAS_GATE_DIR:-$CDir}"
CApi="${KIOSZTAS_API:-http://localhost:3420}"

megall() {
  echo "MEGALLT" >&2
  echo "  $1" >&2
  exit 1
}

# ── 0. Argumentumok ───────────────────────────────────────────────────────────────────────────
[ $# -ge 2 ] || megall "hasznalat: kartya-kiosztas.sh <kartya-id> <fej> [--folytatas]"

FKartya="$1"
FFej="$2"
FFolytatas=0

shift 2
for arg in "$@"; do
  case "$arg" in
    --folytatas) FFolytatas=1 ;;
    *) megall "ismeretlen kapcsolo: $arg" ;;
  esac
done

FToken="${KIOSZTAS_TOKEN:-}"

if [ -z "$FToken" ]; then
  [ -r "$CDir/../store/.dashboard-token" ] || megall "nincs dashboard-token, es a KIOSZTAS_TOKEN sincs beallitva"
  FToken=$(cat "$CDir/../store/.dashboard-token")
fi

api_get() {
  curl -s -H "Authorization: Bearer $FToken" "$CApi$1"
}

# 🛑 AZ IRAS-HIVASOK VALASZAT ELLENoRIZNI KELL (K2, az ordog atmerese 2026-08-15).
#    Az elso alak mind a harom irast `> /dev/null`-ba dobta es a kilepesi kodot sem nezte.
#    Bukas-eloallitassal igazolt kar: nem letezo fej nevere a restart 404-et ad, a szkript
#    MEGIS dispatchelt, rc=0, kimenet "kiosztva" -- a kartya in_progress-ben allt egy nem
#    letezo fejen. A `-w '%{http_code}'` a torzs UTAN irja a kodot, azt vagjuk le.
api_ir() {
  local metodus="$1" ut="$2" torzs="$3" cimke="$4"
  local valasz kod

  valasz=$(curl -s -X "$metodus" -w '%{http_code}' \
                -H "Content-Type: application/json" -H "Authorization: Bearer $FToken" \
                -d "$torzs" "$CApi$ut")
  kod="${valasz: -3}"

  case "$kod" in
    2*) return 0 ;;
    *)  megall "$cimke: HTTP $kod -- a valasz: ${valasz%???}" ;;
  esac
}

# ── 1-2. A KET KAPU, ebben a sorrendben ───────────────────────────────────────────────────────
# Eloszor a kezi fagyasztas, utana a plafon -- ez a CLAUDE.md-ben rogzitett sorrend.
#
# 🛑 K7: A KILEPESI KOD IS JEL, NEM CSAK A STDOUT ELSo SZAVA. A `qcassa-priority-gate.sh` sajat
#    szerzodese (a fejlec 8-12. sora) kifejezetten allitja, hogy az rc jelet hordoz -- az elso
#    alak ezt eldobta. Ma a ket jel egyezik, tehat kar nincs; de egy szetcsuszas nemán atengedne.
# 🛑 K8: A HIANYZO KAPU INDOKLASA NE "fagyasztas" LEGYEN. Az elso alak a nem letezo szkriptre is
#    azt irta, hogy "kezi fagyasztas alatt semmi nem indul" -- a viselkedes helyes volt (megall),
#    az indoklas viszont HAMIS NYOMRA vitt volna.
kapu() {
  local nev="$1" utvonal="$2" varas="$3" indok="$4"
  local ki rc

  [ -f "$utvonal" ] || megall "$nev: a kapu-szkript NEM LETEZIK ($utvonal) -- meres nelkul nincs kiosztas"

  ki=$(bash "$utvonal" 2>/dev/null | head -1)
  rc=$?

  [ -n "$ki" ] || megall "$nev: a kapu URES valaszt adott ($utvonal) -- ertelmezhetetlen, tehat fail-closed"
  [ "$ki" = "$varas" ] || megall "$nev: [$ki] -- $indok"
  [ "$rc" -eq 0 ] || megall "$nev: a kimenet [$ki], de a kilepesi kod $rc -- a ket jel SZETCSUSZOTT, fail-closed"
}

kapu "kvota-kapu"   "$CGateDir/quota-gate.sh"           "fut" "kezi fagyasztas alatt semmi nem indul"
kapu "keret-plafon" "$CGateDir/qcassa-priority-gate.sh" "fut" "csak Jozsi/Zoli kozvetlen feladata mehet"

# ── 3-5. A kartya es a fej allapota EGY lekerdezesbol ─────────────────────────────────────────
# 🛑 A VALASZOK FAJLBA MENNEK, NEM KORNYEZETI VALTOZOBA. Az elso alak env-ben adta at oket a
#    python3-nak, es az ELES tabla azonnal `Argument list too long`-ot adott: a kanban-lista
#    1,56 MB, az ARG_MAX ezen a gepen 1,05 MB. A teljes ontesztem zold volt -- parbeszednyi
#    listakkal. A hatokor volt a vak folt, nem a logika.
FMunka=$(mktemp -d "${TMPDIR:-/tmp}/kartya-kiosztas.XXXXXX")
trap 'rm -rf "$FMunka"' EXIT

api_get "/api/kanban" > "$FMunka/cards.json"
[ -s "$FMunka/cards.json" ] || megall "a kanban-lista ures valaszt adott -- fail-closed"

api_get "/api/kanban/$FKartya/comments" > "$FMunka/comments.json"

FVerdikt=$(
  KI_DIR="$FMunka" KI_ID="$FKartya" KI_FEJ="$FFej" python3 - <<'PYEOF'
import json, os, sys

def ki(szo, indok=''):
    print(szo + ('|' + indok if indok else ''))
    sys.exit(0)

munka = os.environ['KI_DIR']

try:
    with open(os.path.join(munka, 'cards.json'), encoding='utf-8') as f:
        cards = json.load(f)
except Exception as e:
    ki('MEGALL', f'a kanban-valasz nem ertelmezheto: {e}')

try:
    with open(os.path.join(munka, 'comments.json'), encoding='utf-8') as f:
        comments = json.load(f)

    if not isinstance(comments, list):
        comments = []
except Exception:
    comments = []

cid, fej = os.environ['KI_ID'], os.environ['KI_FEJ']
card = next((c for c in cards if c.get('id') == cid), None)

if card is None:
    ki('MEGALL', f'nincs ilyen kartya: {cid}')

status = (card.get('status') or '').strip()

if status not in ('planned', 'waiting'):
    ki('MEGALL', f'a kartya statusza [{status}] -- csak planned/waiting oszthato ki')

# 🛑 K1 -- A DISPATCH EGYSZER-HASZNALATOS (`kanban.ts:86`: `if (!card || card.dispatched_at) return`).
#    Egy MAR egyszer kiadott kartyan a move NEMAN nem ebreszt fejet. A regi alak lanca:
#    restart --fresh (a fej kontextusa ELVESZ) -> move -> a dispatch elmarad -> "kiosztva".
#    A fej ures ablakban ult volna, feladat nelkul -- pontosan az a kar, aminek megelozesere
#    ez a szkript keszult. Az eles tablan a meres napjan 41 nyitott kartya allt beallitott
#    `dispatched_at`-tal. Ilyenkor a szkript MAGA kuldi ki a feladatot.
mar_ment = bool(card.get('dispatched_at'))

# A MERESKAPU. Nem a meres MINoSEGET meri (azt gep nem tudja), hanem a LETEZESET: vagy a
# leiras hordozza, vagy legalabb egy komment. Ures kartyara friss ablakot inditani =
# amneziat venni token helyett.
leiras = (card.get('description') or '').strip()

if len(leiras) < 200 and len(comments) == 0:
    ki('MEGALL', f'a kartyan nincs meres: a leiras {len(leiras)} karakter es nulla komment all rajta')

# 🛑 K5 -- A KAPU HATOKORE KIMONDVA: az ELES tablan a 343 nyitott kartyabol MIND A 343 atmegy
#    ezen, nulla bukik. Ez nem hiba, hanem a kapu VALODI hatokore: az URES kartya ellen ved,
#    nem a gyenge meres ellen. A meres MINoSEGET gep nem tudja megitelni -- az emberi itelet
#    marad, es ott hibazni fogok. A kuszob azert all itt, hogy a hatar LATSZODJON, ne azert,
#    hogy biztonsagerzetet adjon.

# K6: ha a kartya KIZAROLAG a komment-agon ment at, a friss ablak NEM latja a merest -- a
# dispatch-uzenet csak a cimet es a leirast viszi (`kanban.ts:95`). Ilyenkor kulon szolunk.
csak_komment = len(leiras) < 200 and len(comments) > 0

# A FOGLALTSAG-KAPU. A futo munkat nem szakitjuk felbe -- a friss ablak megolne.
# 🛑 K3: A PAROSITAS NEM LEHET BETuHu. A dispatch `.trim().toLowerCase()`-szel celoz
#    (`kanban-dispatch.ts:29-31`), tehat egy "Akka" vagy "akka " assignee-vel FUTO munkat a
#    betuhu osszehasonlitas nem vette volna eszre -- es a restart --fresh megolte volna.
#    A kapunak UGYANAZT a parositast kell hasznalnia, mint a kezbesitesnek.
def nev(x):
    return (x or '').strip().lower()

fut = [c.get('id') for c in cards
       if nev(c.get('status')) == 'in_progress' and nev(c.get('assignee')) == nev(fej)]

if fut:
    ki('MEGALL', f'a fej MAR dolgozik: {", ".join(str(x) for x in fut)} -- a valtas a kartya-hataron van')

jelek = []
if mar_ment:
    jelek.append('mar_ment')
if csak_komment:
    jelek.append(f'csak_komment:{len(comments)}')

ki('MEHET', ','.join(jelek) if jelek else 'elso')
PYEOF
)

FSzo="${FVerdikt%%|*}"
FIndok="${FVerdikt#*|}"

[ "$FSzo" = "MEHET" ] || megall "$FIndok"

# ── 6. Assignee ELoBB: a dispatch az assignee alapjan ebreszt ─────────────────────────────────
api_ir PUT "/api/kanban/$FKartya" "{\"assignee\":\"$FFej\"}" "assignee beallitasa"

# ── 7. FRISS ABLAK -- a move ELoTT, mert a move mar dispatchel is ─────────────────────────────
# A `{"fresh":true}` torzs a `--continue`-t hagyja el (src/web/routes/agents.ts), tehat a fej
# ures kontextussal all fel. A fej ONMAGAT nem tudja igy ujrainditani -- ez szandekos.
# A hiba (pl. nem letezo fej -> 404) MEGALLIT: utana move-olni annyi lenne, mint egy nem letezo
# ablakba kikuldeni a kartyat.
friss_ablak() {
  local fej="$1"

  api_ir POST "/api/agents/$fej/restart" '{"fresh":true}' "friss ablak inditasa ($fej)"
  # A tmux session felallasa nem pillanatszeru; a move utani dispatch ures promptot var.
  sleep 3
}

if [ "$FFolytatas" -eq 0 ]; then
  friss_ablak "$FFej"
fi

# ── 8. Move -> in_progress. Az ELSo kiadaskor EZ kuldi ki a kartyat (fireKanbanDispatch). ──────
api_ir POST "/api/kanban/$FKartya/move" "{\"status\":\"in_progress\",\"actor\":\"marveen\"}" "statusz-valtas"

# ── 9. AMIT A KEZBESITo NEM VISZ EL -- ket kulon eset, ugyanaz a kovetkezmeny ──────────────────
#   (K1) MAR VOLT KIADVA  -> a move NEMAN nem ebreszt, tehat a feladat egyaltalan nem megy ki;
#   (K6) CSAK KOMMENT-AGON ment at -> a dispatch a cimet es a leirast viszi, a KOMMENTEKET nem,
#        vagyis eppen az a meres marad ki, amiert a kartya atment a kapun.
case "$FIndok" in
  *mar_ment*|*csak_komment*)
    FMsg="${KIOSZTAS_MSG_CMD:-$CDir/agent-msg.sh}"
    FCim=$(KI_DIR="$FMunka" KI_ID="$FKartya" python3 -c "
import json, os
with open(os.path.join(os.environ['KI_DIR'], 'cards.json'), encoding='utf-8') as f:
    cards = json.load(f)
c = next((x for x in cards if x.get('id') == os.environ['KI_ID']), {})
print((c.get('title') or '').strip())
")
    {
      printf '[Kanban feladat #%s]: %s\n\n' "$FKartya" "$FCim"
      case "$FIndok" in
        *mar_ment*)
          printf 'A kartya MAR VOLT egyszer kiadva, ezert ezt az uzenetet a kiosztas kuldi, nem a kezbesito (a kezbesites kartyankent egyszer fut le).\n\n' ;;
      esac
      case "$FIndok" in
        *csak_komment*)
          printf '🛑 A LENYEG A KOMMENTEKBEN VAN, NEM A LEIRASBAN. A kartya leirasa rovid -- a meres, amiert ez a kartya kioszthato lett, a %s kommentben all. A kezbesito uzenet a kommenteket NEM viszi el. Olvasd el oket, mielott barmit kezdesz.\n\n' "${FIndok##*csak_komment:}" ;;
      esac
      printf 'A teljes leiras es minden komment a kartyan all.\n'
    } | bash "$FMsg" marveen "$FFej" - > /dev/null || \
      megall "a kartya statusza atallt, de a feladat KIKULDESE nem sikerult -- a fej ures ablakban ul"
    ;;
esac

echo "kiosztva"
