#!/usr/bin/env python3
"""marveen-api.sh: agent-restart, federation-directory, daily-log-read, memory-backfill.

Before these verbs the main agent made each of these calls by hand: a restart after an update, the federation
catalog the onboarding block asks for before every substantive request, the day's log for the evening summary, and
the nightly embedding backfill. Each one put the token into a header the agent assembled itself. This suite pins what
each verb sends, that a bad call sends nothing, and the two choices that differ from a raw call: agent-restart has no
force, and daily-log-read sends the local day, not the route's UTC default.

The helper runs against a local stub API on 127.0.0.1 (MARVEEN_API_BASE) with a dummy token file
(MARVEEN_TOKEN_FILE), so nothing reaches a real dashboard.

Run:  python3 scripts/__tests__/marveen-api-read-verbs.test.py
"""
import datetime
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HELPER = os.path.join(ROOT, 'scripts', 'marveen-api.sh')
TOKEN = 'tok' + 'e' * 40 + '5678'
SEEN = []
REPLY = {'status': 200, 'body': '{"ok":true}'}
FAILS = []


def ok(cond, name, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('' if cond else '  -- ' + detail))
    if not cond:
        FAILS.append(name)


class Stub(http.server.BaseHTTPRequestHandler):
    def _any(self):
        n = int(self.headers.get('Content-Length', '0') or 0)
        raw = self.rfile.read(n) if n else b''
        SEEN.append({'method': self.command, 'path': self.path, 'headers': dict(self.headers),
                     'body': json.loads(raw) if raw else None})
        out = REPLY['body'].encode()
        self.send_response(REPLY['status'])
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _any

    def log_message(self, *a):
        return


SRV = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=SRV.serve_forever, daemon=True).start()
TMP = tempfile.mkdtemp(prefix='mapi-read-')
TOKFILE = os.path.join(TMP, '.dashboard-token')
with open(TOKFILE, 'w') as f:
    f.write(TOKEN + '\n')


def run(*args, status=200, body='{"ok":true}'):
    SEEN.clear()
    REPLY['status'], REPLY['body'] = status, body
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'MARVEEN_TOKEN_FILE': TOKFILE,
           'MARVEEN_API_BASE': 'http://127.0.0.1:%d' % SRV.server_address[1]}
    p = subprocess.run(['bash', HELPER, *args], env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout, p.stderr, list(SEEN)


def one(seen, method, path, body):
    if len(seen) != 1:
        return False, 'requests=%d' % len(seen)
    s = seen[0]
    auth = s['headers'].get('Authorization')
    good = s['method'] == method and s['path'] == path and s['body'] == body and auth == 'Bearer ' + TOKEN
    return good, '%s %s %r auth_ok=%s' % (s['method'], s['path'], s['body'], auth == 'Bearer ' + TOKEN)


# --- R1-R2: agent-restart ------------------------------------------------------------------------------
rc, out, err, seen = run('agent-restart', 'dani')
g, d = one(seen, 'POST', '/api/agents/dani/restart', {})
ok(rc == 0 and g, 'R1 agent-restart: POST /api/agents/<name>/restart with an empty JSON body (no force)', 'rc=%d %s %s' % (rc, d, err[:160]))
rc, out, err, seen = run('agent-restart', 'dani', '--fresh')
g, d = one(seen, 'POST', '/api/agents/dani/restart', {'fresh': True})
ok(rc == 0 and g, 'R2 agent-restart --fresh: {"fresh": true}, nothing else', 'rc=%d %s %s' % (rc, d, err[:160]))

# --- R3: the error branches send nothing ----------------------------------------------------------------
bad = [('agent-restart',), ('agent-restart', '../x'), ('agent-restart', 'dani', '--force'), ('agent-restart', 'a', 'b'),
       ('federation-directory', 'x'), ('daily-log-read',), ('daily-log-read', 'dani', '--date', '2026-1-1'),
       ('daily-log-read', 'dani', '--date', '2026-11-11&agent=x'), ('memory-backfill', '--all')]
res = [(a, run(*a)) for a in bad]
wrong = [' '.join(a) for a, (rc, _, _, seen) in res if rc != 2 or seen]
ok(not wrong, 'R3 a bad call (missing or extra argument, unsafe name, --force, malformed date) exits 2 and sends nothing', str(wrong))

# --- R4: a busy main agent's 409 comes back as a failure ---------------------------------------------------
rc, out, err, seen = run('agent-restart', 'marveen', status=409, body='{"error":"restart-blocked","reason":"busy"}')
ok(rc == 1 and len(seen) == 1 and 'HTTP 409' in err and 'restart-blocked' in err,
   'R4 a 409 restart-blocked answer: exit 1, the reason on stderr', 'rc=%d n=%d err=%s' % (rc, len(seen), err[:200]))

# --- R5: federation-directory -------------------------------------------------------------------------------
rc, out, err, seen = run('federation-directory', body='{"system":"x","local":{"agents":[]}}')
g, d = one(seen, 'GET', '/api/federation/directory', None)
ok(rc == 0 and g and '"local"' in out, 'R5 federation-directory: GET, the catalog on stdout', 'rc=%d %s %s' % (rc, d, err[:160]))

# --- R6-R7: daily-log-read ------------------------------------------------------------------------------
rc, out, err, seen = run('daily-log-read', 'dani', '--date', '2026-11-11', body='[]')
g, d = one(seen, 'GET', '/api/daily-log?agent=dani&date=2026-11-11', None)
ok(rc == 0 and g, 'R6 daily-log-read --date: agent and date as query parameters', 'rc=%d %s %s' % (rc, d, err[:160]))
before = datetime.date.today().isoformat()
rc, out, err, seen = run('daily-log-read', 'dani', body='[]')
after = datetime.date.today().isoformat()
q = urllib.parse.parse_qs(urllib.parse.urlsplit(seen[0]['path']).query) if len(seen) == 1 else {}
ok(rc == 0 and q.get('agent') == ['dani'] and q.get('date', [''])[0] in (before, after),
   'R7 daily-log-read without --date sends the local day, never leaves it to the route (UTC default)',
   'rc=%d q=%r err=%s' % (rc, q, err[:160]))

# --- R8-R9: memory-backfill -------------------------------------------------------------------------------
rc, out, err, seen = run('memory-backfill', body='{"ok":true,"attempted":2,"embedded":2,"failed":0,"count":2}')
g, d = one(seen, 'POST', '/api/memories/backfill', {})
ok(rc == 0 and g and '"embedded":2' in out, 'R8 memory-backfill: POST, the counts on stdout', 'rc=%d %s %s' % (rc, d, err[:160]))
rc, out, err, seen = run('memory-backfill', status=502, body='{"ok":false,"attempted":3,"embedded":0,"failed":3,"count":0}')
ok(rc == 1 and 'HTTP 502' in err, 'R9 memory-backfill: a 502 (embedding backend down) exits 1, not 0', 'rc=%d err=%s' % (rc, err[:200]))

# --- R10: the new verbs are listed in --help -----------------------------------------------------------------
rc, out, err, _ = run('--help')
missing = [v for v in ('agent-restart', 'federation-directory', 'daily-log-read', 'memory-backfill') if '\n  %s' % v not in out]
ok(rc == 0 and not missing, 'R10 --help lists every new verb', 'missing=%s' % missing)

SRV.shutdown()
print('\n%d failed' % len(FAILS) if FAILS else '\nall passed')
sys.exit(1 if FAILS else 0)
