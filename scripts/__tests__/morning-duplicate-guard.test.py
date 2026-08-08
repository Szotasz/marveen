#!/usr/bin/env python3
"""Unit tests for scripts/hooks/morning-duplicate-guard.py.

The guard has to do two things that pull against each other: stop a second
morning briefing, and never stand between Viktor and an answer. Most of these
tests are about the second one -- the ways a blunter rule would have blocked an
ordinary message.

No hook harness and no real clock: decide() is pure and takes both.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks",
    "morning-duplicate-guard.py",
)
_spec = importlib.util.spec_from_file_location("morning_duplicate_guard", _MODULE_PATH)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

REPLY_TOOL = "mcp__plugin.telegram.telegram__reply"
IN_WINDOW = datetime(2026, 8, 8, 7, 31)
OUTSIDE = datetime(2026, 8, 8, 14, 0)


def payload(text, tool=REPLY_TOOL):
    return {"tool_name": tool, "tool_input": {"chat_id": "1061406155", "text": text}}


class BlocksTheDuplicateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        with open(os.path.join(self.dir, "morning-sent-2026-08-08"), "w") as fh:
            fh.write("sent\n")

    def test_a_second_briefing_in_the_window_is_denied(self):
        allow, reason = guard.decide(payload("Jo reggelt" + guard.SENTINEL), IN_WINDOW, self.dir)
        self.assertFalse(allow)
        self.assertIn("marker", reason)

    def test_the_reason_says_how_to_override_it(self):
        # A block with no way out is a block someone will work around badly.
        _, reason = guard.decide(payload("x" + guard.SENTINEL), IN_WINDOW, self.dir)
        self.assertIn("torold a markert", reason)


class NeverBlocksTheUserTest(unittest.TestCase):
    """Every one of these would have been blocked by a window-only rule."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        with open(os.path.join(self.dir, "morning-sent-2026-08-08"), "w") as fh:
            fh.write("sent\n")

    def test_viktors_own_message_in_the_window_goes_through(self):
        # The reason option 1 was rejected: he answers the briefing at 07:35.
        allow, _ = guard.decide(payload("Koszi, nezd meg a #291-et"), IN_WINDOW, self.dir)
        self.assertTrue(allow)

    def test_a_long_ordinary_reply_goes_through(self):
        # The reason option 2 was rejected: length is not a signal.
        allow, _ = guard.decide(payload("x" * 4000), IN_WINDOW, self.dir)
        self.assertTrue(allow)

    def test_the_sentinel_outside_the_window_goes_through(self):
        allow, _ = guard.decide(payload("valami" + guard.SENTINEL), OUTSIDE, self.dir)
        self.assertTrue(allow)

    def test_another_tool_is_never_touched(self):
        allow, _ = guard.decide(payload("x" + guard.SENTINEL, tool="Bash"), IN_WINDOW, self.dir)
        self.assertTrue(allow)

    def test_a_message_with_no_text_field_goes_through(self):
        allow, _ = guard.decide({"tool_name": REPLY_TOOL, "tool_input": {}}, IN_WINDOW, self.dir)
        self.assertTrue(allow)


class FirstBriefingTest(unittest.TestCase):
    def test_the_first_briefing_of_the_day_goes_through(self):
        # No marker yet: this IS the briefing, and blocking it would be the
        # failure the guard exists to avoid.
        empty = tempfile.mkdtemp()
        allow, _ = guard.decide(payload("Jo reggelt" + guard.SENTINEL), IN_WINDOW, empty)
        self.assertTrue(allow)


class WindowTest(unittest.TestCase):
    def test_the_edges_are_inside(self):
        self.assertTrue(guard.in_window(datetime(2026, 8, 8, 7, 25)))
        self.assertTrue(guard.in_window(datetime(2026, 8, 8, 7, 40)))

    def test_a_minute_either_side_is_outside(self):
        self.assertFalse(guard.in_window(datetime(2026, 8, 8, 7, 24)))
        self.assertFalse(guard.in_window(datetime(2026, 8, 8, 7, 41)))


class FailOpenTest(unittest.TestCase):
    """A crash in a guard must not be able to silence the agent."""

    def _run(self, stdin_text):
        return subprocess.run(
            [sys.executable, _MODULE_PATH], input=stdin_text, capture_output=True, text=True
        )

    def test_a_broken_payload_allows_the_call(self):
        out = self._run("{ not json")
        self.assertEqual(out.returncode, 0)
        self.assertEqual(out.stdout.strip(), "")

    def test_an_empty_payload_allows_the_call(self):
        out = self._run("{}")
        self.assertEqual(out.returncode, 0)
        self.assertEqual(out.stdout.strip(), "")

    def test_a_denial_is_emitted_in_the_shape_the_harness_reads(self):
        mdir = tempfile.mkdtemp()
        today = datetime.now().date().isoformat()
        with open(os.path.join(mdir, f"morning-sent-{today}"), "w") as fh:
            fh.write("sent\n")
        env = {**os.environ, "MORNING_MARKER_DIR": mdir}
        out = subprocess.run(
            [sys.executable, _MODULE_PATH],
            input=json.dumps(payload("brief" + guard.SENTINEL)),
            capture_output=True, text=True, env=env,
        )
        now = datetime.now()
        if not guard.in_window(now):
            self.skipTest("only meaningful inside the morning window")
        body = json.loads(out.stdout)
        self.assertEqual(body["hookSpecificOutput"]["permissionDecision"], "deny")


if __name__ == "__main__":
    unittest.main()
