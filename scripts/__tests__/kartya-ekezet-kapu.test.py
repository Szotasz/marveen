#!/usr/bin/env python3
"""Test the accent gate of scripts/kartya-es-ertesites.py (EKEZETKAPU917).

2026-09-14 ota egy JELZES allt itt ("nem allitalak meg"). 2026-09-17-en KET agens
(Mira es Marveen) futott bele UGYANAZON A NAPON, es MINDKET ekezet nelkuli szoveg
KIMENT -- vagyis a jelzes nulla esetben allitott meg barmit is. Egy kapu, ami soha
nem fog, pontosan annyit er, mintha nem lenne ott; a jelenlete viszont megnyugtat.

Amit ez a teszt ALLIT, es amit a jelzes-valtozat NEM tudott volna teljesiteni:
  1. a megtagadas UTAN a komment NINCS a tablaban (a kapu az IRAS ELOTT all);
  2. a kimondott felulbiralas atenged, es a sor VALOBAN bekerul;
  3. a rovid szoveg es az ekezetes szoveg valtozatlanul megy (nincs uj hamis pozitiv);
  4. a CIM-re nem vonatkozik (gazda-szabaly, 2026-09-07: a cim maradhat ekezet nelkul).

Run:  python3 scripts/__tests__/kartya-ekezet-kapu.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-ekezet-sandbox-')
DB_PATH = None
FAILS = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def fresh_db(path):
    db = sqlite3.connect(path)
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


def comment(card_id, text, extra=()):
    d = tempfile.mkdtemp(prefix='kartya-e-')
    cf = os.path.join(d, 'c.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write(text)
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--comment-file', cf, '--author', 'Boni', *extra],
        capture_output=True, text=True, env=env, timeout=30)


def db_count(card_id):
    db = sqlite3.connect(DB_PATH)
    n = db.execute('SELECT COUNT(*) FROM kanban_comments WHERE card_id=?', (card_id,)).fetchone()[0]
    db.close()
    return n


# A KUSZOB A SCRIPTBEN 300 karakter: az alatta levo szoveg (nyers ertek, log-sor) szabad.
HOSSZU_EKEZET_NELKUL = ('Ez egy hosszu magyar mondat ekezetek nelkul, ami pontosan azt a hibat '
                        'mutatja be, amit a kapu fogni hivatott, es eleg hosszu ahhoz, hogy '
                        'atlepje a kuszobot, tehat a kapu latni fogja. ') * 2
HOSSZU_EKEZETTEL = ('Ez egy hosszú magyar mondat ékezetekkel, ami a rendes esetet mutatja be, és '
                    'elég hosszú ahhoz, hogy átlépje a küszöböt, tehát a kapu látni fogja, '
                    'és át kell engednie. ') * 2


def main():
    global DB_PATH
    d = tempfile.mkdtemp(prefix='kartya-ekezet-db-')
    DB_PATH = os.path.join(d, 'test.db')
    fresh_db(DB_PATH)
    assert len(HOSSZU_EKEZET_NELKUL) >= 300 and len(HOSSZU_EKEZETTEL) >= 300

    # 1. Hosszu, ekezet nelkuli komment -> MEGTAGADVA, ES A SOR NEM KELETKEZIK MEG.
    #    A masodik fele a lenyeg: jelzeskent a sor MAR BENT VOLT, mire a figyelmeztetes megjelent.
    seed('EKEZET1')
    r = comment('EKEZET1', HOSSZU_EKEZET_NELKUL)
    check('ekezet nelkuli hosszu komment MEGTAGADVA', r.returncode != 0, f'rc={r.returncode}')
    check('MEGTAGADVA szo a kimenetben', 'MEGTAGADVA' in (r.stdout + r.stderr))
    check('a megtagadott komment NEM keletkezett meg', db_count('EKEZET1') == 0,
          f'{db_count("EKEZET1")} sor a tablaban')

    # 2. Kimondott felulbiralas -> atengedi, ES a sor VALOBAN bekerul.
    seed('EKEZET2')
    r = comment('EKEZET2', HOSSZU_EKEZET_NELKUL, ('--ekezet-nelkul-szandekos',))
    check('kimondott felulbiralas atenged', r.returncode == 0, f'rc={r.returncode} {r.stderr[:200]}')
    check('felulbiralassal a sor BEKERULT', db_count('EKEZET2') == 1)
    check('a felulbiralas nyomot hagy a stderr-en', 'felulbiralas' in r.stderr.lower())

    # 3. Ekezetes hosszu komment -> valtozatlanul megy (nincs uj hamis pozitiv).
    seed('EKEZET3')
    r = comment('EKEZET3', HOSSZU_EKEZETTEL)
    check('ekezetes hosszu komment atmegy', r.returncode == 0, f'rc={r.returncode} {r.stderr[:200]}')
    check('ekezetes komment bekerult', db_count('EKEZET3') == 1)

    # 4. Rovid, ekezet nelkuli szoveg (nyers ertek, log-sor) -> szabad, a kuszob alatt.
    seed('EKEZET4')
    r = comment('EKEZET4', 'run 35193869763 conclusion=success 98s')
    check('rovid ekezet nelkuli szoveg szabad', r.returncode == 0, f'rc={r.returncode} {r.stderr[:200]}')
    check('rovid szoveg bekerult', db_count('EKEZET4') == 1)

    # 5. ARANY-KAPU (EKEZETARANY921, 2026-09-21). Az elozo alak `any`-predikatum volt: egy 800+
    #    karakteres, ekezet nelkuli szoveg ATMENT, ha a vegen allt EGY ekezetes szo (Marveen merese:
    #    831 karakter, 0,36 szazalek). Ez a kartya KAPUJA: a token-ekezetes hosszu szoveg MEGTAGADVA,
    #    a 3. eset (rendesen ekezetezett, 10,6 szazalek) valtozatlanul atmegy -- a ketto EGYUTT a
    #    bizonyitek, kulon egyik sem.
    TOKEN_EKEZET = (HOSSZU_EKEZET_NELKUL + ' ' + HOSSZU_EKEZET_NELKUL + ' ' + HOSSZU_EKEZET_NELKUL
                    + ' A cim: Telepítő.')
    assert len(TOKEN_EKEZET) >= 800
    betuk = [ch for ch in TOKEN_EKEZET if ch.isalpha()]
    arany = sum(1 for ch in betuk if ch in 'áéíóöőúüűÁÉÍÓÖŐÚÜŰ') / len(betuk)
    assert arany < 0.01, arany
    seed('EKEZET5')
    r = comment('EKEZET5', TOKEN_EKEZET)
    check('5 hosszu szoveg EGY ekezetes szoval MEGTAGADVA (arany-kapu, nem jelenlet-kapu)',
          r.returncode != 0 and 'MEGTAGADVA' in (r.stdout + r.stderr), f'rc={r.returncode} {(r.stdout + r.stderr)[:200]}')
    check('5 a megtagadas kimondja a MERT aranyt es a kuszobot',
          'ekezet-arany' in (r.stdout + r.stderr) and '4%' in (r.stdout + r.stderr), (r.stdout + r.stderr)[:300])
    check('5 a sor NEM keletkezett meg', db_count('EKEZET5') == 0, f'{db_count("EKEZET5")} sor')
    #    A kiut MEGMARAD (Marveen kikotese): ugyanez a szoveg kimondott felulbiralassal bemegy.
    seed('EKEZET6')
    r = comment('EKEZET6', TOKEN_EKEZET, ('--ekezet-nelkul-szandekos',))
    check('5 kimondott felulbiralassal a token-ekezetes szoveg is bemegy', r.returncode == 0 and db_count('EKEZET6') == 1,
          f'rc={r.returncode} {r.stderr[:200]}')
    #    Es a hatar-eset a kuszob FELETT: 5 szazalekos szoveg atmegy (a kuszob 4, nem 10).
    ot_szazalek = ('Ez egy mérés a tábla adatán, a küszöb fölött. ' * 3
                   + 'A tobbi resz szandekosan nyers log es azonosito, ekezet nelkul, hogy az arany ot szazalek korul legyen. ' * 4)
    betuk = [ch for ch in ot_szazalek if ch.isalpha()]
    arany = sum(1 for ch in betuk if ch in 'áéíóöőúüűÁÉÍÓÖŐÚÜŰ') / len(betuk)
    assert 0.04 <= arany <= 0.08, arany
    seed('EKEZET7')
    r = comment('EKEZET7', ot_szazalek)
    check(f'5 kuszob feletti ({arany:.1%}) szoveg atmegy', r.returncode == 0 and db_count('EKEZET7') == 1,
          f'rc={r.returncode} {r.stderr[:200]}')

    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {FAILS}", file=sys.stderr)
        sys.exit(1)
    print(f"\nOK: {7} eset, mind zold.")


if __name__ == '__main__':
    main()
