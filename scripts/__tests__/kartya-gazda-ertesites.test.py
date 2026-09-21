#!/usr/bin/env python3
"""GAZDAUZENET921 (2026-09-21): a gazdanak (szabolcs) cimzett kartya-ertesites NEM kezbesitheto --
a gazda nem agens, nincs tmux-sessionje -- es az eszkoz megis zold `UZENET OK`-ot irt, mert a
POST-olt SORT olvasta vissza, nem a kezbesitest (a teljes tortenetben 19 failed / 0 delivered).
Marveen ketszer olvasta ugy, hogy az ertesites elment.

A javitas: gazda-felelosnel az eszkoz NEM POST-ol, hanem a kimeneten KIMONDJA a hianyt (a merendo
szamokkal, ugyanabbol a DB-bol), a kartya letrejon, es a kartya-nyom is a hianyt rogziti. A dry-run
ugyanezt mondja (paritas). Pozitiv kontroll ugyanazon a muszeren: flotta-felelosnel az uzenet
tovabbra is kimegy, es a kimenet `UZENET OK`.

Ugyanaz a vaz, mint a kartya-ertesites-felado teszt: izolalt DB (KARTYA_DB), API-stub (KARTYA_API).
Futtatas:  python3 scripts/__tests__/kartya-gazda-ertesites.test.py
"""
import json, os, sqlite3, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'kartya-es-ertesites.py')
POSTED = []
SANDBOX_ROOT = tempfile.mkdtemp(prefix='kartya-sandbox-')
DB_PATH = None


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
    # A TORTENET ALAKJA, kicsiben: harom regi, gazda-cimzettu sor, mind failed, egy sem delivered.
    now = int(time.time())
    for i in range(3):
        db.execute("INSERT INTO agent_messages (from_agent,to_agent,content,status,created_at)"
                   " VALUES ('marveen','szabolcs',?, 'failed', ?)", (f'regi {i}', now - 1000 + i))
    db.commit(); db.close()


def run(card_id, assignee, msg_text, port, extra=()):
    d = tempfile.mkdtemp(prefix='kartya-t-')
    mf = os.path.join(d, 'msg.txt')
    with open(mf, 'w', encoding='utf-8') as f:
        f.write(msg_text)
    env = dict(os.environ)
    env['KARTYA_DB'] = DB_PATH; env['CLAUDECLAW_ROOT'] = SANDBOX_ROOT
    env['KARTYA_TOKEN'] = 'teszt-token'; env['KARTYA_API'] = f'http://127.0.0.1:{port}/api/messages'
    return subprocess.run([sys.executable, SCRIPT, '--id', card_id, '--assignee', assignee,
                           '--title', f'teszt kartya {card_id}', '--msg-file', mf, *extra],
                          capture_output=True, text=True, env=env, timeout=30)


FAILS = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def main():
    global DB_PATH
    fd, DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-'); os.close(fd); os.remove(DB_PATH)
    fresh_db(DB_PATH)
    srv = HTTPServer(('127.0.0.1', 0), Stub); port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # 1. GAZDA-FELELOS + --msg-file: a kartya letrejon, az uzenet NEM megy ki, a kimenet KIMONDJA.
    POSTED.clear()
    p = run('GAZDAA921', 'szabolcs', 'Kartya: GAZDAA921 -- dontes-kerdes a gazdanak.', port,
            extra=('--from', 'marveen'))
    out = p.stdout + p.stderr
    check('1 lefutott (a kartya legitim, nem megtagadas)', p.returncode == 0, out)
    check('1 NEM POST-olt a gazdanak', not POSTED, f'POSTED={POSTED}')
    check('1 a kimenet NEM ir zold UZENET OK-ot', 'UZENET OK' not in out, out)
    check('1 a kimenet KIMONDJA a hianyt (FIGYELEM + NEM lesz kezbesitve)',
          'FIGYELEM' in out and 'NEM lesz kezbesitve' in out, out)
    check('1 a kimenet a MERT szamokat hordozza (3 failed, 0 delivered a fixturabol)',
          '3 failed' in out and '0 delivered' in out, out)
    check('1 a kimenet a Telegram-utat nevezi meg', 'TELEGRAMON' in out.upper(), out)
    db = sqlite3.connect(DB_PATH)
    n = db.execute("SELECT count(*) FROM kanban_cards WHERE id='GAZDAA921' AND assignee='szabolcs'").fetchone()[0]
    nyom = db.execute("SELECT content FROM kanban_comments WHERE card_id='GAZDAA921'").fetchone()
    uj_sor = db.execute("SELECT count(*) FROM agent_messages WHERE to_agent='szabolcs'").fetchone()[0]
    db.close()
    check('1 a kartya letrejott a gazda neven', n == 1)
    check('1 a kartya-nyom a HIANYT rogziti, nem a kuldest',
          nyom is not None and 'NEM ment ki' in nyom[0] and 'msg ' not in nyom[0], nyom[0] if nyom else 'nincs nyom')
    check('1 nem keletkezett uj gazda-cimzettu sor (3 maradt)', uj_sor == 3, f'sorok={uj_sor}')

    # 2. DRY-RUN PARITAS: ugyanaz a hivas --dry-run-nal ugyanezt mondja, es nem ir semmit.
    POSTED.clear()
    p = run('GAZDAB921', 'szabolcs', 'Kartya: GAZDAB921 -- dry-run a gazdanak.', port,
            extra=('--from', 'marveen', '--dry-run'))
    out = p.stdout + p.stderr
    check('2 dry-run lefutott', p.returncode == 0, out)
    check('2 dry-run is KIMONDJA a hianyt', 'FIGYELEM' in out and 'NEM lesz kezbesitve' in out, out)
    check('2 dry-run nem POST-olt', not POSTED)
    db = sqlite3.connect(DB_PATH)
    n2 = db.execute("SELECT count(*) FROM kanban_cards WHERE id='GAZDAB921'").fetchone()[0]; db.close()
    check('2 dry-run nem irt kartyat', n2 == 0)

    # 3. POZITIV KONTROLL ugyanazon a muszeren: flotta-felelosnel az uzenet kimegy, UZENET OK all.
    POSTED.clear()
    p = run('GAZDAC921', 'samu', 'Kartya: GAZDAC921 -- flotta-felelos, kontroll.', port,
            extra=('--from', 'marveen'))
    out = p.stdout + p.stderr
    check('3 kontroll lefutott', p.returncode == 0, out)
    check('3 kontroll: az uzenet kiment samunak', POSTED and POSTED[0]['to'] == 'samu', f'POSTED={POSTED}')
    check('3 kontroll: UZENET OK all a kimeneten', 'UZENET OK' in out, out)
    check('3 kontroll: nincs gazda-FIGYELEM', 'NEM lesz kezbesitve' not in out, out)

    srv.shutdown(); os.remove(DB_PATH)
    if FAILS:
        sys.stderr.write('\nBUKOTT: ' + ', '.join(FAILS) + '\n'); return 1
    print('\nminden teszt atment'); return 0


if __name__ == '__main__':
    sys.exit(main())
