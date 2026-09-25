#!/usr/bin/env python3
"""MEMLINKAUDIT915: a consolidated slug is a HIT, not a broken link.

The regression that made this card: consolidation merges a memory file into a
topic collector and keeps the original slug as a `## <slug>` heading, precisely
so existing [[links]] keep resolving. The audit indexed only filenames and
`name:` fields, so every such link landed in UNRESOLVED -- the bucket its own
footer calls "JAVITANDO". Measured on the live store: 919 unresolved, of which
688 were consolidated slugs that are exactly where they belong. Anyone
"repairing" that list would rewrite working references.

The over-report is not static: it grows with every consolidation round (94 of
those targets came from a single morning's merge of 128 files), which is why
this is wired into CI rather than left as a manual check.

Cases:
  1. a merged slug that exists ONLY as a `## <slug>` heading -> MEMORY-SZEKCIO
     (the real live shape, and the case the fix exists for)
  2. hyphen/underscore drift against a heading              -> MEMORY-SZEKCIO
  3. a type-prefix-only match                               -> SZEKCIO-PREFIX?,
     never silently resolved: feedback_x and reference_x are different memories
  4. a target that exists nowhere                           -> UNRESOLVED
  5. NEGATIVE CONTROL: the buckets that did not change      -> a plain file hit
     is still MEMORY, a `name:` hit still MEMORY-NEV, prose still ARTIFACT
  6. a prose heading (`## Ket szo`) is NOT an anchor: headings are indexed only
     when they are a single token, so a chapter title cannot swallow a link
  7. headings are found deep in the body, past the 2 KB frontmatter window
"""
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'memory-link-audit.py')


def memory_file(name, body, declared=None):
    head = "---\nname: %s\ndescription: fixture\nmetadata:\n  type: reference\n---\n" % (
        declared if declared is not None else name)
    return head + body


class MemoryLinkAudit(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="memlinkaudit")
        def w(name, text):
            with open(os.path.join(cls.dir, name), "w", encoding="utf-8") as fh:
                fh.write(text)

        # A collector that swallowed two memories; both slugs live on as headings.
        # The second sits past 2048 bytes on purpose (case 7).
        filler = "\nsoronkenti toltelek, hogy a fejlec a frontmatter-ablakon KIVUL essen.\n" * 40
        w("topic_collector.md", memory_file(
            "topic_collector",
            "Tema-gyujto.\n\n"
            "## feedback_merged_away\n_Beolvasztott emlek, csak fejleckent letezik._\n"
            + filler +
            "\n## reference_deep_in_the_body\n_A 2 KB-os ablakon tuli fejlec._\n"
            "\n## Ket szo\nProza-fejlec, nem horgony.\n"))

        # An ordinary memory file, and one whose name: field drifts from its stem.
        w("reference_plain_file.md", memory_file("reference_plain_file", "Sima fajl.\n"))
        w("reference_named.md", memory_file(
            "reference_named", "Nev-mezos talalat.\n", declared="a-declared-name"))

        # The file that links to everything above.
        w("project_links.md", memory_file("project_links", "\n".join([
            "[[feedback_merged_away]]",          # 1 exact heading
            "[[reference_deep_in_the_body]]",    # 7 heading past the window
            "[[feedback-merged-away]]",          # 2 spelling drift
            "[[reference_merged_away]]",         # 3 prefix-only -> flagged
            "[[nowhere_at_all]]",                # 4 genuinely unresolved
            "[[reference_plain_file]]",          # 5 negative control: MEMORY
            "[[a-declared-name]]",               # 5 negative control: MEMORY-NEV
            "[[:space:]]",                       # 5 negative control: ARTIFACT
            "[[Ket szo]]",                       # 6 prose heading -> ARTIFACT (phrase)
        ]) + "\n"))

        cls.out = subprocess.run(
            [sys.executable, SCRIPT, cls.dir],
            capture_output=True, text=True, check=True).stdout

    def bucket(self, name):
        """Return the list of targets printed under a bucket header."""
        m = re.search(r"^%s: (\d+) egyedi / (\d+) elofordulas$" % re.escape(name),
                      self.out, re.MULTILINE)
        self.assertIsNotNone(m, "hianyzo csoport a kimenetbol: %s\n%s" % (name, self.out))
        rest = self.out[m.end():]
        targets = []
        for line in rest.splitlines()[1:]:
            if not line.startswith("  "):
                break
            targets.append(line.strip().split("  <- ")[0])
        return int(m.group(1)), targets

    def test_1_merged_slug_resolves_as_section(self):
        count, _ = self.bucket("MEMORY-SZEKCIO")
        self.assertEqual(count, 3, self.out)  # exact + drift + deep-in-body

    def test_2_spelling_drift_resolves(self):
        self.assertNotIn("feedback-merged-away", self.bucket("UNRESOLVED")[1])

    def test_3_prefix_only_is_flagged_not_resolved(self):
        count, targets = self.bucket("SZEKCIO-PREFIX?")
        self.assertEqual(count, 1, self.out)
        self.assertEqual(targets, ["reference_merged_away"])

    def test_4_real_miss_stays_unresolved(self):
        count, targets = self.bucket("UNRESOLVED")
        self.assertEqual(targets, ["nowhere_at_all"], self.out)
        self.assertEqual(count, 1)

    def test_5_untouched_buckets_are_unchanged(self):
        self.assertEqual(self.bucket("MEMORY")[0], 1, self.out)
        self.assertEqual(self.bucket("MEMORY-NEV")[1], ["a-declared-name"], self.out)
        self.assertEqual(self.bucket("ARTIFACT")[0], 2, self.out)

    def test_6_prose_heading_is_not_an_anchor(self):
        # "Ket szo" is a phrase, so it is ARTIFACT -- but the point is that the
        # heading never entered the anchor index in the first place.
        self.assertNotIn("Ket szo", self.bucket("MEMORY-SZEKCIO")[1])

    def test_7_every_link_lands_in_exactly_one_bucket(self):
        total = sum(self.bucket(b)[0] for b in (
            "MEMORY", "MEMORY-NEV", "MEMORY-SZEKCIO", "SKILL/TASK",
            "ARTIFACT", "SZEKCIO-PREFIX?", "UNRESOLVED"))
        self.assertEqual(total, 9, self.out)

    def test_8_footer_names_the_new_bucket(self):
        self.assertIn("MEMORY-SZEKCIO", self.out.split("JAVITANDO")[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
