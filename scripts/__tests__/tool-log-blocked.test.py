#!/usr/bin/env python3
"""Unit tests for the blocked-call row in scripts/hooks/tool-log-capture.py.

A call stopped by a PreToolUse gate never reaches PostToolUse, so it used to
leave no row at all: for 48 hours the ledger showed zero WebFetch calls while
the egress log was full of denials (#232). Someone reading the ledger would
conclude the fleet never tries to read the web.

These tests are about the row that now stands in for the missing one -- and
about it being recognisable as a block rather than as an ordinary failure,
because those two need different responses from whoever reads it.
"""
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks",
    "tool-log-capture.py",
)
_spec = importlib.util.spec_from_file_location("tool_log_capture", _MODULE_PATH)
capture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(capture)


def payload(blocked=False):
    body = {
        "session_id": "sess-1",
        "tool_name": "WebFetch",
        "tool_input": {"url": "https://vercel.com/docs/whatever"},
        "cwd": "/home/viktor/Projects/marveen",
        "tool_use_id": "toolu_123",
    }
    if blocked:
        body["blocked_by"] = "egress-gate"
    return body


class SummaryTest(unittest.TestCase):
    def test_an_ordinary_row_is_unchanged(self):
        self.assertEqual(
            capture._input_summary({"url": "https://example.com/x"}, "WebFetch"),
            "https://example.com/x",
        )


class BlockedRowTest(unittest.TestCase):
    """Driven through the script so the row it POSTs is what is asserted."""

    def _captured_body(self, blocked):
        sent = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"{}"

        def fake_urlopen(req, timeout=None):
            sent["body"] = json.loads(req.data.decode())
            return FakeResponse()

        with patch.object(capture, "_dashboard_token", return_value="tok"), \
             patch.object(capture.urllib.request, "urlopen", side_effect=fake_urlopen), \
             patch.object(capture.sys, "stdin"):
            capture.sys.stdin.read = lambda: json.dumps(payload(blocked))
            try:
                capture.main()
            except SystemExit:
                pass
        return sent.get("body")

    def test_a_blocked_call_is_recorded_at_all(self):
        # The whole point: without this there is no row, and the ledger reads
        # as "nobody tried".
        body = self._captured_body(blocked=True)
        self.assertIsNotNone(body)
        self.assertEqual(body["tool_name"], "WebFetch")

    def test_it_is_marked_unsuccessful(self):
        self.assertFalse(self._captured_body(blocked=True)["success"])

    def test_it_says_it_was_blocked_and_by_what(self):
        # A failed call and a blocked call need different responses from a
        # reader: one is a bug, the other is policy working.
        summary = self._captured_body(blocked=True)["input_summary"]
        self.assertIn("[BLOCKED egress-gate]", summary)
        self.assertIn("vercel.com", summary)

    def test_an_ordinary_call_is_not_labelled(self):
        body = self._captured_body(blocked=False)
        self.assertTrue(body["success"])
        self.assertNotIn("BLOCKED", body["input_summary"])

    def test_it_keeps_the_correlation_id(self):
        # Same trace_id the allowed calls carry, so a blocked call can be found
        # next to whatever the agent did instead.
        self.assertEqual(self._captured_body(blocked=True)["trace_id"], "toolu_123")


class GateWiringTest(unittest.TestCase):
    def test_the_gate_records_before_it_denies(self):
        # Ordering matters: deny() exits the process, so a record written after
        # it would never happen.
        gate = os.path.join(os.path.dirname(_MODULE_PATH), "egress-gate.mjs")
        with open(gate, encoding="utf-8") as fh:
            source = fh.read()
        record_at = source.index("recordBlockInLedger(payload)")
        deny_at = source.index("deny(BLOCK_MESSAGE)")
        self.assertLess(record_at, deny_at)

    def test_the_gate_hands_the_blocked_marker_to_the_same_writer(self):
        gate = os.path.join(os.path.dirname(_MODULE_PATH), "egress-gate.mjs")
        with open(gate, encoding="utf-8") as fh:
            source = fh.read()
        # One writer, one row shape: the gate must not build its own row.
        self.assertIn("tool-log-capture.py", source)
        self.assertIn("blocked_by", source)


if __name__ == "__main__":
    unittest.main()
