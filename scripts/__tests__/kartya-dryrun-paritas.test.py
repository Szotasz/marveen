#!/usr/bin/env python3
"""Dry-run / live parity for scripts/kartya-es-ertesites.py (KARTYADRYRUN907).

Mira's finding (2026-09-07): `--dry-run` returned OK for a card id that ALREADY
EXISTED, while the same command without `--dry-run` was refused. The exact use the
flag exists for -- "would this go through?" -- was the one that broke. A dry-run
that is MORE PERMISSIVE than the live path is worse than none: it returns green for
what the system rejects.

The assertion here is PARITY, not "dry-run refuses": both directions must agree, so
a future divergence on either side goes red.

Drives the script as a subprocess against an isolated DB (KARTYA_DB). Run:
    python3 scripts/__tests__/kartya-dryrun-paritas.test.py
Exit 0 = all pass; non-zero = a failure.
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
FAILS = []

# KET SANDBOX-GYOKER, mert az egyik or eppen a token HIANYAT meri:
#   TOKEN_ROOT  -- van store/.dashboard-token
#   NOTOKEN_ROOT -- nincs
TOKEN_ROOT = tempfile.mkdtemp(prefix='kartya-dry-tok-')
NOTOKEN_ROOT = tempfile.mkdtemp(prefix='kartya-dry-notok-')
os.makedirs(os.path.join(TOKEN_ROOT, 'store'))
os.makedirs(os.path.join(NOTOKEN_ROOT, 'store'))
with open(os.path.join(TOKEN_ROOT, 'store', '.dashboard-token'), 'w') as f:
    f.write('teszt-token')
DB_PATH = os.path.join(TOKEN_ROOT, 'store', 'claudeclaw.db')


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def fresh_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript('''
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
    ''')
    db.commit(); db.close()


def seed(card_id):
    db = sqlite3.connect(DB_PATH)
    now = int(time.time())
    db.execute('INSERT INTO kanban_cards (id,title,status,assignee,priority,created_at,updated_at)'
               ' VALUES (?,?,?,?,?,?,?)', (card_id, f'teszt {card_id}', 'planned', 'boni', 'normal', now, now))
    db.commit(); db.close()


def exists(card_id):
    db = sqlite3.connect(DB_PATH)
    r = db.execute('SELECT 1 FROM kanban_cards WHERE id=?', (card_id,)).fetchone()
    db.close()
    return r is not None


def run(card_id, extra=(), root=TOKEN_ROOT):
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = root
    return subprocess.run(
        # A --author KIMONDVA megy, holott a LETREHOZO agon nem kotelezo: enelkul a felado
        # csendben 'marveen' lenne, es a teszt sorai MAS agens neveben mennenek ki. (A teszt
        # egy korabbi valtozata azt allitotta, hogy az --author a letrehozo agon KOTELEZO --
        # 2026-09-08-an visszamerve ez NEM igaz: a kotelezoseg CSAK a komment-modra all, es a
        # letrehozo ag alapertelmezeset a kartya-ertesites-felado teszt 3. ellenorzese
        # regresszio-kontrollkent rogziti.)
        # A CIM HORGONYA (KARTYAHORGONY906): a cimnek tartalmaznia kell a kartya sajat ID-jet,
        # kulonben a futas MAR A HORGONY-KAPUN elhal, es a teszt a ROSSZ OKBOL lenne piros.
        # Ez a kapu UJABB, mint a teszt elso valtozata -- merve 2026-09-08-an: mind az ot
        # "paritas" ellenorzes ezen bukott, nem a merni kivant viselkedesen.
        [sys.executable, SCRIPT, '--id', card_id, '--assignee', 'boni',
         '--title', f'{card_id} paritas teszt',
         '--author', 'Boni', *extra],
        capture_output=True, text=True, env=env, timeout=30)


def msgfile(card_id):
    d = tempfile.mkdtemp(prefix='kartya-dry-msg-')
    p = os.path.join(d, 'm.txt')
    with open(p, 'w', encoding='utf-8') as f:
        f.write(f'Kartya: {card_id} -- teszt uzenet.\n')
    return p


fresh_db()

# --- 1. A LELET MAGA: letezo ID-n a ket ag EGYETERT (mindketto megtagad) ---
seed('LETEZO1')
dry = run('LETEZO1', ('--no-msg', '--dry-run'))
live = run('LETEZO1', ('--no-msg',))
check('1 dry-run megtagadja a letezo ID-t', dry.returncode != 0, f'exit={dry.returncode} out={dry.stdout!r}')
check('2 az eles ag is megtagadja', live.returncode != 0, f'exit={live.returncode}')
check('3 PARITAS: a ket ag ugyanazt az okot mondja',
      'MAR LETEZIK' in (dry.stdout + dry.stderr) and 'MAR LETEZIK' in (live.stdout + live.stderr),
      f'dry={dry.stdout + dry.stderr!r}')

# --- 2. A JO UT NEM TORT EL: uj ID-n a dry-run zold, ES nem ir semmit ---
dry_uj = run('UJKARTYA1', ('--no-msg', '--dry-run'))
check('4 uj ID-n a dry-run tovabbra is zold', dry_uj.returncode == 0, f'exit={dry_uj.returncode} err={dry_uj.stderr!r}')
check('5 a dry-run NEM hozta letre a kartyat', not exists('UJKARTYA1'))

# --- 3. TOKEN-OR: uzenettel, token nelkul az eles ag RESZLEGESEN irna (kartya igen, uzenet nem) ---
mf = msgfile('TOKENUJ1')
dry_notok = run('TOKENUJ1', ('--msg-file', mf, '--dry-run'), root=NOTOKEN_ROOT)
check('6 token nelkul + uzenettel a dry-run megtagad', dry_notok.returncode != 0, f'exit={dry_notok.returncode}')
check('7 es kimondja, hogy a kartya eles futasban MAR LETREJONNE',
      'LETREJONNE' in (dry_notok.stdout + dry_notok.stderr), f'{dry_notok.stdout + dry_notok.stderr!r}')
check('8 a megtagadott dry-run semmit nem irt', not exists('TOKENUJ1'))

# --- 4. NEGATIV KONTROLL: az or NEM tulzottan szeles ---
dry_tok = run('TOKENUJ2', ('--msg-file', msgfile('TOKENUJ2'), '--dry-run'), root=TOKEN_ROOT)
check('9 letezo tokennel ugyanaz a futas zold', dry_tok.returncode == 0, f'exit={dry_tok.returncode} err={dry_tok.stderr!r}')
dry_nomsg = run('TOKENUJ3', ('--no-msg', '--dry-run'), root=NOTOKEN_ROOT)
check('10 token nelkul, de --no-msg mellett zold (az or az UZENET-utra szol)',
      dry_nomsg.returncode == 0, f'exit={dry_nomsg.returncode} err={dry_nomsg.stderr!r}')

# --- 5. ELOZMENY-FIGYELMEZTETES: A DRY-RUN AG NEM LEHET VAKABB AZ ELESNEL ---
# Mira lelete, 2026-09-11: a figyelmeztetes eloszor CSAK az eles agon futott, mert a
# komment-mod dry-run `return`-je elotte allt. Ezzel EPP a gondos hasznalot buntette --
# aki elovigyazatossagbol dry-runol egy mezomozgatas elott, kevesebbet latott, mint aki
# gondolkodas nelkul nekifutott. A paritas itt nem elmeleti: a negyedik utkozest pont az
# elozetes ellenorzes elozne meg.
seed('ELOZM1')
# elso mozgatas MARVEEN neveben (eles), hogy legyen elozmeny-nyom
run('ELOZM1', ('--comment-file', msgfile('ELOZM1'), '--author', 'Marveen', '--status', 'in_progress'))
# majd MIRA neveben dry-run: MAS szerzo, 30 percen belul -> HANGOS figyelmeztetes kell
d = run('ELOZM1', ('--comment-file', msgfile('ELOZM1'), '--author', 'Mira', '--status', 'planned', '--dry-run'))
out_d = d.stdout + d.stderr
check('11 a dry-run ag is kiirja az elozmeny-figyelmeztetest',
      'AZ ELOZO MEZOMOZGATAS' in out_d, f'{out_d!r}')
check('12 es a dry-run NEM allitja, hogy vegrehajtja',
      'most semmi nem irodik' in out_d and 'A mozgatast VEGREHAJTOM' not in out_d, f'{out_d!r}')
# NEGATIV KONTROLL: ugyanaz a szerzo -> csak a halk sor, hangos NEM
d2 = run('ELOZM1', ('--comment-file', msgfile('ELOZM1'), '--author', 'Marveen', '--status', 'planned', '--dry-run'))
out_d2 = d2.stdout + d2.stderr
check('13 NEGATIV KONTROLL: sajat elozmenynel nincs hangos figyelmeztetes',
      'AZ ELOZO MEZOMOZGATAS' not in out_d2 and 'elozo mezomozgatas:' in out_d2, f'{out_d2!r}')

# --- 6. A TAROLT NYOM A TELJES REGI ERTEKET ORZI ---
# A valtoztatas LENYEGE: a kartya-mezo egyerteku, aki utoljara ir, felulir. A rovidített
# (60 karakteres) nyomból egy felulirt hosszu cimet nem lehetett visszaallitani -- pont
# akkor nem, amikor kellett volna. A konzol marad rovid, a TAROLT nyom teljes.
# A CIM HORGONYA (KARTYAHORGONY906) a kartya ID-jet koveteli -- enelkul a futas MAR A
# HORGONY-KAPUN elhalna, es ez a ket ellenorzes a ROSSZ OKBOL lenne piros.
HOSSZU = ('TELJES1 EREDETI HOSSZU CIM, amit vissza kell tudni allitani: '
          + 'x' * 120 + ' -- a vege is szamit')
seed('TELJES1')
_db = sqlite3.connect(DB_PATH)
_db.execute('UPDATE kanban_cards SET title=?, assignee=NULL WHERE id=?', (HOSSZU, 'TELJES1'))
_db.commit(); _db.close()
run('TELJES1', ('--comment-file', msgfile('TELJES1'), '--author', 'Marveen',
                '--title', 'TELJES1 uj rovid cim', '--assignee', 'samu'))
_db = sqlite3.connect(DB_PATH)
_nyom = _db.execute("SELECT content FROM kanban_comments WHERE card_id='TELJES1' AND "
                    "content LIKE '[kartya-es-ertesites.py] Mezomozgatas%' "
                    "ORDER BY created_at DESC LIMIT 1").fetchone()
_db.close()
_nyom = _nyom[0] if _nyom else ''
check('14 a tarolt nyom a TELJES regi cimet orzi (nem a 60 karakteres rovidítest)',
      HOSSZU in _nyom, f'{_nyom!r}')
check('15 a NULL regi ertek megkulonboztetheto az ures szotol',
      '(ures -- NULL volt)' in _nyom, f'{_nyom!r}')

print()
if FAILS:
    print(f'BUKOTT: {len(FAILS)} -- {", ".join(FAILS)}', file=sys.stderr)
    sys.exit(1)
print('minden teszt atment')
