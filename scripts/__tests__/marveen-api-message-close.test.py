#!/usr/bin/env python3
"""marveen-api.sh message-close: a --result-file close of an `[Eredmény]` receipt is refused (unless --no-notify).

Closing a receipt sends nothing back (src/web/routes/messages.ts, the completion-report ping-pong guard), so a
result written there never reaches the sender: on 2026-11-10 two tasks answered inside a receipt were lost this
way. The helper reads the row first and refuses (exit 2, no PUT) when it is a receipt; every other close is sent
as before. The helper runs against a local stub API (MARVEEN_API_BASE) with a dummy token file.

Run:  python3 scripts/__tests__/marveen-api-message-close.test.py
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), 'marveen-api.sh')
TOKEN = 'tok' + 'e' * 40 + '5678'
SEEN = []
ROW = {'status': 200, 'body': '{}'}
FAILS = []


def ok(cond, name, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('' if cond else '  -- ' + detail))
    if not cond:
        FAILS.append(name)


class Stub(http.server.BaseHTTPRequestHandler):
    def _any(self):
        n = int(self.headers.get('Content-Length', '0') or 0)
        raw = self.rfile.read(n) if n else b''
        SEEN.append((self.command, self.path, json.loads(raw) if raw else None))
        status, out = (ROW['status'], ROW['body'].encode()) if self.command == 'GET' else (200, b'{"ok":true}')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_PUT = _any

    def log_message(self, *a):
        return


SRV = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=SRV.serve_forever, daemon=True).start()
TMP = tempfile.mkdtemp(prefix='mapi-close-')
TOKFILE = os.path.join(TMP, '.dashboard-token')
with open(TOKFILE, 'w') as f:
    f.write(TOKEN + '\n')
RESULT = os.path.join(TMP, 'eredmeny.txt')


def run(*args, row_status=200, content='[Feladat] csinald meg'):
    SEEN.clear()
    ROW['status'], ROW['body'] = row_status, json.dumps({'id': 42, 'content': content})
    with open(RESULT, 'w', encoding='utf-8') as f:
        f.write('kesz, bizonyitek: x')
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'MARVEEN_TOKEN_FILE': TOKFILE,
           'MARVEEN_API_BASE': 'http://127.0.0.1:%d' % SRV.server_address[1]}
    p = subprocess.run(['bash', HELPER, 'message-close', '42', *args], env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stderr, [s for s in SEEN if s[0] == 'PUT']


rc, err, puts = run('--result-file', RESULT, content='[Eredmény] msg_id:41 status:done\n\nkesz')
ok(rc == 2 and puts == [] and 'receipt' in err, 'C1 receipt + --result-file: refused, exit 2, no PUT', 'rc=%d puts=%r %s' % (rc, puts, err[:200]))

rc, err, puts = run('--result-file', RESULT)
ok(rc == 0 and puts == [('PUT', '/api/messages/42', {'status': 'done', 'result': 'kesz, bizonyitek: x'})],
   'C2 a task + --result-file: closed with the result', 'rc=%d puts=%r %s' % (rc, puts, err[:200]))

rc, err, puts = run('--no-notify', content='[Eredmény] msg_id:41 status:done')
ok(rc == 0 and puts == [('PUT', '/api/messages/42', {'status': 'done', 'notify': False})],
   'C3 receipt + --no-notify (no result): closed as before', 'rc=%d puts=%r %s' % (rc, puts, err[:200]))

RECIPE = os.path.join(TMP, 'api-eredmeny.txt')  # a recipe payload name: emptied after a send
with open(RECIPE, 'w', encoding='utf-8') as f:
    f.write('az eredmeny')
rc, err, puts = run('--result-file', RECIPE, '--no-notify', content='[Eredmény] msg_id:41 status:done')
kept = open(RECIPE, encoding='utf-8').read()
ok(rc == 0 and puts == [('PUT', '/api/messages/42', {'status': 'done', 'notify': False})] and 'ignored' in err
   and kept == 'az eredmeny',
   'C5 receipt + --result-file + --no-notify: closed, the result ignored (stderr says so), its file kept',
   'rc=%d puts=%r kept=%r %s' % (rc, puts, kept, err[:200]))

with open(RECIPE, 'w', encoding='utf-8') as f:
    f.write('az eredmeny')
rc, err, puts = run('--result-file', RECIPE, '--no-notify')
kept = open(RECIPE, encoding='utf-8').read()
ok(rc == 0 and puts == [('PUT', '/api/messages/42', {'status': 'done', 'result': 'az eredmeny', 'notify': False})]
   and 'ignored' not in err and kept == '',
   'C6 a task + --result-file + --no-notify: closed with the result and notify:false, its recipe file emptied',
   'rc=%d puts=%r kept=%r %s' % (rc, puts, kept, err[:200]))

rc, err, puts = run('--result-file', RESULT, row_status=404, content='')
ok(rc == 0 and len(puts) == 1, 'C4 unreadable row: not refused, the close goes out', 'rc=%d puts=%r %s' % (rc, puts, err[:200]))

SRV.shutdown()
print('\n%d FAIL' % len(FAILS) if FAILS else '\nALL PASS')
sys.exit(1 if FAILS else 0)
