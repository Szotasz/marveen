#!/usr/bin/env python3
"""KOMMENTMSGFILE922: komment-modban a --msg-file MEGENGEDETT -- komment + ertesites EGY futasban.

A KOMMENTERTESITES922 kotelezove tette az ertesitest mas flotta-agens kartyajan, de a kapcsolot,
ami megadja, ugyanaz az eszkoz TILTOTTA (keveres-kapu). A ket allitas egyszerre nem allhatott.

AMIT EZ A SUITE MER, es amiert nem eleg a "ment ertesites" allitas: a cimzett-halmaznak PONTOSAN
azzal kell egyeznie, amit a KAPU kovetelt. Ket kulon szarmaztatas eseten a kapu panaszkodhatna az
egyik nevre, mikozben az uzenet egy masikhoz megy, es mindket allitas zold lenne.

Futtatas:  python3 scripts/__tests__/kartya-komment-msgfile.test.py
"""
import json, os, sqlite3, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-msgfile-sandbox-')
DB_PATH = None
POSTED = []
FAILS = []
DB_SZAM = 0


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        POSTED.append(body)
        db = sqlite3.connect(DB_PATH)
        cur = db.execute('INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at)'
                         ' VALUES (?,?,?,?,?)',
                         (body['from'], body['to'], body['content'], 'pending', int(time.time())))
        db.commit(); mid = cur.lastrowid; db.close()
        out = json.dumps({'id': mid}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)

    def log_message(self, *a):
        pass


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
    for cid, who in (('MASE922', 'samu'), ('ENYEM922', 'geri'), ('ATAD922', 'geri'),
                     ('KETTO922', 'zara'), ('SORREND922', 'samu'), ('ELLENT922', 'samu'),
                     ('FROM922', 'samu')):
        db.execute('INSERT INTO kanban_cards (id,title,assignee,status,priority,created_at,updated_at)'
                   " VALUES (?,?,?,'planned','normal',?,?)", (cid, f'teszt {cid}', who, now, now))
    db.commit(); db.close()


def run(card_id, author, port, with_msg=True, extra=()):
    d = tempfile.mkdtemp(prefix='kartya-m-')
    cf = os.path.join(d, 'komment.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write('Próba-komment, ékezetes szöveggel, hogy az ékezet-kapu ne ezen akadjon fenn.')
    args = [sys.executable, SCRIPT, '--id', card_id, '--comment-file', cf, '--author', author]
    if with_msg:
        mf = os.path.join(d, 'uzenet.txt')
        with open(mf, 'w', encoding='utf-8') as f:
            f.write('Ertesites: irtam a ' + card_id + ' kartyara.')
        args += ['--msg-file', mf]
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH; env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    env['KARTYA_TOKEN'] = 'teszt-token'; env['KARTYA_API'] = f'http://127.0.0.1:{port}/api/messages'
    return subprocess.run(args + list(extra), capture_output=True, text=True, env=env, timeout=30)


def cimzettek():
    """Akihez az uzenet TENYLEGESEN ment, a DB sorabol -- nem a kimenet szovegebol."""
    db = sqlite3.connect(DB_PATH)
    rows = db.execute('SELECT to_agent FROM agent_messages ORDER BY id').fetchall()
    db.close()
    return sorted(r[0] for r in rows)


def torol_uzenetek():
    db = sqlite3.connect(DB_PATH); db.execute('DELETE FROM agent_messages'); db.commit(); db.close()
    POSTED.clear()


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-msgfile-'); os.close(fd); os.remove(DB_PATH)
    fresh_db(DB_PATH)
    srv = HTTPServer(('127.0.0.1', 0), Stub); port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # 1. MAS FLOTTA-FELELOS + --msg-file: a komment BEIRODIK es az uzenet KIMEGY, EGY futasban.
    torol_uzenetek()
    p = run('MASE922', 'Geri', port)
    out = p.stdout + p.stderr
    check('1 lefutott (a --msg-file mar NEM tiltott komment-modban)', p.returncode == 0, out)
    check('1 a komment beirodott', 'KOMMENT OK' in out, out)
    check('1 es az uzenet is kiment', 'UZENET OK' in out, out)
    check('1 a CIMZETT pontosan a kartya felelose (samu), es csak o', cimzettek() == ['samu'],
          f'cimzettek={cimzettek()}')

    # 2. A KAPU-HALMAZ ES A CIMZETT-HALMAZ AZONOS -- ATADASKOR AZ UJ FELELOSSEL EGYUTT.
    # Eloszor MERJUK, mit KOVETEL a kapu (--msg-file nelkul, a megtagadas szovegebol),
    # aztan hogy KINEK ment. A ketto osszehasonlitasa a lenyeg.
    torol_uzenetek()
    k = run('KETTO922', 'Geri', port, with_msg=False, extra=('--assignee', 'samu'))
    kovetelt = k.stdout + k.stderr
    check('2 a kapu a REGI es az UJ felelost EGYUTT koveteli',
          'samu' in kovetelt and 'zara' in kovetelt and 'MEGTAGADVA' in kovetelt, kovetelt)
    torol_uzenetek()
    p = run('KETTO922', 'Geri', port, extra=('--assignee', 'samu'))
    out = p.stdout + p.stderr
    check('2 a futas sikeres', p.returncode == 0, out)
    check('2 es az ERTESITES PONTOSAN ugyanarra a ket nevre ment (samu, zara)',
          cimzettek() == ['samu', 'zara'], f'cimzettek={cimzettek()}')

    # 3. ATADAS a sajat kartyamrol: a kapu az UJ felelost koveteli, es az uzenet is oda megy.
    torol_uzenetek()
    p = run('ATAD922', 'Geri', port, extra=('--assignee', 'samu'))
    out = p.stdout + p.stderr
    check('3 atadaskor az UJ felelos kapja az ertesitest', p.returncode == 0 and cimzettek() == ['samu'],
          f'cimzettek={cimzettek()} | {out}')

    # 4. ELLENTMONDAS: --msg-file ES --nincs-ertesites-szandekos egyszerre -> MEGTAGADVA
    torol_uzenetek()
    p = run('ELLENT922', 'Geri', port, extra=('--nincs-ertesites-szandekos',))
    out = p.stdout + p.stderr
    check('4 --msg-file + --nincs-ertesites-szandekos: MEGTAGADVA',
          p.returncode != 0 and 'MEGTAGADVA' in out and 'ellentmond' in out, out)
    check('4 es semmi nem ment ki', cimzettek() == [], f'cimzettek={cimzettek()}')

    # 5. --msg-file, de NINCS kit ertesiteni (sajat kartya) -> MEGTAGADVA, nem talalunk ki cimzettet
    torol_uzenetek()
    p = run('ENYEM922', 'Geri', port)
    out = p.stdout + p.stderr
    check('5 --msg-file cimzett nelkul: MEGTAGADVA (nem talalunk ki cimzettet)',
          p.returncode != 0 and 'MEGTAGADVA' in out, out)
    check('5 es semmi nem ment ki', cimzettek() == [], f'cimzettek={cimzettek()}')

    # 6. FELADO-ATTRIBUCIO: a sor from_agent-je az --author kisbetusitve (KARTYAKULDO908 alak),
    # nem a koordinator. Csendes koordinator-attribucio nem keletkezhet.
    torol_uzenetek()
    p = run('FROM922', 'Boni', port)
    db = sqlite3.connect(DB_PATH)
    frm = db.execute('SELECT from_agent FROM agent_messages ORDER BY id LIMIT 1').fetchone()
    db.close()
    check('6 a felado az --author kisbetusitve (boni), nem marveen',
          p.returncode == 0 and frm and frm[0] == 'boni', f'from={frm} | {p.stdout}{p.stderr}')

    # 7. A MEGTAGADAS SZOVEGE TANIT: a --msg-file all ELOL, a kulon szkript utana,
    # a kimondott kihagyas UTOLSONAK.
    torol_uzenetek()
    p = run('SORREND922', 'Geri', port, with_msg=False)
    out = p.stdout + p.stderr
    i_msg = out.find('--msg-file')
    i_script = out.find('agent-msg.sh')
    i_flag = out.find('--nincs-ertesites-szandekos')
    check('7 a megtagadas mindharom utat megnevezi', min(i_msg, i_script, i_flag) >= 0, out)
    check('7 a --msg-file all ELOL (a legolcsobb ut a helyes)', 0 <= i_msg < i_script, out)
    check('7 a kimondott kihagyas van UTOLSO helyen', i_flag > i_script, out)

    # 7b. A MEGNEVEZETT HELPER LETEZIK ES KOVETETT. Samu lelete a #1466-on: az elozo szoveg a
    # scripts/agent-msg-send.sh-ra mutatott, ami CSAK a gazda gepen letezik (untracked), tehat
    # minden mas telepitesen egy nem letezo parancsot ajanlott volna. Ezt a suite most MERI:
    # nem eleg, hogy a fajl ott van a fejlesztoi gepen, a REPONAK kell hordoznia.
    #
    # KET MUSZER, ES KIMONDJUK, MELYIK FUTOTT (Samu eszrevetele, 28109): a git-index kerdezese egy
    # GIT NELKULI masolaton (tarball-telepites) nem az untracked-nevet merne, hanem a git hianyat,
    # es pirosat adna rossz okbol. Ahol van git, a KOVETETTSEG a szigorubb meres; ahol nincs, ott a
    # kerdes ugyis az, hogy a parancs OTT VAN-E a telepitesben -- azt merjuk, es megnevezzuk.
    import subprocess as _sp
    _HELPER = 'scripts/agent-msg.sh'
    _git = _sp.run(['git', 'rev-parse', '--git-dir'], cwd=ROOT, capture_output=True, text=True)
    if _git.returncode == 0:
        _ls = _sp.run(['git', 'ls-files', '--error-unmatch', _HELPER],
                      cwd=ROOT, capture_output=True, text=True)
        check('7b a megtagadasban ajanlott helper a repoban van, git-index szerint (nem csak a gazda gepen)',
              _ls.returncode == 0, _ls.stderr.strip())
    else:
        # Nem skip: a git hianya nem teszi merhetetlenne a kerdest, csak gyengebbe a muszert.
        check('7b (git-index nelkul) a megnevezett helper OTT VAN a telepitesben',
              os.path.exists(os.path.join(ROOT, _HELPER)),
              'nincs git index, es a fajl sincs: ' + _HELPER)
        print('      (muszer: git-index nem elerheto, ezert a FAJL letezeset mertuk)')

    # 8. NYOM A KARTYAN: a trace-komment megnevezi a msg-id-ket ES a cimzetteket.
    torol_uzenetek()
    run('MASE922', 'Geri', port)
    db = sqlite3.connect(DB_PATH)
    nyom = db.execute("SELECT content FROM kanban_comments WHERE card_id='MASE922'"
                      " AND author='kartya-es-ertesites' ORDER BY id DESC LIMIT 1").fetchone()
    db.close()
    check('8 a kartyan nyom marad az ertesitesrol, a cimzett nevevel',
          bool(nyom) and 'samu' in nyom[0] and 'msg ' in nyom[0], str(nyom))

    print('')
    print(f'kartya-komment-msgfile: {DB_SZAM - len(FAILS)}/{DB_SZAM} allitas zold')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
