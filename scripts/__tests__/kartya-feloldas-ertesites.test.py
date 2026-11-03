#!/usr/bin/env python3
"""Test that a comment-mode move to done asks the server for the unblock notice (PR2027SCRIPTNOTIFY1018).

The server tells the next agent when the card it waited on reaches done (#2027), but only on its
own /move and PUT. This script moves cards in the DB directly -- on the fleet's board every done
transition came through it -- so after its move it calls POST /api/kanban/<id>/notify-unblocked.
The rules stay on the server; here only the call is checked: when it is made, with what, and
what the script says when it cannot be made.

A fake HTTP server stands in for the dashboard. On a call it writes the system comment the real
server writes, so the script's read-back has something real to find. Run:
    python3 scripts/__tests__/kartya-feloldas-ertesites.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import importlib.util, json, os, sqlite3, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('mezo', os.path.join(HERE, 'kartya-mezomozgatas.test.py'))
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

CALLS = []
# What the fake server answers next: (status, body, write_comment_for)
ANSWER = {'status': 200, 'freed': [], 'already': [], 'comment': True}


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n).decode()
        CALLS.append({'path': self.path, 'body': json.loads(body) if body else None,
                      'auth': self.headers.get('Authorization')})
        if ANSWER['status'] != 200:
            self.send_response(ANSWER['status']); self.end_headers(); self.wfile.write(b'{}'); return
        if ANSWER['comment']:
            db = sqlite3.connect(M.DB_PATH)
            for fid in ANSWER['freed']:
                db.execute("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?,?,?,?)",
                           (fid, 'system', 'A(z) #1 kártya kész lett, és ez volt az utolsó, amire ez a kártya várt. Folytatható.',
                            int(time.time())))
            db.commit(); db.close()
        out = json.dumps({'ok': True, 'freed': ANSWER['freed'], 'already_notified': ANSWER['already']}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(out)


def run(card_id, status, api, extra=(), token='tok-test'):
    d = tempfile.mkdtemp(prefix='kartya-fel-')
    cf = os.path.join(d, 'c.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write(f'Kártya {card_id}: kész, a teszt lefutott.')
    env = dict(os.environ)
    env['KARTYA_DB'] = M.DB_PATH
    env['CLAUDECLAW_ROOT'] = M.SANDBOX_ROOT
    env['KARTYA_API'] = api + '/api/messages'
    env.pop('KARTYA_KANBAN_API', None)
    if token is None:
        env.pop('KARTYA_TOKEN', None)
    else:
        env['KARTYA_TOKEN'] = token
    return subprocess.run([sys.executable, M.SCRIPT, '--id', card_id, '--comment-file', cf, '--author', 'Boni',
                           '--nincs-ertesites-szandekos', '--status', status, *extra],
                          capture_output=True, text=True, env=env, timeout=30)


def block(card_id, blocker_id):
    db = sqlite3.connect(M.DB_PATH)
    db.execute('INSERT INTO kanban_card_blockers (card_id, blocker_id, created_at) VALUES (?,?,?)',
               (card_id, blocker_id, int(time.time())))
    db.commit(); db.close()


def main():
    fd, M.DB_PATH = tempfile.mkstemp(suffix='.db', prefix='kartya-fel-')
    os.close(fd); os.remove(M.DB_PATH)
    M.fresh_db(M.DB_PATH)
    db = sqlite3.connect(M.DB_PATH)
    db.executescript('''CREATE TABLE kanban_card_blockers (card_id TEXT NOT NULL, blocker_id TEXT NOT NULL,
                        created_at INTEGER NOT NULL, PRIMARY KEY (card_id, blocker_id));''')
    db.commit(); db.close()

    srv = HTTPServer(('127.0.0.1', 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    api = f'http://127.0.0.1:{srv.server_address[1]}'
    check = M.check

    # A) A done-ra mozgatott, mast blokkolo kartya: a szerver vegpontja hivodik, a mozgato
    #    actor-kent, tokennel, es a kimenet a visszaolvasott felszabadulast mondja.
    M.seed('FELA1', 'in_progress'); M.seed('VARA1', 'planned', assignee='samu'); block('VARA1', 'FELA1')
    ANSWER.update(status=200, freed=['VARA1'], already=[], comment=True); CALLS.clear()
    p = run('FELA1', 'done', api)
    check('A lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('A a statusz done', M.card('FELA1')[0] == 'done')
    check('A pontosan egy hivas', len(CALLS) == 1, str(CALLS))
    check('A a vegpont utja', CALLS and CALLS[0]['path'] == '/api/kanban/FELA1/notify-unblocked', str(CALLS))
    check('A az actor a mozgato', CALLS and CALLS[0]['body'] == {'actor': 'boni'}, str(CALLS))
    check('A Bearer token', CALLS and CALLS[0]['auth'] == 'Bearer tok-test', str(CALLS))
    check('A a kimenet visszaolvasott OK', 'FELOLDAS-ERTESITES OK (visszaolvasva): felszabadult: VARA1' in p.stdout, p.stdout)

    # B) Done-ra mozgatott kartya, ami SEMMIT nem blokkol: nincs hivas.
    M.seed('FELB1', 'in_progress'); CALLS.clear()
    p = run('FELB1', 'done', api)
    check('B lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('B nincs hivas', CALLS == [], str(CALLS))

    # C) Blokkolo kartya, de NEM done-ra mozdul: nincs hivas.
    M.seed('FELC1', 'in_progress'); M.seed('VARC1', 'planned'); block('VARC1', 'FELC1'); CALLS.clear()
    p = run('FELC1', 'waiting', api)
    check('C lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('C nincs hivas', CALLS == [], str(CALLS))

    # D) A szerver nem erheto el: a mozgatas megmarad, a kimenet a potlo hivast adja, a kod nem 0.
    M.seed('FELD1', 'in_progress'); M.seed('VARD1', 'planned'); block('VARD1', 'FELD1')
    p = run('FELD1', 'done', 'http://127.0.0.1:1')
    check('D nem 0 a kod', p.returncode != 0, p.stdout + p.stderr)
    check('D a mozgatas megmaradt', M.card('FELD1')[0] == 'done')
    check('D a potlo hivas a kimenetben', 'NE futtasd ujra' in p.stderr and '/api/kanban/FELD1/notify-unblocked' in p.stderr,
          p.stderr)

    # E) A szerver felszabadultnak mond egy kartyat, de nincs rajta rendszer-komment: HIBA.
    M.seed('FELE1', 'in_progress'); M.seed('VARE1', 'planned'); block('VARE1', 'FELE1')
    ANSWER.update(status=200, freed=['VARE1'], already=[], comment=False)
    p = run('FELE1', 'done', api)
    check('E nem 0 a kod', p.returncode != 0, p.stdout + p.stderr)
    check('E a visszaolvasas hibat mond', 'NEM OLVASHATO VISSZA' in p.stderr, p.stderr)

    # F) 409: kozben mar nem done -- nincs kit ertesiteni, a futas rendben.
    M.seed('FELF1', 'in_progress'); M.seed('VARF1', 'planned'); block('VARF1', 'FELF1')
    ANSWER.update(status=409)
    p = run('FELF1', 'done', api)
    check('F lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('F a kimenet kimondja', '409' in p.stdout, p.stdout)

    # G) Nincs token: a mozgatas megmarad, a kimenet a potlo hivast adja.
    M.seed('FELG1', 'in_progress'); M.seed('VARG1', 'planned'); block('VARG1', 'FELG1')
    ANSWER.update(status=200, freed=[], already=[], comment=True); CALLS.clear()
    p = run('FELG1', 'done', api, token=None)
    check('G nem 0 a kod', p.returncode != 0, p.stdout + p.stderr)
    check('G nincs hivas', CALLS == [], str(CALLS))
    check('G a mozgatas megmaradt', M.card('FELG1')[0] == 'done')
    check('G a potlo hivas a kimenetben', 'NINCS TOKEN' in p.stderr and 'NE futtasd ujra' in p.stderr, p.stderr)

    # H) Dry-run: kimondja a done utani szerver-hivast, de nem hiv es nem mozgat.
    M.seed('FELH1', 'in_progress'); M.seed('VARH1', 'planned'); block('VARH1', 'FELH1'); CALLS.clear()
    p = run('FELH1', 'done', api, extra=('--dry-run',))
    check('H lefutott', p.returncode == 0, p.stdout + p.stderr)
    check('H kimondja a hivast', 'done utan: feloldas-ertesites' in p.stdout, p.stdout)
    check('H nincs hivas', CALLS == [], str(CALLS))
    check('H nem mozgatott', M.card('FELH1')[0] == 'in_progress')

    srv.shutdown()
    if M.FAILS:
        print(f'\n{len(M.FAILS)} teszt BUKOTT: ' + ', '.join(M.FAILS), file=sys.stderr)
        sys.exit(1)
    print('\nminden teszt atment')


if __name__ == '__main__':
    main()
