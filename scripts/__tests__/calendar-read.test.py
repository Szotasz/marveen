#!/usr/bin/env python3
"""Unit tests for scripts/calendar-read.py.

The point of this module is a single distinction: "no events today" and "I
could not read the calendar" must never look alike. Most of what follows pins
exactly that -- including the case the whole design exists for, a stale
snapshot left behind by a LaunchAgent that stopped running.
"""
import importlib.util
import os
import unittest
from datetime import datetime, timedelta, timezone

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "calendar-read.py",
)

_spec = importlib.util.spec_from_file_location("calendar_read", _MODULE_PATH)
cr = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_spec and cr)  # type: ignore[union-attr]

LOCAL = timezone(timedelta(hours=2))
NOW = datetime(2026, 8, 13, 9, 0, tzinfo=LOCAL)


def payload(status="ok", events=None, minutes_old=5, **kw):
    generated = NOW - timedelta(minutes=minutes_old)
    return {
        "status": status,
        "generatedAt": generated.isoformat(),
        "dayStart": "2026-08-13T00:00:00+02:00",
        "dayEnd": "2026-08-14T00:00:00+02:00",
        "events": events if events is not None else [],
        **kw,
    }


def event(start="2026-08-13T10:30:00+02:00", end="2026-08-13T11:00:00+02:00", **kw):
    base = {"start": start, "end": end, "title": "Egyeztetés", "location": None,
            "allDay": False, "calendar": "Munka"}
    base.update(kw)
    return base


class TestInterpret(unittest.TestCase):
    def test_fresh_ok_with_events_is_measured(self):
        r = cr.interpret(payload(events=[event()]), NOW)
        self.assertEqual(r["state"], "ok")
        self.assertEqual(len(r["events"]), 1)

    def test_fresh_ok_without_events_is_a_measured_zero(self):
        # This is the ONLY case allowed to say "no events today".
        r = cr.interpret(payload(events=[]), NOW)
        self.assertEqual(r["state"], "empty")
        self.assertTrue(r["measured"])

    def test_denied_is_not_a_zero(self):
        r = cr.interpret(payload(status="denied"), NOW)
        self.assertEqual(r["state"], "denied")
        self.assertFalse(r["measured"])

    def test_not_determined_is_not_a_zero(self):
        r = cr.interpret(payload(status="not_determined"), NOW)
        self.assertFalse(r["measured"])

    def test_error_status_is_not_a_zero(self):
        r = cr.interpret(payload(status="error", detail="consent timed out"), NOW)
        self.assertFalse(r["measured"])
        self.assertIn("consent timed out", r["message"])

    def test_stale_snapshot_is_not_measured_even_when_status_is_ok(self):
        # The failure this module exists for: the LaunchAgent stopped running,
        # the file still says "ok", and yesterday's events would be served as
        # today's.
        r = cr.interpret(payload(status="ok", events=[event()], minutes_old=600), NOW)
        self.assertEqual(r["state"], "stale")
        self.assertFalse(r["measured"])

    def test_stale_beats_empty(self):
        # An old empty snapshot must not be reported as "no events today".
        r = cr.interpret(payload(status="ok", events=[], minutes_old=600), NOW)
        self.assertEqual(r["state"], "stale")

    def test_missing_file_is_not_a_zero(self):
        r = cr.interpret(None, NOW)
        self.assertEqual(r["state"], "missing")
        self.assertFalse(r["measured"])

    def test_unparsable_generated_at_is_not_measured(self):
        r = cr.interpret(payload(generatedAt="tegnap"), NOW)
        self.assertFalse(r["measured"])

    def test_missing_generated_at_is_not_measured(self):
        p = payload()
        del p["generatedAt"]
        self.assertFalse(cr.interpret(p, NOW)["measured"])

    def test_a_snapshot_from_the_future_is_not_trusted(self):
        # Clock skew or a hand-edited file; treating it as fresh would be worse.
        r = cr.interpret(payload(minutes_old=-120), NOW)
        self.assertFalse(r["measured"])

    def test_freshness_window_is_configurable(self):
        p = payload(minutes_old=100)
        self.assertFalse(cr.interpret(p, NOW, max_age_minutes=60)["measured"])
        self.assertTrue(cr.interpret(p, NOW, max_age_minutes=180)["measured"])

    def test_every_non_measured_state_carries_a_reason(self):
        for st in ("denied", "not_determined", "restricted", "write_only", "error"):
            r = cr.interpret(payload(status=st), NOW)
            self.assertFalse(r["measured"], st)
            self.assertTrue(r["message"].strip(), f"{st} has no reason text")

    def test_the_message_never_claims_absence_when_unmeasured(self):
        # Guards the wording itself: the briefing copies this line verbatim.
        for st in ("denied", "not_determined", "error"):
            msg = cr.interpret(payload(status=st), NOW)["message"].lower()
            self.assertNotIn("nincs esemény", msg, st)


class TestFormatting(unittest.TestCase):
    def test_timed_event_shows_a_range(self):
        self.assertEqual(
            cr.format_event(event(title="Egyeztetés")), "10:30-11:00  Egyeztetés"
        )

    def test_all_day_event_is_labelled(self):
        line = cr.format_event(event(allDay=True, title="Szabadság"))
        self.assertIn("egész nap", line)
        self.assertNotIn("00:00-", line)

    def test_location_is_appended_when_present(self):
        self.assertIn("(Iroda)", cr.format_event(event(location="Iroda")))

    def test_missing_location_adds_no_empty_parentheses(self):
        self.assertNotIn("()", cr.format_event(event(location=None)))

    def test_unparsable_times_do_not_raise(self):
        self.assertIsInstance(cr.format_event(event(start="???", end="???")), str)


if __name__ == "__main__":
    unittest.main(verbosity=2)
