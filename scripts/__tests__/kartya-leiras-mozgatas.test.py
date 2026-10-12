#!/usr/bin/env python3
"""A leiras (description) mozgatasa komment-modban -- EKEZETKAPU919.

A lelet (Marveen, 2026-09-19): a leiras volt az EGYETLEN kartya-mezo, amit letrehozas
utan senki nem tudott javitani. A `--desc-file` csak a letrehozo agon volt bekotve, a
komment-ag pedig a keveres-kapuval utasitotta vissza -- nem leiras-vedelembol, hanem
mert a mozgato ag nem ismerte a mezot. Eloszor egy gazda ele keszulo szovegben okozott
kart: egy rossz hatarido negy helyen bent maradt, es a cim javithato volt, a leiras nem.

Az engedmeny FELTETELE, es ezert a 3. es 4. eset a legfontosabb itt: a csere NEM torolheti
a regi szoveget. A regi leiras teljes egeszeben bekerul a mozgatas-nyom kommentbe, kulonben
a leiras csendes atiras-felulet lenne, ami rosszabb a mai korlatnal.

Az izolalt DB-n hajtja meg a szkriptet alfolyamatkent (KARTYA_DB). Futtatas:
    python3 scripts/__tests__/kartya-leiras-mozgatas.test.py
Exit 0 = minden pass.
"""
import os, sqlite3, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
DB_PATH = None
FAILS = []
# SANDBOX-GYOKER: ugyanaz a mutacios kontroll, mint a mezomozgatas-tesztben -- ha az
# ut-feloldas eltorik, ez a sor tartja tavol a futast az ELES tablatol.
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-leiras-sandbox-')


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


def seed(card_id, leiras):
    db = sqlite3.connect(DB_PATH)
    now = int(time.time())
    db.execute('INSERT INTO kanban_cards (id,title,description,status,assignee,priority,'
               'created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
               (card_id, f'teszt {card_id}', leiras, 'planned', 'boni', 'normal', now, now))
    db.commit()
    db.close()


def fut(card_id, komment, leiras=None, extra=()):
    d = tempfile.mkdtemp(prefix='kartya-l-')
    cf = os.path.join(d, 'c.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write(komment)
    # KOMMENTERTESITES922: ez a suite a LEIRAS-MOZGATAST meri, nem az ertesitest.
    args = [sys.executable, SCRIPT, '--id', card_id, '--comment-file', cf, '--author', 'Geri',
            '--nincs-ertesites-szandekos']
    if leiras is not None:
        df = os.path.join(d, 'd.txt')
        with open(df, 'w', encoding='utf-8') as f:
            f.write(leiras)
        args += ['--desc-file', df]
    args += list(extra)
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    return subprocess.run(args, capture_output=True, text=True, env=env, timeout=30)


def leiras(card_id):
    db = sqlite3.connect(DB_PATH)
    r = db.execute('SELECT description FROM kanban_cards WHERE id=?', (card_id,)).fetchone()
    db.close()
    return r[0] if r else None


def comments(card_id):
    db = sqlite3.connect(DB_PATH)
    r = db.execute('SELECT content FROM kanban_comments WHERE card_id=? ORDER BY id', (card_id,)).fetchall()
    db.close()
    return [x[0] for x in r]


REGI = ('A hatarido szeptember 28-ig tart, es ez NEGY helyen szerepel ebben a szovegben.\n'
        'Masodik sor, hogy a tobbsorossag is merve legyen.\n'
        'Harmadik sor egy olyan resszel, amit vissza kell tudni allitani.')
UJ = ('A hatarido SZEPTEMBER 27, VASARNAP VEGEIG tart (a tarolt 09-28 00:00 kizaro pillanat).\n'
      'A javitas oka: a naiv olvasat egy nappal tobbet mondott, mint ameddig fizetni lehet.')


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-l-')
    os.close(fd); os.remove(DB_PATH)
    fresh_db(DB_PATH)

    # 1. A LELET MAGA: a --desc-file komment-modban TENYLEG atirja a leirast.
    #    A javitas elott ez a futas a keveres-kapun halt el (exit != 0), tehat ez az eset
    #    kulonbozteti meg a javitott allapotot a regitol.
    seed('LEIRA919', REGI)
    p = fut('LEIRA919', 'Kartya LEIRA919: a hatarido rosszul allt a leirasban, javitom.', UJ)
    check('1 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('1 a leiras TENYLEG az uj', leiras('LEIRA919') == UJ, f'kapott: {leiras("LEIRA919")!r}')
    check('1 a kimenet kimondja a mozgatast', 'MEZOMOZGATAS OK' in p.stdout, p.stdout)

    # 2. A KOMMENT ATTOL MEG BEKERUL (a leiras-csere nem nyeli el a sajat indokat).
    check('2 a komment is beirt', any('a hatarido rosszul allt' in c for c in comments('LEIRA919')))

    # 3. AZ ENGEDMENY FELTETELE: a REGI szoveg TELJES EGESZEBEN megmarad a nyomban.
    #    Nem "valamit ir rola", hanem minden sora visszakereshetoen ott van -- kulonben a
    #    csere csendes atiras lenne, es a regi allitast semmi nem orizne meg.
    nyom = [c for c in comments('LEIRA919') if 'Mezomozgatas' in c]
    check('3 van mozgatas-nyom', len(nyom) == 1, f'{len(nyom)} nyom-komment')
    egyben = '\n'.join(nyom)
    check('3 a regi leiras MINDEN sora bent van a nyomban',
          all(sor in egyben for sor in REGI.split('\n')),
          'hianyzo sor(ok): ' + repr([s for s in REGI.split('\n') if s not in egyben]))
    check('3 a nyom megnevezi a description mezot', 'description' in egyben, egyben[:200])

    # 4. ELSO-RANEZESRE-JO ELLENPELDA: a nyom ne csak a RÖVIDITETT erteket orizze. A mozgatas
    #    osszefoglalo sora 60 karakter utan levag; ha CSAK az lenne, a 3. eset is "atmenne"
    #    egy rovid leirasra, es a hosszu leirasok csendben csonkulnanak. Ezert kulon merjuk,
    #    hogy a regi szoveg UTOLSO sora is bent van (az esik a levagason kivulre).
    check('4 a regi leiras UTOLSO sora is bent van (nem csak a rovid osszefoglalo)',
          REGI.split('\n')[-1] in egyben)

    # 5. URES --desc-file: MEGTAGADAS. Egy ures leiras ugyanugy nez ki, mint egy elfelejtett,
    #    ezert a kiuritesnek KIMONDOTTNAK kell lennie (egy sor arrol, miert ures).
    seed('LEIRB919', REGI)
    p = fut('LEIRB919', 'Kartya LEIRB919: ures leirast probalok beirni.', '   \n  \n')
    check('5 megtagadva', p.returncode != 0, p.stdout + p.stderr)
    check('5 a leiras VALTOZATLAN', leiras('LEIRB919') == REGI)
    check('5 a komment sem irodott be', not comments('LEIRB919'), comments('LEIRB919'))

    # 6. NO-OP: ugyanaz a leiras -- kimondja, nem hallgat rola, es nincs hamis mozgatas-nyom.
    seed('LEIRC919', REGI)
    p = fut('LEIRC919', 'Kartya LEIRC919: ugyanazt a leirast kuldom.', REGI)
    check('6 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('6 kimondja, hogy mar ezen az erteken all', 'mar ezen az erteken all' in p.stdout, p.stdout)
    check('6 nincs mozgatas-nyom', not any('Mezomozgatas' in c for c in comments('LEIRC919')))

    # 7. HOMOGLIFA-KAPU a leirason is (ugyanaz a hamisitas-felulet, mint a cimen).
    #    A cirill "а" a latin "a" helyen.
    seed('LEIRD919', REGI)
    p = fut('LEIRD919', 'Kartya LEIRD919: homoglifas leiras.', 'A hаtarido szeptember 27-ig tart.')
    check('7 megtagadva', p.returncode != 0, p.stdout + p.stderr)
    check('7 a megtagadas a LEIRAST nevezi meg', 'leirasban' in (p.stdout + p.stderr), p.stdout + p.stderr)
    check('7 a leiras valtozatlan', leiras('LEIRD919') == REGI)

    # 8. A --msg-file TOVABBRA IS tiltva komment-modban: az ERTESITES a letrehozo age.
    #    Ha ez a kapu a --desc-file kiengedesevel egyutt eltunt volna, egy komment-futas
    #    csendben uzenetet is kuldott volna.
    seed('LEIRE919', REGI)
    d = tempfile.mkdtemp(prefix='kartya-l-')
    mf = os.path.join(d, 'm.txt')
    with open(mf, 'w', encoding='utf-8') as f:
        f.write('Kartya LEIRE919: ertesites.')
    p = fut('LEIRE919', 'Kartya LEIRE919: komment.', UJ, ('--msg-file', mf))
    check('8 megtagadva', p.returncode != 0, p.stdout + p.stderr)
    check('8 a megtagadas a --msg-file-t nevezi meg', '--msg-file' in (p.stdout + p.stderr),
          p.stdout + p.stderr)
    check('8 a leiras valtozatlan', leiras('LEIRE919') == REGI)

    # 9. DRY-RUN PARITAS: a --desc-file a dry-run agon is latszik, es semmit nem ir.
    seed('LEIRF919', REGI)
    p = fut('LEIRF919', 'Kartya LEIRF919: dry-run.', UJ, ('--dry-run',))
    check('9 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('9 a terv megnevezi a description mezot', 'description' in p.stdout, p.stdout)
    check('9 a leiras VALTOZATLAN maradt', leiras('LEIRF919') == REGI)
    check('9 semmi nem irodott be', not comments('LEIRF919'), comments('LEIRF919'))

    print('---')
    print(f'FAILS: {len(FAILS)}' + (': ' + ', '.join(FAILS) if FAILS else ''))
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
