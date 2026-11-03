#!/usr/bin/env python3
"""BONIKAPUHOOK1102: the billingo-hatralek-orszem issuing gate is a gate instrument.

The gate decides which open billing_errors rows may get a 27% Billingo document
(irreversible at NAV). It used to live only in the scheduled-task store, where
nothing ran its self-test; a gate whose proof only runs by hand rots. This test
runs it the way the scheduled round does (`python3 -I`), so CI goes red when it
breaks.

Cases:
  1. --self-test exits 0 and prints the "SELF-TEST OK" line
  2. input with no JSON -> exit 3 ("NEM MERT"), never a silent zero
  3. --claim-sql on a mixed input: a CLAIM-SQL line for the ELIGIBLE row only,
     pinned on its payment id, none for the REPORT row
Hermetic: a throwaway temp dir, no network, no database.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'billingo', 'kiallitasi-kapu.py')


def run(*args):
    return subprocess.run([sys.executable, '-I', SCRIPT, *args],
                          capture_output=True, text=True, timeout=60)


class IssuingGate(unittest.TestCase):
    def test_self_test_passes(self):
        p = run('--self-test')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('SELF-TEST OK', p.stdout.splitlines())

    def test_no_json_is_not_measured(self):
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, 'rows.json')
            with open(f, 'w', encoding='utf-8') as fh:
                fh.write('Error: unauthorized\n')
            p = run(f, '--claim-sql')
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
        self.assertIn('NEM MERT', p.stdout)
        self.assertNotIn('CLAIM-SQL', p.stdout)

    def test_claim_only_for_eligible(self):
        ok_id = '00000000-0000-0000-0000-000000000001'
        refund_id = '00000000-0000-0000-0000-000000000002'
        rows = {'rows': [
            {'id': ok_id, 'stripe_payment_id': 'pi_abcd1',
             'error_message': 'Failed to create Billingo document: 422', 'context': {}},
            {'id': refund_id, 'stripe_payment_id': 'pi_abcd2',
             'error_message': 'Stripe refund storno failed: x', 'context': {}},
        ]}
        with tempfile.TemporaryDirectory() as d:
            f = os.path.join(d, 'rows.json')
            with open(f, 'w', encoding='utf-8') as fh:
                json.dump(rows, fh)
            p = run(f, '--claim-sql')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        claims = [line for line in p.stdout.splitlines() if line.startswith('CLAIM-SQL ')]
        self.assertEqual(len(claims), 1, p.stdout)
        self.assertIn(f"id='{ok_id}'", claims[0])
        self.assertIn("stripe_payment_id='pi_abcd1'", claims[0])
        self.assertNotIn(refund_id, '\n'.join(claims))


if __name__ == '__main__':
    unittest.main()
