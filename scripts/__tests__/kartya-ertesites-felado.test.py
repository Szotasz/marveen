#!/usr/bin/env python3
"""Test the sender attribution of scripts/kartya-es-ertesites.py (KARTYAKULDO906).

Boni's finding (msg 20254): the tool posted every agent's card notification with
`from: 'marveen'` hardcoded, so a reader would attribute someone else's measurement
to the main agent. It also mailed a self-assigned card back to its own author.

Drives the script as a subprocess against an isolated DB (KARTYA_DB) and a local
stub of the messages API (KARTYA_API) that records the posted envelope. Run:
    python3 scripts/__tests__/kartya-ertesites-felado.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import json, os, sqlite3, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')

POSTED = []          # every envelope the script posted
# SANDBOX-GYOKER: lasd a masik teszt magyarazatat -- a mutacios kontroll nem erheti el az eles tablat.
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-sandbox-')
DB_PATH = None       # set in main(); the stub writes the row the script reads back


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        POSTED.append(body)
        db = sqlite3.connect(DB_PATH)
        cur = db.execute(
            'INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at)'
            ' VALUES (?,?,?,?,?)',
            (body['from'], body['to'], body['content'], 'pending', int(time.time())))
        db.commit()
        mid = cur.lastrowid
        db.close()
        out = json.dumps({'id': mid}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


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
    db.commit()
    db.close()


def run(card_id, assignee, msg_text, port, extra=()):
    d = tempfile.mkdtemp(prefix='kartya-t-')
    mf = os.path.join(d, 'msg.txt')
    with open(mf, 'w', encoding='utf-8') as f:
        f.write(msg_text)
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    env['KARTYA_TOKEN'] = 'teszt-token'
    env['KARTYA_API'] = f'http://127.0.0.1:{port}/api/messages'
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--assignee', assignee,
         '--title', f'teszt kartya {card_id}', '--msg-file', mf, *extra],
        capture_output=True, text=True, env=env, timeout=30)


FAILS = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-')
    os.close(fd)
    os.remove(DB_PATH)
    fresh_db(DB_PATH)

    srv = HTTPServer(('127.0.0.1', 0), Stub)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # 1. A masik agens neveben felvett kartya ertesitese AZ O NEVEBEN megy ki.
    POSTED.clear()
    p = run('KULDOA906', 'samu', 'Kartya: KULDOA906 -- Boni merese, Samunak.', port,
            extra=('--from', 'boni'))
    check('1 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('1 felado == boni (nem marveen)', POSTED and POSTED[0]['from'] == 'boni',
          f'kapott: {POSTED[0]["from"] if POSTED else "semmi"}')
    check('1 cimzett == samu', POSTED and POSTED[0]['to'] == 'samu')

    # 2. --from nelkul az --author dont; ez tartja a regi viselkedest (--author nelkul: marveen).
    POSTED.clear()
    p = run('KULDOB906', 'samu', 'Kartya: KULDOB906 -- szerzo dont a feladorol.', port,
            extra=('--author', 'Boni'))
    check('2 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('2 felado az --author-bol == boni', POSTED and POSTED[0]['from'] == 'boni',
          f'kapott: {POSTED[0]["from"] if POSTED else "semmi"}')

    POSTED.clear()
    p = run('KULDOC906', 'samu', 'Kartya: KULDOC906 -- alapertelmezes valtozatlan.', port)
    check('3 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('3 alapertelmezett felado marveen (regresszio-kontroll)',
          POSTED and POSTED[0]['from'] == 'marveen')

    # 4. ONHUROK: felado == felelos -> a koordinatorhoz megy, es ki is mondja.
    POSTED.clear()
    p = run('KULDOD906', 'boni', 'Kartya: KULDOD906 -- Boni sajat magara osztja.', port,
            extra=('--from', 'boni'))
    check('4 lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('4 nem onmagahoz megy', POSTED and POSTED[0]['to'] != 'boni',
          f'kapott: {POSTED[0]["to"] if POSTED else "semmi"}')
    check('4 a koordinatorhoz megy', POSTED and POSTED[0]['to'] == 'marveen')
    check('4 felado tovabbra is boni', POSTED and POSTED[0]['from'] == 'boni')
    check('4 KIMONDVA a kimeneten', 'ATIRANYITVA' in p.stdout, p.stdout)
    check('4 KIMONDVA az uzenet torzseben', POSTED and 'ATIRANYITVA' in POSTED[0]['content'])

    # 5. Elgepelt felado-nev kapu: csendes rossz attribucio helyett megtagadas, iras nelkul.
    POSTED.clear()
    p = run('KULDOE906', 'samu', 'Kartya: KULDOE906 -- elgepelt felado.', port,
            extra=('--from', 'bonii'))
    check('5 megtagadva', p.returncode != 0)
    check('5 semmit nem kuldott', not POSTED)
    db = sqlite3.connect(DB_PATH)
    n = db.execute('SELECT count(*) FROM kanban_cards WHERE id=?', ('KULDOE906',)).fetchone()[0]
    db.close()
    check('5 a kartya sem jott letre', n == 0)

    # 6. A kartya-nyom is a valodi feladot nevezi meg.
    db = sqlite3.connect(DB_PATH)
    nyom = db.execute("SELECT content FROM kanban_comments WHERE card_id='KULDOA906'").fetchone()
    db.close()
    check('6 a nyom-komment a feladot nevezi', nyom and 'boni -> samu' in nyom[0],
          nyom[0] if nyom else 'nincs komment')

    srv.shutdown()
    os.remove(DB_PATH)
    if FAILS:
        sys.stderr.write('\nBUKOTT: ' + ', '.join(FAILS) + '\n')
        return 1
    print('\nminden teszt atment')
    return 0


if __name__ == '__main__':
    sys.exit(main())
