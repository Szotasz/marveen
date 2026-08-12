#!/usr/bin/env python3
"""Unit tests for the degradation notice in scripts/napindito-router-draft.py.

Why this exists: on 2026-08-12 the morning brief's Hungarian draft was served
by strikex/qwen3:14b instead of gemma4:31b-magyar, because air903max had
stopped serving overnight. The router said so -- `host` and `model` were in the
returned dict all along -- and nobody read it. The data being present is not a
signal; the deviation has to announce itself.

So the tests below are about the one thing that failed in real life: a
successful answer from the WRONG model must not look like a normal success.
"""
import importlib.util
import os
import unittest

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "napindito-router-draft.py",
)
_spec = importlib.util.spec_from_file_location("napindito_router_draft", _MODULE_PATH)
draft = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(draft)


def served(model, host="air903max"):
    return {"ok": True, "text": "draft", "host": host, "model": model, "usage": {}}


class DegradationNotice(unittest.TestCase):
    def test_no_notice_when_the_intended_model_answered(self):
        self.assertIsNone(draft.degradation_note(served("gemma4:31b-magyar")))

    def test_notice_when_a_different_family_answered(self):
        # The real 2026-08-12 case.
        note = draft.degradation_note(served("qwen3:14b", host="strikex"))
        self.assertIsNotNone(note)
        self.assertIn("qwen3:14b", note)

    def test_notice_when_the_smaller_gemma_answered(self):
        # Same family, still a deviation: the reviewer should know the draft
        # came from the 12b, not the 31b.
        note = draft.degradation_note(served("gemma4:12b", host="strikex"))
        self.assertIsNotNone(note)
        self.assertIn("gemma4:12b", note)

    def test_a_missing_model_field_is_reported_not_assumed_fine(self):
        # An older router build, or a proxy that drops the field. Silence here
        # would be the same failure mode in a new costume: unknown must not
        # read as "the right one answered".
        note = draft.degradation_note({"ok": True, "text": "d", "host": None, "model": None})
        self.assertIsNotNone(note)

    def test_refusals_get_no_notice_because_the_caller_already_sees_them(self):
        # A refusal is DATA and the napindito already composes in-session for
        # it; a second warning on top would be noise.
        self.assertIsNone(draft.degradation_note({"ok": False, "refusal": "unreachable"}))

    def test_notice_is_attached_to_the_result_the_caller_prints(self):
        out = draft.annotate(served("qwen3:14b", host="strikex"))
        self.assertIn("degraded", out)
        self.assertTrue(out["degraded"])
        self.assertIn("degraded_note", out)

    def test_annotate_leaves_a_clean_result_alone(self):
        out = draft.annotate(served("gemma4:31b-magyar"))
        self.assertNotIn("degraded_note", out)
        self.assertFalse(out.get("degraded", False))


if __name__ == "__main__":
    unittest.main()
