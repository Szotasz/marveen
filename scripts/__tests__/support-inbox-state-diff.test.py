#!/usr/bin/env python3
"""Unit tests for scripts/support-inbox-state-diff.py (#132 P4a, route point R1).

Two things have to hold, and they are the reason this route point can be put
inside a 15-minute heartbeat at all.

FAIL-OPEN: neither a refusing router nor a malformed answer may stop the run.
Both come back as exit 3 with the reason on stdout, and the heartbeat then
writes its state note exactly as it did before this step existed.

SEPARATE COUNTERS: "the router gave us nothing" and "the model returned the
wrong shape" are different problems with different fixes. Added together they
would produce one useless number, so the stats file keeps them apart -- and the
shape reasons too, because "not-json" and "wrong type on one key" do not call
for the same change to the prompt.

No network: ask() is patched throughout.
"""
import importlib.util
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "support-inbox-state-diff.py",
)
_spec = importlib.util.spec_from_file_location("support_inbox_state_diff", _MODULE_PATH)
sd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sd)

GOOD = {
    "changed": True,
    "count_delta": 1,
    "unread": 0,
    "new_external_sender": "someone@example.com",
    "reason": "one more message than the previous snapshot",
}
# What check_shape() returns for GOOD: the same fields plus the flag recording
# whether an excluded address had to be dropped.
GOOD_OUT = {**GOOD, "excluded_sender_dropped": False}

LISTING = "INBOX: 9 total, 0 unread. Last 1:\n  [9]         Sat, 9 Aug | a@b.c | hello"


class ShapeCheck(unittest.TestCase):
    def test_accepts_a_well_formed_answer(self):
        fields, err, fenced = sd.check_shape(json.dumps(GOOD))
        self.assertIsNone(err)
        self.assertFalse(fenced)
        self.assertEqual(fields, GOOD_OUT)

    def test_accepts_a_null_sender(self):
        fields, err, _ = sd.check_shape(json.dumps({**GOOD, "new_external_sender": None}))
        self.assertIsNone(err)
        self.assertIsNone(fields["new_external_sender"])

    def test_strips_a_code_fence_and_reports_it(self):
        # A fence is a formatting habit, not a wrong answer -- usable, but
        # worth knowing about, so it is stripped AND flagged.
        fields, err, fenced = sd.check_shape("```json\n" + json.dumps(GOOD) + "\n```")
        self.assertIsNone(err)
        self.assertTrue(fenced)
        self.assertEqual(fields["count_delta"], 1)

    def test_collapses_whitespace_in_the_reason(self):
        fields, err, _ = sd.check_shape(json.dumps({**GOOD, "reason": " two\n lines  here "}))
        self.assertIsNone(err)
        self.assertEqual(fields["reason"], "two lines here")

    def test_rejects_prose_and_non_objects(self):
        for text, expected in [
            ("", "empty"),
            ("Sure! Here is the diff.", "not-json"),
            ("[1, 2]", "not-an-object"),
        ]:
            with self.subTest(text=text):
                fields, err, _ = sd.check_shape(text)
                self.assertIsNone(fields)
                self.assertEqual(err, expected)

    def test_rejects_a_missing_key(self):
        for key in ("changed", "count_delta", "unread", "reason", "new_external_sender"):
            with self.subTest(key=key):
                broken = {k: v for k, v in GOOD.items() if k != key}
                fields, err, _ = sd.check_shape(json.dumps(broken))
                self.assertIsNone(fields)
                self.assertEqual(err, f"missing:{key}")

    def test_rejects_a_stringified_bool_or_number(self):
        # The failure mode being measured: a local model that answers in the
        # right words but the wrong types. Coercing here would hide it.
        for key, value in [("changed", "true"), ("count_delta", "1"), ("unread", "0")]:
            with self.subTest(key=key):
                fields, err, _ = sd.check_shape(json.dumps({**GOOD, key: value}))
                self.assertIsNone(fields)
                self.assertEqual(err, f"type:{key}")

    def test_rejects_a_bool_where_a_number_belongs(self):
        # bool is a subclass of int in Python, so a naive isinstance passes
        # this. It must not.
        fields, err, _ = sd.check_shape(json.dumps({**GOOD, "count_delta": True}))
        self.assertIsNone(fields)
        self.assertEqual(err, "type:count_delta")

    def test_rejects_an_empty_reason(self):
        fields, err, _ = sd.check_shape(json.dumps({**GOOD, "reason": "   "}))
        self.assertIsNone(fields)
        self.assertEqual(err, "empty:reason")

    def test_drops_an_own_or_automated_sender_without_calling_it_malformed(self):
        # Measured against the live router: told to skip viktor.tolnai@*, the
        # model returned viktor.tolnai@gmail.com -- it had matched the peci.io
        # example rather than the rule. The answer is well formed, so this is
        # not a shape error; it is corrected here and counted, because a rule
        # that decides whether a support draft gets written must not depend on
        # a model obeying an instruction.
        for addr in ("viktor.tolnai@gmail.com", "VIKTOR.TOLNAI@peci.io",
                     "noreply@zohomail.com", "no-reply@eu.zoho.com"):
            with self.subTest(addr=addr):
                fields, err, _ = sd.check_shape(json.dumps({**GOOD, "new_external_sender": addr}))
                self.assertIsNone(err)
                self.assertIsNone(fields["new_external_sender"])
                self.assertTrue(fields["excluded_sender_dropped"])

    def test_keeps_a_genuine_external_sender(self):
        for addr in ("jane@shopmerchant.io", "marcell.szijarto@peers.law",
                     "noreply@shopify.com", "viktor.tolnai.dev@example.com"):
            with self.subTest(addr=addr):
                fields, err, _ = sd.check_shape(json.dumps({**GOOD, "new_external_sender": addr}))
                self.assertIsNone(err)
                self.assertEqual(fields["new_external_sender"], addr)
                self.assertFalse(fields["excluded_sender_dropped"])

    def test_rejects_a_non_string_sender(self):
        fields, err, _ = sd.check_shape(json.dumps({**GOOD, "new_external_sender": 42}))
        self.assertIsNone(fields)
        self.assertEqual(err, "type:new_external_sender")


class RunOutcomes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.stats = os.path.join(self.tmp.name, "route-point-stats.json")
        self.state = os.path.join(self.tmp.name, "support-inbox-state.json")
        with open(self.state, "w", encoding="utf-8") as fh:
            json.dump({"last_seen_count": 8, "last_seen_unread": 0, "note": "unchanged"}, fh)
        patcher = patch.multiple(sd, STATS_PATH=self.stats, STATE_PATH=self.state)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_main(self, stdin=LISTING, ask_result=None):
        out = io.StringIO()
        with patch.object(sd.sys, "stdin", io.StringIO(stdin)), \
             patch.object(sd.sys, "stdout", out), \
             patch.object(sd, "ask", return_value=ask_result):
            code = sd.main()
        return code, out.getvalue()

    def counters(self):
        with open(self.stats, encoding="utf-8") as fh:
            return json.load(fh)[sd.ROUTE_POINT]

    def test_a_usable_answer_exits_zero_with_the_fields(self):
        code, out = self.run_main(ask_result={"ok": True, "text": json.dumps(GOOD),
                                              "host": "air903max", "model": "qwen3-coder:latest"})
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["fields"], GOOD_OUT)
        self.assertEqual(self.counters()["ok"], 1)
        self.assertEqual(self.counters()["calls"], 1)

    def test_a_refusal_exits_three_and_is_counted_as_a_refusal(self):
        code, out = self.run_main(ask_result={"ok": False, "refusal": "all-busy",
                                              "detail": "every host busy", "fallback": "retry"})
        self.assertEqual(code, 3)
        # The reason reaches the caller: it decides what to do, not this script.
        self.assertEqual(json.loads(out)["refusal"], "all-busy")
        counts = self.counters()
        self.assertEqual(counts["refused"], 1)
        self.assertEqual(counts["refusal_codes"]["all-busy"], 1)
        self.assertNotIn("shape_error", counts)

    def test_a_malformed_answer_exits_three_but_counts_as_a_shape_error(self):
        code, out = self.run_main(ask_result={"ok": True, "text": "Sure! Here you go.",
                                              "host": "air903max", "model": "qwen3-coder:latest"})
        self.assertEqual(code, 3)
        payload = json.loads(out)
        self.assertEqual(payload["refusal"], "bad-shape")
        self.assertEqual(payload["detail"], "not-json")
        # The raw answer travels with it, or nobody can fix the prompt.
        self.assertIn("Sure!", payload["raw"])
        counts = self.counters()
        self.assertEqual(counts["shape_error"], 1)
        self.assertEqual(counts["shape_reasons"]["not-json"], 1)
        self.assertNotIn("refused", counts)

    def test_the_two_failures_never_share_a_counter(self):
        self.run_main(ask_result={"ok": False, "refusal": "unreachable", "detail": "x"})
        self.run_main(ask_result={"ok": True, "text": "[]"})
        self.run_main(ask_result={"ok": True, "text": json.dumps(GOOD)})
        counts = self.counters()
        self.assertEqual(counts["calls"], 3)
        self.assertEqual(counts["refused"], 1)
        self.assertEqual(counts["shape_error"], 1)
        self.assertEqual(counts["ok"], 1)

    def test_a_dropped_sender_gets_its_own_counter(self):
        code, out = self.run_main(ask_result={"ok": True, "text": json.dumps(
            {**GOOD, "new_external_sender": "viktor.tolnai@gmail.com"})})
        self.assertEqual(code, 0)
        self.assertIsNone(json.loads(out)["fields"]["new_external_sender"])
        counts = self.counters()
        self.assertEqual(counts["ok"], 1)
        self.assertEqual(counts["excluded_sender_dropped"], 1)

    def test_no_input_exits_two_without_calling_the_router(self):
        with patch.object(sd, "ask", side_effect=AssertionError("must not call")) as spy:
            out = io.StringIO()
            with patch.object(sd.sys, "stdin", io.StringIO("   ")), \
                 patch.object(sd.sys, "stdout", out):
                code = sd.main()
        self.assertEqual(code, 2)
        spy.assert_not_called()
        self.assertFalse(os.path.exists(self.stats))

    def test_a_missing_state_file_is_not_a_failure(self):
        os.remove(self.state)
        seen = {}

        def capture(prompt, task_class=None, **kw):
            seen["prompt"] = prompt
            seen["task_class"] = task_class
            return {"ok": True, "text": json.dumps({**GOOD, "changed": False, "count_delta": 0})}

        out = io.StringIO()
        with patch.object(sd.sys, "stdin", io.StringIO(LISTING)), \
             patch.object(sd.sys, "stdout", out), \
             patch.object(sd, "ask", side_effect=capture):
            code = sd.main()
        self.assertEqual(code, 0)
        self.assertIn("state file absent", seen["prompt"])
        # The class is what decides the model; naming the wrong one would put
        # this measurement on gemma4 and change what the latencies mean.
        self.assertEqual(seen["task_class"], "structured")

    def test_an_unwritable_stats_file_does_not_break_the_run(self):
        # The stats are the observation. Losing them must not cost the caller
        # its answer -- otherwise the measuring device breaks the thing it
        # measures.
        with patch.object(sd, "STATS_PATH", os.path.join(self.tmp.name, "no", "such", "dir.json")):
            code, out = self.run_main(ask_result={"ok": True, "text": json.dumps(GOOD)})
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["ok"])

    def test_a_long_previous_note_is_truncated_before_the_prompt(self):
        with open(self.state, "w", encoding="utf-8") as fh:
            json.dump({"last_seen_count": 8, "note": "x" * 5000}, fh)
        seen = {}

        def capture(prompt, task_class=None, **kw):
            seen["prompt"] = prompt
            return {"ok": True, "text": json.dumps(GOOD)}

        out = io.StringIO()
        with patch.object(sd.sys, "stdin", io.StringIO(LISTING)), \
             patch.object(sd.sys, "stdout", out), \
             patch.object(sd, "ask", side_effect=capture):
            sd.main()
        # A route point that starts getting refused because its own history
        # grew would be measuring itself, not the work.
        self.assertNotIn("x" * (sd.MAX_PREV_NOTE + 1), seen["prompt"])


if __name__ == "__main__":
    unittest.main()
