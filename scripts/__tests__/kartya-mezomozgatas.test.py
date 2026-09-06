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


def seed(card_id, status='planned', priority='normal', assignee='boni'):
    db = sqlite3.connect(DB_PATH)
    now = int(time.time())
    db.execute('INSERT INTO kanban_cards (id,title,status,assignee,priority,created_at,updated_at)'
               ' VALUES (?,?,?,?,?,?,?)', (card_id, f'teszt {card_id}', status, assignee, priority, now, now))
    db.commit()
    db.close()


def felelos(card_id):
    db = sqlite3.connect(DB_PATH)
    r = db.execute('SELECT assignee FROM kanban_cards WHERE id=?', (card_id,)).fetchone()
    db.close()
    return r[0] if r else None


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
                        '--title', 'UJKARTYA906 uj kartya teszt', '--no-msg'],
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

    # ---------------------------------------------------------------------------
    # KARTYAKULDO906 FOLLOW-UP (2026-09-06): negy tetel a #1204 merge utan.
    # ---------------------------------------------------------------------------

    # 14. FELELOS-MOZGATAS (4. tetel). A lelet sajat hasznalatbol: a CONNMKT906-ot le kellett
    #     vennem a gazda sorarol, es az eszkoz nem tudta -- nyers sqlite3-hoz kellett nyulni,
    #     pont ahhoz az uthoz, amit nyugdijazni akar.
    seed('FELELOSA906', assignee='szabolcs')
    p = comment('FELELOSA906', 'Kartya FELELOSA906: a dontes visszakerul a vegrehajtohoz.',
                ('--assignee', 'samu'))
    check('14 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('14 a felelos TENYLEG samu lett', felelos('FELELOSA906') == 'samu', f'kapott: {felelos("FELELOSA906")}')
    check('14 a kimenet kimondja a mozgatast', 'MEZOMOZGATAS OK' in p.stdout, p.stdout)
    check('14 a nyom-komment nevezi a felelos-valtast',
          any('assignee' in c and 'szabolcs' in c and 'samu' in c
              for c in comments('FELELOSA906')), f'kapott: {comments("FELELOSA906")}')

    # 15. A KEVERES-KAPUT ki kellett engedni az --assignee-hoz. Ha ez visszazarul, a 14. teszt
    #     bukik -- de a --desc-file/--msg-file TOVABBRA IS tiltott komment-modban.
    d = tempfile.mkdtemp(prefix='kartya-m5-')
    df = os.path.join(d, 'd.txt'); open(df, 'w', encoding='utf-8').write('leiras')
    seed('KEVER906')
    p = comment('KEVER906', 'Kartya KEVER906: keveres.', ('--desc-file', df))
    check('15 a --desc-file tovabbra is tiltott komment-modban',
          p.returncode != 0 and 'nem keverheto' in (p.stdout + p.stderr), p.stdout + p.stderr)

    # 16. ISMERETLEN NEV, amin MASIK kartya sem all: megtagadas. A felelos-oszlop NEM zart halmaz
    #     (merve: 40 kulonbozo ertek), ezert nem nev-halmazt kapuzunk, hanem azt, hogy a nev
    #     letezik-e mar a tablan. Egy elgepeles kulonben sajat, egy-elemu oszlopot nyit.
    seed('FELELOSB906', assignee='samu')
    p = comment('FELELOSB906', 'Kartya FELELOSB906: elgepelt nev.', ('--assignee', 'samuu'))
    check('16 megtagadva az ismeretlen nev', p.returncode != 0 and 'nem ismert' in (p.stdout + p.stderr),
          p.stdout + p.stderr)
    check('16 a felelos valtozatlan', felelos('FELELOSB906') == 'samu')
    check('16 a komment SEM irodott be', comments('FELELOSB906') == [], f'kapott: {comments("FELELOSB906")}')
    check('16 felajanlja a hasonlo LETEZO nevet', 'samu' in p.stdout + p.stderr)

    # 17. UGYANAZ A NEV, KIMONDVA (--assignee-uj): atmegy, es a KIS/NAGYBETU SZO SZERINT marad.
    #     A tablan a kulso GitHub-nevek vegyes alakban allnak (Vlbbtabs, KratoBal); a feltetel
    #     nelkuli .lower() mas ertekre irna, mint ami a tablan van.
    seed('FELELOSC906', assignee='samu')
    p = comment('FELELOSC906', 'Kartya FELELOSC906: uj kulso szerzo.', ('--assignee', 'UjSzerzo', '--assignee-uj'))
    check('17 lefutott a kimondott uj nevvel', p.returncode == 0, p.stdout + p.stderr)
    check('17 a nev SZO SZERINT maradt', felelos('FELELOSC906') == 'UjSzerzo', f'kapott: {felelos("FELELOSC906")}')

    # 18. ISMERETLEN, DE A TABLAN MAR LETEZO nev: flag nelkul is atmegy (a 17. hozta letre).
    seed('FELELOSD906', assignee='samu')
    p = comment('FELELOSD906', 'Kartya FELELOSD906: ugyanaz a kulso szerzo.', ('--assignee', 'UjSzerzo'))
    check('18 letezo kulso nev flag nelkul is atmegy', p.returncode == 0, p.stdout + p.stderr)
    check('18 a felelos tenyleg atallt', felelos('FELELOSD906') == 'UjSzerzo')

    # 19. FLOTTA-NEV kisbetusites: "Samu" -> "samu", tehat a mar-ezen-az-erteken ag sul el,
    #     nem egy latszolagos mozgatas.
    seed('FELELOSE906', assignee='samu')
    p = comment('FELELOSE906', 'Kartya FELELOSE906: ugyanaz nagybetuvel.', ('--assignee', 'Samu'))
    check('19 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('19 kimondja hogy mar ezen az erteken all', 'mar ezen az erteken all' in p.stdout, p.stdout)
    check('19 nem keletkezett mozgatas-nyom',
          not any('Mezomozgatas' in c for c in comments('FELELOSE906')), f'{comments("FELELOSE906")}')

    # 20. ID-HORGONY a CIM-MOZGATASON (1. tetel, Boni). A 411 kartyas migracio azon allt vagy
    #     bukott, hogy az ID ott van-e a cimben; egy cim-mozgatas csendben leveheti.
    seed('HORGONY906')
    regi = title('HORGONY906')
    p = comment('HORGONY906', 'Kartya HORGONY906: horgony nelkuli uj cim.',
                ('--title', 'Valami egeszen mas cim, azonosito nelkul.'))
    check('20 megtagadva a horgony nelkuli cim',
          p.returncode != 0 and 'nem tartalmazza a kartya sajat ID' in (p.stdout + p.stderr), p.stdout + p.stderr)
    check('20 a cim valtozatlan', title('HORGONY906') == regi)
    check('20 a komment SEM irodott be', comments('HORGONY906') == [])

    # 21. A KAPU NORMALIZAL, es ez nem kenyelmi kerdes: a nyers `id not in title` a tabla bevett
    #     PR-kartya-konvenciojat tagadna meg (id PR1195, cim "PR #1195 (...)"). Merve az utolso het
    #     354 kartyajan: nyers 52 elutasitas (14,7%), normalizalt 13 (3,7%).
    seed('PR1195')
    p = comment('PR1195', 'Kartya PR1195: a bevett PR-cim-alak.',
                ('--title', 'PR #1195 (Samu): copy-gate -- az edit_message is a kapun belul.'))
    check('21 a "PR #1195" alak ATMEGY a PR1195 id-hez', p.returncode == 0, p.stdout + p.stderr)
    check('21 a cim tenyleg valtozott', title('PR1195').startswith('PR #1195'), f'kapott: {title("PR1195")}')

    # 22. UGYANAZ A KAPU A LETREHOZO AGON. Ha csak a mozgatason allna, a horgony nelkuli cim
    #     egyszeruen a letrehozaskor kerulne be, es a kapu semmit nem vedene.
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH; env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    env['KARTYA_API'] = 'http://127.0.0.1:1/api/messages'
    p = subprocess.run([sys.executable, SCRIPT, '--id', 'HORGONYUJ906', '--assignee', 'marveen',
                        '--title', 'cim azonosito nelkul', '--no-msg'],
                       capture_output=True, text=True, env=env, timeout=30)
    check('22 a letrehozo ag is megtagadja a horgony nelkuli cimet',
          p.returncode != 0 and 'nem tartalmazza a kartya sajat ID' in (p.stdout + p.stderr), p.stdout + p.stderr)
    check('22 kartyat sem hozott letre', card('HORGONYUJ906') is None)

    # 23. A LETEZO-DE-URES DB (2. tetel, Samu lelete a #1204 verifyben): korabban ATMENT a kapun
    #     (az csak os.path.exists-t nezett), es nyers Python-tracebacket adott a szep MEGTAGADVA
    #     helyett. Nem hamis siker volt, de hasznalhatatlan hibauzenet.
    ures_db = os.path.join(tempfile.mkdtemp(prefix='kartya-uresdb-'), 'ures.db')
    open(ures_db, 'wb').close()
    d = tempfile.mkdtemp(prefix='kartya-m6-')
    cf = os.path.join(d, 'c.txt'); open(cf, 'w', encoding='utf-8').write('Kartya MOZGA906: ures DB-re.')
    env2 = dict(env); env2['KARTYA_DB'] = ures_db
    p = subprocess.run([sys.executable, SCRIPT, '--id', 'MOZGA906', '--comment-file', cf, '--author', 'Boni'],
                       capture_output=True, text=True, env=env2, timeout=30)
    ki = p.stdout + p.stderr
    check('23 megtagadva a letezo-de-ures DB', p.returncode != 0 and 'MEGTAGADVA' in ki, ki)
    check('23 NEM nyers traceback', 'Traceback' not in ki, ki)
    # A puszta 'kanban_cards' elofordulas NEM megkulonbozteto: a kapu NELKULI valtozat
    # tracebackje is tartalmazza ("no such table: kanban_cards"). A MEGTAGADVA-sorra allitunk.
    check('23 a MEGTAGADVA-uzenet nevezi meg a hianyzo tablat',
          any('MEGTAGADVA' in l or 'kanban_cards tabla' in l
              for l in ki.splitlines() if 'kanban_cards' in l), ki)

    # 24. Az --assignee-uj a LETREHOZO agon ertelmetlen -- egy nem hato kapcsolo pont az a
    #     hibaosztaly, amit ez az eszkoz ket kore zar (a --status csendes elvesztese).
    p = subprocess.run([sys.executable, SCRIPT, '--id', 'UJFLAG906', '--assignee', 'marveen',
                        '--title', 'UJFLAG906 teszt', '--no-msg', '--assignee-uj'],
                       capture_output=True, text=True, env=env, timeout=30)
    check('24 megtagadva az --assignee-uj a letrehozo agon',
          p.returncode != 0 and 'csak komment-modban' in (p.stdout + p.stderr), p.stdout + p.stderr)
    check('24 kartyat sem hozott letre', card('UJFLAG906') is None)

    # 25. A LETREHOZO AG IS MEGORZI a kulso nev kis/nagybetujet (a kozos feloldas kovetkezmenye).
    #     Korabban a feltetel nelkuli .lower() mas erteket irt volna, mint ami a tablan all.
    p = subprocess.run([sys.executable, SCRIPT, '--id', 'KULSONEV906', '--assignee', 'UjSzerzo',
                        '--title', 'KULSONEV906 kulso szerzo kartyaja', '--no-msg'],
                       capture_output=True, text=True, env=env, timeout=30)
    check('25 a letrehozo ag lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('25 a kulso nev SZO SZERINT kerult be', felelos('KULSONEV906') == 'UjSzerzo',
          f'kapott: {felelos("KULSONEV906")}')

    os.remove(DB_PATH)
    if FAILS:
        sys.stderr.write('\nBUKOTT: ' + ', '.join(FAILS) + '\n')
        return 1
    print('\nminden teszt atment')
    return 0


if __name__ == '__main__':
    sys.exit(main())
