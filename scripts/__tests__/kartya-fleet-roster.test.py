#!/usr/bin/env python3
"""KARTYAFLEET1030: a FLEET a futo flottabol is jon (agents/<nev>), nem csak a kezi listabol.

Merve 2026-10-30: a kezi lista elavult volt (abel, bence, nora, orsi, vera hianyzott), es Bence
nem tudott kartyat nyitni (ismeretlen felado). A szabaly a dashboard listAgentNames-e: valodi
konyvtar az agents/ alatt, nem agents/-on beluli symlink, nem a fo agens, nincs .hidden-from-dashboard.

A script alprocesszkent fut egy sandbox CLAUDECLAW_ROOT-tal (sajat agents/ konyvtarral), izolalt
DB-vel es az uzenet-API stubjaval. Futtatas:  python3 scripts/__tests__/kartya-fleet-roster.test.py
"""
import json, os, sqlite3, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-roster-sandbox-')
POSTED = []
DB_PATH = None
FAILS = []


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
    db.commit(); db.close()


def roster():
    a = os.path.join(SANDBOX_ROOT, 'agents')
    os.makedirs(os.path.join(a, 'ujagens'))          # a futo flotta uj tagja
    os.makedirs(os.path.join(a, 'rejtett'))          # technikai worker, rejtve
    open(os.path.join(a, 'rejtett', '.hidden-from-dashboard'), 'w').close()
    os.makedirs(os.path.join(a, 'marveen'))          # a fo agens neve: nem sub-agens
    os.symlink(os.path.join(a, 'ujagens'), os.path.join(a, 'alias'))  # masodik nev ugyanarra
    open(os.path.join(a, 'fajl'), 'w').close()       # nem konyvtar


def run(card_id, assignee, sender, port):
    d = tempfile.mkdtemp(prefix='kartya-roster-t-')
    mf = os.path.join(d, 'msg.txt')
    with open(mf, 'w', encoding='utf-8') as f:
        f.write(f'Kartya: {card_id} -- roster-teszt.')
    env = dict(os.environ)
    env.pop('MAIN_AGENT_ID', None)
    env['KARTYA_DB'] = DB_PATH
    env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    env['KARTYA_TOKEN'] = 'teszt-token'
    env['KARTYA_API'] = f'http://127.0.0.1:{port}/api/messages'
    return subprocess.run(
        [sys.executable, SCRIPT, '--id', card_id, '--assignee', assignee,
         '--title', f'teszt kartya {card_id}', '--msg-file', mf, '--from', sender],
        capture_output=True, text=True, env=env, timeout=30)


def card_exists(card_id):
    db = sqlite3.connect(DB_PATH)
    n = db.execute('SELECT count(*) FROM kanban_cards WHERE id=?', (card_id,)).fetchone()[0]
    db.close()
    return n == 1


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-roster-')
    os.close(fd); os.remove(DB_PATH); fresh_db(DB_PATH)
    roster()
    srv = HTTPServer(('127.0.0.1', 0), Stub)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # 1. A kezi listaban NEM szereplo, de agents/-konyvtarral futo agens feladokent elfogadva.
    POSTED.clear()
    p = run('ROSTERA1030', 'samu', 'ujagens', port)
    check('1 az uj flotta-tag feladokent lefut', p.returncode == 0, p.stdout + p.stderr)
    check('1 a felado az uj tag', POSTED and POSTED[0]['from'] == 'ujagens')
    check('1 a kartya letrejott', card_exists('ROSTERA1030'))

    # 2. Az uj flotta-tag FELELOSKENT is flotta: ertesitest kap.
    POSTED.clear()
    p = run('ROSTERB1030', 'ujagens', 'boni', port)
    check('2 az uj tagnak szolo kartya lefut', p.returncode == 0, p.stdout + p.stderr)
    check('2 az ertesites az uj taghoz megy', POSTED and POSTED[0]['to'] == 'ujagens')

    # 3-5. Ami NEM flotta-tag: a rejtett worker, az agents/-on beluli symlink, a sima fajl.
    for i, nev in ((3, 'rejtett'), (4, 'alias'), (5, 'fajl')):
        POSTED.clear()
        cid = f'ROSTER{i}X1030'
        p = run(cid, 'samu', nev, port)
        check(f'{i} {nev} feladokent megtagadva', p.returncode != 0, p.stdout + p.stderr)
        check(f'{i} {nev}: semmi nem ment ki', not POSTED)
        check(f'{i} {nev}: a kartya nem jott letre', not card_exists(cid))

    # 6. A kezi lista also korlat marad: a nem konyvtaras hidli tovabbra is elfogadott felado.
    POSTED.clear()
    p = run('ROSTERC1030', 'samu', 'hidli', port)
    check('6 a kezi lista tagja (hidli) tovabbra is lefut', p.returncode == 0, p.stdout + p.stderr)

    srv.shutdown()
    os.remove(DB_PATH)
    if FAILS:
        sys.stderr.write('\nBUKOTT: ' + ', '.join(FAILS) + '\n')
        return 1
    print('\nminden teszt atment')
    return 0


if __name__ == '__main__':
    sys.exit(main())
