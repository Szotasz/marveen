#!/bin/bash
# hu: BUILD-SZAM UTKOZES-KAPU -- commit ELoTTI ellenorzo, worktree-k KOZOTT is mer.
#
# MIERT LETEZIK: a BuildNumberV2.txt a $(QaeBuild)-en at a FileVersion/InformationalVersion resze,
# tehat a SZOFTVER VERZIOSZAMANAK resze. A 8/2025 NGM 23. § (1) szerint a verzioszam "a szoftver
# programverziojanak EGYEDI AZONOSITOJA". KET AGON AZONOS SZAM = KET KULONBOZo BINARIS UGYANAZZAL
# AZ AZONOSITOVAL.
#
# 🛑 A KAPU AZ AZONOS ERTEK ELoFORDULASAT NEM TILTJA -- A VISSZATERES-T TILTJA.
#    Ket lepteles kozott MINDEN commit ugyanazt a szamot mutatja: az a szam NORMALIS ELETTARTAMA.
#    Valodi utkozes az, ha a szam egy MASIK ertek utan UJRA megjelenik (9 -> 10 -> 9).
#    (Egy 2026-08-09-i audit ezt osszekeverte, es negy "duplikatumot" allitott ott, ahol nulla volt.)
#
# 🛑 KET MODSZER KELL, MERT MAST MERNEK, ES EGYIK SEM RESZHALMAZA A MASIKNAK:
#    (1) VISSZATERES: minden commiton kiolvasott ertek, egy ertek ujra megjelenik-e masik utan.
#    (2) FAJL-VALTOZAS: a fajlt ERINTo commitok kozul ketto azonos erteket mutat (pl. merge-feloldas,
#        ahol a fajl "valtozott", de az ertek maradt).
#    A JokerQ-n a (2) adta a 620-at, az (1) a 602/729/777-et -- a teljes kep a kettojuk unioja.
#
# EGY HARMADIK, KULON HIBAOSZTALY: a COMMIT-CIM mas build-szamot hirdet, mint a fajl tartalma.
#    Ez nem azonosito-utkozes, hanem HAMIS DOKUMENTACIO -- de ugyanaz a kar: a kovetkezo olvaso
#    tenykent hasznalja. Ismert eset mindket repoban (QCassa 4b5ea94/cfde0b4, JokerQ 5af6597).
#
# A KAPU SEMMIT NEM JAVIT ES NEM IR AT -- csak jelent. A tortenet valtozatlan marad.
#
# en: BUILD NUMBER COLLISION GATE -- pre-commit check that also measures ACROSS worktrees.
#     It does NOT forbid a repeated value (that is a number's normal lifetime between bumps); it
#     forbids a RETURNING value. Two detectors are needed because they measure different things and
#     neither is a subset of the other. A third, separate class: the commit SUBJECT announcing a
#     different build number than the file holds.
#
# 🛑 NINCS "GYORS MOD", ES EZ MERT DONTES -- NEM EGYSZERuSITESI KENYELEM:
#   (a) A LELET-KOR nem szukitheto INGYEN: a koltseg a BEJARAS (egy `git log` + egy
#       `git cat-file --batch`), nem a detektorok. MERVE a JokerQ-n: log 33 ms, first-parent 13 ms,
#       batch 38 ms, worktree-lista 9 ms; mind a negy detektor EBBoL AZ EGY beolvasott adathalmazbol
#       szamol, tiszta pythonban. Egy detektor kihagyasa nulla masodpercet sporolna, cserebe egy MAR
#       KISZAMOLT sertest rejtene el. A cim-elteres raadasul az EGYETLEN lelet, amit kizarolag
#       COMMIT-IDoBEN lehet javitani -- utana be van egetve a tortenetbe.
#   (b) A MELYSEG sem szukitheto: a VISSZATERES-detektor a leghosszabb memoriara epul, es van olyan
#       valos alak, amit CSAK o lat -- oldalagon ujra kiadott szam, ahol az elso-szulo lancon NINCS
#       csokkenes. Barmely veges ablak epp ezt a detektort vakitja el. MERVE (JokerQ): 60 commit
#       187 ms · 200 commit 206 ms · 500 commit 216 ms · TELJES tortenet (838 commit) 252 ms;
#       QuantumAE teljes (1363 commit) 293 ms. *** A melyseg nem szuk keresztmetszet. ***
#   Ezert az alapertelmezes a TELJES tortenet, es `--quick` kapcsolo NINCS: egy kapcsolo, amirol a
#   hivo azt hiszi, hogy szukebb modban fut, ugyanaz a nema csapda, mint amit a kapu keres.
#   Ha valaha kell valodi gyors mod, az UJ kapcsolo lesz, mert lesz mit sporolnia.
#
# HASZNALAT / USAGE:
#   buildszam-utkozes-kapu.sh                          # a HIVO repoja, TELJES tortenet
#   buildszam-utkozes-kapu.sh --repo /path/to/repo     # adott repo (tobbszor is adhato)
#   buildszam-utkozes-kapu.sh --all                    # MINDEN repo a gyokerek alatt (lassu, opt-in)
#   buildszam-utkozes-kapu.sh --root /Users/ceo/Source # sajat gyoker (--all-lal ertelmes)
#   buildszam-utkozes-kapu.sh --limit 200              # SEKELYEBB bejaras (alap: teljes tortenet)
#
# EXIT: 0 = nincs lelet | 1 = LELET (utkozes, hamis cim vagy ERTELMEZHETETLEN ertek) | 2 = hasznalati hiba

set -uo pipefail

CBuildFile="BuildNumberV2.txt"
# hu: 0 = NINCS MELYSEG-KORLAT (a teljes tortenet). Lasd a fejlec „a melyseg nem szukithet" reszet.
# en: 0 = NO depth limit (walk the whole history).
CDefaultLimit=0

FRoots=()
FRepos=()
FLimit=$CDefaultLimit
FLimitGiven=0
FAll=0
FArgCount=$#

# ── Parancssor ────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --root)  [ $# -ge 2 ] || { echo "HIBA: a --root ertek nelkul all"; exit 2; }; FRoots+=("$2"); shift 2 ;;
    --repo)  [ $# -ge 2 ] || { echo "HIBA: a --repo ertek nelkul all"; exit 2; }; FRepos+=("$2"); shift 2 ;;
    --limit) [ $# -ge 2 ] || { echo "HIBA: a --limit ertek nelkul all"; exit 2; }; FLimit="$2"; FLimitGiven=1; shift 2 ;;
    --all)   FAll=1;   shift ;;
    -h|--help) sed -n '2,56p' "$0"; exit 0 ;;
    *) echo "HIBA: ismeretlen kapcsolo: $1"; echo "      (a kapcsolok: --all --repo --root --limit --help)"; exit 2 ;;
  esac
done

# hu: A HATOKOR ALAPERTELMEZESE A HIVO REPOJA. Parameter nelkul a kapu NEM jarja be a gepet:
#     a teljes bejaras kifejezett `--all`-ra megy. Aki gyorsan akar merni, ne kelljen tudnia,
#     hogy melyik kapcsolo vedi meg a percektol.
# en: Default scope is the CALLER'S repo; the full sweep is opt-in via --all.
if [ ${#FRepos[@]} -eq 0 ] && [ ${#FRoots[@]} -eq 0 ]; then
  if [ "$FAll" -eq 1 ]; then
    FRoots=("$HOME/Source" "$HOME/Work")
  else
    FSelf=$(git rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$FSelf" ]; then
      FRepos=("$FSelf")
    else
      echo "HIBA: nem git-repoban allsz, es nincs --repo/--root/--all megadva."
      echo "      (a hatokor alapertelmezese a HIVO repoja -- itt nincs mibol dolgozni)"
      exit 2
    fi
  fi
fi

# hu: EGYSOROS HASZNALAT-KIIRAS a parameter nelkuli futas ELEJEN. A parameterezes ne a README-bol
#     derüljon ki: egy atmero, aki a nevet FELTETELEZI, a kapu hibajat meri, nem a repoet.
if [ "$FArgCount" -eq 0 ]; then
  echo "(alap: a hivo repoja, TELJES tortenet | --limit N = sekelyebb | --all = minden repo | --help)"
fi

# ── Repo-lista osszeallitasa ──────────────────────────────────────────────────
if [ ${#FRepos[@]} -eq 0 ]; then
  while IFS= read -r f; do
    FRepos+=("$(dirname "$f")")
  done < <(
    for r in "${FRoots[@]}"; do
      [ -d "$r" ] || continue
      find "$r" -name "$CBuildFile" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null
    done | sort -u
  )
fi

if [ ${#FRepos[@]} -eq 0 ]; then
  echo "HIBA: egyetlen $CBuildFile sem talalhato a megadott hatokorben."
  echo "      (Ha ez varatlan, a hatokor a hibas -- NEM az, hogy nincs build-szam sehol.)"
  exit 2
fi

FFindings=0
FCheckedRepos=0
FCheckedCommits=0
FCheckedSubjects=0
FUnreadable=0

if [ "$FLimit" -le 0 ] 2>/dev/null; then
  FDepthText="TELJES tortenet"
else
  FDepthText="$FLimit commit"
fi
echo "BUILD-SZAM UTKOZES-KAPU -- hatokor: ${#FRepos[@]} hely, commit-melyseg: $FDepthText"
echo

# hu: EGY WORKTREE KODALLAPOTANAK UJJLENYOMATA -- A LEMEZRoL, nem a commitbol.
#     Harom resz, mert egyik sem eleg onmagaban (mindharomra van eloallitott eset a mereseszkozben):
#       (1) `git diff HEAD`                -- a kovetett fajlok TARTALMA; az UJ fajlokat nem latja
#       (2) `git status --porcelain -uall` -- nevek es statuszok; az uj fajl JELENLETET fogja,
#                                             a TARTALMAT nem (ket eltero modositas azonos nevvel
#                                             ugyanazt a kimenetet adja)
#       (3) `git hash-object` az uj fajlokra -- az azonos nevu UJ fajl eltero tartalma
#     KOLTSEG: ~20-40 ms worktree-nkent, ezert a hivo CSAK akkor keri, ha van azonos-szam +
#     azonos-HEAD par. A tipikus futasban egyetlen extra git-hivas sem tortenik.
# en: Fingerprints a worktree's code state FROM DISK. Three parts, none sufficient alone; the caller
#     invokes it only for same-number + same-HEAD pairs, so the typical run pays nothing.
FFpCache="|"
FFp=""
worktree_fingerprint() {
  local wt="$1" rest

  # hu: Gyorsitotar -- egy worktree ujjlenyomata a futason belul valtozatlan, es tobb parban is
  #     szerepelhet. Ot azonos-HEAD worktree eseten a cache nelkul 8 szamitas fut 5 helyett
  #     (MERVE a QCassa.MHMI-n: 410 ms -> a cache-sel ~250).
  # en: Cache -- one worktree can appear in several pairs; without it five worktrees cost eight probes.
  case "$FFpCache" in
    *"|$wt="*)
      rest="${FFpCache#*|$wt=}"
      FFp="${rest%%|*}"
      return 0 ;;
  esac

  FFp=$(worktree_fingerprint_compute "$wt")
  FFpCache="$FFpCache$wt=$FFp|"
}

# hu: Ket worktree kodallapota ELTER-e. Kilepesi kod: 0 = elternek (tehat utkozes).
# en: Whether two worktrees hold different code states; exit 0 means they differ.
worktrees_differ() {
  local a b

  worktree_fingerprint "$1"; a="$FFp"
  worktree_fingerprint "$2"; b="$FFp"

  [ "$a" != "$b" ]
}

worktree_fingerprint_compute() {
  local wt="$1" f

  {
    git -C "$wt" rev-parse HEAD 2>/dev/null
    git -C "$wt" diff HEAD 2>/dev/null
    git -C "$wt" status --porcelain --untracked-files=all 2>/dev/null

    git -C "$wt" status --porcelain --untracked-files=all 2>/dev/null \
      | sed -n 's/^?? //p' \
      | while IFS= read -r f; do
          [ -f "$wt/$f" ] && git -C "$wt" hash-object -- "$f" 2>/dev/null
        done
  } | shasum 2>/dev/null | cut -d' ' -f1
}

# ── 1. WORKTREE-K KOZOTTI UTKOZES ─────────────────────────────────────────────
# hu: A kivalto eset: a JokerQ nyolc worktree-je szetszort szamokkal, es a Fo MUNKAKONYVTAR a main
#     MOGOTT allt -- a kovetkezo commitja egy MAR FOGLALT szamot adott volna.
check_worktrees() {
  local repo="$1"
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || return 0
  git -C "$repo" rev-parse --git-common-dir >/dev/null 2>&1 || return 0

  local seen_values="" line wt val head prev prev_head prev_wt dup=""

  # 🛑 AZONOS SZAM ONMAGABAN NEM UTKOZES -- A KODALLAPOTNAK IS ELTERoNEK KELL LENNIE.
  #    MERT HAMIS RIASZTAS: a `QCassa.MHMI` ot worktree-je mind ugyanazon a commiton all, tiszta
  #    munkafaval, mind a 113-as szammal -- a szam-alapu osszevetes NEGY "utkozest" jelentett rajta.
  #
  # 🛑 DE A HEAD ONMAGABAN SZuK: AZ ERTEKET A LEMEZRoL OLVASSUK, TEHAT AZ AZONOSSAGNAK IS A LEMEZT
  #    KELL TUKROZNIE. Ket worktree allhat ugyanazon a commiton ELTERo commitolatlan tartalommal --
  #    az ket kulonbozo binaris ugyanazzal a build-szammal. A kartya sajat tezise ugyanez:
  #    *** az APK a MUNKAFABOL fordul, nem a HEAD-boL. ***
  #    A ket kezenfekvo mechanizmus KULON-KULON mast hagy ki, ezert MINDHAROM resz kell:
  #      `git diff HEAD`                     -- a kovetett fajlok TARTALMA (uj fajlokat nem lat)
  #      `git status --porcelain -uall`      -- a nevek/statuszok, az UJ fajlok JELENLETE (tartalmat nem)
  #      `git hash-object` az uj fajlokra    -- az azonos nevu UJ fajl ELTERo tartalma
  # en: The value is read from DISK, so identity must reflect the disk too -- HEAD alone is too narrow.
  #     Each of the three parts covers what the others miss.
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        wt="${line#worktree }"
        head=""
        continue ;;
      "HEAD "*)
        head="${line#HEAD }" ;;
      *) continue ;;
    esac

    [ -n "$wt" ] || continue
    [ -f "$wt/$CBuildFile" ] || continue
    val=$(tr -d '[:space:]' < "$wt/$CBuildFile" 2>/dev/null)
    [ -n "$val" ] || continue

    prev=$(echo "$seen_values" | grep "^$val|" | head -1)

    if [ -n "$prev" ]; then
      prev_head=$(echo "$prev" | cut -d'|' -f2)
      prev_wt=$(echo "$prev" | cut -d'|' -f3)

      if [ "$prev_head" != "$head" ]; then
        dup="$dup$val|$wt|$prev_wt
"
      elif worktrees_differ "$wt" "$prev_wt"; then
        # hu: Azonos commit, ELTERo munkafa. A dragabb meres CSAK ide fut be -- ha nincs
        #     azonos-szam + azonos-HEAD par, egyetlen extra git-hivas sem tortenik.
        # en: Same commit, different working tree. The costlier probe runs only for this narrow case.
        dup="$dup$val|$wt (munkafa)|$prev_wt (munkafa)
"
      fi
    fi

    seen_values="$seen_values$val|$head|$wt
"
  done < <(git -C "$repo" worktree list --porcelain 2>/dev/null)

  if [ -n "$dup" ]; then
    echo "  🛑 WORKTREE-UTKOZES ($repo):"
    echo "$dup" | while IFS='|' read -r v a b; do
      [ -n "$v" ] || continue
      echo "     build $v KET helyen: $a"
      echo "                          $b"
    done
    return 1
  fi

  return 0
}

# ── 2. VISSZATERES + 3. KIADAS-DUPLIKATUM + 4. CIM-ELTERES + 5. CSOKKENES ─────
#
# 🛑 A KIADAS DEFINICIOJA -- EZ A DETEKTOR MAGVA:
#    Egy commit AKKOR ad ki uj build-szamot, ha az ertek MINDEN SZULoJEHEZ kepest valtozott.
#    Merge-nel tehat a MASODIK szulohoz kepest is. Ha a merge azert "valtoztatja" a fajlt, mert a
#    behozott ag mar a magasabb szamot hordozza, az NEM uj kiadas -- ugyanaz a kiadas erkezik meg
#    egy masik agra.
#    MERVE (QuantumAE): `5dc45e30` szulo 735 -> 736 = valodi kiadas; `20f3e366` szuloi 686 ES 736,
#    az erteke 736 -- a masodik szulohoz kepest NEM valtozott, tehat nem kiadas. E szabaly nelkul a
#    kapu 18 duplikatumot allit ott, ahol 17 van. KET FUGGETLEN MERo adta elsore ugyanezt a 18-at.
# en: A commit RELEASES a number only if the value differs from EVERY parent -- including a merge's
#     second parent. Without this the gate reports one collision too many.
#
# 🛑 MIERT PYTHON A MAG, ES MIERT NEM BASH:
#    A szulo-osszevetes commitonkent tobb ERTEK-OLVASAST kivan, es a gepen bash 3.2 fut (nincs
#    asszociativ tomb). A string-alapu gyorsitotar NEGYZETESEN skalazodik: MERVE 50/100/200/400
#    commitra 0.9 / 2.3 / 9.3 / 56 masodperc. Egy kapu, ami percekig fut, KI LESZ KAPCSOLVA.
#    A python-mag EGYETLEN `git cat-file --batch` hivassal olvassa ki az osszes erteket.
# en: The core is Python because the parent comparison needs a real hash map; the bash string cache
#     measured quadratic (56 s at 400 commits). One `git cat-file --batch` call replaces N reads.
check_history() {
  local repo="$1" out rc measured

  out=$(BSZ_REPO="$repo" BSZ_FILE="$CBuildFile" BSZ_LIMIT="$FLimit" python3 - <<'PYEOF'
import os
import re
import subprocess
import sys

CRepo  = os.environ["BSZ_REPO"]
CFile  = os.environ["BSZ_FILE"]
CLimit = int(os.environ["BSZ_LIMIT"])

# hu: 0 (vagy negativ) = NINCS melyseg-korlat. A `-N` kapcsolo ilyenkor EL IS MARAD a `git log`-bol --
#     egy `-0` NULLA commitot adna vissza, vagyis a "teljes tortenet" szandekbol NEMA VAKSAG lenne.
#     (Elo is allt fejlesztes kozben; a kapu sajat „A MERo VAK" jelzese fogta meg.)
# en: 0 means NO limit, and the `-N` flag must be omitted entirely: `git log -0` returns nothing, so
#     the "whole history" intent would silently become blindness.
CDepthArgs = [] if CLimit <= 0 else ["-%d" % CLimit]

CCompanion = re.compile(r"\[(deploy|kapu|release)\]")
CSubjBuild = re.compile(r"build\s+([0-9]+)", re.IGNORECASE)


def git_text(*args):
    """hu: git-hivas szoveges kimenettel. en: git call returning text."""
    r = subprocess.run(["git", "-C", CRepo, *args],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return r.stdout.decode("utf-8", "replace")


def values_for(shas):
    """hu: EGY `git cat-file --batch` hivas -- a valasz BAJT-pontosan darabolva, nem sor-szinkronnal
       (a sor-szinkron elcsuszna, ha a fajl valaha tobb soros lenne).
       en: One batch call; the reply is split by byte length, not by line, so a multi-line file
       cannot silently desynchronise the parser."""
    shas = [s for s in shas if s]
    if not shas:
        return {}

    req = "".join("%s:%s\n" % (s, CFile) for s in shas).encode()
    r = subprocess.run(["git", "-C", CRepo, "cat-file", "--batch"],
                       input=req, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    out, pos, res = r.stdout, 0, {}

    for s in shas:
        nl = out.find(b"\n", pos)
        if nl < 0:
            break
        header = out[pos:nl].decode("utf-8", "replace").split()
        pos = nl + 1

        if len(header) == 3 and header[1] == "blob":
            size = int(header[2])
            res[s] = out[pos:pos + size].decode("utf-8", "replace").strip()
            pos += size + 1
        # hu: `<sha> missing` -- nincs tartalom-blokk, a pozicio mar a kovetkezo fejlecen all

    return res


branch = git_text("rev-parse", "--abbrev-ref", "HEAD").strip()

commits = []
for line in git_text("log", "--format=%H|%P|%s", *CDepthArgs, "HEAD").splitlines():
    if not line.strip():
        continue
    sha, _, rest = line.partition("|")
    parents, _, subject = rest.partition("|")
    commits.append((sha, parents.split(), subject))

first_parent = [c for c in git_text("log", "--first-parent", "--format=%H",
                                    *CDepthArgs, "HEAD").split() if c]

wanted = []
for sha, parents, _ in commits:
    wanted.append(sha)
    wanted.extend(parents)
wanted.extend(first_parent)
values = values_for(list(dict.fromkeys(wanted)))

checked_commits = 0
checked_subjects = 0
returning = []
release_values = {}
duplicates = []
subject_mismatch = []

seen_values = set()
prev = None

for sha, parents, subject in commits:
    v = values.get(sha)
    if not v:
        continue
    checked_commits += 1

    # (a) VISSZATERES: az ertek egy MASIK ertek utan ujra megjelenik-e a bejart lancon
    if v != prev:
        if v in seen_values and v not in returning:
            returning.append(v)
        seen_values.add(v)
    prev = v

    # (b) KIADAS-DUPLIKATUM: ket KIADAS-commit ugyanazt az erteket adja ki
    #
    # 🛑 A KISERo-COMMIT NEM SERTES. A `[deploy]`/`[kapu]`/`[release]` utotagu commit SZANDEKOSAN
    #    nem leptet: a build-szam KIADAS-azonosito, nem commit-azonosito. Merve (JokerQ): az utolso
    #    60 build-szamot erinto commit kozul egyetlen kisero-utotagu van, es az 0 kodot visz.
    if not CCompanion.search(subject):
        is_release = all(values.get(p) != v for p in parents)

        if is_release:
            if v in release_values:
                if v not in duplicates:
                    duplicates.append(v)
            else:
                release_values[v] = sha

    # (c) CIM-ELTERES: a commit CIME mas build-szamot hirdet, mint a fajl tartalma
    m = CSubjBuild.search(subject)
    if m:
        checked_subjects += 1
        if m.group(1) != v:
            subject_mismatch.append("     %s: a cim 'build %s'-t hirdet, a fajlban %s | %s"
                                    % (sha[:8], m.group(1), v, subject[:52]))

# (d) CSOKKENES az elso-szulo lancon -- a legelesebb alak, es a mai valos esetet is ez fogta meg
#     (777 -> 778 -> 777: a HEAD szama KISEBB, mint a szulojee). A szam SOSEM csokkenhet.
#
# 🛑 ES ITT VOLT A HARMADIK REPO-ALLAPOT, AMI ZOLDET ADOTT: a nem-numerikus erteket ez a ciklus
#    NEMAN atugorta. Harom allapot van, nem ketto:
#      (1) nincs fajl             -> "nem hasznal build-szamot", exit 0   -- helyes
#      (2) van, de URES           -> "A MERo VAK", exit 2                 -- helyes
#      (3) van ertek, de NEM SZAM -> "Nincs lelet", exit 0                -- HIBA VOLT
#    A (3) legelesebb alakja a FELOLDATLAN MERGE-KONFLIKTUS a fajlban: a kapu a konfliktus-markert
#    ERTEKNEK szamolja (a szamlalo "nem vak"-ot mutat), a szam-alapu detektorok atugorjak, es a
#    verdikt ZOLD -- egy „megoldom kesobb" merge atmegy azon a kapun, ami epp a merge-feloldast
#    celozza. Ezert a (3) mostantol BLOKKOL: egy konfliktus-marker a build-szam fajlban nem uzemi
#    allapot, es a javitasa trivialis -- a fail-closed ara itt nulla.
# en: A THIRD repo state existed and returned green: a value that is present but NOT A NUMBER (an
#     unresolved merge conflict being the sharpest shape). The ordering detectors skipped it
#     silently while the counter reported a non-blind measurement. It now BLOCKS.
decreasing = []
prev_num = None

# hu: Az ERTELMEZHETETLEN ertekek a TELJES bejart lancrol gyulnek, nem csak az elso-szulo agrol --
#     kulonben egy oldalagon allo konfliktus-marker ugyanugy atmenne, ahogy eddig mindegyik.
# en: Unreadable values are collected from the WHOLE walked history, not just the first-parent line.
unreadable = [
    "     %s: %s" % (sha[:8], " ".join(values[sha].split())[:60])
    for sha, _, _ in commits
    if values.get(sha) and not values[sha].isdigit()
]

for sha in reversed(first_parent):
    v = values.get(sha)
    if not v or not v.isdigit():
        continue

    if prev_num is not None and int(v) < prev_num:
        decreasing.append("     %s: %d -> %s (CSOKKENT)" % (sha[:8], prev_num, v))
    prev_num = int(v)

hit = False
out = []

# 🛑 MIND A NEGY LELET MINDIG KIIRODIK -- NINCS "gyors mod", ami valamelyiket elhagyna.
#    MERVE (JokerQ): a koltseg a bejaras -- `git log` 33 ms, first-parent log 13 ms,
#    `cat-file --batch` 38 ms (60 commit). A negy detektor mind EBBoL AZ EGY beolvasott
#    adathalmazbol szamol, tiszta pythonban: *** egyetlen detektor kihagyasa nulla masodpercet
#    sporolna. *** Amit a kihagyas ezzel szemben KOLTENE: a cim-elteres az EGYETLEN a negybol, amit
#    kizarolag COMMIT-IDoBEN lehet javitani -- utana be van egetve a tortenetbe.
# en: All four findings are always reported: every detector computes from the same single read, so
#     skipping one would save nothing -- while the subject mismatch is the only finding that can be
#     fixed exclusively at commit time.
if decreasing:
    out.append("  🛑 A BUILD-SZAM CSOKKENT (%s, ag: %s) -- a szam SOSEM csokkenhet:" % (CRepo, branch))
    out.extend(decreasing)
    hit = True

if unreadable:
    out.append("  🛑 %d ERTEK ERTELMEZHETETLEN (%s, ag: %s) -- a rendezettseg ezeken NEM merheto:"
               % (len(unreadable), CRepo, branch))
    out.extend(unreadable)
    out.append("     (tipikus ok: FELOLDATLAN MERGE-KONFLIKTUS a build-szam fajlban)")
    hit = True

if returning:
    out.append("  🛑 VISSZATERo BUILD-SZAM (%s, ag: %s): %s" % (CRepo, branch, " ".join(returning)))
    out.append("     (a szam egy MASIK ertek utan ujra megjelent -- ket kodallapot egy azonositon)")
    hit = True

if duplicates:
    out.append("  🛑 AZONOS ERTEK KET FAJL-VALTOZASBAN (%s, ag: %s): %s"
               % (CRepo, branch, " ".join(duplicates)))
    out.append("     (ket KIADAS-commit ugyanazt a szamot adta ki -- ket kodallapot egy azonositon)")
    out.append("     (a merge, ami mar meglevo szamot HOZ AT, NEM kiadas -- ki van zarva)")
    out.append("     (a [deploy]/[kapu]/[release] kisero-commitok szinten ki vannak zarva)")
    hit = True

if subject_mismatch:
    out.append("  🛑 COMMIT-CIM ELTER A FAJLTOL (%s, ag: %s) -- hamis dokumentacio:" % (CRepo, branch))
    out.extend(subject_mismatch)
    out.append("     (ez az EGYETLEN lelet, amit kizarolag COMMIT-IDoBEN lehet javitani)")
    hit = True

print("\n".join(out)) if out else None
print("#MERT|%d|%d|%d" % (checked_commits, checked_subjects, len(unreadable)))
sys.exit(1 if hit else 0)
PYEOF
)
  rc=$?

  measured=$(printf '%s\n' "$out" | grep '^#MERT|' | tail -1)
  if [ -n "$measured" ]; then
    FCheckedCommits=$((FCheckedCommits + $(echo "$measured" | cut -d'|' -f2)))
    FCheckedSubjects=$((FCheckedSubjects + $(echo "$measured" | cut -d'|' -f3)))
    FUnreadable=$((FUnreadable + $(echo "$measured" | cut -d'|' -f4)))
  fi

  printf '%s\n' "$out" | grep -v '^#MERT|' | grep -v '^$'

  return $rc
}

# ── Futtatas ──────────────────────────────────────────────────────────────────
# hu: A "NEM HASZNAL BUILD-SZAMOT" ES A "VAK MERES" KET KULONBOZo ALLAPOT, ES UGYANUGY NEZNEK KI:
#     mindketto NULLA kiolvasott erteket ad. Ha nem valasztjuk szet, a kapu MINDEN build-szam
#     nelkuli repoban hibaval all meg -- egy commit-hookban ez fals riasztas, es a kaput
#     kikapcsoljak. A dontes MERT: letezik-e a fajl a HEAD-en VAGY barhol a tortenetben.
# en: "repo has no build number" and "the measurement was blind" both yield zero readings; the gate
#     must tell them apart, otherwise it fails on every unrelated repo it is hooked into.
FSkipped=0

for repo in "${FRepos[@]}"; do
  [ -d "$repo" ] || continue
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || continue

  if ! git -C "$repo" cat-file -e "HEAD:$CBuildFile" 2>/dev/null; then
    if [ -z "$(git -C "$repo" log --format=%H -1 --all -- "$CBuildFile" 2>/dev/null)" ]; then
      echo "  ⏭️  KIHAGYVA ($repo): ez a repo nem hasznal $CBuildFile-t -- nincs mit merni."
      FSkipped=$((FSkipped + 1))
      continue
    fi
    echo "  ⚠️  A $CBuildFile a HEAD-en NINCS, de a tortenetben VAN ($repo) -- a meres folytatodik."
  fi

  FCheckedRepos=$((FCheckedRepos + 1))

  check_worktrees "$repo" || FFindings=$((FFindings + 1))
  check_history   "$repo" || FFindings=$((FFindings + 1))
done

echo
echo "MERT HATOKOR: $FCheckedRepos repo | $FCheckedCommits commit-ertek | $FCheckedSubjects build-szamot allito cim | $FUnreadable ERTELMEZHETETLEN ertek | $FSkipped kihagyva (nincs build-szam)"

# hu: POZITIV KONTROLL A MEROoN. Ha volt merendo repo, de egyetlen commit-erteket sem olvastunk ki,
#     a NULLA LELET nem eredmeny, hanem VAKSAG -- a hatokor rossz, nem a valosag tiszta.
# en: POSITIVE CONTROL ON THE MEASURING TOOL. Zero readings from a non-empty scope mean blindness.
if [ "$FCheckedRepos" -gt 0 ] && [ "$FCheckedCommits" -eq 0 ]; then
  echo "🛑 A MERo VAK: egyetlen commit-erteket sem olvasott ki. A hatokor hibas -- a 'nincs lelet' NEM allitas."
  exit 2
fi

if [ "$FFindings" -gt 0 ]; then
  echo "🛑 LELET: $FFindings helyen. A kapu NEM javit semmit -- a rendezes dontes kerdese."
  exit 1
fi

echo "✅ Nincs lelet a mert hatokorben."
exit 0
