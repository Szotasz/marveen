#!/bin/bash
# hu: Kiadja a kovetkezo Telegram-uzenet sorszamat es lepteti a szamlalot.
#     A szamlalo FAJLBAN el, ezert tuleli a session-ujrainditast es a friss kontextust.
#     A szamlalo KOZOS az egesz flottara -- minden fej ugyanezt hivja.
# en: Emits the next Telegram message sequence number and advances the counter.
#     The counter lives in a file, shared by the whole fleet.
set -euo pipefail

F="/Users/ceo/Marveen/store/telegram-msg-seq.txt"
LOCKDIR="${F}.lockdir"
TURELEM_MP=10       # hu: ennyit varunk a zarra, VALOS ido; utana FAIL-CLOSED (exit 3)

# hu: 🛑 A ZAR mkdir-ALAPU, NEM flock -- ezen a gepen (macOS) NINCS flock. A korabbi alak
#     `flock 9 2>/dev/null || true`-t hasznalt: a `|| true` ELNYELTE a "command not found"-ot,
#     tehat a zar SOHA nem jott letre. Merve, 20 parhuzamos hivas: 3-6 EGYEDI szam (az {1}-est
#     tizenharomszor is kiadta). A mkdir POSIX-on ATOMI -- pontosan ez kell zarnak.
#     (avalonia + ordog, egymastol fuggetlenul, 2026-08-13)
#
# hu: 🛑 FAIL-CLOSED (az ordog erve, szo szerint): "Egy ki nem adott szam eszrevehetó; egy
#     duplikalt szam nem." Ha a zar nem szerezheto meg, INKABB NE ADJON KI SZAMOT.
#
# hu: 🛑 ARVA-ZAR VISSZAVETEL NINCS -- ES EZ SZANDEKOS, MERT MERVE ROSSZABB VOLT.
#     Volt benne kor-alapu automatikus visszavetel (ha a zar > N mp, elvesszuk). Az ordog
#     bukas-eloallitassal kimutatta, hogy MAGA A VISSZAVETEL VERSENYHELYZET: a "nezd meg a kort"
#     (stat) es a "cselekedj" (rmdir) kozott a zar allapota megvaltozhat, tehat B elveheti A
#     ELo zarat, es KETTEN kerulnek a kritikus szakaszba. MERVE: egy arva zar + 20 egyideju hivo,
#     20 kor -> 9 korben duplikatum. Az o sajat javitasa (atomi `mv`) is MEGBUKOTT (8-bol 2 kor),
#     mert a verseny nem a TORLES modjaban van, hanem a NEZD-MEG-MAJD-CSELEKEDJ szerkezetben.
#     A VISSZAVETEL NELKUL, ugyanazon a terhelesen: 0 duplikatum, 8/8 kor tiszta.
#     AZ ARA, kimondva: egy tenylegesen beragadt zar MEGALLITJA a szamozast, amig valaki kezzel
#     fel nem oldja -- ezert irja ki a script a pontos parancsot. Ez ugyanaz az elv, mint fent.
# en: No automatic stale-lock reclaim: check-then-act is itself a race (measured). Manual only.
kezdet=$(date +%s)
until mkdir "$LOCKDIR" 2>/dev/null; do
  if [ $(( $(date +%s) - kezdet )) -ge "$TURELEM_MP" ]; then
    echo "tg-seq: a zarat ${TURELEM_MP} mp alatt nem sikerult megszerezni -- SZAM NEM KERULT KIADASRA." >&2
    echo "tg-seq: ha a zar beragadt, oldd fel KEZZEL:  rmdir '$LOCKDIR'" >&2
    exit 3
  fi
  sleep 0.05
done

# hu: 🛑 A TRAP oRIZZE MEG A KILEPESI KODOT. A korabbi alak (`trap 'rmdir ... || true' EXIT`)
#     utolso parancsa a `|| true` volt, tehat MINDEN nem-szandekos hiba (set -e / set -u megallas)
#     0-ra maszkolodott: a hivo SIKERT latott es URES stringet kapott -> "{} <uzenet>" ment volna ki.
#     Merve (ordog): serult szamlalo -> rc=0, stdout 0 bajt; ep szamlalo -> rc=0, stdout '501'.
#     A KET ESET KILEPESI KODJA AZONOS VOLT.
trap '__rc=$?; rmdir "$LOCKDIR" 2>/dev/null || true; exit $__rc' EXIT

[ -f "$F" ] || printf '0\n' > "$F"
__cur=$(cat "$F")

# hu: 🛑 A BEOLVASOTT ERTEKET ERVENYESITENI KELL. Egy 0 bajtos szamlalo-fajl csendben 1-et adott
#     vissza -- ami UTKOZIK minden eddig kiadott szammal. Igy lesz ures: az iras ELoSZOR CSONKOL,
#     es ha ott szakad meg (kill, tele lemez), a fajl 0 bajtos marad. (ordog, merve)
case "$__cur" in
  ""|*[!0-9]*)
    echo "tg-seq: SERULT SZAMLALO: [$__cur] -- SZAM NEM KERULT KIADASRA. Fajl: $F" >&2
    exit 4
    ;;
esac

n=$(( __cur + 1 ))
# hu: atomi csere -- a cel-fajl SOHA nem lesz felkesz allapotban (a fenti csonkolas-ablak ellen)
printf '%s\n' "$n" > "${F}.tmp.$$"
mv -f "${F}.tmp.$$" "$F"
printf '%s\n' "$n"
