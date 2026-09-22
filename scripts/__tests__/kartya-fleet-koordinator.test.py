#!/usr/bin/env python3
"""FLEETKIVETEL922: a koordinator (marveen) kartyaja is ERTESITEST kovetel.

A KOMMENTERTESITES922 kapuja a FLEET halmazra allt, es a marveen NEM volt benne. Merve a 30 napos
ablakon (flotta-szerzo, mas felelosu kartya): marveen 1003 (51%), FLEET 656 (33%), egyeb 320 (16%).
A legnagyobb egyetlen celcsoport a kivetelben allt, tehat a kapu a cel-forgalom egyharmadat fedte.

AMIT EZ A SUITE ROGZIT, es amiert nem eleg a "marveen benne van a halmazban" allitas: a
VISELKEDES mindket agon (komment ES letrehozas), plusz a SZANDEKOS kivetel, ami MARAD -- a gazda
(szabolcs), akinek az inter-agent uzenet szerkezetileg nem kezbesitheto.

Futtatas:  python3 scripts/__tests__/kartya-fleet-koordinator.test.py
"""
import json, os, sqlite3, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-fleetkiv-sandbox-')
DB_PATH = None
FAILS = []
DB_SZAM = 0


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
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
    for cid, who in (('KOORD922', 'marveen'), ('KOORD2922', 'marveen'), ('GAZDA922', 'szabolcs'),
                     ('SAJAT922', 'marveen')):
        db.execute('INSERT INTO kanban_cards (id,title,assignee,status,priority,created_at,updated_at)'
                   " VALUES (?,?,?,'planned','normal',?,?)", (cid, f'teszt {cid}', who, now, now))
    db.commit(); db.close()


def kozos_env(port):
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH; env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    env['KARTYA_TOKEN'] = 'teszt-token'; env['KARTYA_API'] = f'http://127.0.0.1:{port}/api/messages'
    return env


def komment(card_id, author, port, with_msg=False, extra=()):
    d = tempfile.mkdtemp(prefix='kartya-f-')
    cf = os.path.join(d, 'k.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write('Próba-komment, ékezetes szöveggel, hogy az ékezet-kapu ne ezen akadjon fenn.')
    args = [sys.executable, SCRIPT, '--id', card_id, '--comment-file', cf, '--author', author]
    if with_msg:
        mf = os.path.join(d, 'm.txt')
        with open(mf, 'w', encoding='utf-8') as f:
            f.write('Ertesites a ' + card_id + ' kartyarol.')
        args += ['--msg-file', mf]
    return subprocess.run(args + list(extra), capture_output=True, text=True,
                          env=kozos_env(port), timeout=30)


def letrehoz(card_id, assignee, author, port, with_msg=False):
    d = tempfile.mkdtemp(prefix='kartya-fu-')
    args = [sys.executable, SCRIPT, '--id', card_id, '--assignee', assignee,
            '--title', f'{card_id} teszt kartya', '--author', author]
    if with_msg:
        mf = os.path.join(d, 'm.txt')
        with open(mf, 'w', encoding='utf-8') as f:
            f.write('Uj kartya: ' + card_id)
        args += ['--msg-file', mf]
    return subprocess.run(args, capture_output=True, text=True, env=kozos_env(port), timeout=30)


def cimzettek():
    db = sqlite3.connect(DB_PATH)
    rows = db.execute('SELECT to_agent FROM agent_messages ORDER BY id').fetchall()
    db.close()
    return sorted(r[0] for r in rows)


def torol():
    db = sqlite3.connect(DB_PATH); db.execute('DELETE FROM agent_messages'); db.commit(); db.close()


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-fleetkiv-'); os.close(fd); os.remove(DB_PATH)
    fresh_db(DB_PATH)
    srv = HTTPServer(('127.0.0.1', 0), Stub); port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # 1. A LENYEG: a koordinator kartyajan a komment ertesites nelkul MEGTAGADVA.
    # Ez az az eset, ami a valtozas elott ATMENT, es a cel-forgalom 51%-a ilyen.
    torol()
    p = komment('KOORD922', 'Geri', port)
    out = p.stdout + p.stderr
    check('1 a koordinator kartyajan a komment ertesites nelkul MEGTAGADVA',
          p.returncode != 0 and 'MEGTAGADVA' in out, out)
    check('1 a megtagadas megnevezi a koordinatort', 'marveen' in out, out)

    # 2. --msg-file-lal atmegy, es az ertesites A KOORDINATORHOZ megy.
    torol()
    p = komment('KOORD2922', 'Geri', port, with_msg=True)
    out = p.stdout + p.stderr
    check('2 --msg-file-lal atmegy', p.returncode == 0 and 'KOMMENT OK' in out, out)
    check('2 es az ertesites a koordinatorhoz ment', cimzettek() == ['marveen'], f'cimzettek={cimzettek()}')

    # 3. SZANDEKOS KIVETEL, AMI MARAD: a GAZDA kartyaja. Neki az inter-agent uzenet szerkezetileg
    # nem kezbesitheto (GAZDAUZENET921), tehat a kapu nem kovetelhet olyat, amit teljesiteni sem lehet.
    torol()
    p = komment('GAZDA922', 'Geri', port)
    out = p.stdout + p.stderr
    check('3 a GAZDA kartyajan a komment tovabbra is ATMEGY (szandekos kivetel)',
          p.returncode == 0 and 'KOMMENT OK' in out, out)
    check('3 es semmi nem ment ki', cimzettek() == [], f'cimzettek={cimzettek()}')

    # 4. SAJAT KARTYA: a koordinator a sajatjara ir -- a szerzo == felelos, tehat atmegy.
    torol()
    p = komment('SAJAT922', 'Marveen', port)
    out = p.stdout + p.stderr
    check('4 a koordinator a SAJAT kartyajara ertesites nelkul is irhat',
          p.returncode == 0 and 'KOMMENT OK' in out, out)

    # 5. PARITAS A LETREHOZO AGON: uj kartya a koordinator nevere, ertesites nelkul -> MEGTAGADVA.
    # A valtozas a FLEET halmazt bovitette, tehat a masik ag is orokli; ezt MERJUK, nem feltetelezzuk.
    torol()
    p = letrehoz('UJKOORD922', 'marveen', 'Geri', port)
    out = p.stdout + p.stderr
    check('5 letrehozo agon is MEGTAGADVA a koordinator-kartya ertesites nelkul',
          p.returncode != 0 and 'MEGTAGADVA' in out, out)
    p = letrehoz('UJKOORD922', 'marveen', 'Geri', port, with_msg=True)
    out = p.stdout + p.stderr
    check('5 ugyanaz --msg-file-lal letrejon, es az ertesites a koordinatorhoz megy',
          p.returncode == 0 and cimzettek() == ['marveen'], f'cimzettek={cimzettek()} | {out}')

    print('')
    print(f'kartya-fleet-koordinator: {DB_SZAM - len(FAILS)}/{DB_SZAM} allitas zold')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
