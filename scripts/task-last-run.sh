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
# The window goes into the SQL as a number: a whole number or nothing.
case "$HOURS" in ''|*[!0-9]*) [ -z "$HOURS" ] || { echo "HOURS: egesz szam kell (kapott: nem szam)" >&2; exit 2; } ;; esac

# The queries go through python3's stdlib sqlite3 module, NOT the `sqlite3`
# command-line tool: that tool is not an install dependency (install-linux.sh
# asks for ffmpeg, git, tmux, lsof, curl, python3, pipx, unzip, zstd), and
# without it this script died with 127 on every call -- exactly where it is
# meant to replace hand-written SQL. The name and the window are bound parameters (?),
# not spliced into the SQL. The DB is never created (a missing file is an
# error), and the connection refuses writes (PRAGMA query_only).
#   sql <header:1|0> <sql> [param...]   -> column output, like the CLI's -header -column
[ -f "$DB" ] || { echo "nincs adatbazis: $DB" >&2; exit 1; }
sql() {
  python3 - "$DB" "$@" <<'PYEOF'
import sqlite3, sys
db, header, query, params = sys.argv[1], sys.argv[2] == "1", sys.argv[3], sys.argv[4:]
con = sqlite3.connect(db, timeout=5)
try:
    con.execute("PRAGMA query_only=ON")
    cur = con.execute(query, params)
    cols = [d[0] for d in cur.description or []]
    rows = [["" if v is None else str(v) for v in r] for r in cur.fetchall()]
finally:
    con.close()
if not header:
    for r in rows:
        print("|".join(r))
    sys.exit(0)
if not rows:
    sys.exit(0)
w = [max([len(c)] + [len(r[i]) for r in rows]) for i, c in enumerate(cols)]
line = lambda vals: "  ".join(v.ljust(w[i]) for i, v in enumerate(vals)).rstrip()
print(line(cols))
print("  ".join("-" * n for n in w))
for r in rows:
    print(line(r))
PYEOF
}

if [ "$NAME" = "--stats" ]; then
  # Kimaradasi rata task-onkent. Az ablak relativ epoch-on, a ts/1000 osztas
  # KOTELEZO -- nelkule minden sor atmegy a szuron, es a szam a tabla eleteben
  # mert osszeget adja vissza az ablak helyett.
  W="${HOURS:-24}"
  echo "-- ablak: utolso ${W} ora | MA=$(date '+%Y-%m-%d %H:%M:%S') --"
  sql 1 "
    SELECT name,
           sum(status='fired')   AS fired,
           sum(status='skipped') AS skipped,
           CASE WHEN count(*)=0 THEN NULL
                ELSE round(100.0*sum(status='skipped')/count(*),1) END AS skip_pct,
           datetime(max(ts)/1000,'unixepoch','localtime') AS utolso
      FROM task_runs
     WHERE ts/1000 > strftime('%s','now') - (CAST(? AS INTEGER) * 3600)
     GROUP BY name
     ORDER BY skipped DESC, name;" "$W"
  echo
  echo "-- pozitiv kontroll: az ablakon KIVULI sorok szama (ha 0, az ablak gyanusan tag) --"
  sql 0 "SELECT count(*) FROM task_runs WHERE ts/1000 <= strftime('%s','now') - (CAST(? AS INTEGER) * 3600);" "$W"
  exit 0
fi

if [ -z "$NAME" ]; then
  # Minden task utolso futasa. A rendezes az epoch-on tortenik, a kiiras
  # localtime-ban -- a datum MINDIG benne van, hogy a frissesseg-itelet ne
  # egy csupasz ora-percbol szulessen.
  sql 1 "
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

if [ -n "$HOURS" ]; then
  # Relativ ablak epoch-on: sem a timezone, sem az off-by-one-hour nem merul fel.
  sql 1 "
    SELECT datetime(ts/1000,'unixepoch','localtime') AS futas,
           status,
           agent
      FROM task_runs
     WHERE name = ? AND ts/1000 > strftime('%s','now') - (CAST(? AS INTEGER) * 3600)
     ORDER BY ts DESC
     LIMIT 40;" "$NAME" "$HOURS"
else
  sql 1 "
    SELECT datetime(ts/1000,'unixepoch','localtime') AS futas,
           status,
           agent
      FROM task_runs
     WHERE name = ?
     ORDER BY ts DESC
     LIMIT 40;" "$NAME"
fi

# POZITIV KONTROLL: ha a fenti ures, ez megmutatja, hogy a NEV rossz-e, vagy
# tenyleg nem futott. Ures szuro nelkuli szamlalas -- ha ez is 0, a task neve
# nem letezik a tablaban.
echo
echo "-- pozitiv kontroll (szuro nelkul, ugyanerre a nevre) --"
sql 1 "
  SELECT count(*) AS osszes_futas,
         datetime(max(ts)/1000,'unixepoch','localtime') AS legutolso
    FROM task_runs WHERE name = ?;" "$NAME"
