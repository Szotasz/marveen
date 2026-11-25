#!/usr/bin/env python3
"""DONESINCE1123: read-only close reports against a local stub, never a real dashboard.

Run: python3 scripts/__tests__/marveen-api-done-since.test.py
"""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HELPER = os.path.join(ROOT, 'scripts', 'marveen-api.sh')
GATE = os.path.join(ROOT, 'scripts', 'kanban-write-gate.mjs')
SINCE = 1795400000
TOKEN = 'done-since-dummy-token'
SEEN = []
REPLIES = {}
FAILS = []


def ok(cond, name, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + ('' if cond else '  -- ' + detail))
    if not cond:
        FAILS.append(name)


class Stub(http.server.BaseHTTPRequestHandler):
    def _any(self):
        SEEN.append({'method': self.command, 'path': self.path,
                     'authorization': self.headers.get('Authorization')})
        path = urllib.parse.urlsplit(self.path).path
        status, body = REPLIES.get(path, (404, {'error': 'unexpected path'}))
        out = (body if isinstance(body, str) else json.dumps(body)).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _any

    def log_message(self, *args):
        return


try:
    SRV = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Stub)
except OSError as e:
    print('SKIP  local HTTP stub cannot bind 127.0.0.1: %s' % e)
    sys.exit(0)
threading.Thread(target=SRV.serve_forever, daemon=True).start()
TMP = tempfile.TemporaryDirectory(prefix='mapi-done-since-')
TOKFILE = os.path.join(TMP.name, '.dashboard-token')
with open(TOKFILE, 'w', encoding='utf-8') as f:
    f.write(TOKEN + '\n')


def run(*args, kanban=None, kanban_status=200, agents=None, agents_status=200):
    SEEN.clear()
    REPLIES.clear()
    REPLIES.update({'/api/kanban': (kanban_status, [] if kanban is None else kanban),
                    '/api/agents': (agents_status, [] if agents is None else agents)})
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'MARVEEN_TOKEN_FILE': TOKFILE,
           'MARVEEN_API_BASE': 'http://127.0.0.1:%d' % SRV.server_address[1]}
    p = subprocess.run(['bash', HELPER, 'kanban-done-since', *args], env=env,
                       capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout, p.stderr, list(SEEN)


def card(card_id, timestamp, assignee=None, status='done', **extra):
    return {'id': card_id, 'last_status_at': timestamp, 'status': status,
            'assignee': assignee, **extra}


def report(out):
    try:
        return json.loads(out)
    except ValueError:
        return None


def kanban_request(req):
    url = urllib.parse.urlsplit(req['path'])
    return (req['method'] == 'GET' and url.path == '/api/kanban'
            and urllib.parse.parse_qs(url.query) == {
                'status': ['done'], 'includeArchived': ['1'],
                'fields': ['status,assignee,last_status_at']}
            and req['authorization'] == 'Bearer ' + TOKEN)


# A: the boundary is inclusive; a recent comment must not bring an older close in.
rows = [card('A', SINCE - 1, updated_at=SINCE + 200), card('B', SINCE),
        card('C', SINCE + 5, 'owner'), card('D', SINCE + 100),
        card('E', SINCE + 50, status='waiting')]
rc, out, err, seen = run(str(SINCE), kanban=rows)
expected = {'since': SINCE, 'team': None, 'members': None, 'count': 3, 'ids': ['B', 'C', 'D']}
ok(rc == 0 and out == json.dumps(expected, ensure_ascii=False) + '\n' and err == '',
   'A no team: exact one-line JSON, inclusive boundary, only current done status',
   'rc=%d out=%r err=%s' % (rc, out, err))
ok(len(seen) == 1 and kanban_request(seen[0]),
   'A request: exactly one GET, fixed query fields, dummy Bearer token', repr(seen))

# B: stable sorting uses id to break timestamp ties.
rc, out, err, seen = run(str(SINCE), kanban=[
    card('Z1', SINCE + 1), card('A1', SINCE + 1), card('M1', SINCE)])
ok(rc == 0 and report(out) == {**expected, 'ids': ['M1', 'A1', 'Z1']},
   'B order: timestamp then id ascending', 'rc=%d out=%r err=%s' % (rc, out, err))

# C: direct reports and explicit delegates count, with comma-separated assignees.
AGENTS = [
    {'name': 'karcsi', 'team': {'role': 'leader', 'reportsTo': 'okostodor', 'delegatesTo': ['szekusjozsi']}},
    {'name': 'bence', 'team': {'role': 'member', 'reportsTo': 'karcsi', 'delegatesTo': []}},
    {'name': 'webesdavid', 'team': {'role': 'leader', 'reportsTo': 'karcsi', 'delegatesTo': []}},
    {'name': 'tomikutya', 'team': {'role': 'member', 'reportsTo': 'okostodor', 'delegatesTo': []}},
    {'name': 'okostodor', 'team': {'role': 'leader', 'reportsTo': None, 'delegatesTo': []}},
]
assignees = ['webesdavid', 'tomi2,webesdavid', 'karcsi', 'tomikutya', None,
             'Bence', 'szekusjozsi', '', ' webesdavid ']
rows = [card('c%d' % i, SINCE + i, assignee) for i, assignee in enumerate(assignees, 1)]
team_expected = {'since': SINCE, 'team': 'karcsi',
                 'members': ['bence', 'karcsi', 'szekusjozsi', 'webesdavid'],
                 'count': 6, 'ids': ['c1', 'c2', 'c3', 'c6', 'c7', 'c9']}
rc, out, err, seen = run(str(SINCE), '--assignee-team', 'karcsi', kanban=rows, agents=AGENTS)
ok(rc == 0 and out == json.dumps(team_expected, ensure_ascii=False) + '\n' and err == '',
   'C team: leader, direct reports, delegate, multiple assignees, case and whitespace',
   'rc=%d out=%r err=%s' % (rc, out, err))
ok(len(seen) == 2 and kanban_request(seen[0]) and seen[1] == {
    'method': 'GET', 'path': '/api/agents', 'authorization': 'Bearer ' + TOKEN},
   'C requests: one kanban GET then one authenticated agents GET', repr(seen))

# D: an unknown leader is a usage error, with sorted known leaders.
rc, out, err, seen = run(str(SINCE), '--assignee-team', 'arazo', agents=AGENTS)
ok(rc == 2 and out == '' and "unknown team leader 'arazo'" in err
   and 'known leaders: karcsi, okostodor, webesdavid' in err,
   'D unknown leader: exit 2 and sorted known leaders', 'rc=%d err=%s' % (rc, err))

# E: validation happens before either endpoint is contacted.
bad_args = [
    ('non-numeric epoch', ['abc']),
    ('negative epoch', ['-5']),
    ('future epoch', [str(int(time.time()) + 86400)]),
    ('second positional', [str(SINCE), 'extra']),
    ('unknown option', [str(SINCE), '--team', 'karcsi']),
    ('missing team value', [str(SINCE), '--assignee-team']),
    ('invalid team name', [str(SINCE), '--assignee-team', 'Bad Name']),
]
for name, args in bad_args:
    rc, out, err, seen = run(*args)
    ok(rc == 2 and not seen and out == '', 'E refused before request: ' + name,
       'rc=%d requests=%r err=%s' % (rc, seen, err[:200]))

# F: both requests preserve the helper's HTTP failure exit code.
rc, out, err, seen = run(str(SINCE), kanban_status=500, kanban={'error': 'x'})
ok(rc == 1 and out == '' and 'FAIL: HTTP 500' in err and len(seen) == 1,
   'F kanban HTTP 500: exit 1', 'rc=%d err=%s' % (rc, err))
rc, out, err, seen = run(str(SINCE), '--assignee-team', 'karcsi',
                         agents_status=503, agents={'error': 'x'})
ok(rc == 1 and out == '' and 'FAIL: HTTP 503' in err and len(seen) == 2,
   'F agents HTTP 503: exit 1', 'rc=%d err=%s' % (rc, err))

# G: incomplete or malformed data cannot silently produce an empty report.
bad_bodies = [
    ('string timestamp', [{'id': 'x', 'status': 'done', 'last_status_at': '12'}]),
    ('non-list body', {'a': 1}),
    ('bool timestamp', [card('x', True)]),
    ('missing timestamp even on an excluded row', [{'id': 'x', 'status': 'waiting'}]),
    ('non-string id', [card(12, SINCE)]),
    ('non-object row', [None]),
    ('invalid JSON', '{broken'),
]
for name, body in bad_bodies:
    rc, out, err, seen = run(str(SINCE), kanban=body)
    ok(rc == 1 and out == '' and 'unexpected card row' in err,
       'G bad kanban data: ' + name, 'rc=%d err=%s' % (rc, err))
rc, out, err, seen = run(str(SINCE), '--assignee-team', 'karcsi', agents={'a': 1})
ok(rc == 1 and out == '' and 'FAIL:' in err and '/api/agents' in err,
   'G non-list agents body: exit 1', 'rc=%d err=%s' % (rc, err))

# H: exercise the same hook stdin protocol as kanban-write-gate.test.ts.
node = shutil.which('node')
if node is None:
    print('SKIP  H write gate: node is not available')
else:
    def gate(command):
        return subprocess.run([node, GATE], input=json.dumps({
            'tool_name': 'Bash', 'tool_input': {'command': command}}),
            capture_output=True, text=True, timeout=60, cwd=ROOT,
            env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')})

    baseline = gate('bash scripts/marveen-api.sh kanban-list')
    done_since = gate('bash scripts/marveen-api.sh kanban-done-since 1795400000 --assignee-team karcsi')
    ok(baseline.returncode == done_since.returncode == 0
       and baseline.stdout == done_since.stdout == ''
       and baseline.stderr == done_since.stderr == '',
       'H write gate: same empty output as kanban-list, no deny',
       'baseline=%r report=%r' % ((baseline.returncode, baseline.stdout, baseline.stderr),
                                  (done_since.returncode, done_since.stdout, done_since.stderr)))

SRV.shutdown()
SRV.server_close()
TMP.cleanup()
print('FAIL: %d' % len(FAILS) if FAILS else 'OK')
sys.exit(1 if FAILS else 0)
