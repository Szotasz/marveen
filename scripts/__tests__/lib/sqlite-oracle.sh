# Shared SQLite oracle for scripts/__tests__ suites.  source it, do not run it.
#
# WHY THIS EXISTS. Several suites looked into (or seeded) a database with the
# `sqlite3` command-line tool. That binary is NOT an install dependency --
# install-linux.sh asks for ffmpeg, git, tmux, lsof, curl, python3, pipx and
# unzip -- so on such a host those suites died with `sqlite3: command not found`
# and went red for a packaging decision, not for the code under test.
# python3 IS a dependency, and its stdlib sqlite3 module opens the very same
# file; the fleet's own code (intel_db.py, ledger_lib.py, memoria_heartbeat_gate.py)
# already reads the DB that way. intel-db.test.sh made this swap first (45792b43)
# with the helpers inline; this is that oracle, moved here so the suites with
# the same failure do not each carry a copy.
#
# THIS IS AN ORACLE, NOT CODE UNDER TEST. Use it where a suite seeds a fixture
# or checks what the script under test wrote. Where the script under test itself
# shells out to `sqlite3`, the dependency is the script's, and swapping the
# test's side does not change that -- leave such a suite red, it is telling the
# truth.
#
# Output shape is the sqlite3 CLI's default list mode, so assertions written
# against the CLI stay byte-identical: one line per row, columns joined by '|',
# NULL as the empty string.
#
#   oracle_query  <db> <sql>        one statement; prints its rows
#   oracle_exec   <db> <sql | ->    any number of statements (';'-separated),
#                                   from the argument or, with '-', from stdin;
#                                   prints nothing, like the CLI for DDL/DML
#   oracle_tables <db>              table names, one per line (see below)
#
# All three exit non-zero on an SQL error or an unopenable file and print the
# python error on stderr, so a broken fixture fails loudly instead of leaving
# an empty database behind.

_SQLITE_ORACLE_PY='
import sqlite3, sys
mode, path = sys.argv[1], sys.argv[2]
sql = sys.stdin.read() if sys.argv[3] == "-" else sys.argv[3]
con = sqlite3.connect(path)
try:
    if mode == "exec":
        con.executescript(sql)
        rows = []
    else:
        rows = con.execute(sql).fetchall()
    con.commit()
finally:
    con.close()
for r in rows:
    print("|".join("" if v is None else str(v) for v in r))
'

oracle_query() { python3 -c "$_SQLITE_ORACLE_PY" query "$1" "$2"; }
oracle_exec()  { python3 -c "$_SQLITE_ORACLE_PY" exec  "$1" "$2"; }
# The CLI dot-command `.tables` has no SQL form, so this is the one place the
# oracle is not a literal translation: the same names from sqlite_master, one
# per line instead of in columns. Grep for a name; do not compare the layout.
oracle_tables() { oracle_query "$1" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"; }
