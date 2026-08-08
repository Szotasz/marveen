#!/usr/bin/env python3
"""Unit tests for scripts/hooks/morning-mark-sent.py.

This hook exists because of one specific hole: on 2026-08-08 the FIRST briefing
went out through the reply tool from a session that never wrote a marker, so
the blocking guard had nothing to read. The marker now gets written by the
mechanism that saw the send succeed.

The tests are mostly about when it must NOT mark -- marking the day wrongly is
the failure that costs Viktor his briefing entirely.
"""
import importlib.util
import os
import tempfile
import unittest

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks",
    "morning-mark-sent.py",
)
_spec = importlib.util.spec_from_file_location("morning_mark_sent", _MODULE_PATH)
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)

REPLY_TOOL = "mcp__plugin.telegram.telegram__reply"


def payload(text, tool=REPLY_TOOL, error=False):
    return {
        "tool_name": tool,
        "tool_input": {"chat_id": "1061406155", "text": text},
        "tool_response": {"is_error": True} if error else {"ok": True},
    }


class MarksTest(unittest.TestCase):
    def test_marks_a_delivered_briefing(self):
        self.assertTrue(hook.should_mark(payload("Jo reggelt" + hook.SENTINEL)))

    def test_writes_the_file_the_other_guard_reads(self):
        d = tempfile.mkdtemp()
        path = hook.marker_path(day="2026-08-08", mdir=d)
        self.assertTrue(hook.mark(path, note="chat=1061406155"))
        self.assertTrue(os.path.exists(path))
        # The name has to match the sender-side claim and the task exactly, or
        # the two paths would be guarding different days.
        self.assertTrue(path.endswith("morning-sent-2026-08-08"))

    def test_does_not_overwrite_a_marker_the_sender_already_wrote(self):
        # That record carries the message id; this one would replace it with
        # less information.
        d = tempfile.mkdtemp()
        path = hook.marker_path(day="2026-08-08", mdir=d)
        with open(path, "w") as fh:
            fh.write("sent chat=1 message_id=42\n")
        self.assertFalse(hook.mark(path))
        with open(path) as fh:
            self.assertIn("message_id=42", fh.read())


class DoesNotMarkTest(unittest.TestCase):
    """Marking wrongly costs the day's briefing -- these are the guards on that."""

    def test_does_not_mark_a_failed_send(self):
        # The case where the agent still has to reach the user; a marker here
        # would stop the retry.
        self.assertFalse(hook.should_mark(payload("Jo reggelt" + hook.SENTINEL, error=True)))

    def test_does_not_mark_an_ordinary_reply(self):
        self.assertFalse(hook.should_mark(payload("Koszi, megnezem")))

    def test_does_not_mark_another_tool(self):
        self.assertFalse(hook.should_mark(payload("x" + hook.SENTINEL, tool="Bash")))

    def test_does_not_mark_when_there_is_no_text(self):
        self.assertFalse(hook.should_mark({"tool_name": REPLY_TOOL, "tool_input": {}}))

    def test_an_unwritable_path_is_not_an_error(self):
        # A PostToolUse hook runs after delivery; the only thing an exception
        # could achieve is noise.
        self.assertFalse(hook.mark("/dev/null/nope/marker"))


class SharedFormatTest(unittest.TestCase):
    def test_the_sentinel_is_the_same_one_the_blocking_guard_looks_for(self):
        guard_path = os.path.join(os.path.dirname(_MODULE_PATH), "morning-duplicate-guard.py")
        spec = importlib.util.spec_from_file_location("guard", guard_path)
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        self.assertEqual(hook.SENTINEL, guard.SENTINEL)
        # And the same marker name: two files that disagree here would look
        # like a working pair while guarding different days.
        self.assertEqual(
            os.path.basename(hook.marker_path(day="2026-08-08", mdir="/tmp")),
            f"{guard.MARKER_PREFIX}-2026-08-08",
        )


if __name__ == "__main__":
    unittest.main()
