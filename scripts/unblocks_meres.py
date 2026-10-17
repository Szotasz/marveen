#!/usr/bin/env python3
"""Card #673 -- the before/after measurement for the `unblocks` interrupt.

WHY A SCRIPT AND NOT A RECALLED NUMBER: the acceptance condition on the card is a
p95 comparison plus a positive control, and both have to be produced the same way
on both sides of the change. A number typed from memory proves the memory.

Run it BEFORE the patch goes in (baseline) and again AFTER, with the same
arguments, and compare the two printouts.

    python3 scripts/unblocks_meres.py                 # whole history
    python3 scripts/unblocks_meres.py --since 2026-09-26

WHAT COUNTS AS SUCCESS, stated before the numbers exist so it cannot be moved:

  1. Flagged messages (affects_current_work='unblocks') deliver with a p95 that
     is a small multiple of the router tick, not of the busy turn.
  2. POSITIVE CONTROL -- unflagged webby->cody messages must KEEP their old,
     slow shape. If their p95 collapses too, the flag is not what changed
     anything and the green is measuring something else.
  3. No message from a sender other than the main agent ever carries the flag.
     A row that does is a route bypass, not a feature.
"""
import argparse
import os
import sqlite3
import time
from collections import defaultdict

DEFAULT_DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'store', 'claudeclaw.db')


def pct(values, q):
    if not values:
        return None
    s = sorted(values)
    return s[int(round((len(s) - 1) * q))]


def fmt(v):
    return '-' if v is None else f'{v} s'


def line(label, vals):
    print(f'  {label:<34} n={len(vals):<6} median={fmt(pct(vals, .5)):<10} '
          f'p95={fmt(pct(vals, .95)):<10} p99={fmt(pct(vals, .99)):<10} max={fmt(max(vals) if vals else None)}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DEFAULT_DB)
    ap.add_argument('--since', help='YYYY-MM-DD, local time; omit for the whole history')
    ap.add_argument('--main', default='webby', help='the main agent id (the only one allowed to set the flag)')
    args = ap.parse_args()

    conn = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True)
    # The BEFORE run happens on a database that does not have the column yet.
    # It has to work there, or the two sides are not comparable -- which is the
    # whole point of running the same script twice.
    has_column = any(r[1] == 'affects_current_work'
                     for r in conn.execute('PRAGMA table_info(agent_messages)'))
    flag_col = 'affects_current_work' if has_column else 'NULL'
    where = ['delivered_at IS NOT NULL', 'created_at IS NOT NULL', 'delivered_at >= created_at']
    params = []
    if args.since:
        where.append("date(created_at,'unixepoch','localtime') >= ?")
        params.append(args.since)
    rows = list(conn.execute(
        f'SELECT from_agent, to_agent, {flag_col}, delivered_at - created_at '
        'FROM agent_messages WHERE ' + ' AND '.join(where), params))

    print(f'# unblocks-meres  db={args.db}  since={args.since or "(teljes elozmeny)"}  '
          f'futtatva={time.strftime("%Y-%m-%d %H:%M:%S")}')
    print(f'# delivered sorok: {len(rows)}')
    print(f'# affects_current_work oszlop: {"BENT VAN" if has_column else "NINCS (ez az ELOTTE-allapot)"}')
    print()

    flagged = [d for _, _, a, d in rows if a == 'unblocks']
    print('1) MEGJELOLT uzenetek (affects_current_work=unblocks)')
    if not flagged:
        print('   nincs egyetlen megjelolt kezbesites sem -- a mezo meg nem volt hasznalatban.')
        print('   Ez NEM siker es NEM bukas: a meres tortenet nelkul nem mond semmit.')
    else:
        line('unblocks', flagged)
    print()

    print('2) POZITIV KONTROLL -- a megjeloletlen forgalomnak valtozatlannak kell maradnia')
    by_edge = defaultdict(list)
    for f, t, a, d in rows:
        if a != 'unblocks':
            by_edge[(f, t)].append(d)
    for edge, vals in sorted(by_edge.items(), key=lambda x: -(pct(x[1], .95) or 0)):
        if len(vals) >= 20:
            line(f'{edge[0]}->{edge[1]}', vals)
    print()

    print('3) KI ALLITOTTA BE -- a fo-agensen kivul senki nem teheti')
    offenders = sorted({f for f, _, a, _ in rows if a == 'unblocks' and f != args.main})
    if offenders:
        print(f'   LELET: a mezot ezek a nem-fo kuldok is hasznaltak: {", ".join(offenders)}')
        print('   Ez route-megkerules (kozvetlen DB-iras), nem funkcio.')
    else:
        print(f'   rendben: csak "{args.main}" (vagy senki) hasznalta.')

    if not has_column:
        print()
        print('EZ AZ ELOTTE-MERES: az oszlop nincs a tablaban, tehat az 1) es a 3) szakasz')
        print('meg nem mondhat semmit. A 2) szakasz szamai az alapvonal -- ezekhez kell')
        print('majd az UTANA-futast hasonlitani.')


if __name__ == '__main__':
    main()
