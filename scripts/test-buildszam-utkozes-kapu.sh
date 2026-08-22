#!/bin/bash
# hu: A BUILD-SZAM UTKOZES-KAPU merooeszkoze. Szintetikus git-repokat epit (determinisztikus,
#     halozat- es allapot-fuggetlen), es EGY valos esetet is atmer a QuantumAE tortenetén.
#
# 🛑 MIERT VAN BENNE MUTACIO-ESET: a zold keszlet onmagaban NEM mondja meg, hogy a teszt mer-e.
#    A T5 a kaput a merge-szabaly NELKULI alakjara mutalja, es elvarja, hogy az eset VISSZAJOJJON.
#    Ha a mutans is zold, a T2 vak -- nem a kapu jo.
#
# en: Measuring harness for the build-number collision gate. Builds synthetic git repos, and also
#     measures one real case from the QuantumAE history. T5 is a mutation case: it strips the
#     merge rule from a copy of the gate and requires the finding to come BACK.
#
# EXIT: 0 = minden eset a vart eredmenyt adta | 1 = legalabb egy eset elter

set -uo pipefail

CGate="$(cd "$(dirname "$0")" && pwd)/buildszam-utkozes-kapu.sh"
CRealRepo="$HOME/Source/github.com/QCassa.com/QuantumAE"

FTmp=$(mktemp -d "${TMPDIR:-/tmp}/buildszam-kapu-teszt.XXXXXX")
trap 'rm -rf "$FTmp"' EXIT

FPass=0
FFail=0

# ── Segedek ───────────────────────────────────────────────────────────────────
# 🛑 FAIL-CLOSED oR A MEROESZKOZON -- KET MERT HIBAOSZTALY MIATT KELL:
#
#   (1) `git -C ""` NEM HIBA, HANEM NO-OP: a git a JELENLEGI munkakonyvtar repojaban fut,
#       exit 0-val. Merve: `git -C "" rev-parse --show-toplevel` -> /Users/ceo/Marveen, RC=0.
#       Vagyis egy uresen maradt utvonal-valtozotol a mero a VALOS repot piszkalja, nemán.
#   (2) `set -u` + egysoros onhivatkozo `local a="$1" b="$FTmp/$a"` -> `a: unbound variable`,
#       a fuggveny AZONNAL kilep, a visszateresi ertek URES -- es ezzel eloall az (1) bemenete.
#
#   Az or ezert nem a hibat javitja, hanem a KOVETKEZMENYT zarja ki: minden git-hivas utvonala
#   KOTELEZoEN a teszt sajat ideiglenes mappaja alatt kell legyen.
gitq() {
  local dir="$1"

  if [ -z "$dir" ] || [ "${dir#$FTmp/}" = "$dir" ]; then
    echo "🛑 A MERoESZKOZ MEGALLT: git-hivas a teszt-mappan KIVUL: '[$dir]'" >&2
    echo "   (ures utvonalnal a 'git -C' a JELENLEGI repoban futna -- ez fail-closed vedelem)" >&2
    exit 2
  fi

  git -C "$dir" -c user.email=t@t -c user.name=t -c commit.gpgsign=false "${@:2}"
}

# hu: uj szintetikus repo, elso commit a megadott ertekkel.
#     A `local` KULON SOROKBAN all -- egy sorban a `$FTmp/$name` onhivatkozas `set -u` alatt dob.
#     Az ag-nevet `symbolic-ref`-fel allitjuk: a `git init -b` csak 2.28 ota letezik, itt 2.23 fut.
new_repo() {
  local name="$1"
  local val="$2"
  local dir="$FTmp/$name"

  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" symbolic-ref HEAD refs/heads/main
  echo "$val" > "$dir/BuildNumberV2.txt"
  gitq "$dir" add BuildNumberV2.txt
  gitq "$dir" commit -q -m "init (build $val)"

  git -C "$dir" rev-parse --verify HEAD >/dev/null 2>&1 || {
    echo "🛑 A MERoESZKOZ VAK: a szintetikus repo ($name) nem jott letre." >&2
    exit 2
  }

  echo "$dir"
}

bump() {   # dir ertek cim
  echo "$2" > "$1/BuildNumberV2.txt"
  gitq "$1" add BuildNumberV2.txt
  gitq "$1" commit -q -m "$3"
}

expect() { # cimke  varhato(PIROS|ZOLD)  minta  kimenet
  local label="$1" want="$2" pattern="$3" out="$4"
  local got="ZOLD"
  echo "$out" | grep -q "$pattern" && got="PIROS"

  if [ "$got" = "$want" ]; then
    echo "  ✅ $label -- $got (vart: $want)"
    FPass=$((FPass + 1))
  else
    echo "  ❌ $label -- $got, de $want lenne a helyes"
    echo "$out" | sed 's/^/       | /'
    FFail=$((FFail + 1))
  fi
}

echo "BUILD-SZAM UTKOZES-KAPU -- MERES"
echo "kapu: $CGate"
echo

# ── T1: KET TESTVER-COMMIT UGYANARRA AZ ERTEKRE -- VALODI UTKOZES ─────────────
# hu: Ugyanaz a szulo (100), ket kulonbozo kodallapot, MINDKETTo 101-re lep. Ket binaris egy
#     azonositon. Ez a QuantumAE 670..686 mintaja, es a merge-szabaly ezt NEM nemithatja el:
#     mindketto MINDEN szulojehez kepest valtozott.
#
# 🛑 A KAPU HATOKORE AZ AKTUALIS AG TORTENETE. Amig a ket testver KULON agon all es nincs
#    osszeolvasztva, a tortenet-detektor CSAK az egyiket latja -- ott a WORKTREE-detektor ved
#    (ez a ket detektor komplementaritasa). Ezert T1a ZOLD es T1b PIROS: az elso nem a kapu
#    hibaja, hanem a hatokore, es ezt ki kell mondani, nem elfedni.
echo "T1 -- ket testver-commit ugyanarra az ertekre (valodi utkozes)"
R=$(new_repo t1 100)
bump "$R" 101 "feat: A ag (build 101)"
gitq "$R" checkout -q -b oldal HEAD~1
bump "$R" 101 "fix: B ag (build 101)"
gitq "$R" checkout -q main
OUT=$(bash "$CGate" --repo "$R" --limit 50 2>&1)
expect "T1a a masik agon allo testver a tortenetbol NEM lathato" ZOLD "AZONOS ERTEK KET FAJL-VALTOZASBAN" "$OUT"
gitq "$R" checkout -q oldal
gitq "$R" merge -q --no-edit -m "merge: main -> oldal" main 2>/dev/null || {
  echo "101" > "$R/BuildNumberV2.txt"; gitq "$R" add BuildNumberV2.txt
  gitq "$R" commit -q -m "merge: main -> oldal"
}
OUT=$(bash "$CGate" --repo "$R" --limit 50 2>&1)
expect "T1b osszeolvasztas utan a duplikatum PIROS" PIROS "AZONOS ERTEK KET FAJL-VALTOZASBAN" "$OUT"

# ── T2: MERGE, AHOL A MASODIK SZULo MAR A CELERTEKET HORDOZZA -- NEM KIADAS ───
# hu: A QuantumAE `736`-os par mintaja. Az `oldal` ag 200-on all, a main 201-re lep, a merge a
#     main erteket veszi at: 201. A merge-commit a MASODIK szulojehez kepest NEM valtozott,
#     tehat NEM uj kiadas -- egyetlen valodi 201-es kiadas van.
echo
echo "T2 -- merge, a masodik szulo mar a celerteket hordozza (NEM kiadas)"
R=$(new_repo t2 200)
gitq "$R" checkout -q -b oldal
echo "oldal munka" > "$R/oldal.txt"; gitq "$R" add oldal.txt; gitq "$R" commit -q -m "feat: oldal munka"
gitq "$R" checkout -q main
bump "$R" 201 "feat: main lepteti (build 201)"
gitq "$R" checkout -q oldal
gitq "$R" merge -q --no-edit -m "merge: main (build 201) -> oldal" main
OUT=$(bash "$CGate" --repo "$R" --limit 50 2>&1)
expect "T2 merge nem duplikatum" ZOLD "AZONOS ERTEK KET FAJL-VALTOZASBAN" "$OUT"

# ── T3: KISERo-COMMIT ([deploy]) -- REGRESSZIO-oR ──────────────────────────────
echo
echo "T3 -- [deploy] kisero-commit nem leptet (regresszio-or)"
R=$(new_repo t3 300)
bump "$R" 301 "feat: valami (build 301)"
echo "doksi" > "$R/DEPLOY.md"; gitq "$R" add DEPLOY.md
echo "301" > "$R/BuildNumberV2.txt"; gitq "$R" add BuildNumberV2.txt
gitq "$R" commit -q -m "docs: telepitesi doksi [deploy]"
OUT=$(bash "$CGate" --repo "$R" --limit 50 2>&1)
expect "T3 kisero-commit" ZOLD "AZONOS ERTEK KET FAJL-VALTOZASBAN" "$OUT"

# ── T4: CSOKKENES -- a legelesebb alak ────────────────────────────────────────
echo
echo "T4 -- a szam csokkent az elso-szulo lancon"
R=$(new_repo t4 400)
bump "$R" 401 "feat: lepteti (build 401)"
bump "$R" 400 "hiba: visszalepett (build 400)"
OUT=$(bash "$CGate" --repo "$R" --limit 50 2>&1)
expect "T4 csokkenes" PIROS "A BUILD-SZAM CSOKKENT" "$OUT"

# ── T5: MUTACIO -- a merge-szabaly NELKUL a T2 esetenek VISSZA kell jonnie ────
# hu: Ez a bukas-eloallitas. A mutans kapu a merge-szabalyt nem alkalmazza; ha a T2 igy is ZOLD,
#     akkor a T2 vak -- nem a kapu erdeme volt a zold.
echo
echo "T5 -- MUTACIO: a merge-szabaly kikapcsolva, a T2 esetenek vissza kell jonnie"
FMutant="$FTmp/mutans-kapu.sh"
# hu: A mutacio a SZULo-OSSZEVETEST kapcsolja ki -- ettol minden nem-kisero commit "kiadasnak"
#     szamit, es a merge visszakerul a leletbe.
sed 's/is_release = all(.*/is_release = True/' "$CGate" > "$FMutant"
if ! grep -q 'is_release = True' "$FMutant"; then
  echo "  ❌ T5 -- a mutacio nem fogott: a kapuban nincs szulo-osszevetes"
  echo "       (a mero a hibas, nem a kapu -- a T2 zoldje IGAZOLATLAN)"
  FFail=$((FFail + 1))
else
  R2=$(new_repo t5 200)
  gitq "$R2" checkout -q -b oldal
  echo "oldal munka" > "$R2/oldal.txt"; gitq "$R2" add oldal.txt; gitq "$R2" commit -q -m "feat: oldal munka"
  gitq "$R2" checkout -q main
  bump "$R2" 201 "feat: main lepteti (build 201)"
  gitq "$R2" checkout -q oldal
  gitq "$R2" merge -q --no-edit -m "merge: main (build 201) -> oldal" main
  OUT=$(bash "$FMutant" --repo "$R2" --limit 50 2>&1)
  expect "T5 mutans visszahozza a T2-t" PIROS "AZONOS ERTEK KET FAJL-VALTOZASBAN" "$OUT"
fi

# ── T6: MIND A NEGY LELET KIIRODIK -- NINCS "gyors mod" ──────────────────────
# 🛑 MERVE, ES EZ SZuNTETTE MEG A `--quick` KAPCSOLOT: a koltseg a BEJARAS (egy `git log` + egy
#    `git cat-file --batch`), NEM a detektorok. A JokerQ-n: log 33 ms, first-parent 13 ms, batch
#    38 ms, worktree-lista 9 ms -- a negy detektor mind EBBoL AZ EGY beolvasott adathalmazbol szamol,
#    tiszta pythonban. *** Egyetlen detektor kihagyasa nulla masodpercet sporolt volna ***, cserebe
#    egy MAR KISZAMOLT sertest rejtett volna el. A cim-elteres raadasul az EGYETLEN lelet, amit
#    kizarolag COMMIT-IDoBEN lehet javitani.
echo
echo "T6 -- mind a negy lelet kiirodik (nincs gyors mod)"
R=$(new_repo t6 500)
bump "$R" 501 "feat: lepteti (build 501)"
bump "$R" 500 "hiba: visszalepett (build 500)"
echo "x" > "$R/x.txt"; gitq "$R" add x.txt; gitq "$R" commit -q -m "docs: a cim build 999-et hirdet"
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T6a a csokkenes kiirodik" PIROS "A BUILD-SZAM CSOKKENT" "$OUT"
expect "T6b a cim-elteres kiirodik" PIROS "COMMIT-CIM ELTER A FAJLTOL" "$OUT"

R=$(new_repo t6b 100)
bump "$R" 101 "feat: A ag (build 101)"
gitq "$R" checkout -q -b oldal HEAD~1
bump "$R" 101 "fix: B ag (build 101)"
gitq "$R" merge -q --no-edit -m "merge: main -> oldal" main 2>/dev/null || true
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T6c a kiadas-duplikatum kiirodik" PIROS "AZONOS ERTEK KET FAJL-VALTOZASBAN" "$OUT"

# hu: A TOROLT KAPCSOLO HANGOS. Egy regi hivas ne csendben fusson "gyors modban" (ami ma azonos
#     lenne a teljessel), hanem alljon meg hasznalati hibaval -- a nema azonossag pont az a csapda,
#     amit a kapu keres.
OUT=$(bash "$CGate" --repo "$R" --quick 2>&1)
RC=$?
if [ "$RC" -eq 2 ] && echo "$OUT" | grep -q "ismeretlen kapcsolo"; then
  echo "  ✅ T6d a torolt --quick HANGOS hibat ad (exit=2)"; FPass=$((FPass + 1))
else
  echo "  ❌ T6d a torolt --quick nem allitotta meg a kaput (exit=$RC)"; FFail=$((FFail + 1))
fi

# ── T8: NEM ERTELMEZHETo ERTEK -- A HARMADIK REPO-ALLAPOT, AMI ZOLDET ADOTT ───
# 🛑 HAROM ALLAPOT VAN, NEM KETTo, ES A HARMADIK ADTA A HAMIS ZOLDET:
#    (1) nincs fajl            -> "nem hasznal build-szamot", exit 0   -- helyes
#    (2) van, de URES          -> "A MERo VAK", exit 2                 -- helyes
#    (3) van ertek, de NEM SZAM -> eddig "Nincs lelet", exit 0         -- LELET
#    A (3) legelesebb alakja a FELOLDATLAN MERGE-KONFLIKTUS a fajlban: a kapu a konfliktus-markert
#    ERTEKNEK szamolja, a szamlalo "nem vak"-ot mutat, a szam-alapu detektorok atugorjak, es a
#    verdikt ZOLD -- *** egy „megoldom kesobb" merge atmegy azon a kapun, ami epp a merge-feloldast
#    celozza. *** Fail-closed: egy konfliktus-marker a build-szam fajlban NEM uzemi allapot, es a
#    javitasa trivialis -- a fail-closed ara itt nulla.
echo
echo "T8 -- nem ertelmezheto ertek (feloldatlan konfliktus / nem szam)"
R=$(new_repo t8 100)
bump "$R" 101 "feat: lepteti (build 101)"
printf '<<<<<<< HEAD\n102\n=======\n99\n>>>>>>> oldal\n' > "$R/BuildNumberV2.txt"
gitq "$R" add BuildNumberV2.txt
gitq "$R" commit -q -m "merge: feloldatlan konfliktus a build-szam fajlban"
OUT=$(bash "$CGate" --repo "$R" --limit 50 2>&1)
RC=$?
# hu: A minta a LELET-sorra szuk (`N ERTEK ERTELMEZHETETLEN`), NEM a puszta szora: a `MERT
#     HATOKOR` sor is tartalmazza a szot (`0 ERTELMEZHETETLEN ertek`), es a tagabb minta a
#     SZAMLALORA is illeszkedne -- akkor a teszt a nulla eseten is PIROS-t mondana.
expect "T8a a konfliktus-marker LELETKENT jelenik meg" PIROS "ERTEK ERTELMEZHETETLEN" "$OUT"
if [ "$RC" -ne 0 ]; then
  echo "  ✅ T8b a verdikt BLOKKOL (exit=$RC)"; FPass=$((FPass + 1))
else
  echo "  ❌ T8b a verdikt ATENGEDTE (exit=0) -- a nem-numerikus ertek nem blokkol"; FFail=$((FFail + 1))
fi

# hu: POZITIV KONTROLL a (3)-hoz: a TISZTA szamokra ne legyen "ertelmezhetetlen" jelzes.
R=$(new_repo t8ok 200)
bump "$R" 201 "feat: lepteti (build 201)"
OUT=$(bash "$CGate" --repo "$R" --limit 50 2>&1)
expect "T8c KONTROLL: tiszta szamokra nincs ilyen lelet" ZOLD "ERTEK ERTELMEZHETETLEN" "$OUT"

# ── T11: A MELYSEG NEM SZuKITHET -- A VISSZATERES-DETEKTORNAK HOSSZU MEMORIA KELL ─
# 🛑 A MERT ESET, AMI EZT ELDONTOTTE: a `100` REGEN all a lancban, utana 101..130, majd egy
#    OLDALAGON ujra `100`, es a merge utan az elso-szulo lanc 130 -> 131. *** NINCS csokkenes ***,
#    tehat a csokkenes-detektor NEM potolja: a visszateres-detektor az EGYETLEN, ami latja --
#    es epp az igenyli a leghosszabb memoriat. Egy sekely ablak PONT azt a detektort vakitja el.
#    Eddig minden valos eset egyben csokkenes is volt az elso-szulo lancon, ezert a sekely futas
#    "megis fogta" -- ez a fedettseg VELETLEN volt, nem szerkezeti.
echo
echo "T11 -- oldalagi visszateres csokkenes NELKUL (a melyseg nem szukithet)"
R=$(new_repo t11 100)
i=101
while [ $i -le 170 ]; do
  bump "$R" $i "feat: lepteti (build $i)"
  i=$((i + 1))
done

# hu: OLDALAG, ami UJRA kiadja a mar hasznalt 100-at, majd vissza a main-be. A merge-feloldasban a
#     main erteke marad, ezert az elso-szulo lancon NINCS csokkenes -- a visszateres-detektor az
#     egyetlen, ami latja.
gitq "$R" checkout -q -b oldal HEAD~3
bump "$R" 100 "hiba: az oldalag UJRA kiadja a 100-at (build 100)"
gitq "$R" checkout -q main
gitq "$R" merge -q --no-edit -m "merge: oldal -> main" oldal >/dev/null 2>&1
echo "170" > "$R/BuildNumberV2.txt"
gitq "$R" add BuildNumberV2.txt
gitq "$R" commit -q -m "merge: oldal -> main (a main erteke marad)" >/dev/null 2>&1
bump "$R" 171 "feat: lepteti (build 171)"

# hu: A mero sajat pozitiv kontrollja: a lanc TENYLEG hosszabb legyen, mint a vizsgalt ablakok --
#     kulonben a T11 nem azt merne, amit allit.
FLen=$(git -C "$R" rev-list --count HEAD)
if [ "$FLen" -lt 70 ]; then
  echo "  ❌ T11 -- a lanc csak $FLen commit; a melyseg-kerdes igy nem merheto"
  FFail=$((FFail + 1))
else
  echo "     (a lanc $FLen commit -- hosszabb, mint a 25-os es a 60-as ablak)"

  OUT=$(bash "$CGate" --repo "$R" --limit 500 2>&1)
  expect "T11a mely ablakkal a visszateres LATSZIK" PIROS "VISSZATERo BUILD-SZAM" "$OUT"
  expect "T11b es NINCS csokkenes (a masik detektor nem potolja)" ZOLD "A BUILD-SZAM CSOKKENT" "$OUT"

  # hu: A LENYEG: parameter nelkul ES `--quick` alatt UGYANEZ latszodjon. Barmely VEGES ablak epp
  #     azt a detektort vakitja el, amelyik a legregebbi adatra epul.
  OUT=$(bash "$CGate" --repo "$R" 2>&1)
  expect "T11c ALAPERTELMEZESSEL is latszik" PIROS "VISSZATERo BUILD-SZAM" "$OUT"
  # hu: ES A MELYSEG KIIRASA IS MONDJA KI, hogy nincs korlat -- kulonben a kovetkezo olvaso egy
  #     szamot keres a fejlecben, es a hianyabol nem tudja, teljes-e a bejaras.
  expect "T11d a fejlec kimondja a TELJES tortenetet" PIROS "commit-melyseg: TELJES tortenet" "$OUT"
fi

# ── T12: WORKTREE-UTKOZES CSAK ELTERo KODALLAPOTNAL ──────────────────────────
# 🛑 MERT HAMIS RIASZTAS, KET ELo REPOBAN: a `QCassa.MHMI` OT worktree-je mind a `b591c1aa`
#    commiton all, tiszta munkafaval, mind a 113-as szammal -- a kapu megis NEGY "utkozest" jelentett.
#    A JokerQ-ban ugyanez a `683`-as par (`deploy-828` es `headguard`, mindketto `798a04f2`).
#    *** Azonos szam + AZONOS kodallapot = ugyanaz a build, nem ket kulonbozo binaris egy azonositon. ***
#    A detektor eredeti indoka az volt, hogy egy worktree olyan szamot HORDOZ, ami mar foglalt egy
#    MASIK kodallapoton -- ezt a HEAD-ek eltérese meri, nem a szam puszta ismetlodese.
#    A JokerQ `775`-os para viszont VALODI (`enc-import-kapu` = e50c22f6 vs `factory-provisioning`
#    = 439d139d), tehat a szukites nem "elnemitas": a valos eset megmarad.
echo
echo "T12 -- worktree-utkozes csak eltero kodallapotnal"
R=$(new_repo t12 900)
echo "oldalag munka" > "$R/oldal.txt"
gitq "$R" checkout -q -b oldal
gitq "$R" add oldal.txt
gitq "$R" commit -q -m "feat: oldalag munka (a build-szam marad 900)"
gitq "$R" checkout -q main

# (a) AZONOS commit ket helyen -- NEM utkozes
gitq "$R" worktree add -q --detach "$FTmp/t12-azonos" HEAD >/dev/null 2>&1
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T12a azonos kodallapot NEM utkozes" ZOLD "WORKTREE-UTKOZES" "$OUT"

# (b) ELTERo commit, AZONOS szam -- VALODI utkozes
gitq "$R" worktree add -q "$FTmp/t12-eltero" oldal >/dev/null 2>&1
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T12b eltero kodallapot azonos szammal UTKOZES" PIROS "WORKTREE-UTKOZES" "$OUT"

# ── T14: AZONOS HEAD, DE ELTERo MUNKAFA -- A LEMEZ DONT, NEM A COMMIT ────────
# 🛑 A DETEKTOR KET OLDALANAK KONZISZTENSNEK KELL LENNIE: az ERTEKET a LEMEZRoL olvassuk
#    (`BuildNumberV2.txt` a munkafabol), tehat az AZONOSSAGOT is a lemeznek kell tukroznie -- nem
#    eleg a `HEAD` osszevetese. A kartya sajat tezise ugyanez: *** az APK a MUNKAFABOL fordul,
#    nem a HEAD-boL. *** Ket worktree azonos commiton, de eltero commitolatlan tartalommal KET
#    KULONBOZo BINARIS ugyanazzal a build-szammal.
#
# 🛑 ES A KET KEZENFEKVo MECHANIZMUS KULON-KULON MAST HAGY KI -- ezert meri ez a blokk mind a kettot:
#      `git status --porcelain`  -> a JELENLETET fogja, a TARTALMAT nem  (T14d bukna rajta)
#      `git diff HEAD`           -> a TARTALMAT fogja, az UJ fajlokat nem (T14e bukna rajta)
#      egyik sem fogja az azonos nevu UJ fajl eltero tartalmat            (T14f)
echo
echo "T14 -- azonos HEAD, eltero munkafa (a lemez dont)"
R=$(new_repo t14 900)
echo "eredeti tartalom" > "$R/kod.txt"
gitq "$R" add kod.txt
gitq "$R" commit -q -m "feat: kod (build 900)"
gitq "$R" worktree add -q --detach "$FTmp/t14-masodik" HEAD >/dev/null 2>&1
FSecond="$FTmp/t14-masodik"

# hu: A mero sajat kontrollja: a kiindulas KET TISZTA, AZONOS allapotu worktree -- ha mar itt
#     jelezne a kapu, a tobbi eset semmit nem bizonyitana.
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T14-kiindulas: ket tiszta, azonos worktree -> nincs lelet" ZOLD "WORKTREE-UTKOZES" "$OUT"

# (a) AZ ORDOG REPRODUKCIOJA: azonos HEAD, az EGYIK munkafaja piszkos
echo "MASIK tartalom" > "$FSecond/kod.txt"
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T14a azonos HEAD + az egyik PISZKOS -> utkozes" PIROS "WORKTREE-UTKOZES" "$OUT"

# (c) MINDKETTo piszkos, UGYANAZZAL a tartalommal -> azonos kodallapot, NEM utkozes
echo "MASIK tartalom" > "$R/kod.txt"
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T14c mindketto piszkos, AZONOS tartalommal -> nincs utkozes" ZOLD "WORKTREE-UTKOZES" "$OUT"

# (d) MINDKETTo piszkos, KULONBOZo tartalommal -> a puszta `status` NEM fogna (azonos fajlnev, azonos statusz)
echo "HARMADIK tartalom" > "$R/kod.txt"
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T14d mindketto piszkos, ELTERo tartalommal -> utkozes" PIROS "WORKTREE-UTKOZES" "$OUT"

# (e) UJ, nyomon nem kovetett fajl az egyikben -> a `git diff HEAD` NEM fogna
echo "MASIK tartalom" > "$R/kod.txt"
echo "uj fajl" > "$R/ujdonsag.txt"
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T14e UJ (untracked) fajl az egyikben -> utkozes" PIROS "WORKTREE-UTKOZES" "$OUT"

# (f) AZONOS NEVu uj fajl MINDKETToBEN, ELTERo tartalommal -> sem a `status`, sem a `diff` nem fogja
echo "MASIK tartalom" > "$FSecond/ujdonsag.txt"
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T14f azonos nevu UJ fajl ELTERo tartalommal -> utkozes" PIROS "WORKTREE-UTKOZES" "$OUT"

# (g) KONTROLL: az uj fajl MINDKETToBEN azonos tartalommal -> nincs utkozes
echo "uj fajl" > "$FSecond/ujdonsag.txt"
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T14g KONTROLL: azonos uj fajl azonos tartalommal -> nincs utkozes" ZOLD "WORKTREE-UTKOZES" "$OUT"

# (h) AZONOS TARTALMU, de MAS NEVu uj fajl -> a `hash-object`-lista AZONOS, a `status` ELTER.
#     Ez az EGYETLEN eset, amit a `status --porcelain` resz fog -- nelkule a kapu ZOLDET adna.
#     (Merve: a harom resz kikapcsolasa kulon-kulon a T14d / (ez) / T14f esetet buktatja.)
echo "azonos tartalom" > "$R/egyik-nev.txt"
echo "azonos tartalom" > "$FSecond/masik-nev.txt"
OUT=$(bash "$CGate" --repo "$R" 2>&1)
expect "T14h azonos tartalmu, MAS NEVu uj fajl -> utkozes" PIROS "WORKTREE-UTKOZES" "$OUT"
rm -f "$R/egyik-nev.txt" "$FSecond/masik-nev.txt"


# ── T15: MUTACIO -- a munkafa-ujjlenyomat HAROM RESZE KULON-KULON ────────────
# 🛑 EZ A BLOKK AZT IGAZOLJA, HOGY EGYIK RESZ SEM FELESLEGES. Merve: a harom resz kikapcsolasa
#    PONTOSAN EGY-EGY esetet buktat -- vagyis mindegyik olyasmit fog, amit a masik ketto nem:
#      `git diff HEAD`      -> T14d (kovetett fajl eltero TARTALMA)
#      `status --porcelain` -> T14h (azonos tartalmu, MAS NEVu uj fajl)
#      `hash-object`        -> T14f (azonos nevu uj fajl eltero TARTALMA)
#    Egy resz, amirol nem tudjuk bizonyitani, hogy mer, hamis biztonsag -- ezert kap sajat esetet.
echo
echo "T15 -- MUTACIO: a munkafa-ujjlenyomat harom resze"

mut_case() {   # <cimke> <sed-minta> <ellenorzo-minta> <eloallito-fuggveny>
  local label="$1" sedexpr="$2" guard="$3" setup="$4"
  local mutant="$FTmp/mutans-$label.sh"

  sed "$sedexpr" "$CGate" > "$mutant"

  if ! grep -q "$guard" "$mutant"; then
    echo "  ❌ T15-$label -- a mutacio nem fogott (a mero a hibas, nem a kapu)"
    FFail=$((FFail + 1))
    return
  fi

  local R2
  R2=$("$setup")
  OUT=$(bash "$mutant" --repo "$R2" 2>&1)
  expect "T15-$label a mutans ELREJTI a sajat eseteet" ZOLD "WORKTREE-UTKOZES" "$OUT"
  OUT=$(bash "$CGate" --repo "$R2" 2>&1)
  expect "T15-$label KONTROLL: az EREDETI kapu jelzi" PIROS "WORKTREE-UTKOZES" "$OUT"
}

# hu: kozos kiindulas -- ket worktree AZONOS commiton, tiszta munkafaval
setup_pair() {   # <nev> -> a repo utja (stdout)
  local name="$1" r
  r=$(new_repo "$name" 700)
  echo "eredeti" > "$r/kod.txt"
  gitq "$r" add kod.txt
  gitq "$r" commit -q -m "feat: kod (build 700)"
  gitq "$r" worktree add -q --detach "$FTmp/$name-masodik" HEAD >/dev/null 2>&1
  echo "$r"
}

setup_diff() {   # kovetett fajl eltero tartalommal MINDKET oldalon
  local r; r=$(setup_pair t15a)
  echo "egyik" > "$r/kod.txt"
  echo "masik" > "$FTmp/t15a-masodik/kod.txt"
  echo "$r"
}
setup_names() {  # azonos tartalmu, MAS NEVu uj fajl
  local r; r=$(setup_pair t15b)
  echo "azonos" > "$r/egyik-nev.txt"
  echo "azonos" > "$FTmp/t15b-masodik/masik-nev.txt"
  echo "$r"
}
setup_content() { # azonos nevu uj fajl ELTERo tartalommal
  local r; r=$(setup_pair t15c)
  echo "egyik" > "$r/ujdonsag.txt"
  echo "masik" > "$FTmp/t15c-masodik/ujdonsag.txt"
  echo "$r"
}

mut_case "diffHEAD" 's|^    git -C "$wt" diff HEAD 2>/dev/null$|    true|' '^    true$' setup_diff
mut_case "status"   's|^    git -C "$wt" status --porcelain --untracked-files=all 2>/dev/null$|    true|' '^    true$' setup_names
mut_case "hashobj"  's|\[ -f "$wt/$f" \] && git -C "$wt" hash-object -- "$f" 2>/dev/null|true|' 'then true$\|true$' setup_content

# ── T13: MUTACIO -- a HEAD-osszevetes kikapcsolva ────────────────────────────
# hu: A T12a zoldje csak akkor er valamit, ha a HEAD-osszevetes nelkul VISSZAJON a hamis riasztas.
#     A mutans a HEAD-et egy sosem egyezo ertekre hasonlitja, azaz a szam-alapu regi viselkedes all vissza.
echo
echo "T13 -- MUTACIO: a worktree HEAD-osszevetese kikapcsolva"
FMutant4="$FTmp/mutans-worktree.sh"
sed 's/!= "$head"/!= "SOHA-NEM-EGYEZo"/' "$CGate" > "$FMutant4"
if ! grep -q 'SOHA-NEM-EGYEZo' "$FMutant4"; then
  echo "  ❌ T13 -- a mutacio nem fogott: a kapuban nincs HEAD-osszevetes"
  echo "       (a mero a hibas, nem a kapu -- a T12a zoldje IGAZOLATLAN)"
  FFail=$((FFail + 1))
else
  R=$(new_repo t13 900)
  gitq "$R" worktree add -q --detach "$FTmp/t13-azonos" HEAD >/dev/null 2>&1
  OUT=$(bash "$FMutant4" --repo "$R" 2>&1)
  expect "T13 a mutans visszahozza a hamis riasztast" PIROS "WORKTREE-UTKOZES" "$OUT"
  OUT=$(bash "$CGate" --repo "$R" 2>&1)
  expect "T13b KONTROLL: az EREDETI kapu csendben marad" ZOLD "WORKTREE-UTKOZES" "$OUT"
fi

# ── T9: MUTACIO -- az ERTELMEZHETETLEN-detektor kikapcsolva ──────────────────
# hu: A T8 zoldje csak akkor er valamit, ha a detektor nelkul VISSZAJON a hamis zold. A mutans a
#     lelet-agat kapcsolja ki -- pontosan azt az allapotot allitja vissza, ami a konfliktus-markert
#     ertekkent szamolta es `Nincs lelet`-et mondott.
echo
echo "T9 -- MUTACIO: az ERTELMEZHETETLEN-detektor kikapcsolva"
FMutant2="$FTmp/mutans-ertelmezhetetlen.sh"
sed 's/^if unreadable:/if False:/' "$CGate" > "$FMutant2"
if ! grep -q '^if False:' "$FMutant2"; then
  echo "  ❌ T9 -- a mutacio nem fogott: a kapuban nincs `if unreadable:` ag"
  echo "       (a mero a hibas, nem a kapu -- a T8 zoldje IGAZOLATLAN)"
  FFail=$((FFail + 1))
else
  R=$(new_repo t9 100)
  bump "$R" 101 "feat: lepteti (build 101)"
  printf '<<<<<<< HEAD\n102\n=======\n99\n>>>>>>> oldal\n' > "$R/BuildNumberV2.txt"
  gitq "$R" add BuildNumberV2.txt
  gitq "$R" commit -q -m "merge: feloldatlan konfliktus a build-szam fajlban"
  OUT=$(bash "$FMutant2" --repo "$R" --limit 50 2>&1)
  RC=$?
  if [ "$RC" -eq 0 ]; then
    echo "  ✅ T9 a mutans visszahozza a hamis ZOLDET (exit=0)"; FPass=$((FPass + 1))
  else
    echo "  ❌ T9 a mutans is blokkolt (exit=$RC) -- a T8 nem a detektort meri"; FFail=$((FFail + 1))
  fi
fi

# ── T10: MUTACIO -- a cim-elteres agat kikapcsolva a T6b-nek BUKNIA kell ─────
# hu: A T6b zoldje csak akkor er valamit, ha a lelet-ag nelkul eltunik. Ez az a lelet, amit a
#     megszunt "gyors mod" ingyen elrejtett volna.
echo
echo "T10 -- MUTACIO: a cim-elteres lelet-aga kikapcsolva"
FMutant3="$FTmp/mutans-cim.sh"
sed 's/^if subject_mismatch:/if False:/' "$CGate" > "$FMutant3"
if ! grep -q '^if False:' "$FMutant3"; then
  echo "  ❌ T10 -- a mutacio nem fogott: a kapuban nincs `if subject_mismatch:` ag"
  echo "       (a mero a hibas, nem a kapu -- a T6b zoldje IGAZOLATLAN)"
  FFail=$((FFail + 1))
else
  R=$(new_repo t10 500)
  bump "$R" 501 "feat: lepteti (build 501)"
  echo "x" > "$R/x.txt"; gitq "$R" add x.txt; gitq "$R" commit -q -m "docs: a cim build 999-et hirdet"
  OUT=$(bash "$FMutant3" --repo "$R" 2>&1)
  expect "T10 a mutans elrejti a cim-eltEREST" ZOLD "COMMIT-CIM ELTER A FAJLTOL" "$OUT"
  OUT=$(bash "$CGate" --repo "$R" 2>&1)
  expect "T10b KONTROLL: az EREDETI kapu kiirja" PIROS "COMMIT-CIM ELTER A FAJLTOL" "$OUT"
fi

# ── T7: VALOS ESET -- QuantumAE: 670..686 PIROS, a 736 NINCS a listaban ───────
echo
echo "T7 -- valos eset: QuantumAE tortenete"
if [ -d "$CRealRepo/.git" ]; then
  # hu: A `--limit` a TELJES commit-lancra ertendo (nem a fajlt erinto commitokra), ezert a
  #     670..686 sav csak melyebb ablakbol lathato. Ha ezt 400-ra vennenk, a teszt NULLA leletet
  #     merne, es az ugy nezne ki, mint a tiszta tortenet.
  OUT=$(bash "$CGate" --repo "$CRealRepo" --limit 800 2>&1)
  LINE=$(echo "$OUT" | grep "AZONOS ERTEK KET FAJL-VALTOZASBAN" | head -1)
  if [ -z "$LINE" ]; then
    echo "  ❌ T7 -- egyetlen fajl-valtozas leletet sem adott; a 670..686 PIROS kellene legyen"
    FFail=$((FFail + 1))
  else
    VALS=$(echo "$LINE" | sed 's/.*: //' | tr -s ' ')
    N=$(echo "$VALS" | tr ' ' '\n' | grep -c '^[0-9][0-9]*$')
    echo "     mert ertekek ($N): $VALS"
    if echo " $VALS " | grep -q ' 670 ' && echo " $VALS " | grep -q ' 686 '; then
      echo "  ✅ T7a a 670..686 sav PIROS"; FPass=$((FPass + 1))
    else
      echo "  ❌ T7a a 670..686 sav HIANYZIK a leletbol"; FFail=$((FFail + 1))
    fi
    if echo " $VALS " | grep -q ' 736 '; then
      echo "  ❌ T7b a 736 MEG mindig a listaban -- a merge-szabaly nem hat"; FFail=$((FFail + 1))
    else
      echo "  ✅ T7b a 736 NINCS a listaban (merge, nem kiadas)"; FPass=$((FPass + 1))
    fi
    if [ "$N" -eq 17 ]; then
      echo "  ✅ T7c a darabszam 17"; FPass=$((FPass + 1))
    else
      echo "  ❌ T7c a darabszam $N, de 17 lenne a helyes"; FFail=$((FFail + 1))
    fi
  fi
else
  echo "  ⚠️  T7 KIHAGYVA -- a QuantumAE repo nincs a helyen: $CRealRepo"
  echo "     (ez NEM zold: a valos eset merese elmaradt)"
fi

# ── Osszegzes ─────────────────────────────────────────────────────────────────
echo
echo "EREDMENY: $FPass rendben | $FFail elter"
[ "$FFail" -eq 0 ] || exit 1
echo "✅ Minden eset a vart eredmenyt adta."
exit 0
