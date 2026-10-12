#!/usr/bin/env python3
"""TASKEGRESSDRIFT913: the egress sweep must see LOGICAL lines and tell marked from bare.

The regression that made this card: a per-physical-line grep for `curl ... https://`
missed a command whose `curl` and `https://` sat on two lines joined by a trailing
backslash. Two procedure files passed the sweep that way.

Cases:
  1. single-line forbidden command in a code block   -> unmarked (both sweeps see it)
  2. backslash-continued command                     -> unmarked, and a physical-line
     grep on the same fixture finds NOTHING (the negative control on the old method)
  3. the same command under the fleet's block note   -> marked
  4. the note in a LATER "Buktatok" section          -> marked-file (read it, not a finding)
  5. a SCOPE-LIMITED note in another section          -> the hit stays unmarked
     (the measured supabase-edge-function-deploy shape: a banner on one section,
      eight bare curls above it)
  6. `curl https://` mentioned in prose              -> prose
  7. wget and a path-prefixed curl                   -> unmarked
  8. exit code: 1 only with an unmarked hit
  9. old-grep blindness is measured against the REAL old method: a continued command
     whose FIRST physical line already carries curl and https:// is NOT old-blind
 10. a bare '#1218' mention in an unrelated paragraph does not mark a bare command
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'egress-drift-scan.py')

SINGLE = "## Eljaras\n```bash\ncurl -s -H 'Authorization: Bearer x' https://api.example.test/v1/thing\n```\n"
CONTINUED = ("## Eljaras\n```bash\ncurl -s -H 'Authorization: Bearer x' \\\n"
             "  \"https://api.example.test/v1/thing\" \\\n"
             "  | python3 -c 'import sys'\n```\n")
NOTE = ("> **FIGYELEM (2026-09-12): AZ ALABBI RECEPT `curl https://` LEPESEI MA NEM FUTTATHATOK** -- a\n"
        "> flotta egress-deny miatt megallnak.\n\n")
MARKED = "## Eljaras\n" + NOTE + CONTINUED.replace("## Eljaras\n", "")
LATER_NOTE = (CONTINUED + "\n## Buktatok\n- **A FENTI `curl` RECEPT 2026-09-12-EN NEM FUTTATHATO -- A KAPU TILTJA (merve).**\n"
              "  A #1218 ota a `curl https://` flotta-szinten DENY.\n")
SCOPED_BANNER = (CONTINUED + "\n## Verify\n> **EZ A SZAKASZ (es CSAK ez: a deploy UTANI verify) 2026-09-11-EN ATIRODOTT. A REGI curl\n"
                 "> alak a #1218 ota tiltott.**\n```bash\nsupabase functions list --project-ref x\n```\n")
PROSE = "A #1218 ota a `curl https://` flotta-szinten DENY, ezert ez a lepes nem fut.\n"
FIRST_LINE_FULL = ("## Eljaras\n```bash\ncurl -s https://api.example.test/v1/thing \\\n  -H 'Authorization: Bearer x' \\\n  | python3 -c 'import sys'\n```\n")
MENTION_ELSEWHERE = (CONTINUED + "\n## Buktatok\n- A #1218 utan a flotta egress-kapuja mas skilleket is erintett; ez itt csak megjegyzes.\n")
OTHERS = "## Telepites\n```sh\n# a `curl https://` alak itt csak komment, nem parancs\nwget https://example.test/a.tar.gz\n/usr/bin/curl -fsSL \\\n  https://example.test/install.sh | sh\n```\n"


def write_skill(root, name, body):
    d = os.path.join(root, name)
    os.makedirs(d)
    with open(os.path.join(d, 'SKILL.md'), 'w', encoding='utf-8') as f:
        f.write('---\nname: ' + name + '\n---\n' + body)
    return os.path.join(d, 'SKILL.md')


def run(root):
    p = subprocess.run([sys.executable, SCRIPT, '--json', '--roots', root], capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout)


def physical_line_grep(path):
    """The OLD sweep: one physical line must carry both `curl` and `https://`."""
    with open(path, encoding='utf-8') as fh:
        return [l for l in fh if re.search(r'\bcurl\b', l) and 'https://' in l]


class EgressDriftScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='egress913-')

    def code_kinds(self, report, path):
        return [h['kind'] for h in report['hits'].get(path, []) if h['kind'] != 'prose']

    def test_single_line_is_unmarked(self):
        p = write_skill(self.tmp, 'single', SINGLE)
        rc, rep = run(self.tmp)
        self.assertEqual(self.code_kinds(rep, p), ['unmarked'])
        self.assertEqual(rc, 1)

    def test_continuation_is_found_where_physical_grep_is_blind(self):
        p = write_skill(self.tmp, 'cont', CONTINUED)
        self.assertEqual(physical_line_grep(p), [])  # negative control on the old method
        rc, rep = run(self.tmp)
        self.assertEqual(self.code_kinds(rep, p), ['unmarked'])
        self.assertTrue(rep['hits'][p][0]['continuation'])
        self.assertEqual(rep['summary']['old_grep_blind_files'], 1)
        self.assertEqual(rc, 1)

    def test_block_note_above_makes_it_marked(self):
        p = write_skill(self.tmp, 'marked', MARKED)
        rc, rep = run(self.tmp)
        self.assertEqual(self.code_kinds(rep, p), ['marked'])
        self.assertEqual(rc, 0)

    def test_note_in_a_later_section_is_marked_file(self):
        p = write_skill(self.tmp, 'later', LATER_NOTE)
        rc, rep = run(self.tmp)
        self.assertEqual(self.code_kinds(rep, p), ['marked-file'])
        self.assertEqual(rc, 0)

    def test_scope_limited_banner_does_not_reach_other_sections(self):
        p = write_skill(self.tmp, 'scoped', SCOPED_BANNER)
        rc, rep = run(self.tmp)
        self.assertEqual(self.code_kinds(rep, p), ['unmarked'])
        self.assertEqual(rc, 1)

    def test_prose_mention_is_not_a_finding(self):
        p = write_skill(self.tmp, 'prose', PROSE)
        rc, rep = run(self.tmp)
        self.assertEqual([h['kind'] for h in rep['hits'][p]], ['prose'])
        self.assertEqual(rc, 0)

    def test_wget_and_path_prefixed_curl(self):
        p = write_skill(self.tmp, 'others', OTHERS)
        rc, rep = run(self.tmp)
        self.assertEqual(self.code_kinds(rep, p), ['unmarked', 'unmarked'])
        self.assertEqual(rc, 1)

    def test_first_line_full_command_is_not_old_grep_blind(self):
        p = write_skill(self.tmp, 'firstline', FIRST_LINE_FULL)
        self.assertEqual(len(physical_line_grep(p)), 1)  # the old method SEES this one
        rc, rep = run(self.tmp)
        self.assertEqual(self.code_kinds(rep, p), ['unmarked'])
        self.assertTrue(rep['hits'][p][0]['continuation'])
        self.assertEqual(rep['summary']['old_grep_blind_files'], 0)

    def test_unrelated_gate_mention_does_not_mark_a_bare_command(self):
        p = write_skill(self.tmp, 'mention', MENTION_ELSEWHERE)
        rc, rep = run(self.tmp)
        self.assertEqual(self.code_kinds(rep, p), ['unmarked'])
        self.assertEqual(rc, 1)

    def test_clean_tree_exits_zero_and_counts_files(self):
        write_skill(self.tmp, 'clean', "```bash\nsupabase db query 'select 1' --linked\n```\n")
        rc, rep = run(self.tmp)
        self.assertEqual(rc, 0)
        self.assertEqual(rep['files'], 1)
        self.assertEqual(rep['hits'], {})


if __name__ == '__main__':
    unittest.main(verbosity=2)
