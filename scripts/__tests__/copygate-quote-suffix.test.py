#!/usr/bin/env python3
"""COPYGATETOLDALEK920: a Hungarian suffix hanging off a CLOSING QUOTE.

HYPHEN_WORD admits only letters around the hyphen, so in
`a "git pull develop"-ot mondja` the quote cuts the word and leaves a bare "ot",
which the accent dictionary reads as the accent-stripped "öt". The gate then
BLOCKS the whole message. Measured on a live morning briefing 2026-09-20, and
reproduced on develop 2026-09-23 (exit 2, `ot -> öt`). The technical masks cannot
reach it: a quoted span is not a technical region, so nothing swallows the suffix
with it, the way the filename and proper-noun branches do.

The suite deliberately drives the hook as a subprocess with an isolated rules
file, so the live store/outgoing-copy-gate-rules.json is never read or touched.

METHODOLOGY NOTE, the reason this bug survived three earlier fixes of the same
class: the accent check only runs when is_hungarian() finds three markers, so a
SHORT test sentence never triggers it and the bug is invisible. Every fixture
here is a full, long Hungarian sentence on purpose.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(ROOT, "hooks", "outgoing-copy-gate.py")

LEAD = ("Köszönöm, megnéztem a részleteket és a naplót is átolvastam. ")
TAIL = (" Ezt még ma megnézem a gépen, utána pedig szólok neked a részletekről.")


def run_gate(text):
    rules = os.path.join(tempfile.mkdtemp(prefix="copygate-"), "rules.json")
    with open(rules, "w", encoding="utf-8") as fh:
        json.dump({"no_name_rule": True}, fh)
    env = dict(os.environ)
    env["OUTGOING_COPY_GATE_RULES"] = rules
    p = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps({"tool_name": "mcp__plugin_telegram_telegram__reply",
                          "tool_input": {"text": text}}),
        capture_output=True, text=True, env=env, timeout=30)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


class QuoteSuffixPasses(unittest.TestCase):
    def test_straight_quote_suffix(self):
        code, out = run_gate(LEAD + 'A dokumentáció a "git pull develop"-ot mondja.' + TAIL)
        self.assertEqual(code, 0, f"false accent alarm on a quoted command + suffix:\n{out}")

    def test_typographic_quote_suffix(self):
        code, out = run_gate(LEAD + 'A leírás a „git pull develop”-ot mondja.' + TAIL)
        self.assertEqual(code, 0, f"false alarm with Hungarian typographic quotes:\n{out}")

    def test_closing_bracket_suffix(self):
        code, out = run_gate(LEAD + 'A parancsot (git pull develop)-ot kell futtatni.' + TAIL)
        self.assertEqual(code, 0, f"false alarm after a closing bracket:\n{out}")

    def test_apostrophe_suffix(self):
        code, out = run_gate(LEAD + "A beállítás a 'develop'-ot említi a leírásban." + TAIL)
        self.assertEqual(code, 0, f"false alarm after a single quote:\n{out}")


class TheCheckStillWorks(unittest.TestCase):
    """The cure must not be the disease: an accentless Hungarian message still
    has to be stopped, and only the SHORT suffix after a closer is exempt."""

    def test_genuinely_accentless_message_is_blocked(self):
        code, out = run_gate(
            "Szia! Koszonom szepen, holnap kuldom at a szamlat es a reszleteket, "
            "illetve a szerzodes masolatat is mellekelem a levelhez.")
        self.assertEqual(code, 2, f"an accentless message went through:\n{out}")
        self.assertIn("HIANYZO EKEZETEK", out)

    def test_long_compound_after_a_quote_is_still_checked(self):
        """5+ letters after the hyphen is not a suffix, so the exemption must not
        cover it -- otherwise the quote becomes a way to smuggle prose past the
        accent check."""
        code, out = run_gate(
            LEAD + 'A "Telegram"-kuldes nem indult el a gépen, ezért újra megnézem.' + TAIL)
        self.assertEqual(code, 2, f"a long accentless compound slipped through:\n{out}")
        self.assertIn("kuldes", out)

    def test_clean_hungarian_still_passes(self):
        code, out = run_gate(
            "Szia! Köszönöm szépen, holnap küldöm át a számlát és a részleteket, "
            "illetve a szerződés másolatát is mellékelem a levélhez.")
        self.assertEqual(code, 0, f"correct Hungarian was blocked:\n{out}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
