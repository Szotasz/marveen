#!/usr/bin/env python3
"""Unit tests for the pure decision step of scripts/gepterem/gree-thermostat.py.

The two incidents these tests encode (card #310, 2026-08-09/10): Viktor powers
the AC on by hand, the sensor sits in the cold outflow, the reading dips under
the off threshold within minutes, and the loop switches the AC off behind his
back. The manual override must stop that -- without ever suspending the
high-temp protection that guards the machines.

decide() is pure (state in, state out, injected clock); no UDP, no files.
"""
import importlib.util
import os
import unittest

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "gepterem",
    "gree-thermostat.py",
)
_spec = importlib.util.spec_from_file_location("gree_thermostat", _MODULE_PATH)
th = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(th)

NOW = 1_786_340_000
HOUR = 3600
ON, OFF = 29.0, 27.0


class ColdStart(unittest.TestCase):
    def test_first_run_adopts_current_state_without_override(self):
        cmd, note, state = th.decide(28.0, ON, OFF, True, {}, NOW)
        self.assertIsNone(cmd)
        self.assertEqual(state["last_cmd_pow"], 1)
        self.assertFalse(NOW < state.get("override_until", 0))

    def test_first_run_still_applies_off_rule(self):
        # Cold-start limitation, deliberate: with no baseline there is no way
        # to tell a manual ON from our own -- the rule wins once, then the
        # baseline exists.
        cmd, _, _ = th.decide(26.0, ON, OFF, True, {}, NOW)
        self.assertEqual(cmd, "off")


class ManualOverride(unittest.TestCase):
    def test_manual_on_is_not_killed_by_off_rule(self):
        # The incident: loop last commanded OFF, Viktor turns it on, sensor
        # reads the cold outflow (26 <= 27). Old loop -> OFF. New loop: hands off.
        state = {"last_cmd_pow": 0}
        cmd, note, state = th.decide(26.0, ON, OFF, True, state, NOW)
        self.assertIsNone(cmd)
        self.assertIn("manual ON respected", note)
        self.assertGreater(state["override_until"], NOW)

    def test_override_expires_and_off_rule_resumes(self):
        state = {"last_cmd_pow": 1, "override_until": NOW - 1}
        cmd, _, state = th.decide(26.0, ON, OFF, True, state, NOW)
        self.assertEqual(cmd, "off")
        self.assertEqual(state["last_cmd_pow"], 0)

    def test_override_persists_across_runs_via_state(self):
        state = {"last_cmd_pow": 0}
        _, _, state = th.decide(26.0, ON, OFF, True, state, NOW)
        # Next tick: unit matches the adopted baseline, override still active.
        cmd, note, state = th.decide(26.5, ON, OFF, True, state, NOW + 300)
        self.assertIsNone(cmd)
        self.assertIn("respected", note)

    def test_high_temp_protection_beats_manual_off(self):
        # Loop commanded ON, someone switched it off, room climbs to the ON
        # threshold: the machines win, the AC comes back.
        state = {"last_cmd_pow": 1}
        cmd, _, state = th.decide(30.0, ON, OFF, False, state, NOW)
        self.assertEqual(cmd, "on")
        self.assertEqual(state["override_until"], 0)

    def test_manual_off_below_threshold_is_respected(self):
        state = {"last_cmd_pow": 1}
        cmd, _, _ = th.decide(28.0, ON, OFF, False, state, NOW)
        self.assertIsNone(cmd)


class NormalHysteresis(unittest.TestCase):
    def test_hot_turns_on(self):
        cmd, _, state = th.decide(29.0, ON, OFF, False, {"last_cmd_pow": 0}, NOW)
        self.assertEqual(cmd, "on")
        self.assertEqual(state["last_cmd_pow"], 1)

    def test_cool_turns_off(self):
        cmd, _, _ = th.decide(27.0, ON, OFF, True, {"last_cmd_pow": 1}, NOW)
        self.assertEqual(cmd, "off")

    def test_band_is_no_change(self):
        for powered in (True, False):
            cmd, _, _ = th.decide(28.0, ON, OFF, powered,
                                  {"last_cmd_pow": 1 if powered else 0}, NOW)
            self.assertIsNone(cmd)


if __name__ == "__main__":
    unittest.main()
