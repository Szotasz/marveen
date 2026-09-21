#!/usr/bin/env bash
# Az update.sh ket branch-kapuja MINDKET nyelven a sajat nyelven beszeljen (UPDATEENHU921).
#
# A LELET (merve 2026-09-21, eldobhato klonon): a Guard 1 (detached HEAD) nem-shallow aga es a
# Guard 1b (csak-lokalis ag) alatti sorok EN nyelven is MAGYARUL mentek, mikozben a folottuk allo
# HIBA/ERROR fejlec helyesen valtott. A #1438 szandekosan hagyta igy: a kartya a regresszio-merest
# a VALTOZATLAN HU alakra kotte ki.
#
# EZERT EZ A TESZT KET IRANYBAN MER, es a ketto EGYUTT a bizonyitek:
#   - a HU kimenet BAJTRA ugyanaz maradt (kulonben a javitas ELRONTOTTA a magyar utat);
#   - az EN kimenetben a magyar sor MAR NINCS OTT, es az angol helyette IGEN.
# Egy iranyban merve egy "mindent angolra cserelek" valtozat is zold lenne.
#
# FIXTURA: MINIMALIS git repo (nem a mi fank, nem klon), csak update.sh + install-lang.sh.
# A ket kapu HALOZAT NELKUL elsul: detached HEAD, illetve remote nelkuli lokalis ag.
# BIZTONSAGI KAPU: mind a negy futas exit 2-t kell adjon. Ha egy kapu NEM sulne el, az update.sh
# tovabbmenne (pull, npm, szolgaltatas-ujraindias) -- ezert az exit-kod allitas nem kenyelem,
# hanem az, ami ezt a tesztet artalmatlanna teszi.
#
# Run:  bash scripts/__tests__/update-guard-nyelv.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAILS=0
DB=0

check() {  # check <nev> <feltetel-kimenet: 0=ok>
  DB=$((DB+1))
  if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1"; FAILS=$((FAILS+1)); fi
}

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/update-guard-nyelv.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

mini_repo() {  # mini_repo <ut>
  local d="$1"
  mkdir -p "$d"
  git -C "$d" init -q .
  cp "$ROOT/update.sh" "$ROOT/install-lang.sh" "$d/"
  git -C "$d" add -A
  git -C "$d" -c user.email=t@example.invalid -c user.name=teszt commit -qm init
}

# A KIMENET FAJLBA MEGY, ES A KILEPESI KOD A SZULOBEN MARAD. Elso valtozatban a futas
# parancs-behelyettesitesben allt (`ki="$(...)"; RC=$?`), es az `RC` a SUBSHELLBEN kapott
# erteket -- `set -u` mellett ez azonnal "unbound variable"-lel elszallt. Ha nem lett volna
# `set -u`, CSENDBEN ures maradt volna, es az exit-kod allitas -- a teszt biztonsagi kapuja --
# nem mert volna semmit.
KI=""   # az utolso futas kimeneti fajlja
futtat() {  # futtat <ut> <nyelv>  -> a kilepesi kod a fuggveny visszaterese, a kimenet a $KI fajlban
  local d="$1" nyelv="$2"
  if [ "$nyelv" = "en" ]; then echo en > "$d/.lang"; else rm -f "$d/.lang"; fi
  KI="$SANDBOX/ki-$(basename "$d")-$nyelv.txt"
  ( cd "$d" && timeout 60 bash update.sh ) > "$KI" 2>&1
  return $?
}

HU1="Allj at egy release branchre, majd indithatod ujra a frissitest"
EN1="Switch to a release branch, then you can start the update again"
HU2A="Csak az origin-on is meglevo (kovetett) branchrol lehet frissiteni."
HU2B="Allj at egy release branchre, pl.:"
EN2A="You can only update from a branch that also exists on origin"
EN2B="Switch to a release branch, e.g.:"

# ── Guard 1: detached HEAD, NEM shallow ─────────────────────────────────────
G1="$SANDBOX/g1"; mini_repo "$G1"; git -C "$G1" checkout -q --detach HEAD

futtat "$G1" hu; RC1=$?
check "G1/HU a kapu elsult (exit 2)" "$([ "$RC1" = 2 ] && echo 0 || echo 1)"
grep -qF "$HU1" "$KI"; check "G1/HU a magyar sor valtozatlanul ott van" $?
grep -qF "HIBA:" "$KI"; check "G1/HU a fejlec magyar" $?

futtat "$G1" en; RC2=$?
check "G1/EN a kapu elsult (exit 2)" "$([ "$RC2" = 2 ] && echo 0 || echo 1)"
grep -qF "$EN1" "$KI"; check "G1/EN az angol sor megjelent" $?
grep -qF "$HU1" "$KI"; check "G1/EN a magyar sor MAR NINCS ott" "$([ $? -ne 0 ] && echo 0 || echo 1)"
grep -qF "ERROR:" "$KI"; check "G1/EN a fejlec angol" $?

# ── Guard 1b: csak-lokalis ag (az origin-on nincs meg) ──────────────────────
G2="$SANDBOX/g2"; mini_repo "$G2"; git -C "$G2" checkout -q -b csak-lokalis-teszt-ag

futtat "$G2" hu; RC3=$?
check "G1b/HU a kapu elsult (exit 2)" "$([ "$RC3" = 2 ] && echo 0 || echo 1)"
grep -qF "$HU2A" "$KI"; check "G1b/HU az elso magyar sor valtozatlan" $?
grep -qF "$HU2B" "$KI"; check "G1b/HU a masodik magyar sor valtozatlan" $?

futtat "$G2" en; RC4=$?
check "G1b/EN a kapu elsult (exit 2)" "$([ "$RC4" = 2 ] && echo 0 || echo 1)"
grep -qF "$EN2A" "$KI"; check "G1b/EN az elso angol sor megjelent" $?
grep -qF "$EN2B" "$KI"; check "G1b/EN a masodik angol sor megjelent" $?
grep -qF "$HU2A" "$KI"; check "G1b/EN az elso magyar sor MAR NINCS ott" "$([ $? -ne 0 ] && echo 0 || echo 1)"
grep -qF "$HU2B" "$KI"; check "G1b/EN a masodik magyar sor MAR NINCS ott" "$([ $? -ne 0 ] && echo 0 || echo 1)"

# A darabszam SZAMOLT, nem begepelt: egy begepelt szam akkor is ugyanazt mondja, ha
# kozben egy allitas kiesett a futasbol.
echo
if [ "$FAILS" -gt 0 ]; then
  echo "$FAILS FAILED a $DB allitasbol" >&2
  exit 1
fi
echo "OK: $DB allitas, mind zold."
