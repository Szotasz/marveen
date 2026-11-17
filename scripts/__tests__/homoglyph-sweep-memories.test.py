#!/usr/bin/env python3
"""MEMKULCSHOMOGLIF1009: the sweep must look at the memory table, both columns.

Until 2026-10-09 scripts/homoglyph-sweep.py swept FILES and agent_messages and
never touched `memories`. The write-time gate on POST /api/memories read
`content` only, so a Cyrillic letter could enter `keywords` behind a plain 200,
and nothing downstream would ever find it: the gate was on one path, the sweep
on another, and the damage sat between them.

Why `keywords` is not just one more column: in `content` a lookalike is
cosmetic -- the sentence still reads, and the sweep finds the character. In
`keywords` it is functional, because that column is the search surface. The
corrupted word removes the single query path that led through it while every
other keyword on the row keeps matching, so the loss reads as "no such memory".

The cases below pin the contract of the pure row scanner (the I/O wrapper is
one SELECT around it):

  1. a clean row is not a hit
  2. a lookalike in KEYWORDS is a hit, and the field is named
  3. a lookalike in CONTENT is a hit, and the field is named
  4. a row on the intentional list is skipped (the live gate probe, 1075)
  5. NULL keywords does not crash and is not a hit
  6. positive control: the same scanner, same call shape, DOES fire -- a zero
     from this test must be a measured zero, not a no-op

Cyrillic characters are built from codepoints on purpose: a literal would make
this file a hit for the sweep it tests.
"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'homoglyph-sweep.py')

spec = importlib.util.spec_from_file_location('homoglyph_sweep', SCRIPT)
sweep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sweep)

CYR_O = chr(0x043E)  # looks like 'o'
CYR_E = chr(0x0435)  # looks like 'e'


def row(mid, content, keywords, agent='agent-a', category='cold'):
    return (mid, agent, category, content, keywords)


class ScanMemoryRows(unittest.TestCase):
    def test_clean_row_is_not_a_hit(self):
        rows = [row(1, 'árvíztűrő tükörfúrógép, mérése kész', 'mérése, nevező')]
        self.assertEqual(sweep.scan_memory_rows(rows), [])

    def test_keywords_contamination_is_found_and_the_field_is_named(self):
        rows = [row(2, 'tiszta tartalom', f'mer{CYR_E}se, nevezo')]
        hits = sweep.scan_memory_rows(rows)
        self.assertEqual(len(hits), 1)
        mid, agent, category, col, words = hits[0]
        self.assertEqual(mid, 2)
        self.assertEqual(col, 'keywords')
        self.assertEqual(agent, 'agent-a')
        self.assertEqual(words, [f'mer{CYR_E}se'])

    def test_content_contamination_is_still_found(self):
        rows = [row(3, f'a fej mer{CYR_E}se kesz', 'tiszta, kulcsszo')]
        hits = sweep.scan_memory_rows(rows)
        self.assertEqual([h[3] for h in hits], ['content'])

    def test_both_columns_hit_separately(self):
        rows = [row(4, f'visszakereshet{CYR_O}', f'mer{CYR_E}se')]
        hits = sweep.scan_memory_rows(rows)
        self.assertEqual(sorted(h[3] for h in hits), ['content', 'keywords'])

    def test_intentional_rows_are_skipped(self):
        # 1075 is the live probe that proved the keywords gate fires; it must
        # not turn the sweep into a checker that cries on every run.
        rows = [row(1075, 'proba', f'mer{CYR_E}se')]
        self.assertEqual(sweep.scan_memory_rows(rows), [])
        # and the skip is a LIST, not a rule about probes: any other id hits
        self.assertEqual(len(sweep.scan_memory_rows([row(1076, 'proba', f'mer{CYR_E}se')])), 1)

    def test_null_keywords_is_not_text(self):
        rows = [row(5, 'tiszta tartalom kulcsszo nelkul', None)]
        self.assertEqual(sweep.scan_memory_rows(rows), [])

    def test_positive_control_the_scanner_actually_fires(self):
        dirty = sweep.scan_memory_rows([row(6, 'x', f'mer{CYR_E}se')])
        clean = sweep.scan_memory_rows([row(7, 'x', 'merese')])
        self.assertTrue(dirty, 'the scanner found nothing on deliberately dirty input')
        self.assertFalse(clean)


class FlagWiring(unittest.TestCase):
    def test_memories_is_a_known_flag(self):
        # an unknown flag exits 2; the sweep must not reject its own new flag
        self.assertIn('--memories', sweep.KNOWN_FLAGS)


if __name__ == '__main__':
    unittest.main(verbosity=2)
