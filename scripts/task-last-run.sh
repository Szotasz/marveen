#!/bin/bash
# Utemezett feladatok futasanak lekerdezese HELYES ido-kezelessel.
#
# Miert letezik ez a szkript: a task_runs.ts oszlop MILLISZEKUNDUM epoch, a
# store/claudeclaw.db tobbi timestampje viszont MASODPERC. Ha valaki kezzel ir
# ido-szurot (strftime('%s','2026-08-19 08:00')*1000), az SQLite a stringet
# UTC-nek veszi -> CEST alatt ket oraval a jovobe csuszik az ablak, es a
# lekerdezes URES halmazt ad. Az ures halmaz pontosan ugy nez ki, mint "a task
# nem futott". 2026-08-19-en ez ketszer sult el egy koron belul.
#
# A masik csapda, amit ez kivalt: "SELECT name, max(ts) ... GROUP BY name
# HAVING ts=max(ts)" NEM megbizhatoan a legutolso sort adja vissza.
#
# Hasznalat:
#   scripts/task-last-run.sh                 # minden task utolso futasa
#   scripts/task-last-run.sh pr-figyeles     # egy task utolso 10 futasa
#   scripts/task-last-run.sh pr-figyeles 24  # az utolso 24 oraban
#   scripts/task-last-run.sh --stats 24      # fired/skipped bontas + kimaradasi rata
#
# A --stats azert kerult ide (2026-08-21): a heartbeat "9 fired, 1 skipped"
# sorat akartam ellenorizni, ami NEM frissesseg-kerdes, ezert nem jutott
# eszembe ez a szkript, es kezzel irt SQL-t hasznaltam -- amiben a ts/1000
# osztas kimaradt, tehat a "24 oras" szuro a TELJES tablat adta vissza
# (9012 sor 24 orakent). Nem ures halmaz jott, hanem TULZO szam, ami sokkal
# csendesebb hiba. A tanulsag: minden task_runs-kerdes ide tartozik, nem csak
# az "utoljara mikor futott".

set -euo pipefail
DB="$(cd "$(dirname "$0")/.." && pwd)/store/claudeclaw.db"
NAME="${1:-}"
HOURS="${2:-}"

if [ "$NAME" = "--stats" ]; then
  # Kimaradasi rata task-onkent. Az ablak relativ epoch-on, a ts/1000 osztas
  # KOTELEZO -- nelkule minden sor atmegy a szuron, es a szam a tabla eleteben
  # mert osszeget adja vissza az ablak helyett.
  W="${HOURS:-24}"
  echo "-- ablak: utolso ${W} ora | MA=$(date '+%Y-%m-%d %H:%M:%S') --"
  sqlite3 -header -column "$DB" "
    SELECT name,
           sum(status='fired')   AS fired,
           sum(status='skipped') AS skipped,
           CASE WHEN count(*)=0 THEN NULL
                ELSE round(100.0*sum(status='skipped')/count(*),1) END AS skip_pct,
           datetime(max(ts)/1000,'unixepoch','localtime') AS utolso
      FROM task_runs
     WHERE ts/1000 > strftime('%s','now') - ($W * 3600)
     GROUP BY name
     ORDER BY skipped DESC, name;"
  echo
  echo "-- pozitiv kontroll: az ablakon KIVULI sorok szama (ha 0, az ablak gyanusan tag) --"
  sqlite3 "$DB" "SELECT count(*) FROM task_runs WHERE ts/1000 <= strftime('%s','now') - ($W * 3600);"
  exit 0
fi

if [ -z "$NAME" ]; then
  # Minden task utolso futasa. A rendezes az epoch-on tortenik, a kiiras
  # localtime-ban -- a datum MINDIG benne van, hogy a frissesseg-itelet ne
  # egy csupasz ora-percbol szulessen.
  sqlite3 -header -column "$DB" "
    SELECT name,
           agent,
           datetime(max(ts)/1000,'unixepoch','localtime') AS utolso_futas,
           round((strftime('%s','now') - max(ts)/1000)/60.0, 1) AS perce,
           count(*) AS futasok_osszesen
      FROM task_runs
     GROUP BY name, agent
     ORDER BY max(ts) DESC;"
  exit 0
fi

WHERE="name = '$NAME'"
if [ -n "$HOURS" ]; then
  # Relativ ablak epoch-on: sem a timezone, sem az off-by-one-hour nem merul fel.
  WHERE="$WHERE AND ts/1000 > strftime('%s','now') - ($HOURS * 3600)"
fi

sqlite3 -header -column "$DB" "
  SELECT datetime(ts/1000,'unixepoch','localtime') AS futas,
         status,
         agent
    FROM task_runs
   WHERE $WHERE
   ORDER BY ts DESC
   LIMIT 40;"

# POZITIV KONTROLL: ha a fenti ures, ez megmutatja, hogy a NEV rossz-e, vagy
# tenyleg nem futott. Ures szuro nelkuli szamlalas -- ha ez is 0, a task neve
# nem letezik a tablaban.
echo
echo "-- pozitiv kontroll (szuro nelkul, ugyanerre a nevre) --"
sqlite3 -header -column "$DB" "
  SELECT count(*) AS osszes_futas,
         datetime(max(ts)/1000,'unixepoch','localtime') AS legutolso
    FROM task_runs WHERE name = '$NAME';"
