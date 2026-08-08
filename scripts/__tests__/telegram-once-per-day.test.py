#!/usr/bin/env python3
"""Unit tests for the once-per-day claim in scripts/hooks/telegram_fallback_send.py.

The morning briefing reached Viktor twice on three separate days (2026-08-02,
08-07, 08-08). Each time two sessions ran the same scheduled task around a
channels restart, and each time the prompt-side guard failed for a different
reason: a hot-memory note the new session had not read yet, a check-then-send
that was not atomic, and finally a stale session that sent without running the
guard at all.

A guard in the prompt can only protect the sessions that run it. These tests
are about the claim that moved into the SENDER, where every send has to pass.

No network: the Bot API is never called in the atomic-claim tests, and the CLI
tests point at a stub.
"""
import importlib.util
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks",
    "telegram_fallback_send.py",
)
_spec = importlib.util.spec_from_file_location("telegram_fallback_send", _MODULE_PATH)
sender = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sender)


class ClaimTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "morning-sent-2026-08-08")

    def test_the_first_caller_wins(self):
        self.assertTrue(sender.claim_once_per_day(self.path))

    def test_the_second_caller_is_refused(self):
        sender.claim_once_per_day(self.path)
        self.assertFalse(sender.claim_once_per_day(self.path))

    def test_exactly_one_of_many_simultaneous_callers_wins(self):
        # The acceptance criterion on the card, and the case the prompt-side
        # check-then-send actually lost: two sessions arriving together.
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: sender.claim_once_per_day(self.path), range(8)))
        self.assertEqual(sum(1 for r in results if r), 1)

    def test_the_marker_says_who_claimed_it(self):
        sender.claim_once_per_day(self.path)
        with open(self.path) as fh:
            self.assertIn("pid=", fh.read())

    def test_an_unwritable_location_refuses_rather_than_sends(self):
        # Fail-closed. If we cannot prove we are the only sender, we do not
        # send: a duplicate briefing is worse than a missing one, because the
        # reader cannot tell which of the two is current.
        self.assertFalse(sender.claim_once_per_day("/dev/null/nope/marker"))

    def test_releasing_gives_the_day_back(self):
        # Only after a FAILED send: a claim that outlives a failure would cost
        # the day's briefing, which is the opposite failure.
        sender.claim_once_per_day(self.path)
        sender.release_claim(self.path)
        self.assertTrue(sender.claim_once_per_day(self.path))

    def test_releasing_something_that_is_not_there_is_harmless(self):
        sender.release_claim(os.path.join(self.dir, "never-existed"))


class MarkerPathTest(unittest.TestCase):
    def test_one_marker_per_label_per_day(self):
        p1 = sender.marker_path("morning-sent", "/tmp/x", day="2026-08-08")
        p2 = sender.marker_path("morning-sent", "/tmp/x", day="2026-08-09")
        self.assertNotEqual(p1, p2)
        self.assertTrue(p1.endswith("morning-sent-2026-08-08"))

    def test_two_labels_do_not_share_a_claim(self):
        # A second daily message must not be blocked by the briefing's marker.
        self.assertNotEqual(
            sender.marker_path("morning-sent", "/tmp/x", day="2026-08-08"),
            sender.marker_path("evening-digest", "/tmp/x", day="2026-08-08"),
        )

    def test_the_directory_can_be_pointed_elsewhere_for_tests(self):
        self.assertTrue(sender.marker_dir("/somewhere/else").endswith("/somewhere/else"))


class ArgsTest(unittest.TestCase):
    def test_reads_the_label_and_the_marker_dir(self):
        pos, sid, sdir, label, mdir = sender.parse_args(
            ["123", "hello", "--once-per-day", "morning-sent", "--marker-dir", "/tmp/m"]
        )
        self.assertEqual(pos, ["123", "hello"])
        self.assertEqual(label, "morning-sent")
        self.assertEqual(mdir, "/tmp/m")

    def test_the_old_call_shape_still_parses(self):
        # Every existing caller passes chat_id and text only; adding a flag must
        # not change what they get.
        pos, sid, sdir, label, mdir = sender.parse_args(["123", "hello", "--sid", "abc"])
        self.assertEqual(pos, ["123", "hello"])
        self.assertEqual(sid, "abc")
        self.assertIsNone(label)


if __name__ == "__main__":
    unittest.main()
