#!/usr/bin/env python3
"""Test that a field move of scripts/kartya-es-ertesites.py writes the board's event rows
(KARTYAEVENTS1010).

The server writes a kanban_card_events row on every status change and a
kanban_card_field_events row on every change of a KANBAN_AUDITED_FIELDS column
(src/db.ts: moveKanbanCard / updateKanbanCard). This script changed the row with a
plain UPDATE and wrote neither: measured 2026-10-10 on the live DB, both tables had
zero rows, so "when did this card move, and who moved it" had no answer, and the
time-in-progress figure (#1863) would read "not measured" for nearly every card.

Drives the script as a subprocess against an isolated DB (KARTYA_DB). Run:
    python3 scripts/__tests__/kartya-esemenysor.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import os, re, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
DB_TS = os.path.join(ROOT, 'src', 'db.ts')
DB_PATH = None
FAILS = []
# SANDBOX-GYOKER, mint a tobbi kartya-suite-ban: ha a KARTYA_DB-t barmi elrontja, a gyoker
# ide oldodik fel, nem az eles fara.
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-sandbox-')


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


BASE_SCHEMA = '''
  CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'planned'
      CHECK(status IN ('planned','in_progress','testing','waiting','done')),
    assignee TEXT,
    priority TEXT NOT NULL DEFAULT 'normal'
      CHECK(priority IN ('low','normal','high','urgent')),
    project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
    parent_id TEXT, dispatched_at INTEGER);
  CREATE TABLE kanban_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
    author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    result TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER);
'''
# A db.ts DDL-je szo szerint (initDatabase).
EVENT_TABLES = {
    'kanban_card_events': '''CREATE TABLE kanban_card_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, actor TEXT,
      created_at INTEGER NOT NULL);''',
    'kanban_card_field_events': '''CREATE TABLE kanban_card_field_events (id INTEGER PRIMARY KEY
      AUTOINCREMENT, card_id TEXT NOT NULL, field TEXT NOT NULL, old_value TEXT, new_value TEXT,
      actor TEXT, created_at INTEGER NOT NULL);''',
}


def fresh_db(path, tables=tuple(EVENT_TABLES), extra=''):
    db = sqlite3.connect(path)
    db.executescript(BASE_SCHEMA + '\n'.join(EVENT_TABLES[t] for t in tables) + extra)
    db.commit()
    db.close()


def q(sql, args=()):
    db = sqlite3.connect(DB_PATH)
    r = db.execute(sql, args).fetchall()
    db.close()
    return r


def seed(card_id, status='planned', priority='normal', assignee='boni'):
    now = int(time.time()) - 100
    db = sqlite3.connect(DB_PATH)
    db.execute('INSERT INTO kanban_cards (id,title,status,assignee,priority,created_at,updated_at)'
               ' VALUES (?,?,?,?,?,?,?)', (card_id, f'teszt {card_id}', status, assignee, priority, now, now))
    db.commit()
    db.close()


def move(card_id, extra=(), author='Boni'):
    d = tempfile.mkdtemp(prefix='kartya-e-')
    cf = os.path.join(d, 'c.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write(f'Kartya {card_id}: esemenysor-teszt.')
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    # Halott port: ha valami megis uzenetet kuldene, ne az eles API-ra menjen.
    env['KARTYA_API'] = 'http://127.0.0.1:9/api/messages'
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--comment-file', cf, '--author', author,
         '--nincs-ertesites-szandekos', *extra],
        capture_output=True, text=True, env=env, timeout=30)


def events(card_id):
    return q('SELECT from_status,to_status,actor,created_at FROM kanban_card_events WHERE card_id=? ORDER BY id',
             (card_id,))


def field_events(card_id):
    return q('SELECT field,old_value,new_value,actor,created_at FROM kanban_card_field_events'
             ' WHERE card_id=? ORDER BY id', (card_id,))


def updated_at(card_id):
    return q('SELECT updated_at FROM kanban_cards WHERE id=?', (card_id,))[0][0]


def new_db(**kw):
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-e-')
    os.close(fd); os.remove(DB_PATH)
    fresh_db(DB_PATH, **kw)


def main():
    new_db()

    # 1. A LELET: egy szkriptes statuszvaltas eseménysort ir, a szerver alakjaban.
    seed('EVA1', 'planned')
    p = move('EVA1', ('--status', 'waiting'))
    check('1 lefutott', p.returncode == 0, p.stdout + p.stderr)
    ev = events('EVA1')
    check('1 pontosan egy esemenysor', len(ev) == 1, f'kapott: {ev}')
    check('1 from/to a valodi atmenet', ev and ev[0][:2] == ('planned', 'waiting'), f'kapott: {ev}')
    check('1 actor a kisbetus szerzo (mint a /move actor-ja)', ev and ev[0][2] == 'boni', f'kapott: {ev}')
    check('1 created_at == a kartya updated_at-je (egy pillanat)', ev and ev[0][3] == updated_at('EVA1'),
          f'kapott: {ev} vs {updated_at("EVA1")}')
    check('1 a kimenet kimondja a visszaolvasott sort', 'ESEMENYSOR OK' in p.stdout, p.stdout)
    check('1 statusz-valtas NEM ir mezo-esemenyt', field_events('EVA1') == [], f'{field_events("EVA1")}')

    # 2. Masodik mozgatas: a sor a FRISS elozo statuszbol indul, nem a seedbol.
    p = move('EVA1', ('--status', 'in_progress'))
    ev = events('EVA1')
    check('2 masodik sor waiting -> in_progress', len(ev) == 2 and ev[1][:2] == ('waiting', 'in_progress'),
          f'kapott: {ev}')

    # 3. --from felulirja az actort (ugyanaz a felado-szabaly, mint az ertesitesnel).
    seed('EVA3', 'planned')
    p = move('EVA3', ('--status', 'done', '--from', 'Samu'))
    ev = events('EVA3')
    check('3 actor a --from kisbetusen', ev and ev[0][2] == 'samu', f'kapott: {ev}')

    # 4. Auditalt mezok (priority, assignee): mezo-esemenysor szovegkent, statusz-sor nelkul.
    seed('EVA4', 'planned', priority='normal', assignee='boni')
    p = move('EVA4', ('--priority', 'high', '--assignee', 'samu'))
    check('4 lefutott', p.returncode == 0, p.stdout + p.stderr)
    fe = {r[0]: r[1:3] for r in field_events('EVA4')}
    check('4 priority sor normal -> high', fe.get('priority') == ('normal', 'high'), f'kapott: {fe}')
    check('4 assignee sor boni -> samu', fe.get('assignee') == ('boni', 'samu'), f'kapott: {fe}')
    check('4 nincs statusz-sor', events('EVA4') == [], f'{events("EVA4")}')

    # 5. Nem auditalt mezo (cim) es no-op mozgatas: egyik tablaba sem kerul sor.
    seed('EVA5', 'waiting')
    p = move('EVA5', ('--title', 'EVA5 uj cim'))
    check('5 cim-mozgatas lefutott', p.returncode == 0, p.stdout + p.stderr)
    p = move('EVA5', ('--status', 'waiting'))
    check('5 no-op statusz lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('5 se statusz-, se mezo-sor', events('EVA5') == [] and field_events('EVA5') == [],
          f'{events("EVA5")} {field_events("EVA5")}')

    # 6. EGY TRANZAKCIO: ha a sor nem irhato be, a statusz sem valtozik (a szerver alakja).
    new_db(extra="CREATE TRIGGER no_ev BEFORE INSERT ON kanban_card_events BEGIN SELECT RAISE(ABORT,'blokk'); END;")
    seed('EVA6', 'planned')
    p = move('EVA6', ('--status', 'waiting'))
    check('6 a futas hibaval all le', p.returncode != 0, p.stdout + p.stderr)
    check('6 a statusz NEM mozdult sor nelkul', q("SELECT status FROM kanban_cards WHERE id='EVA6'")[0][0] == 'planned',
          f'{q("SELECT status FROM kanban_cards WHERE id=?", ("EVA6",))}')

    # 7. HIANYZO TABLA: megtagadas az ELSO iras elott (komment sem), a dry-runon is.
    new_db(tables=())
    seed('EVA7', 'planned')
    for extra, nev in ((('--status', 'waiting'), 'eles'), (('--status', 'waiting', '--dry-run'), 'dry-run')):
        p = move('EVA7', extra)
        check(f'7 {nev}: megtagadva', p.returncode != 0 and 'kanban_card_events' in (p.stdout + p.stderr),
              p.stdout + p.stderr)
    check('7 statusz valtozatlan', q("SELECT status FROM kanban_cards WHERE id='EVA7'")[0][0] == 'planned')
    check('7 komment sem irodott', q("SELECT count(*) FROM kanban_comments WHERE card_id='EVA7'")[0][0] == 0)
    # ...de egy mozgatas NELKULI komment ugyanitt atmegy: a kapu csak az esemenyt koveto irast fogja.
    p = move('EVA7')
    check('7 sima komment a tabla nelkul is atmegy', p.returncode == 0, p.stdout + p.stderr)

    # 8. KONFORMANCIA: a szkript mezo-listaja a db.ts KANBAN_AUDITED_FIELDS tukre.
    src = open(DB_TS, encoding='utf-8').read()
    m = re.search(r'export const KANBAN_AUDITED_FIELDS = \[([^\]]*)\]', src)
    szerver = tuple(re.findall(r"'([a-z_]+)'", m.group(1))) if m else None
    script = open(SCRIPT, encoding='utf-8').read()
    m2 = re.search(r'^AUDITALT_MEZOK = \(([^)]*)\)', script, re.M)
    sajat = tuple(re.findall(r"'([a-z_]+)'", m2.group(1))) if m2 else None
    check('8 AUDITALT_MEZOK == KANBAN_AUDITED_FIELDS', szerver and sajat == szerver,
          f'szerver={szerver} szkript={sajat}')

    os.remove(DB_PATH)
    if FAILS:
        sys.stderr.write('\nBUKOTT: ' + ', '.join(FAILS) + '\n')
        return 1
    print('\nminden teszt atment')
    return 0


if __name__ == '__main__':
    sys.exit(main())
