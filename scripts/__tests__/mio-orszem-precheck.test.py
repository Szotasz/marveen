#!/usr/bin/env python3
"""ORSICTX912: the sentinel preCheck may only say SKIP on a cleanly measured
all-zero -- every other path must end in a model turn.

The stakes: runPreCheck treats exit 0 + "SKIP" as "no model turn". A precheck
that says SKIP on an error would silence the community sentinel for good, and
nobody would ask why (silence is what the quiet policy legitimizes). So the
cases pin the fail direction case by case:

  1. all-zero counts               -> "SKIP", exit 0
  2. non-zero counts               -> prefix naming the deltas, exit 0, no SKIP
  3. state file missing            -> exit 0, EMPTY stdout (intentional first
                                      model round, not an error)
  4. corrupted threshold (quote /  -> non-zero exit, and the poison never
     injection attempt)               reaches the query string
  5. query output without JSON     -> non-zero exit
  6. empty PAT from the vault      -> non-zero exit
  7. the PAT never appears on stdout in any case
"""
import os
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'hooks', 'mio-orszem-precheck.sh')

STATE_OK = ('{"last_run_at": 1789480000, "last_user_at": "2026-09-15 10:00:00+00",'
            ' "last_post_at": "2026-09-15 10:00:00+00",'
            ' "last_comment_at": "2026-09-15 10:00:00+00",'
            ' "last_purchase_at": "2026-09-15 10:00:00+00", "outcome": "quiet"}')


def run(state=None, query_json=None, pat='dummy-pat-value-44chars-aaaaaaaaaaaaaaaaaaaa',
        supabase_exit=0):
    tmp = tempfile.mkdtemp(prefix='miopre-')
    env = dict(os.environ)

    if state is not None:
        state_path = os.path.join(tmp, 'state.json')
        with open(state_path, 'w') as fh:
            fh.write(state)
        env['MIO_PRECHECK_STATE'] = state_path
    else:
        env['MIO_PRECHECK_STATE'] = os.path.join(tmp, 'missing.json')

    # Stub vault resolver: prints X=<pat> like the real one.
    vault = os.path.join(tmp, 'vault-stub.mjs')
    with open(vault, 'w') as fh:
        fh.write(f'console.log("X={pat}");\n')
    env['MIO_PRECHECK_VAULT'] = vault

    # Stub supabase CLI: records argv (the injection probe reads it back) and
    # prints the scripted response.
    sup = os.path.join(tmp, 'supabase-stub.sh')
    argv_log = os.path.join(tmp, 'supabase-argv.txt')
    with open(sup, 'w') as fh:
        fh.write('#!/usr/bin/env bash\n'
                 f'printf "%s\\n" "$@" > {argv_log}\n'
                 f'cat {tmp}/response.txt\n'
                 f'exit {supabase_exit}\n')
    os.chmod(sup, os.stat(sup).st_mode | stat.S_IEXEC)
    with open(os.path.join(tmp, 'response.txt'), 'w') as fh:
        fh.write(query_json if query_json is not None else '')
    env['MIO_PRECHECK_SUPABASE'] = sup

    node = env.get('MIO_TEST_NODE') or 'node'
    env['MIO_PRECHECK_NODE'] = node

    proc = subprocess.run(['bash', SCRIPT], capture_output=True, text=True,
                          env=env, timeout=30)
    argv = open(argv_log).read() if os.path.exists(argv_log) else ''
    return proc, argv


ZERO = '[{"users": 0, "posts": 0, "comments": 0, "purchases": 0}]'
SOME = 'NOTICE: noise before\n[{"users": 1, "posts": 0, "comments": 2, "purchases": 0}]\ntrailing noise'


class MioOrszemPrecheck(unittest.TestCase):
    def test_all_zero_skips(self):
        proc, _ = run(state=STATE_OK, query_json=ZERO)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), 'SKIP')

    def test_nonzero_runs_with_prefix(self):
        proc, _ = run(state=STATE_OK, query_json=SOME)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotEqual(proc.stdout.strip(), 'SKIP')
        self.assertIn('users=1', proc.stdout)
        self.assertIn('comments=2', proc.stdout)

    def test_missing_state_is_an_intentional_model_round(self):
        proc, _ = run(state=None, query_json=ZERO)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), '')

    def test_injection_attempt_fails_open_and_never_reaches_the_query(self):
        poison = STATE_OK.replace('2026-09-15 10:00:00+00',
                                  "2026-09-15') ; drop table posts; --", 1)
        proc, argv = run(state=poison, query_json=ZERO)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), '')
        self.assertNotIn('drop table', argv)

    def test_unparseable_query_output_fails_open(self):
        proc, _ = run(state=STATE_OK, query_json='{"_tag":"Error","error":{"code":"boom"}}')
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn('SKIP', proc.stdout)

    def test_empty_pat_fails_open(self):
        proc, _ = run(state=STATE_OK, query_json=ZERO, pat='')
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn('SKIP', proc.stdout)

    def test_pat_never_on_stdout(self):
        secret = 'sbp-SECRET-MARKER-000000000000000000000000000'
        for state, qjson in ((STATE_OK, ZERO), (STATE_OK, SOME), (STATE_OK, 'garbage')):
            proc, _ = run(state=state, query_json=qjson, pat=secret)
            self.assertNotIn(secret, proc.stdout)


if __name__ == '__main__':
    sys.exit(unittest.main())
