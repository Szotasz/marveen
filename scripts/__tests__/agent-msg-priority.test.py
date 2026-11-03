#!/usr/bin/env python3
"""agent-msg.sh --priority (card ad771121): the accepted forms, and every empty or misplaced form
failing BEFORE anything is sent.

Measured by the card's independent test on the first version: an empty value
("--priority=" or "--priority ''") went out as normal, a switch after the content was silently
dropped, and a switch after the sender took the recipient's place. Each of those must now exit
non-zero with a FAIL line and ZERO requests; the accepted forms keep their behavior (the "OK id=<n>"
line as the server's queue answer (#1674) makes it, and a DOWNGRADED notice on stderr only when the
pair's hourly high budget turned the row normal).

agent-msg.sh runs against a local stub API on 127.0.0.1 (MARVEEN_API_BASE) with a dummy token file
(MARVEEN_TOKEN_FILE), so nothing reaches a real dashboard.

Run:  python3 scripts/__tests__/agent-msg-priority.test.py
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, 'scripts', 'agent-msg.sh')
REQS = []
ANSWER = {'body': None}
FAILS = []

QUEUE = {'queueDepth': 1, 'estimatedDelaySec': None}


class Stub(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        REQS.append(json.loads(self.rfile.read(n) or b'{}'))
        out = json.dumps(ANSWER['body']).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def main():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    tok = tempfile.NamedTemporaryFile('w', delete=False, prefix='agent-msg-priority-token-')
    tok.write('test-token')
    tok.close()
    env = dict(os.environ, MARVEEN_API_BASE='http://127.0.0.1:%d' % srv.server_address[1], MARVEEN_TOKEN_FILE=tok.name)

    def run(args, answer=None, stdin=None):
        ANSWER['body'] = answer if answer is not None else {'id': 7, 'status': 'pending', 'queue': QUEUE}
        del REQS[:]
        io = {'input': stdin} if stdin is not None else {'stdin': subprocess.DEVNULL}
        r = subprocess.run(['bash', SCRIPT] + args, capture_output=True, text=True, env=env, timeout=60, **io)
        return r.returncode, r.stdout.strip(), r.stderr.strip(), list(REQS)

    try:
        # POSITIVE CONTROLS: the accepted forms behave as before.
        rc, out, err, reqs = run(['--priority', 'high', 'kuldo', 'cel', 'x'])
        check('--priority high before <from>: sent high, the OK line with the queue, no DOWNGRADED',
              rc == 0 and out == 'OK id=7 queue=1' and len(reqs) == 1 and reqs[0].get('priority') == 'high'
              and 'DOWNGRADED' not in err,
              'rc=%d out=%r requests=%r err=%r' % (rc, out, reqs, err[:120]))
        rc, out, err, reqs = run(['--priority=normal', 'kuldo', 'cel', 'x'])
        check('--priority=normal before <from>: sent normal',
              rc == 0 and out == 'OK id=7 queue=1' and len(reqs) == 1 and reqs[0].get('priority') == 'normal',
              'rc=%d out=%r requests=%r' % (rc, out, reqs))
        rc, out, err, reqs = run(['kuldo', 'cel', 'x'])
        check('no switch: no priority key in the body (the server default, FIFO)',
              rc == 0 and out == 'OK id=7 queue=1' and len(reqs) == 1 and 'priority' not in reqs[0],
              'rc=%d out=%r requests=%r' % (rc, out, reqs))
        content = 'multi\nline $(not run) `not run`'
        rc, out, err, reqs = run(['--priority=high', 'kuldo', 'cel', '-'], stdin=content + '\n')
        check('--priority=high with the content from STDIN: sent high, the content verbatim',
              rc == 0 and len(reqs) == 1 and reqs[0].get('priority') == 'high' and reqs[0].get('content') == content,
              'rc=%d requests=%r' % (rc, reqs))
        rc, out, err, reqs = run(['--priority', 'high', 'kuldo', 'cel', 'x'],
                                 {'id': 12, 'priority': 0, 'downgraded': True, 'queue': QUEUE})
        check('a downgraded answer: DOWNGRADED on stderr, the OK line unchanged',
              rc == 0 and out == 'OK id=12 queue=1' and 'DOWNGRADED' in err, 'rc=%d out=%r err=%r' % (rc, out, err[:160]))
        rc, out, err, reqs = run(['--priority', 'high', 'kuldo', 'cel', 'x'], {'id': 14, 'priority': 1, 'queue': QUEUE})
        check('NEGATIVE CONTROL: a high row accepted as high says nothing on stderr',
              rc == 0 and out == 'OK id=14 queue=1' and err == '', 'rc=%d out=%r err=%r' % (rc, out, err[:160]))
        rc, out, err, reqs = run(['kuldo', 'cel', 'x'], {'id': 13, 'status': 'pending'})
        check('an answer without a queue field (an older server): exactly the old OK line, nothing on stderr',
              rc == 0 and out == 'OK id=13' and err == '', 'rc=%d out=%r err=%r' % (rc, out, err[:80]))

        # The refused forms: a non-zero exit, a FAIL line, and NOTHING sent.
        refused = [
            ('an unknown value', ['--priority', 'urgent', 'kuldo', 'cel', 'x']),
            ('a value in another case', ['--priority', 'HIGH', 'kuldo', 'cel', 'x']),
            ('an empty value, "=" form', ['--priority=', 'kuldo', 'cel', 'x']),
            ('an empty value, separate argument', ['--priority', '', 'kuldo', 'cel', 'x']),
            ('the switch alone, without a value', ['--priority']),
            ('the switch after the content', ['kuldo', 'cel', 'x', '--priority', 'high']),
            ('the switch after the content, "=" form', ['kuldo', 'cel', 'x', '--priority=high']),
            ('the switch after the sender (it would take the recipient\'s place)', ['kuldo', '--priority', 'high', 'cel', 'x']),
            ('the switch after the recipient (it would become the content)', ['kuldo', 'cel', '--priority', 'high']),
            ('the switch twice', ['--priority', 'high', '--priority', 'normal', 'kuldo', 'cel', 'x']),
        ]
        for name, args in refused:
            rc, out, err, reqs = run(args)
            check('refused before sending: ' + name, rc != 0 and out.startswith('FAIL') and len(reqs) == 0,
                  'rc=%d out=%r err=%r requests=%d' % (rc, out, err[:120], len(reqs)))
    finally:
        srv.shutdown()
        os.unlink(tok.name)

    print('%d check(s) failed: %s' % (len(FAILS), FAILS) if FAILS else 'all checks passed')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
