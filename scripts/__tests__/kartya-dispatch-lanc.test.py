#!/usr/bin/env python3
"""Test that a field move of scripts/kartya-es-ertesites.py follows the server's dispatched_at
rule and stamps the parent chain, in the same transaction as the move (KARTYADISPATCH1010).

The server's two status paths (moveKanbanCard, updateKanbanCard) clear dispatched_at on a write
that leaves the card anywhere but in_progress (db.ts kanbanWriteClearsDispatch) and stamp every
ancestor's updated_at (touchAncestorChain). The script did neither: a card it took out of
in_progress kept its stamp, so the next /move to in_progress woke nobody, and a parent looked idle
while its subcards moved. The script only clears; it never dispatches.

Drives the script as a subprocess against an isolated DB (KARTYA_DB). Run:
    python3 scripts/__tests__/kartya-dispatch-lanc.test.py
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
REGI = int(time.time()) - 1000


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def schema(dispatched_at=True):
    return f'''
  CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'planned'
      CHECK(status IN ('planned','in_progress','testing','waiting','done')),
    assignee TEXT,
    priority TEXT NOT NULL DEFAULT 'normal'
      CHECK(priority IN ('low','normal','high','urgent')),
    project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
    parent_id TEXT{', dispatched_at INTEGER' if dispatched_at else ''});
  CREATE TABLE kanban_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
    author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    result TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER);
  CREATE TABLE kanban_card_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, actor TEXT,
    created_at INTEGER NOT NULL);
  CREATE TABLE kanban_card_field_events (id INTEGER PRIMARY KEY
    AUTOINCREMENT, card_id TEXT NOT NULL, field TEXT NOT NULL, old_value TEXT, new_value TEXT,
    actor TEXT, created_at INTEGER NOT NULL);
'''


def new_db(dispatched_at=True, extra=''):
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-d-')
    os.close(fd); os.remove(DB_PATH)
    db = sqlite3.connect(DB_PATH)
    db.executescript(schema(dispatched_at) + extra)
    db.commit()
    db.close()


def q(sql, args=()):
    db = sqlite3.connect(DB_PATH)
    r = db.execute(sql, args).fetchall()
    db.close()
    return r


def seed(card_id, status='planned', parent=None, dispatched=None):
    db = sqlite3.connect(DB_PATH)
    cols = [r[1] for r in db.execute('PRAGMA table_info(kanban_cards)')]
    if 'dispatched_at' in cols:
        db.execute('INSERT INTO kanban_cards (id,title,status,assignee,priority,created_at,updated_at,parent_id,'
                   'dispatched_at) VALUES (?,?,?,?,?,?,?,?,?)',
                   (card_id, f'teszt {card_id}', status, 'boni', 'normal', REGI, REGI, parent, dispatched))
    else:
        db.execute('INSERT INTO kanban_cards (id,title,status,assignee,priority,created_at,updated_at,parent_id)'
                   ' VALUES (?,?,?,?,?,?,?,?)', (card_id, f'teszt {card_id}', status, 'boni', 'normal', REGI, REGI, parent))
    db.commit()
    db.close()


def move(card_id, extra=()):
    d = tempfile.mkdtemp(prefix='kartya-d-')
    cf = os.path.join(d, 'c.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write(f'Kartya {card_id}: dispatch- es lanc-teszt.')
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    # Halott port: ha valami megis uzenetet kuldene, ne az eles API-ra menjen.
    env['KARTYA_API'] = 'http://127.0.0.1:9/api/messages'
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--comment-file', cf, '--author', 'Boni',
         '--nincs-ertesites-szandekos', *extra],
        capture_output=True, text=True, env=env, timeout=30)


def disp(card_id):
    return q('SELECT dispatched_at FROM kanban_cards WHERE id=?', (card_id,))[0][0]


def upd(card_id):
    return q('SELECT updated_at FROM kanban_cards WHERE id=?', (card_id,))[0][0]


def main():
    new_db()

    # 1. A LELET: in_progress -> waiting a szkripttel nullazza a belyeget (a /move szabalya).
    seed('D1', 'in_progress', dispatched=REGI)
    p = move('D1', ('--status', 'waiting'))
    check('1 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('1 dispatched_at NULL', disp('D1') is None, f'{disp("D1")}')
    check('1 a kimenet kimondja a visszaolvasast', 'DISPATCH OK' in p.stdout, p.stdout)

    # 2. A szkript CSAK nullaz: in_progress-re mozgatva nem ebreszt, nem belyegez.
    seed('D2', 'planned')
    p = move('D2', ('--status', 'in_progress'))
    check('2 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('2 dispatched_at NULL marad (nincs ebresztes)', disp('D2') is None, f'{disp("D2")}')
    check('2 nem ment uzenet', q('SELECT count(*) FROM agent_messages')[0][0] == 0)
    check('2 nincs DISPATCH-sor a kimenetben', 'DISPATCH OK' not in p.stdout, p.stdout)

    # 3. Ugyanaz a spell: in_progress-ben marado kartya mezomozgatasa megtartja a belyeget.
    seed('D3', 'in_progress', dispatched=REGI)
    p = move('D3', ('--priority', 'high'))
    check('3 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('3 dispatched_at megmarad', disp('D3') == REGI, f'{disp("D3")}')

    # 4. Gyogyulas: nem-in_progress kartya beragadt belyege barmely valodi irasnal NULL lesz.
    seed('D4', 'planned', dispatched=REGI)
    p = move('D4', ('--priority', 'high'))
    check('4 beragadt belyeg NULL', p.returncode == 0 and disp('D4') is None, f'{disp("D4")} {p.stderr}')

    # 5. Szulo-lanc: G <- P <- C; C mozgatasa P-t es G-t is belyegzi, a mozgatas idejevel.
    seed('G5'); seed('P5', parent='G5'); seed('C5', parent='P5'); seed('X5')
    p = move('C5', ('--status', 'waiting'))
    check('5 lefutott', p.returncode == 0, p.stdout + p.stderr)
    t = upd('C5')
    check('5 szulo belyegezve a mozgatas idejevel', upd('P5') == t and t != REGI, f'{upd("P5")} vs {t}')
    check('5 nagyszulo is', upd('G5') == t, f'{upd("G5")} vs {t}')
    check('5 idegen kartya erintetlen', upd('X5') == REGI, f'{upd("X5")}')
    check('5 a kimenet kimondja', 'SZULO-LANC OK' in p.stdout and 'P5 -> G5' in p.stdout, p.stdout)

    # 6. Kor a lancban: hangos figyelmeztetes, megallas, a mozgatas maga sikeres.
    seed('A6', parent='B6'); seed('B6', parent='A6')
    p = move('A6', ('--status', 'waiting'))
    check('6 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('6 kor-figyelmeztetes', 'parent_id kor' in p.stderr, p.stderr)
    check('6 B6 belyegezve', upd('B6') == upd('A6'), f'{upd("B6")} vs {upd("A6")}')

    # 7. Melysegi korlat: 20 szintes lancbol 16 os kap belyeget, figyelmeztetessel.
    for i in range(21):
        seed(f'L7_{i}', parent=(f'L7_{i + 1}' if i < 20 else None))
    p = move('L7_0', ('--status', 'waiting'))
    t = upd('L7_0')
    belyeg = [i for i in range(1, 21) if upd(f'L7_{i}') == t]
    check('7 pontosan 16 os belyegezve', belyeg == list(range(1, 17)), f'{belyeg}')
    check('7 melyseg-figyelmeztetes', 'melyebb' in p.stderr, p.stderr)

    # 8. EGY TRANZAKCIO: ha az esemenysor nem irhato be, se a szulo, se a belyeg nem valtozik.
    new_db(extra="CREATE TRIGGER no_ev BEFORE INSERT ON kanban_card_events BEGIN SELECT RAISE(ABORT,'blokk'); END;")
    seed('P8'); seed('C8', 'in_progress', parent='P8', dispatched=REGI)
    p = move('C8', ('--status', 'waiting'))
    check('8 a futas hibaval all le', p.returncode != 0, p.stdout + p.stderr)
    check('8 a szulo NEM belyegzodott', upd('P8') == REGI, f'{upd("P8")}')
    check('8 a dispatch-belyeg megmaradt', disp('C8') == REGI, f'{disp("C8")}')

    # 9. HIANYZO OSZLOP: megtagadas az ELSO iras elott (komment sem), a dry-runon is.
    new_db(dispatched_at=False)
    seed('D9')
    for extra, nev in ((('--status', 'waiting'), 'eles'), (('--status', 'waiting', '--dry-run'), 'dry-run')):
        p = move('D9', extra)
        check(f'9 {nev}: megtagadva', p.returncode != 0 and 'kanban_cards.dispatched_at' in (p.stdout + p.stderr),
              p.stdout + p.stderr)
    check('9 komment sem irodott', q("SELECT count(*) FROM kanban_comments WHERE card_id='D9'")[0][0] == 0)
    p = move('D9')
    check('9 sima komment az oszlop nelkul is atmegy', p.returncode == 0, p.stdout + p.stderr)

    # 10. KONFORMANCIA: a ket konstans a db.ts tukre.
    src = open(DB_TS, encoding='utf-8').read()
    script = open(SCRIPT, encoding='utf-8').read()
    m = re.search(r"export function kanbanWriteClearsDispatch\([^)]*\): boolean \{\s*return nextStatus !== '([a-z_]+)'\s*\}", src)
    m2 = re.search(r"^DISPATCH_STATUSZ = '([a-z_]+)'", script, re.M)
    check('10 DISPATCH_STATUSZ == kanbanWriteClearsDispatch kiveteles statusza',
          m and m2 and m.group(1) == m2.group(1), f'szerver={m and m.group(1)} szkript={m2 and m2.group(1)}')
    m = re.search(r'^const ANCESTOR_DEPTH_LIMIT = (\d+)', src, re.M)
    m2 = re.search(r'^OS_LANC_MELYSEG = (\d+)', script, re.M)
    check('10 OS_LANC_MELYSEG == ANCESTOR_DEPTH_LIMIT', m and m2 and m.group(1) == m2.group(1),
          f'szerver={m and m.group(1)} szkript={m2 and m2.group(1)}')

    os.remove(DB_PATH)
    if FAILS:
        sys.stderr.write('\nBUKOTT: ' + ', '.join(FAILS) + '\n')
        return 1
    print('\nminden teszt atment')
    return 0


if __name__ == '__main__':
    sys.exit(main())
