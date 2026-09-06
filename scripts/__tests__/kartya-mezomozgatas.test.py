#!/usr/bin/env python3
"""Test the comment-mode field move of scripts/kartya-es-ertesites.py (KARTYASTATUSZ906).

Boni's finding (msg 20271): `--status` and `--priority` were silently dropped in
comment mode. The output said OK, the comment was written, and the card never
moved -- a false success whose direction is wrong, because the card then stays
silent in the WRONG status while the tool reports success.

Drives the script as a subprocess against an isolated DB (KARTYA_DB). Run:
    python3 scripts/__tests__/kartya-mezomozgatas.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
DB_PATH = None
FAILS = []
# SANDBOX-GYOKER: minden futas ide oldja fel a gyokeret, ha a KARTYA_DB-t barmi elrontja.
# Egy MUTACIOS KONTROLL, ami az ut-feloldast tori el, kulonben az ELES tablat irna --
# 2026-09-06-an pontosan ez tortent, egy teszt-kartya keletkezett az eles tablan.
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-sandbox-')


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
    db.commit()
    db.close()


def seed(card_id, status='planned', priority='normal'):
    db = sqlite3.connect(DB_PATH)
    now = int(time.time())
    db.execute('INSERT INTO kanban_cards (id,title,status,assignee,priority,created_at,updated_at)'
               ' VALUES (?,?,?,?,?,?,?)', (card_id, f'teszt {card_id}', status, 'boni', priority, now, now))
    db.commit()
    db.close()


def comment(card_id, text, extra=()):
    d = tempfile.mkdtemp(prefix='kartya-m-')
    cf = os.path.join(d, 'c.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write(text)
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--comment-file', cf, '--author', 'Boni', *extra],
        capture_output=True, text=True, env=env, timeout=30)


def card(card_id):
    db = sqlite3.connect(DB_PATH)
    r = db.execute('SELECT status,priority FROM kanban_cards WHERE id=?', (card_id,)).fetchone()
    db.close()
    return r


def title(card_id):
    db = sqlite3.connect(DB_PATH)
    r = db.execute('SELECT title FROM kanban_cards WHERE id=?', (card_id,)).fetchone()
    db.close()
    return r[0] if r else None


def comments(card_id):
    db = sqlite3.connect(DB_PATH)
    r = db.execute('SELECT content FROM kanban_comments WHERE card_id=? ORDER BY id', (card_id,)).fetchall()
    db.close()
    return [x[0] for x in r]


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-m-')
    os.close(fd); os.remove(DB_PATH)
    fresh_db(DB_PATH)

    # 1. A LELET MAGA: --status komment-modban tenylegesen mozgat.
    seed('MOZGA906', 'planned')
    p = comment('MOZGA906', 'Kartya MOZGA906: a vevo valaszara var.', ('--status', 'waiting'))
    check('1 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('1 a statusz TENYLEG waiting lett', card('MOZGA906')[0] == 'waiting',
          f'kapott: {card("MOZGA906")}')
    check('1 a komment is beirt', any('vevo valaszara var' in c for c in comments('MOZGA906')))
    check('1 a kimenet kimondja a mozgatast', 'MEZOMOZGATAS OK' in p.stdout, p.stdout)
    check('1 nyom-komment a mozgatasrol', any('Mezomozgatas' in c for c in comments('MOZGA906')))

    # 2. --priority ugyanezen az uton, es a ketto egyutt is.
    seed('MOZGB906', 'planned', 'normal')
    p = comment('MOZGB906', 'Kartya MOZGB906: surgos lett.', ('--status', 'in_progress', '--priority', 'high'))
    check('2 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('2 mindket mezo mozdult', card('MOZGB906') == ('in_progress', 'high'), f'kapott: {card("MOZGB906")}')

    # 3. Nem-adott kapcsolo NEM ir felul (a None-alapertelmezes lenyege).
    seed('MOZGC906', 'waiting', 'high')
    p = comment('MOZGC906', 'Kartya MOZGC906: csak komment, mezo nem.')
    check('3 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('3 a mezok valtozatlanok', card('MOZGC906') == ('waiting', 'high'), f'kapott: {card("MOZGC906")}')
    check('3 nincs mozgatas-nyom', not any('Mezomozgatas' in c for c in comments('MOZGC906')))

    # 4. Mar ezen az erteken all: KIMONDJA, nem hallgat rola (a csendes no-op ugyanaz a hibaosztaly).
    seed('MOZGD906', 'waiting')
    p = comment('MOZGD906', 'Kartya MOZGD906: mar waiting.', ('--status', 'waiting'))
    check('4 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('4 kimondja hogy nem mozgat', 'mar ezen az erteken all' in p.stdout, p.stdout)

    # 5. Ervenytelen ertek: megtagadas, es a komment SEM irodik be.
    seed('MOZGE906', 'planned')
    p = comment('MOZGE906', 'Kartya MOZGE906: elgepelt statusz.', ('--status', 'varakozik'))
    check('5 megtagadva', p.returncode != 0)
    check('5 a statusz valtozatlan', card('MOZGE906')[0] == 'planned')
    check('5 a komment sem irodott be', comments('MOZGE906') == [], f'kapott: {comments("MOZGE906")}')

    # 6. Nem letezo kartya: a mezomozgatas nem hozhat letre semmit.
    p = comment('NINCSILYEN906', 'Kartya NINCSILYEN906: nincs ilyen.', ('--status', 'done'))
    check('6 megtagadva nem letezo kartyara', p.returncode != 0)
    check('6 nem hozott letre kartyat', card('NINCSILYEN906') is None)

    # 7. A letrehozo ag alapertelmezese valtozatlan (a None-ra allitott default regresszioja).
    # PROBA-HIGIENIA: a KARTYA_API-t akkor is elteritjuk, ha ez az ag nem kuld -- egy jovobeli
    # szerkesztes ne tudjon az ELES uzenetsorba irni egy teszt futasabol. (Ez a teszt elso
    # valtozata pontosan ezt tette: letrehozott egy valodi sort a sorban.)
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    env['KARTYA_API'] = 'http://127.0.0.1:1/api/messages'
    p = subprocess.run([sys.executable, SCRIPT, '--id', 'UJKARTYA906', '--assignee', 'marveen',
                        '--title', 'uj kartya teszt', '--no-msg'],
                       capture_output=True, text=True, env=env, timeout=30)
    check('7 letrehozo ag lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('7 alapertelmezes planned/normal maradt', card('UJKARTYA906') == ('planned', 'normal'),
          f'kapott: {card("UJKARTYA906")}')

    # 8. ELLENTMONDAS-KAPU: --no-msg + --msg-file egyszerre. Korabban atcsuszott es MEGIS kuldott.
    d = tempfile.mkdtemp(prefix='kartya-m3-')
    mf = os.path.join(d, 'm.txt')
    open(mf, 'w', encoding='utf-8').write('Kartya ELLENT906: ellentmondo kapcsolok.')
    p = subprocess.run([sys.executable, SCRIPT, '--id', 'ELLENT906', '--assignee', 'marveen',
                        '--title', 'ellentmondas teszt', '--msg-file', mf, '--no-msg'],
                       capture_output=True, text=True, env=env, timeout=30)
    # A puszta nem-nulla exit itt NEM eleg: a kapu nelkul is elbukna az uzenetkuldesen (a
    # KARTYA_API elteritve). A megtagadas SZOVEGERE allitunk, kulonben ez a check a helyes
    # eredmenyt rossz okbol fogadna el.
    check('8 megtagadva a --no-msg + --msg-file paros',
          p.returncode != 0 and 'ellentmond' in (p.stdout + p.stderr), p.stdout + p.stderr)
    check('8 kartyat sem hozott letre', card('ELLENT906') is None)

    # 9. A CIM is mozgathato -- enelkul a flotta-szabaly fele ("cimre az eszkoz --title-je")
    #    hamis marad, es a kartya-cim javitasa nyers sqlite3-hoz kenyszerit.
    seed('CIMMOZG906')
    p = comment('CIMMOZG906', 'Kartya CIMMOZG906: pontositott cim.',
                ('--title', 'CIMMOZG906: az uj, pontos cim. Gazda: boni, hatarido 2026-09-09.'))
    check('9 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('9 a cim tenyleg valtozott', title('CIMMOZG906').startswith('CIMMOZG906: az uj'),
          f'kapott: {title("CIMMOZG906")}')

    # 10. A MOZGATAS NEM KERULHETI MEG a 300 karakteres cim-kaput -- kulonben az uj ut pont
    #     azt a triggert engedne be, ami a letrehozo agon meg van fogva.
    seed('CIMHOSSZ906')
    regi = title('CIMHOSSZ906')
    p = comment('CIMHOSSZ906', 'Kartya CIMHOSSZ906: tul hosszu cim.', ('--title', 'X' * 301))
    check('10 megtagadva a 300 feletti cim', p.returncode != 0 and '300' in (p.stdout + p.stderr),
          p.stdout + p.stderr)
    check('10 a cim valtozatlan', title('CIMHOSSZ906') == regi)
    check('10 a komment sem irodott be', comments('CIMHOSSZ906') == [])

    # 11. GYOKER-FELOLDAS: hianyzo DB -> MEGTAGADAS, a feloldott utvonal kimondasaval.
    #     Enelkul az sqlite3.connect letrehozna egy ures fajlt, es a kartya-iras egy arva
    #     masolatba menne (worktree-alak). Boni merese, msg 20272.
    ures = tempfile.mkdtemp(prefix='kartya-gyoker-')
    d = tempfile.mkdtemp(prefix='kartya-m4-')
    cf = os.path.join(d, 'c.txt')
    open(cf, 'w', encoding='utf-8').write('Kartya MOZGA906: rossz gyokerrol.')
    env = dict(os.environ)
    env.pop('KARTYA_DB', None)
    env['CLAUDECLAW_ROOT'] = ures
    env['KARTYA_API'] = 'http://127.0.0.1:1/api/messages'
    p = subprocess.run([sys.executable, SCRIPT, '--id', 'MOZGA906', '--comment-file', cf,
                        '--author', 'Boni'], capture_output=True, text=True, env=env, timeout=30)
    ki = p.stdout + p.stderr
    check('11 megtagadva a hianyzo DB-nel', p.returncode != 0 and 'nem letezik' in ki, ki)
    check('11 kimondja a feloldott utvonalat', ures in ki, ki)
    check('11 NEM hozott letre ures DB-t', not os.path.exists(os.path.join(ures, 'store', 'claudeclaw.db')))

    # 12. Az env SORRENDJE: a KARTYA_DB felulirja a CLAUDECLAW_ROOT-ot (a worktree-futas ki
    #     tudja mondani, hogy az ELO tablat irja).
    env2 = dict(env); env2['KARTYA_DB'] = DB_PATH
    p = subprocess.run([sys.executable, SCRIPT, '--id', 'MOZGA906', '--comment-file', cf,
                        '--author', 'Boni'], capture_output=True, text=True, env=env2, timeout=30)
    check('12 a KARTYA_DB gyoz a CLAUDECLAW_ROOT felett', p.returncode == 0, p.stdout + p.stderr)

    # 13. A visszaolvasas MONDJA KI, melyik tarolobol olvasott (Boni kikotese): egy rossz gyoker
    #     mellett a visszaolvasas onmagaban konzisztens lenne, csak nem az eles tablan.
    check('13 a visszaolvasas megnevezi a DB-t', DB_PATH in p.stdout, p.stdout)

    os.remove(DB_PATH)
    if FAILS:
        sys.stderr.write('\nBUKOTT: ' + ', '.join(FAILS) + '\n')
        return 1
    print('\nminden teszt atment')
    return 0


if __name__ == '__main__':
    sys.exit(main())
