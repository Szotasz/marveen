#!/usr/bin/env python3
"""marveen-api.sh kanban verbs, and the main agent's and the federation block's recipes on the helper.

The CLAUDE.md template and the federation onboarding block told every agent to call the dashboard
with `curl ... -H "Authorization: Bearer $(cat store/.dashboard-token)"`: the token sat on curl's
argv, which `ps` shows to every local user. scripts/marveen-api.sh already reads the token itself
(#2232, #2236, #2338); it had no kanban verbs, so the kanban recipes could not move to it. This
suite pins the kanban verbs (what each sends, and that a bad call sends nothing), and that the two
recipe sources name only the helper. The one curl recipe with a token header left in the template is
the schedule creation: the helper deliberately has no schedule verb (P13), so it cannot become a way
around the self-pace gate. P14-P16 read the recipe source text; they do not measure a runtime argv.

The message verb is a named exception: marveen-api.sh hands it to
scripts/agent-msg.sh, which still puts the token on curl's argv. P18 pins that the recipes say so
instead of claiming the opposite; fixing agent-msg.sh is a separate step.

The helper runs against a local stub API on 127.0.0.1 (MARVEEN_API_BASE) with a dummy token file
(MARVEEN_TOKEN_FILE), so nothing reaches a real dashboard.

Run:  python3 scripts/__tests__/marveen-api-kanban.test.py
"""
import http.server
import json
import os
import re
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HELPER = os.path.join(ROOT, 'scripts', 'marveen-api.sh')
API_PY = os.path.join(ROOT, 'scripts', 'lib', 'marveen_api.py')
TEMPLATE = os.path.join(ROOT, 'templates', 'CLAUDE.md.template')
ONBOARDING = os.path.join(ROOT, 'src', 'web', 'federation', 'onboarding.ts')
TOKEN = 'tok' + 'e' * 40 + '1234'
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
        return  # the stub stays quiet; the test prints its own lines


SRV = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=SRV.serve_forever, daemon=True).start()
TMP = tempfile.mkdtemp(prefix='mapi-kanban-')
TOKFILE = os.path.join(TMP, '.dashboard-token')
with open(TOKFILE, 'w') as f:
    f.write(TOKEN + '\n')


def fpath(name, content):
    p = os.path.join(TMP, name)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(content)
    return p


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


# --- P1-P7: what each kanban verb sends -------------------------------------------------------------
rc, out, err, seen = run('kanban-list', body='[{"id":"abcd1234"}]')
g, d = one(seen, 'GET', '/api/kanban', None)
ok(rc == 0 and g and 'abcd1234' in out, 'P1 kanban-list: GET /api/kanban, token header, body on stdout', 'rc=%d %s %s' % (rc, d, err[:160]))

rc, out, err, seen = run('kanban-create', 'dani', 'high', fpath('title.txt', 'Uj kartya `x` $(nem)\n'))
g, d = one(seen, 'POST', '/api/kanban', {'title': 'Uj kartya `x` $(nem)', 'status': 'planned', 'assignee': 'dani', 'priority': 'high'})
ok(rc == 0 and g, 'P2 kanban-create: title from the file (trimmed), status planned', 'rc=%d %s %s' % (rc, d, err[:160]))

ev = fpath('ev.txt', 'eph j1: 11/11, a "quote" es \\ backslash')
rc, out, err, seen = run('kanban-move', 'abcd1234', 'done', '--expected-status', 'in_progress', '--evidence-file', ev, '--actor', 'dani')
g, d = one(seen, 'POST', '/api/kanban/abcd1234/move', {'status': 'done', 'expected_status': 'in_progress', 'evidence': 'eph j1: 11/11, a "quote" es \\ backslash', 'actor': 'dani'})
ok(rc == 0 and g, 'P3 kanban-move: status, expected_status, evidence from the file, actor', 'rc=%d %s %s' % (rc, d, err[:160]))
rc, out, err, seen = run('kanban-move', 'abcd1234', 'in_progress')
g, d = one(seen, 'POST', '/api/kanban/abcd1234/move', {'status': 'in_progress'})
ok(rc == 0 and g, 'P3b kanban-move: the bare form sends only the status', 'rc=%d %s %s' % (rc, d, err[:160]))

rc, out, err, seen = run('kanban-claim', 'abcd1234', 'dani')
g, d = one(seen, 'POST', '/api/kanban/abcd1234/claim', {'agent': 'dani'})
rc2, out2, err2, seen2 = run('kanban-claim', 'abcd1234', 'dani', '--ttl', '600')
g2, d2 = one(seen2, 'POST', '/api/kanban/abcd1234/claim', {'agent': 'dani', 'ttl_seconds': 600})
ok(rc == 0 and g and rc2 == 0 and g2, 'P4 kanban-claim: agent, and --ttl as an integer ttl_seconds', '%s | %s %s' % (d, d2, (err + err2)[:160]))

rc, out, err, seen = run('kanban-release', 'abcd1234', 'dani')
g, d = one(seen, 'POST', '/api/kanban/abcd1234/release', {'agent': 'dani'})
ok(rc == 0 and g, 'P5 kanban-release: agent', 'rc=%d %s %s' % (rc, d, err[:160]))

rc, out, err, seen = run('kanban-comment', 'abcd1234', 'dani', fpath('c.txt', 'eredmeny `backtick` es $(nem fut)\nmasodik sor\n'))
g, d = one(seen, 'POST', '/api/kanban/abcd1234/comments', {'author': 'dani', 'content': 'eredmeny `backtick` es $(nem fut)\nmasodik sor\n'})
ok(rc == 0 and g, 'P6 kanban-comment: the file content byte for byte, author', 'rc=%d %s %s' % (rc, d, err[:160]))

rc, out, err, seen = run('agents-list', body='[{"name":"dani"}]')
g, d = one(seen, 'GET', '/api/agents', None)
ok(rc == 0 and g and '"dani"' in out, 'P7 agents-list: GET /api/agents', 'rc=%d %s %s' % (rc, d, err[:160]))

# --- P8-P12: the error branches (each with its own token) ---------------------------------------------
rc, out, err, seen = run('kanban-move', 'abcd1234', 'done', '--expected-status', 'in_progress', status=409,
                         body='{"error":"status_conflict","current_status":"testing"}')
ok(rc == 1 and len(seen) == 1 and 'HTTP 409' in err and 'current_status' in err, 'P8 409 on move: exit 1, the conflict body on stderr', 'rc=%d n=%d err=%s' % (rc, len(seen), err[:200]))

rc, out, err, seen = run('kanban-claim', 'abcd1234', 'dani', status=404, body='{"ok":false,"reason":"claim_lock_disabled"}')
ok(rc == 1 and len(seen) == 1 and 'claim_lock_disabled' in err, 'P9 claim with the lock off: exit 1, the reason on stderr', 'rc=%d n=%d err=%s' % (rc, len(seen), err[:200]))

bad_ids = ['../schedules', 'a/b', 'abcd1234?x=1', '']
res = [run('kanban-comment', b, 'dani', fpath('c2.txt', 'x')) for b in bad_ids]
ok(all(r[0] == 2 and not r[3] and 'invalid card id' in r[2] for r in res),
   'P10 a card id that could leave /api/kanban/<id>/ (.., /, ?, empty): exit 2, invalid card id, nothing sent',
   ' | '.join('rc=%d n=%d %s' % (r[0], len(r[3]), r[2][:80].replace('\n', ' ')) for r in res))

rc, out, err, seen = run('kanban-comment', 'abcd1234', 'dani', os.path.join(TMP, 'nincs.txt'))
ok(rc == 2 and not seen and 'cannot read' in err, 'P11 a missing content file: exit 2, cannot read, nothing sent', 'rc=%d n=%d %s' % (rc, len(seen), err[:160]))
rc, out, err, seen = run('kanban-comment', 'abcd1234', 'dani', fpath('ures.txt', '  \n'))
ok(rc == 2 and not seen and 'empty' in err, 'P11b an empty comment: exit 2, empty, nothing sent', 'rc=%d n=%d %s' % (rc, len(seen), err[:160]))

checks = [
    (('kanban-move', 'abcd1234', 'Done;rm'), 'invalid status'),
    (('kanban-move', 'abcd1234', 'done', '--expected-status', 'x y'), 'invalid status'),
    (('kanban-claim', 'abcd1234', 'dani', '--ttl', 'abc'), 'invalid ttl'),
    (('kanban-create', 'dani', 'sürgős', fpath('t2.txt', 'x')), 'invalid priority'),
    (('kanban-release', 'abcd1234', 'Dani Kiss'), 'invalid agent name'),
]
res = [(run(*a), tok) for a, tok in checks]
ok(all(r[0] == 2 and not r[3] and tok in r[2] for r, tok in res),
   'P12 a bad status / ttl / priority / agent name: exit 2 with its own token, nothing sent',
   ' | '.join('rc=%d n=%d want=%s got=%s' % (r[0], len(r[3]), tok, r[2][:70].replace('\n', ' ')) for r, tok in res))

# --- P13 INVARIANS: the helper never builds a schedule path ------------------------------------------
src = open(API_PY, encoding='utf-8').read()
paths = re.findall(r"""f?['"](/api/[^'"]*)['"]""", src)
ok(paths and not [p for p in paths if 'schedul' in p], 'P13 INVARIANS: no helper path under /api/schedules (self-pace gate)',
   'paths=%r' % [p for p in paths if 'schedul' in p])

# --- P14-P16: the recipe sources name the helper, not a curl token header (source text) --------------
tpl = open(TEMPLATE, encoding='utf-8').read()
argv = [m.start() for m in re.finditer(r'Authorization:\s*Bearer', tpl)]
sched = re.search(r'curl -s -X POST http://localhost:\{\{WEB_PORT\}\}/api/schedules \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer \$\(cat store/\.dashboard-token\)" \\\n', tpl)
ok(len(argv) == 1 and sched is not None and sched.start() < argv[0] < sched.end(),
   'P14 template: the only curl token header is the schedule creation recipe',
   'argv=%d at lines %s, schedule recipe found=%s' % (len(argv), [tpl.count('\n', 0, i) + 1 for i in argv], sched is not None))

onb = open(ONBOARDING, encoding='utf-8').read()
hits = [onb.count('\n', 0, m.start()) + 1 for m in re.finditer(r'Authorization:\s*Bearer', onb)]
ok(not hits, 'P15 federation onboarding block: no curl token header', 'lines %s' % hits)

help_rc, help_out, help_err, _ = run('--help')
known = set(re.findall(r'^\s{2}([a-z][a-z-]+)\s', help_out, re.M))
used_tpl = re.findall(r'marveen-api\.sh ([a-z][a-z-]*)', tpl)
# The sub-agent block names the helper through `${helper}`, its absolute path as one shell word (F2).
used_onb = re.findall(r'(?:marveen-api\.sh|\$\{helper\}) ([a-z][a-z-]*)', onb)
unknown = sorted(set(used_tpl + used_onb) - known)
need_tpl = {'memory-save', 'daily-log', 'memory-search', 'kanban-list', 'kanban-create', 'kanban-move',
            'kanban-claim', 'kanban-release', 'kanban-comment', 'message', 'agents-list'}
ok(not unknown and need_tpl <= set(used_tpl) and used_onb.count('message') >= 4,
   'P16 every helper call in the recipes names a verb the helper knows, and each former curl recipe has one',
   'unknown=%s missing_in_template=%s onboarding_message=%d' % (unknown, sorted(need_tpl - set(used_tpl)), used_onb.count('message')))

# --- P17 INVARIANS: a federated recipient passes through the message verb ----------------------------
rc, out, err, seen = run('message', 'dani', 'masik-rendszer/ugynok', fpath('m.txt', 'szia'), body='{"id":7,"status":"pending"}')
ok(rc == 0 and len(seen) >= 1 and seen[-1]['body'] and seen[-1]['body'].get('to') == 'masik-rendszer/ugynok',
   'P17 INVARIANS: message keeps a <system>/<agent> recipient',
   'rc=%d n=%d %s' % (rc, len(seen), (seen[-1]['body'] if seen else None, err[:120])))

# --- P18: the message verb's argv token is a named exception ---------------------
# scripts/agent-msg.sh is out of this change and still puts the token on curl's argv. A recipe must not
# claim the opposite for `message`: the template names the exception where it says the helper keeps
# the token off the command line, and every federation message recipe names it next to the call.
def sentences(s):
    return re.split(r'(?<=[.!?])\s+', re.sub(r'\s+', ' ', s))


def names_exception(s):
    return any('agent-msg.sh' in x and 'argv' in x for x in sentences(s))


CLAIM = re.compile(r'nem kerül a\s+parancssorba|never reaches the\s+command line')
bad_pars = [tpl.count('\n', 0, tpl.find(p)) + 1 for p in re.split(r'\n\s*\n', tpl) if CLAIM.search(p) and not names_exception(p)]
ok(names_exception(tpl) and not bad_pars,
   'P18a template: the message verb argv token is named where the helper claim stands',
   'exception named=%s unqualified claim in the paragraph at lines %s' % (names_exception(tpl), bad_pars))

calls = [m.start() for m in re.finditer(r'(?:marveen-api\.sh|\$\{helper\}) message ', onb)]
bare = []
for i in calls:
    fence = onb.find('\\`\\`\\`', i)
    # the window runs to the end of the paragraph after the closing fence (the note under the call)
    after = onb.find('\n\n', fence if fence >= 0 else i)
    end = onb.find('\n\n', after + 2) if after >= 0 else -1
    if not names_exception(onb[i:end if end >= 0 else len(onb)]):
        bare.append(onb.count('\n', 0, i) + 1)
claims = [onb.count('\n', 0, m.start()) + 1 for m in CLAIM.finditer(onb)]
ok(len(calls) >= 4 and not bare and not claims,
   'P18b federation onboarding: each message recipe names the agent-msg.sh argv exception, none claims the opposite',
   'calls=%d without the exception at lines %s, claim at lines %s' % (len(calls), bare, claims))

# --- P19-P20: review follow-ups -------------------------------------------------------
# A `$`-anchored pattern with re.match lets a trailing newline through ('abcd1234\n' reached
# http.client as a URL and died in a traceback, exit 1 instead of the usage exit 2).
checks = [
    (('kanban-comment', 'abcd1234\n', 'dani', fpath('c3.txt', 'x')), 'invalid card id'),
    (('kanban-move', 'abcd1234', 'done\n'), 'invalid status'),
    (('kanban-release', 'abcd1234', 'dani\n'), 'invalid agent name'),
]
res = [(run(*a), tok) for a, tok in checks]
ok(all(r[0] == 2 and not r[3] and tok in r[2] for r, tok in res),
   'P19 a trailing newline in a card id / status / agent name: exit 2 with its own token, nothing sent',
   ' | '.join('rc=%d n=%d want=%s got=%s' % (r[0], len(r[3]), tok, r[2][:70].replace('\n', ' ')) for r, tok in res))

rc, out, err, seen = run('kanban-move', 'abcd1234', 'done', '--evidence-file', fpath('ev-ures.txt', ' \n\t\n'))
ok(rc == 2 and not seen and 'evidence is empty' in err, 'P20 kanban-move with a blank evidence file: exit 2, evidence is empty, nothing sent',
   'rc=%d n=%d %s' % (rc, len(seen), err[:160]))

# --- P21-P23: the maintainer's review of #2080 -----------------------------------------------------
# An empty title must never reach the board (nothing pinned it: removing the check stayed green).
res = [run('kanban-create', 'dani', 'high', fpath('t-ures%d.txt' % i, c)) for i, c in enumerate(['', ' \n\t\n'])]
ok(all(r[0] == 2 and not r[3] and 'title is empty' in r[2] for r in res),
   'P21 kanban-create with an empty or blank title file: exit 2, title is empty, nothing sent',
   ' | '.join('rc=%d n=%d %s' % (r[0], len(r[3]), r[2][:80].replace('\n', ' ')) for r in res))

# The board cuts a title above 300 characters (the kanban_cards_title_gate trigger, src/db.ts): the
# helper refuses it up front instead of letting the card land with a different title. Characters,
# not bytes (SQLite length() and Python len() both count code points): 300 accented letters go out.
rc, out, err, seen = run('kanban-create', 'dani', 'high', fpath('t301.txt', 'é' * 301 + '\n'))
rc2, out2, err2, seen2 = run('kanban-create', 'dani', 'high', fpath('t300.txt', 'é' * 300 + '\n'))
g, d = one(seen2, 'POST', '/api/kanban', {'title': 'é' * 300, 'status': 'planned', 'assignee': 'dani', 'priority': 'high'})
ok(rc == 2 and not seen and 'longer than 300 characters' in err and rc2 == 0 and g,
   'P22 kanban-create: a 301-character title exits 2 (longer than 300 characters, nothing sent), 300 goes out',
   'rc301=%d n=%d %s | rc300=%d %s' % (rc, len(seen), err[:120].replace('\n', ' '), rc2, d))

# developer-junior (a strict profile) allows `bash ${PROJECT_ROOT}/scripts/marveen-api.sh:*`, so its agents get the
# kanban write verbs too: the description says so, naming the helper and each write verb.
with open(os.path.join(ROOT, 'templates', 'profiles', 'developer-junior.json'), encoding='utf-8') as f:
    desc = json.load(f).get('description', '')
WRITE_VERBS = ['kanban-create', 'kanban-move', 'kanban-claim', 'kanban-release', 'kanban-comment']
ok('marveen-api.sh' in desc and all(v in desc for v in WRITE_VERBS),
   'P23 developer-junior profile: the description says marveen-api.sh also gives the kanban write verbs',
   'missing: %s' % [v for v in ['marveen-api.sh'] + WRITE_VERBS if v not in desc])

SRV.shutdown()
print('FAIL: %d' % len(FAILS) if FAILS else 'OK')
sys.exit(1 if FAILS else 0)
