#!/bin/bash
# hu: Bukas-eloallito teszt a ~/.claude/hooks/destructive-git-guard.sh hookhoz.
#     A hook egy KAPU: sajat magat nem igazolhatja, ezert minden eset ELOALLITOTT
#     repo-allapoton mer, es a POZITIV KONTROLL (amit at KELL engednie) is benne van.
# en: Failure-producing test suite for the destructive-git-guard PreToolUse hook.
#     The hook is a gate: every case runs against a purpose-built repo state, and
#     the positive controls (commands it MUST let through) are part of the suite.

set -uo pipefail

HOOK="${HOOK_PATH:-$HOME/.claude/hooks/destructive-git-guard.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dgg-test.XXXXXX")"
PASS=0
FAIL=0
FAILED_NAMES=()

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if [ ! -x "$HOOK" ]; then
    echo "HIBA: a hook nem futtathato: $HOOK" >&2
    exit 1
fi

# hu: Egy eset lefuttatasa. $1=nev, $2=elvart exit (0=atenged, 2=blokk),
#     $3=parancs, $4=cwd
run_case() {
    local name="$1" expected="$2" command="$3" cwd="$4"
    local payload actual

    payload=$(COMMAND="$command" CWD="$cwd" python3 -c '
import json, os
print(json.dumps({"tool_name": "Bash",
                  "tool_input": {"command": os.environ["COMMAND"]},
                  "cwd": os.environ["CWD"]}))')

    echo "$payload" | "$HOOK" >/dev/null 2>&1
    actual=$?

    if [ "$actual" -eq "$expected" ]; then
        PASS=$((PASS + 1))
        printf '  ok    %-58s (exit %d)\n' "$name" "$actual"
    else
        FAIL=$((FAIL + 1))
        FAILED_NAMES+=("$name")
        printf '  BUKIK %-58s (vart %d, kapott %d)\n' "$name" "$expected" "$actual"
    fi
}

# hu: Csupasz repo egy tracked es egy untracked fajllal, stash nelkul.
make_repo() {
    local dir="$1"
    rm -rf "$dir"
    mkdir -p "$dir"
    git -C "$dir" init -q .
    echo "eredeti" > "$dir/tracked.txt"
    git -C "$dir" add tracked.txt
    git -C "$dir" -c user.email=t@t -c user.name=t commit -qm init
}

BLOCK=2
ALLOW=0

echo "=== A) FELISMERES -- a 'git -C <ut>' alaknak ugyanugy kell blokkolnia ==="
# hu: piszkos tracked fajl + piszkos untracked fajl, NULLA stash -> mind a negy
#     parancs valodi tartalmat dobna el.
R="$WORK/a"
make_repo "$R"
echo "modositva" >> "$R/tracked.txt"
echo "uj" > "$R/untracked.txt"

run_case "git clean -fd"                  $BLOCK "git clean -fd"                      "$R"
run_case "git -C <ut> clean -fd"          $BLOCK "git -C $R clean -fd"                 "$R"
run_case "git reset --hard"               $BLOCK "git reset --hard"                    "$R"
run_case "git -C <ut> reset --hard"       $BLOCK "git -C $R reset --hard"              "$R"
run_case "git restore <fajl>"             $BLOCK "git restore tracked.txt"             "$R"
run_case "git -C <ut> restore <fajl>"     $BLOCK "git -C $R restore tracked.txt"       "$R"
run_case "git checkout -- <fajl>"         $BLOCK "git checkout -- tracked.txt"         "$R"
run_case "git -C <ut> checkout -- <fajl>" $BLOCK "git -C $R checkout -- tracked.txt"   "$R"
# hu: egyeb globalis kapcsolok, amik ugyanugy koze ekelodnek
run_case "git --git-dir=... reset --hard" $BLOCK "git --git-dir=$R/.git --work-tree=$R reset --hard" "$R"
run_case "git -c user.name=x clean -fd"   $BLOCK "git -c user.name=x clean -fd"        "$R"
run_case "osszetett: cd && git -C clean"  $BLOCK "cd /tmp && git -C $R clean -fd"      "/tmp"

echo
echo "=== B) A FELOLDAS TARTALOM-KOTOTT -- 'barmilyen stash' NEM eleg ==="
# hu: B1 -- regi stash MAS fajlrol; a most eldobando tartalom NINCS benne.
R="$WORK/b1"
make_repo "$R"
echo "masik" > "$R/masik.txt"
git -C "$R" add masik.txt
git -C "$R" -c user.email=t@t -c user.name=t commit -qm masik
echo "regi valtozas" >> "$R/masik.txt"
git -C "$R" stash push -q -m "regi, mas fajlrol"
echo "modositva" >> "$R/tracked.txt"
run_case "regi stash MAS fajlrol -> blokk" $BLOCK "git -C $R restore tracked.txt" "$R"

# hu: B2 -- a stash EPP EZT A TARTALMAT tartalmazza -> at kell engedni.
#     (A `stash push` visszaallitja az eredetit, ezert ugyanazt irjuk vissza.)
R="$WORK/b2"
make_repo "$R"
echo "modositva" >> "$R/tracked.txt"
git -C "$R" stash push -q -m "epp ez a tartalom"
echo "modositva" >> "$R/tracked.txt"
run_case "stash EPP ezt a TARTALMAT tartalmazza -> at" $ALLOW "git -C $R restore tracked.txt" "$R"

# hu: B2b -- UGYANAZ A PATH van a stash-ben, de MAS TARTALOMMAL -> blokk.
#     Ez a fo kulonbseg a regi kapuhoz kepest: a path jelenlete nem mentes.
R="$WORK/b2b"
make_repo "$R"
echo "elso valtozat" >> "$R/tracked.txt"
git -C "$R" stash push -q -m "az elso valtozat"
echo "MASODIK, mentetlen valtozat" >> "$R/tracked.txt"
run_case "azonos path, MAS tartalom -> blokk" $BLOCK "git -C $R restore tracked.txt" "$R"

# hu: B3 -- untracked fajl + clean; a stash -u-val keszult es tartalmazza -> at.
R="$WORK/b3"
make_repo "$R"
echo "szemet" > "$R/untracked.txt"
git -C "$R" stash push -u -q -m "untracked is bent"
echo "szemet" > "$R/untracked.txt"
run_case "stash -u tartalmazza az untracked-et -> at" $ALLOW "git -C $R clean -fd" "$R"

# hu: B4 -- untracked fajl + clean; a stash NEM tartalmazza -> blokk.
R="$WORK/b4"
make_repo "$R"
echo "elso" > "$R/elso-untracked.txt"
git -C "$R" stash push -u -q -m "csak az elso"
echo "masodik" > "$R/masodik-untracked.txt"
run_case "stash NEM tartalmazza az untracked-et -> blokk" $BLOCK "git -C $R clean -fd" "$R"

echo
echo "=== C) POZITIV KONTROLL -- amit at KELL engednie ==="
R="$WORK/c"
make_repo "$R"
echo "modositva" >> "$R/tracked.txt"

run_case "git status"                     $ALLOW "git -C $R status --short"           "$R"
run_case "git stash push (a vedohalo)"    $ALLOW "git -C $R stash push -u -m mentes"  "$R"
run_case "git log --grep=restore"         $ALLOW "git -C $R log --grep=restore"       "$R"
# hu: -C NELKUL, kulonben a regi hook a felismeres-vaksag miatt engedne at, es
#     a teszt HAMIS OKBOL lenne zold (a --staged kivetelt nem is merne).
run_case "git restore --staged (csak index)" $ALLOW "git restore --staged tracked.txt" "$R"
# hu: C7 -- a SZABALY ALTAL ELoIRT alak: elobb stash, aztan a parancs, EGY sorban.
#     Ha ezt blokkolnank, a kapu epp a helyes mintat buntetne.
run_case "stash push && reset --hard egy sorban" $ALLOW "git -C $R stash push -u -m mentes && git -C $R reset --hard" "$R"
run_case "nem git repo"                   $ALLOW "git clean -fd"                      "$WORK"

# hu: C6 -- TISZTA working tree: nincs mit elveszteni, ne alljon utba.
#     Szinten -C nelkul: igy a regi hook BLOKKOL (0 stash), az uj ATENGED.
R="$WORK/c6"
make_repo "$R"
run_case "tiszta fa + reset --hard -> at"  $ALLOW "git reset --hard"                  "$R"

echo
echo "=== D) A -C CEL REPOJAT kell merni, nem a CWD-et ==="
# hu: a CWD repoja VEDETT (van rola stash), a -C cel viszont VEDTELEN.
SAFE="$WORK/d-safe"
make_repo "$SAFE"
echo "valami" >> "$SAFE/tracked.txt"
git -C "$SAFE" stash push -q -m "a cwd repo vedve van"

TARGET="$WORK/d-target"
make_repo "$TARGET"
echo "vedtelen valtozas" >> "$TARGET/tracked.txt"

run_case "vedett CWD, vedtelen -C cel -> blokk" $BLOCK "git -C $TARGET reset --hard" "$SAFE"


echo
echo "=== E) AZ ORDOG ATMERESEBoL (2026-08-14) -- OT LELET, MIND FEDVE ==="
# hu: E1 -- `git clean -fdx` ott, ahol az EGYETLEN untracked tartalom gitignore-olt
#     build-maradek. Ez rutin .NET-takaritas: ha a kapu itt blokkol, sosem oldodik
#     fel, es a fej megkeruli. HAMIS POZITIV volt.
R="$WORK/e1"
make_repo "$R"
printf 'bin/\nobj/\n' > "$R/.gitignore"
git -C "$R" add .gitignore
git -C "$R" -c user.email=t@t -c user.name=t commit -qm ignore
mkdir -p "$R/bin" "$R/obj"
echo "build" > "$R/bin/app.dll"
echo "temp"  > "$R/obj/tmp.o"
run_case "clean -fdx CSAK ignoralt szemeten -> at" $ALLOW "git -C $R clean -fdx" "$R"

# hu: E1b -- ugyanott EGY VALODI untracked fajl -> blokkolnia KELL (kulonben az E1
#     javitasa tul sokat engedne at).
echo "valodi mentetlen munka" > "$R/uj-modul.cs"
run_case "clean -fdx valodi untracked-del -> blokk" $BLOCK "git -C $R clean -fdx" "$R"

# hu: E2 -- a `--` NELKULI checkout ugyanugy eldob. Ez az alak, amit gepelnek.
R="$WORK/e2"
make_repo "$R"
echo "modositva" >> "$R/tracked.txt"
run_case "git checkout . (-- nelkul) -> blokk"      $BLOCK "git -C $R checkout ."              "$R"
run_case "git checkout <fajl> (-- nelkul) -> blokk" $BLOCK "git -C $R checkout tracked.txt"    "$R"
run_case "git checkout HEAD <fajl> -> blokk"        $BLOCK "git -C $R checkout HEAD tracked.txt" "$R"
# hu: es a POZITIV KONTROLL: az ag-valtas NEM veszelyes
run_case "git checkout -b uj (ag-valtas) -> at"     $ALLOW "git -C $R checkout -b uj-ag"       "$R"

# hu: E3 -- RESZLEGES stash NEM old fel: a pathspec miatt az untracked kimarad.
R="$WORK/e3"
make_repo "$R"
echo "modositva" >> "$R/tracked.txt"
echo "mentetlen" > "$R/untracked.txt"
run_case "reszleges stash push -- <fajl> && clean -> blokk" $BLOCK \
  "git -C $R stash push -- tracked.txt && git -C $R clean -fd" "$R"
# hu: a resz-sztring-bypass (a `stash` SZO puszta jelenlete) sem oldhat fel
run_case "git stash list && git clean -fd -> blokk" $BLOCK "git -C $R stash list && git -C $R clean -fd" "$R"

# hu: E4 -- FAIL-CLOSED: ha a felismeres bukik, de veszelyes ige all a parancsban.
R="$WORK/e4"
make_repo "$R"
echo "modositva" >> "$R/tracked.txt"
run_case "ertelmezhetetlen idezojel + reset --hard -> blokk" $BLOCK \
  "git -C $R reset --hard \"lezaratlan" "$R"

# hu: E5 -- untracked SYMLINK: a `git clean -fd` torli, a celpontja informacio.
R="$WORK/e5"
make_repo "$R"
ln -s /etc/hosts "$R/csak-egy-symlink"
run_case "untracked symlink + clean -fd -> blokk" $BLOCK "git -C $R clean -fd" "$R"

echo
echo "=== F) AZ IGNORALT FAJL NEM AZONOS A 'NEM ER SEMMIT'-TEL (ordog, 2026-08-14) ==="
# hu: F1 -- gyoker-szintu ignoralt fajl (.env titkos kulccsal) -> BLOKKOLNI KELL.
#     Az ordog merte: a `-u` SOHA nem menti az ignoraltat, csak az `-a` -- tehat ez a
#     tartalom sem committal, sem a kapu altal javasolt stash-sel nem kerul biztonsagba.
R="$WORK/f1"
make_repo "$R"
printf '.env\n*.local\n' > "$R/.gitignore"
git -C "$R" add .gitignore
git -C "$R" -c user.email=t@t -c user.name=t commit -qm ignore
echo "APIKEY=titkos-eles-kulcs" > "$R/.env"
echo "beallitas" > "$R/config.local"
run_case "clean -fdx: gyoker-szintu .env -> blokk" $BLOCK "git -C $R clean -fdx" "$R"
# hu: es ugyanott `-x` NELKUL nincs mit torolni (a ket fajl ignoralt) -> at
run_case "clean -fd ugyanott (-x nelkul) -> at"    $ALLOW "git -C $R clean -fd"  "$R"

# hu: F2 -- CSAK build-kimenet ignoralva -> tovabbra is at (a .NET-takaritas ne alljon).
R="$WORK/f2"
make_repo "$R"
printf 'bin/\nobj/\nnode_modules/\n' > "$R/.gitignore"
git -C "$R" add .gitignore
git -C "$R" -c user.email=t@t -c user.name=t commit -qm ignore
mkdir -p "$R/bin" "$R/obj" "$R/node_modules/csomag"
echo x > "$R/bin/app.dll"; echo y > "$R/obj/tmp.o"; echo z > "$R/node_modules/csomag/index.js"
run_case "clean -fdx: csak build-kimenet -> at" $ALLOW "git -C $R clean -fdx" "$R"

# hu: F3 -- ignoralt fajl EGY NEM-BUILD konyvtarban (`config/.env`) -> blokk.
#     Ez a heurisztika hatara: a hely dont, es a `config/` nem build-konyvtar.
R="$WORK/f3"
make_repo "$R"
printf '*.env\n' > "$R/.gitignore"
git -C "$R" add .gitignore
git -C "$R" -c user.email=t@t -c user.name=t commit -qm ignore
mkdir -p "$R/config"
echo "DB=titkos" > "$R/config/prod.env"
run_case "clean -fdx: config/prod.env -> blokk" $BLOCK "git -C $R clean -fdx" "$R"

# hu: F4 -- a KIMONDOTT LYUK: build-konyvtarban levo ignoralt titok ATCSUSZIK.
#     Nem hiba, hanem VALLALT hatar -- teszt orzi, hogy tudatos maradjon.
R="$WORK/f4"
make_repo "$R"
printf 'obj/\n' > "$R/.gitignore"
git -C "$R" add .gitignore
git -C "$R" -c user.email=t@t -c user.name=t commit -qm ignore
mkdir -p "$R/obj"
echo "TITOK=1" > "$R/obj/titkos.env"
run_case "clean -fdx: obj/titkos.env ATCSUSZIK (vallalt hatar)" $ALLOW "git -C $R clean -fdx" "$R"

# hu: F5 -- `stash push -a` UTAN ugyanaz a parancs at kell menjen (a helyes kiut).
R="$WORK/f5"
make_repo "$R"
printf '.env\n' > "$R/.gitignore"
git -C "$R" add .gitignore
git -C "$R" -c user.email=t@t -c user.name=t commit -qm ignore
echo "APIKEY=titok" > "$R/.env"
run_case "stash push -a && clean -fdx egy sorban -> at" $ALLOW \
  "git -C $R stash push -a -m mentes && git -C $R clean -fdx" "$R"

# hu: F6 -- `packages/` NEM build-konyvtar: JS-monorepoban (pnpm/yarn/lerna) az a FORRAS-gyoker.
#     Az ordog bukas-eloallitassal mutatta meg, hogy igy egy `packages/my-lib/secrets.json`
#     nemán atcsuszott. A teszt orzi, hogy ne kerulhessen vissza a listara.
R="$WORK/f6"
make_repo "$R"
printf 'secrets.json\nobj/\n' > "$R/.gitignore"
git -C "$R" add .gitignore
git -C "$R" -c user.email=t@t -c user.name=t commit -qm ignore
mkdir -p "$R/packages/my-lib" "$R/obj"
echo "{\"token\":\"titkos\"}" > "$R/packages/my-lib/secrets.json"
echo build > "$R/obj/x.o"
run_case "clean -fdx: packages/my-lib/secrets.json -> blokk" $BLOCK "git -C $R clean -fdx" "$R"

echo
echo "================================================================"
printf 'PASS: %d   FAIL: %d\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
    echo "Bukott esetek:"
    for n in "${FAILED_NAMES[@]}"; do echo "  - $n"; done
    exit 1
fi
exit 0
