#!/usr/bin/env python3
# dash-audit: literal indokolt -- a szkenner fixture-jei a karakter nelkul nem tesztelhetok
"""DASHAUDITZAJ915: the dash audit must tell justified literals from drift.

The risk the tool answers: a 96-file raw sweep teaches its reader to discount
findings, and then a real outgoing em dash reads as noise. So the contract is
noise-free classification, and these cases pin it:

  1. literal in a doc file                     -> bare-doc FINDING
  2. literal in a test file without marker     -> bare-test FINDING
  3. literal in a test file WITH the marker    -> marked-test, not a finding
  4. the marker does NOT rescue a doc file     -> stays bare-doc (prose has a
     clean rewrite; marking it would relocate the noise)
  5. vendor/lockfile hits leave the denominator, visibly counted
  6. binary and non-UTF8 files are skipped without crashing
  7. --gate exits 1 only when a finding exists
  8. the word and the codepoint form are NOT hits (the convention's clean
     forms must scan silent)
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'dash-audit-scan.py')
DASH = '—'


def run_scan(tree, gate=False):
    """Build a throwaway git repo from {relpath: content} and scan it."""
    tmp = tempfile.mkdtemp(prefix='dashscan-')
    for rel, content in tree.items():
        path = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = 'wb' if isinstance(content, bytes) else 'w'
        kwargs = {} if isinstance(content, bytes) else {'encoding': 'utf-8'}
        with open(path, mode, **kwargs) as fh:
            fh.write(content)
    subprocess.run(['git', '-C', tmp, 'init', '-q'], check=True)
    subprocess.run(['git', '-C', tmp, 'add', '-A'], check=True)
    cmd = [sys.executable, SCRIPT, '--json', '--repo', tmp]
    if gate:
        cmd.append('--gate')
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc, (json.loads(proc.stdout) if proc.stdout.strip().startswith('{') else None)


class DashAuditScan(unittest.TestCase):
    def kinds(self, data):
        return {r['file']: r['kind'] for r in data['results']}

    def test_doc_literal_is_a_finding(self):
        proc, data = run_scan({'docs/rule.md': f'A gate stops this {DASH} always.\n'})
        self.assertEqual(self.kinds(data)['docs/rule.md'], 'bare-doc')
        self.assertEqual(data['summary']['finding_files'], 1)

    def test_unmarked_test_literal_is_a_finding(self):
        proc, data = run_scan({'src/__tests__/gate.test.ts': f"expect(block('{DASH}')).toBe(true)\n"})
        self.assertEqual(self.kinds(data)['src/__tests__/gate.test.ts'], 'bare-test')

    def test_marked_test_literal_is_ok(self):
        content = (f"// dash-audit: literal indokolt -- a dash-szuro nem tesztelheto a karakter nelkul\n"
                   f"expect(block('{DASH}')).toBe(true)\n")
        proc, data = run_scan({'src/__tests__/gate.test.ts': content})
        self.assertEqual(self.kinds(data)['src/__tests__/gate.test.ts'], 'marked-test')
        self.assertEqual(data['summary']['finding_files'], 0)

    def test_marker_does_not_rescue_a_doc_file(self):
        content = (f"dash-audit: literal indokolt -- nem, itt nem az\n"
                   f"Prose with a literal {DASH} anyway.\n")
        proc, data = run_scan({'docs/rule.md': content})
        self.assertEqual(self.kinds(data)['docs/rule.md'], 'bare-doc')

    def test_vendor_hits_leave_the_denominator_visibly(self):
        proc, data = run_scan({
            'deno.lock': f'{{"cached": "service text {DASH} not ours"}}\n',
            'web/vendor/lib.min.js': f'var s="{DASH}";\n',
            'docs/clean.md': 'No dash here, only the word em dash.\n',
        })
        self.assertEqual(data['summary']['finding_files'], 0)
        self.assertEqual(data['summary']['files_excluded_with_hits'], 2)
        self.assertEqual(data['summary']['counts']['excluded-hits'], 2)

    def test_binary_and_bad_utf8_are_skipped(self):
        proc, data = run_scan({
            'assets/logo.png': b'\x89PNG\x00\x01binary',
            'assets/latin1.txt': 'gondolatjel — baj'.encode('latin-1', errors='replace'),
            'docs/rule.md': f'literal {DASH}\n',
        })
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(data['summary']['finding_files'], 1)

    def test_gate_exit_semantics(self):
        proc_bad, _ = run_scan({'docs/rule.md': f'literal {DASH}\n'}, gate=True)
        self.assertEqual(proc_bad.returncode, 1)
        proc_ok, _ = run_scan({'docs/rule.md': 'clean, the word em dash only\n'}, gate=True)
        self.assertEqual(proc_ok.returncode, 0)
        # default (no --gate) is a report even with findings
        proc_report, _ = run_scan({'docs/rule.md': f'literal {DASH}\n'})
        self.assertEqual(proc_report.returncode, 0)

    def test_clean_forms_scan_silent(self):
        proc, data = run_scan({
            'docs/rule.md': 'Nincs gondolatjel (em dash). Soha.\n',
            'src/gate.ts': "const EM = '\\u2014'  // codepoint form, compares the character\n",
        })
        self.assertEqual(data['summary']['finding_files'], 0)
        self.assertEqual(data['results'], [])


if __name__ == '__main__':
    unittest.main()
