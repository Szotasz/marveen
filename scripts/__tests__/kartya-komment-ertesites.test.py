#!/usr/bin/env python3
"""KOMMENTERTESITES922: komment-modban a MAS FELELOSU kartya ertesites nelkul MEGTAGADVA.

AZ ESET (Marveen, 2026-09-22): az eszkoz komment-only modban eddig csak KIIRTA, hogy
`Ertesites: nem ment (komment-only)`. Egyetlen napon tizszer elolvasta es tovabbment, kozben egy
merge-rol csak a kartyara irt -- egy tars allapot-kepe elavult. Egy jelzes, amit megszoktunk, nem
kapu. Mira mutatott ra, hogy memoriaba irni ezt NEM lezaras.

A KAPU HATARA SZANDEKOS, es a ket negativ kontroll itt all:
  - sajat kartya (felelos == szerzo) ATMEGY,
  - kulso (nem flotta) felelos ATMEGY.
Enelkul a kapu "mukodne", de kozben a mindennapi hasznalatot is megtagadna.

Futtatas:  python3 scripts/__tests__/kartya-komment-ertesites.test.py
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-komment-sandbox-')
DB_PATH = None
FAILS = []


DB_SZAM = 0


def check(name, cond, detail=''):
    global DB_SZAM
    DB_SZAM += 1
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def fresh_db(path):
    db = sqlite3.connect(path)
    db.executescript('''
      CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'planned', assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal',
        project TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
        parent_id TEXT, dispatched_at INTEGER);
      CREATE TABLE kanban_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL,
        author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        result TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER);
    ''')
    now = int(time.time())
    # ugyanaz a kartya HAROMFELE felelossel: flotta-tars, sajat, kulso
    for cid, who in (('MASE922', 'samu'), ('ENYEM922', 'geri'), ('KULSO922', 'zollak'),
                     ('ATADAS922', 'geri')):
        db.execute('INSERT INTO kanban_cards (id,title,assignee,status,priority,created_at,updated_at)'
                   " VALUES (?,?,?,'planned','normal',?,?)",
                   (cid, f'teszt kartya {cid}', who, now, now))
    db.commit(); db.close()


def run(card_id, author, extra=()):
    d = tempfile.mkdtemp(prefix='kartya-k-')
    cf = os.path.join(d, 'komment.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write('Ez egy próba-komment, ékezetes szöveggel, hogy az ékezet-kapu ne ezen akadjon fenn.')
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    return subprocess.run([sys.executable, SCRIPT, '--id', card_id, '--comment-file', cf,
                           '--author', author, *extra],
                          capture_output=True, text=True, env=env, timeout=30)


def kommentek(card_id):
    db = sqlite3.connect(DB_PATH)
    n = db.execute('SELECT count(*) FROM kanban_comments WHERE card_id=?', (card_id,)).fetchone()[0]
    db.close()
    return n


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-komment-'); os.close(fd); os.remove(DB_PATH)
    fresh_db(DB_PATH)

    # 1. POZITIV ESET: mas flotta-agens a felelos, nincs kimondott kapcsolo -> MEGTAGADVA
    p = run('MASE922', 'Geri')
    out = p.stdout + p.stderr
    check('1 mas flotta-felelosu kartyan a komment MEGTAGADVA', p.returncode != 0 and 'MEGTAGADVA' in out, out)
    check('1 a megtagadas MEGNEVEZI a felelost', 'samu' in out, out)
    check('1 a megtagadas megadja a HELYES utat is (agent-msg-send.sh)', 'agent-msg-send.sh' in out, out)
    check('1 a megtagadas megnevezi a kimondott kapcsolot',
          '--nincs-ertesites-szandekos' in out, out)
    check('1 es a komment NEM irodott be (a kapu az IRAS ELOTT all)', kommentek('MASE922') == 0,
          f'kommentek={kommentek("MASE922")}')

    # 2. NEGATIV KONTROLL: sajat kartya -> ATMEGY, es a komment be is irodik.
    # Enelkul a kapu "zold" lenne akkor is, ha MINDENT megtagad.
    p = run('ENYEM922', 'Geri')
    out = p.stdout + p.stderr
    check('2 sajat kartyan a komment ATMEGY', p.returncode == 0 and 'KOMMENT OK' in out, out)
    check('2 es a komment tenyleg be is irodott', kommentek('ENYEM922') == 1)

    # 3. NEGATIV KONTROLL: kulso (nem flotta) felelos -> ATMEGY. Nekik nem inter-agent uzenet megy.
    p = run('KULSO922', 'Geri')
    out = p.stdout + p.stderr
    check('3 kulso felelosu kartyan a komment ATMEGY', p.returncode == 0 and 'KOMMENT OK' in out, out)
    check('3 es a komment tenyleg be is irodott', kommentek('KULSO922') == 1)

    # 4. A KIMONDOTT KAPCSOLO feloldja -- de csak kimondva.
    p = run('MASE922', 'Geri', extra=('--nincs-ertesites-szandekos',))
    out = p.stdout + p.stderr
    check('4 a --nincs-ertesites-szandekos ATENGEDI', p.returncode == 0 and 'KOMMENT OK' in out, out)
    check('4 es ilyenkor a komment be is irodik', kommentek('MASE922') == 1)

    # 5. ATADAS: a kartya MA az enyem, de ugyanez a futas ATADJA egy flotta-tarsnak.
    # Az uj felelosnek tudnia kell rola, tehat a kapu ilyenkor is fog.
    p = run('ATADAS922', 'Geri', extra=('--assignee', 'samu'))
    out = p.stdout + p.stderr
    check('5 atadas kozben is MEGTAGADVA (az UJ felelos is szamit)',
          p.returncode != 0 and 'MEGTAGADVA' in out, out)
    check('5 es atadaskor sem irodott be a komment', kommentek('ATADAS922') == 0)

    # 6. DRY-RUN PARITAS: a kapu a dry-run agon is fog. Egy kapu, ami csak elesben fog,
    # a probat hamis biztonsagba ringatja.
    p = run('MASE922', 'Samu', extra=('--dry-run',))
    # MASE922 felelose samu, a szerzo most SAMU -> sajat kartya, tehat ATMEGY dry-runban is
    out = p.stdout + p.stderr
    check('6a dry-run + sajat kartya: ATMEGY', p.returncode == 0 and 'DRY-RUN OK' in out, out)
    p = run('MASE922', 'Geri', extra=('--dry-run',))
    out = p.stdout + p.stderr
    check('6b dry-run + mas felelos: MEGTAGADVA (paritas az eles aggal)',
          p.returncode != 0 and 'MEGTAGADVA' in out, out)

    print('')
    print(f'kartya-komment-ertesites: {DB_SZAM - len(FAILS)}/{DB_SZAM} allitas zold')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
