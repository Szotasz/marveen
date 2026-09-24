#!/usr/bin/env python3
"""KANBANSTUCKBACKFILL924: a tomeges/gepi komment automated=1 jelet kap, es a jel nem esik le csendben.

AZ ESET (Marveen 29529, Geri merese 29524): a #1531 ota a /api/kanban/stuck a felelos SAJAT
kommentjet munka-nyomnak veszi, kiveve ha a sor automated=1. A 08-24-i cim->komment migraciot
es a 09-04-i sopreseket maga a felelos irta, tehat 81 kartya csak ettol allt "elkezdett, majd
beakadt"-kent a listan. A multat egy egyszeri backfill javitja; ez a teszt a JOVOT fogja:
  - komment-modban a --automated sor automated=1 (es a kimenet kimondja),
  - a kapcsolo NELKUL a sor automated=0 (negativ kontroll: a jel nem mindenhol 1),
  - az eszkoz sajat nyom-sorai ('kartya-es-ertesites' szerzo) automated=1,
  - #1531 ELOTTI DB-n (nincs oszlop) a --automated MEGTAGAD, es a komment NEM irodik be --
    eles es dry-run agon is. A jel csendes elhagyasa pont azt allitana elo, amit megelozne,
  - ugyanott a kapcsolo nelkuli komment tovabbra is megy (visszafele kompatibilis),
  - --automated komment-mod nelkul MEGTAGAD.

Futtatas:  python3 scripts/__tests__/kartya-automated-jel.test.py
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-automated-sandbox-')
FAILS = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def fresh_db(automated_oszlop):
    path = os.path.join(tempfile.mkdtemp(prefix='kartya-automated-db-'), 'kanban.db')
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
    if automated_oszlop:
        # ugyanaz az ALTER, amit a #1531 initDatabase-e futtat
        db.execute('ALTER TABLE kanban_comments ADD COLUMN automated INTEGER NOT NULL DEFAULT 0')
    now = int(time.time())
    db.execute('INSERT INTO kanban_cards (id,title,assignee,status,priority,created_at,updated_at)'
               " VALUES ('SAJAT924','teszt kartya','geri','planned','normal',?,?)", (now, now))
    db.commit(); db.close()
    return path


def run(db_path, extra=(), comment=True):
    d = tempfile.mkdtemp(prefix='kartya-a-')
    cf = os.path.join(d, 'komment.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write('Söprés-komment próbája, ékezetes szöveggel, hogy az ékezet-kapu ne ezen akadjon fenn.')
    env = dict(os.environ)
    env['KARTYA_DB'] = db_path
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    args = [sys.executable, SCRIPT, '--id', 'SAJAT924', '--author', 'geri', *extra]
    if comment:
        args += ['--comment-file', cf]
    return subprocess.run(args, capture_output=True, text=True, env=env, timeout=30)


def sorok(db_path):
    db = sqlite3.connect(db_path)
    cols = [r[1] for r in db.execute('PRAGMA table_info(kanban_comments)')]
    sel = 'author, automated' if 'automated' in cols else 'author, NULL'
    return db.execute(f'SELECT {sel} FROM kanban_comments ORDER BY id').fetchall()


# 1. uj sema, --automated -> automated=1, a kimenet kimondja
p = fresh_db(True)
r = run(p, ['--automated'])
s = sorok(p)
check('uj sema + --automated: a futas sikeres', r.returncode == 0, r.stderr + r.stdout)
check('uj sema + --automated: a komment-sor automated=1', s == [('geri', 1)], str(s))
check('uj sema + --automated: a kimenet kimondja a jelet', 'automated=1' in r.stdout, r.stdout)

# 2. negativ kontroll: kapcsolo nelkul automated=0
p = fresh_db(True)
r = run(p)
s = sorok(p)
check('uj sema, kapcsolo nelkul: a komment-sor automated=0 (munka-nyom marad)',
      r.returncode == 0 and s == [('geri', 0)], str(s) + r.stderr)

# 3. az eszkoz sajat nyom-sora (mezomozgatas) automated=1, a felhasznaloi komment 0 marad
p = fresh_db(True)
r = run(p, ['--status', 'in_progress'])
s = sorok(p)
check('mezomozgatas: a felhasznaloi komment 0, a kartya-es-ertesites nyom-sor 1',
      r.returncode == 0 and s == [('geri', 0), ('kartya-es-ertesites', 1)], str(s) + r.stderr)

# 4. #1531 elotti sema + --automated -> MEGTAGAD, semmi nem irodik (eles es dry-run)
p = fresh_db(False)
r = run(p, ['--automated'])
check('regi sema + --automated: MEGTAGADVA', r.returncode != 0 and 'MEGTAGADVA' in (r.stderr + r.stdout),
      r.stderr + r.stdout)
check('regi sema + --automated: a komment NEM irodott be', sorok(p) == [], str(sorok(p)))
r = run(p, ['--automated', '--dry-run'])
check('regi sema + --automated --dry-run: a dry-run is megtagad',
      r.returncode != 0 and 'MEGTAGADVA' in (r.stderr + r.stdout), r.stderr + r.stdout)

# 5. regi sema, kapcsolo nelkul: tovabbra is megy (visszafele kompatibilis)
p = fresh_db(False)
r = run(p, ['--status', 'in_progress'])
check('regi sema, kapcsolo nelkul: komment + nyom-sor beirodik',
      r.returncode == 0 and [a for a, _ in sorok(p)] == ['geri', 'kartya-es-ertesites'],
      str(sorok(p)) + r.stderr)

# 6. --automated komment-mod nelkul -> MEGTAGAD
p = fresh_db(True)
r = run(p, ['--automated', '--title', 'uj cim'], comment=False)
check('--automated --comment-file nelkul: MEGTAGADVA',
      r.returncode != 0 and 'csak komment-modban' in (r.stderr + r.stdout), r.stderr + r.stdout)

print()
if FAILS:
    print(f'kartya-automated-jel: {len(FAILS)} bukas')
    sys.exit(1)
print('kartya-automated-jel: minden allitas zold')
