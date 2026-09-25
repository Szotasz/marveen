#!/usr/bin/env python3
"""Az ekezet-kapu a LEIRASRA is -- EKEZETKAPU919, mindket agon.

A lelet (Marveen merte 2026-09-20, Geri visszamerte 2026-09-21): az `_ekezet_kapu`
PONTOSAN EGYSZER hivodott, a komment szovegere. A leiras egyik aga sem hivta, sem a
letrehozo, sem a 2026-09-19 ota letezo mozgato. A leiras volt az utolso gazdanak szant
mezo, ami ekezet nelkul bement -- es a gazda ugyanugy OLVASSA, mint a kommentet.

Es nem kimaradas volt: a kod-komment a mozgato agon FELSOROLTA, mi fut ra ("homoglifa
igen, 300 karakter nem, horgony nem"), es az ekezet-kaput meg csak nem is emlitette.
A magabiztos, hianyos felsorolas rosszabb egy kimaradasnal, mert a kovetkezo olvaso
jogosan hiszi el.

AMIT EZ A TESZT ALLIT, es amit a javitas elotti szkript NEM tudott teljesiteni:
  1. a letrehozo agon a hosszu, ekezet nelkuli leiras MEGTAGADVA, es a KARTYA SEM JON LETRE;
  2. a mozgato agon ugyanez MEGTAGADVA, es a REGI leiras VALTOZATLAN (a kapu az IRAS ELOTT all);
  3. a kimondott felulbiralas MINDKET agon atenged, es a sor valoban bekerul;
  4. az ekezetes es a rovid leiras valtozatlanul megy (nincs uj hamis pozitiv);
  5. a megtagadas KIMONDJA, hogy a LEIRAS a baj, nem a komment -- kulonben az olvaso
     a rossz mezot javitja.

Run:  python3 scripts/__tests__/kartya-leiras-ekezet.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
# SANDBOX-GYOKER: ugyanaz a mutacios kontroll, mint a testver-teszteknel -- ha az
# ut-feloldas eltorik, ez tartja tavol a futast az ELES tablatol.
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-leiras-ekezet-sandbox-')
DB_PATH = None
FAILS = []

# A kuszob a szkriptben 300 karakter ES 4 szazalek ekezet-arany.
NELKUL = ('Ez egy hosszu magyar leiras ekezetek nelkul, ami pontosan azt a hibat mutatja be, '
          'amit a kapu fogni hivatott, es eleg hosszu ahhoz, hogy atlepje a kuszobot. ') * 3
EKEZETTEL = ('Ez egy hosszú magyar leírás rendes ékezetekkel, ami a szabályos esetet mutatja be, '
             'és elég hosszú ahhoz, hogy átlépje a küszöböt, tehát a kapunak át kell engednie. ') * 3
ROVID = 'run 35585906615 conclusion=success 18s'


LEFUTOTT = [0]


def check(name, cond, detail=''):
    LEFUTOTT[0] += 1
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


def env():
    e = dict(os.environ)
    e['KARTYA_DB'] = DB_PATH
    e['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    # Zart port: ha barmi MEGIS POST-olni akarna, az itt HIBAKENT latszik, nem csendben megy ki.
    e['KARTYA_API'] = 'http://127.0.0.1:9/api/messages'
    return e


def fajl(nev, tartalom):
    d = tempfile.mkdtemp(prefix='kartya-le-')
    p = os.path.join(d, nev)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(tartalom)
    return p


def letrehoz(card_id, leiras, extra=()):
    """Letrehozo ag. --no-msg + gazda-felelos: igy nem kell ertesites-stub."""
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--assignee', 'szabolcs',
         '--title', f'{card_id} teszt cim', '--desc-file', fajl('d.txt', leiras),
         '--no-msg', '--author', 'Geri', *extra],
        capture_output=True, text=True, env=env(), timeout=30)


def seed(card_id, leiras):
    db = sqlite3.connect(DB_PATH)
    now = int(time.time())
    db.execute('INSERT INTO kanban_cards (id,title,description,status,assignee,priority,created_at,updated_at)'
               ' VALUES (?,?,?,?,?,?,?,?)',
               (card_id, f'{card_id} teszt cim', leiras, 'planned', 'geri', 'normal', now, now))
    db.commit(); db.close()


def mozgat(card_id, uj_leiras, extra=()):
    """Mozgato ag: a leiras-csere KOMMENTHEZ KOTOTT, ezert a komment is megy."""
    cf = fajl('c.txt', 'Ez a csere indoklása, rendes ékezetekkel, hogy a komment-kapu ne szóljon bele.')
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--comment-file', cf, '--author', 'Geri',
         '--desc-file', fajl('d.txt', uj_leiras), *extra],
        capture_output=True, text=True, env=env(), timeout=30)


def kartya(card_id):
    db = sqlite3.connect(DB_PATH)
    r = db.execute('SELECT description FROM kanban_cards WHERE id=?', (card_id,)).fetchone()
    db.close()
    return r


def main():
    global DB_PATH
    d = tempfile.mkdtemp(prefix='kartya-leiras-ekezet-db-')
    DB_PATH = os.path.join(d, 'test.db')
    fresh_db(DB_PATH)
    assert len(NELKUL) >= 300 and len(EKEZETTEL) >= 300 and len(ROVID) < 300

    # 1. LETREHOZO AG: hosszu, ekezet nelkuli leiras -> MEGTAGADVA, ES A KARTYA SEM JON LETRE.
    #    A masodik fele a lenyeg: a kapu az IRAS ELOTT all, nem utana panaszkodik.
    r = letrehoz('LEK1', NELKUL)
    ki = r.stdout + r.stderr
    check('1 letrehozo ag: ekezet nelkuli leiras MEGTAGADVA', r.returncode != 0 and 'MEGTAGADVA' in ki,
          f'rc={r.returncode} {ki[:200]}')
    check('1 a kartya NEM jott letre', kartya('LEK1') is None, str(kartya('LEK1'))[:120])

    # 2. A MEGTAGADAS KIMONDJA, MELYIK MEZO A BAJ. Enelkul az olvaso a kommentjet javitgatja,
    #    mikozben a leiras a hibas -- a ket mezo ugyanabban a hivasban van.
    check('2 a megtagadas a LEIRAST nevezi meg, nem a kommentet', 'leiras' in ki and 'kanban-leirast' in ki, ki[:300])
    check('2 a megtagadas kimondja a MERT aranyt es a kuszobot',
          'ekezet-arany' in ki and '4%' in ki, ki[:300])

    # 3. LETREHOZO AG, KIMONDOTT FELULBIRALAS -> atenged, es a kartya VALOBAN letrejon.
    r = letrehoz('LEK2', NELKUL, ('--ekezet-nelkul-szandekos',))
    check('3 letrehozo ag: felulbiralas atenged', r.returncode == 0, f'rc={r.returncode} {(r.stdout+r.stderr)[:300]}')
    check('3 a kartya letrejott a felulbiralassal', (kartya('LEK2') or [None])[0] == NELKUL)
    check('3 a felulbiralas nyomot hagy a stderr-en', 'felulbiralas' in r.stderr.lower(), r.stderr[:200])

    # 4. LETREHOZO AG: ekezetes es rovid leiras valtozatlanul megy (nincs uj hamis pozitiv).
    r = letrehoz('LEK3', EKEZETTEL)
    check('4 ekezetes leiras atmegy', r.returncode == 0 and (kartya('LEK3') or [None])[0] == EKEZETTEL,
          f'rc={r.returncode} {(r.stdout+r.stderr)[:200]}')
    r = letrehoz('LEK4', ROVID)
    check('4 rovid (kuszob alatti) leiras szabad', r.returncode == 0 and (kartya('LEK4') or [None])[0] == ROVID,
          f'rc={r.returncode} {(r.stdout+r.stderr)[:200]}')

    # 5. MOZGATO AG: a csere ekezet nelkuli szovegre MEGTAGADVA, ES A REGI LEIRAS VALTOZATLAN.
    #    Ez kulon kodut, ezert kulon eset: a javitas elott az egyik ag zold lehetett volna a masik nelkul.
    seed('LEK5', EKEZETTEL)
    r = mozgat('LEK5', NELKUL)
    ki5 = r.stdout + r.stderr
    check('5 mozgato ag: ekezet nelkuli uj leiras MEGTAGADVA', r.returncode != 0 and 'MEGTAGADVA' in ki5,
          f'rc={r.returncode} {ki5[:200]}')
    check('5 a REGI leiras valtozatlan maradt', (kartya('LEK5') or [None])[0] == EKEZETTEL)

    # 6. MOZGATO AG, KIMONDOTT FELULBIRALAS -> a csere valoban megtortenik.
    seed('LEK6', EKEZETTEL)
    r = mozgat('LEK6', NELKUL, ('--ekezet-nelkul-szandekos',))
    check('6 mozgato ag: felulbiralassal a csere megtortenik',
          r.returncode == 0 and (kartya('LEK6') or [None])[0] == NELKUL,
          f'rc={r.returncode} {(r.stdout+r.stderr)[:300]}')

    # 7. MOZGATO AG: ekezetes csere valtozatlanul megy.
    seed('LEK7', 'Régi leírás, ékezettel.')
    r = mozgat('LEK7', EKEZETTEL)
    check('7 mozgato ag: ekezetes csere atmegy',
          r.returncode == 0 and (kartya('LEK7') or [None])[0] == EKEZETTEL,
          f'rc={r.returncode} {(r.stdout+r.stderr)[:300]}')

    # A DARABSZAM SZAMOLT, NEM BEGEPELT: egy begepelt szam akkor is ugyanazt mondja, ha kozben
    # egy allitas kiesett a futasbol -- pont azt a valtozast rejtene el, amiert a teszt letezik.
    if FAILS:
        print(f"\n{len(FAILS)} FAILED a {LEFUTOTT[0]} allitasbol: {FAILS}", file=sys.stderr)
        sys.exit(1)
    print(f"\nOK: {LEFUTOTT[0]} allitas, mind zold.")


if __name__ == '__main__':
    main()
