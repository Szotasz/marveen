#!/usr/bin/env python3
"""Tests for the local-first temperature source order (card #312).

The peci01-side Tuya reader (room-temp-local.json) must win over the HA/nucbox
push (room-temp.json) whenever it is fresh; a stale or broken local file must
fall back to the push, and two dead sources must stay fail-closed (None).
Paths come from env, so the module is loaded with tmp files injected.
"""
import importlib.util
import json
import os
import tempfile
import time
import unittest

TMP = tempfile.mkdtemp(prefix="gree-readtemp-")
LOCAL = os.path.join(TMP, "room-temp-local.json")
PUSHED = os.path.join(TMP, "room-temp.json")
os.environ["ROOM_TEMP_FILE_LOCAL"] = LOCAL
os.environ["ROOM_TEMP_FILE"] = PUSHED

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "gepterem",
    "gree-thermostat.py",
)
_spec = importlib.util.spec_from_file_location("gree_thermostat_rt", _MODULE_PATH)
th = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(th)


def write(path, temp_c, age_sec=0):
    doc = {"fetched_unix": int(time.time()) - age_sec,
           "rooms": [{"key": "mt15_kucko", "name": "MT15 kuckó", "c": temp_c}]}
    with open(path, "w") as f:
        json.dump(doc, f)


def clear(path):
    if os.path.exists(path):
        os.remove(path)


class LocalFirst(unittest.TestCase):
    def setUp(self):
        clear(LOCAL)
        clear(PUSHED)

    def test_fresh_local_wins_over_fresh_pushed(self):
        write(LOCAL, 26.0)
        write(PUSHED, 30.0)
        temp, err = th.read_temp()
        self.assertEqual(temp, 26.0)
        self.assertIsNone(err)

    def test_stale_local_falls_back_to_pushed(self):
        write(LOCAL, 26.0, age_sec=th.STALE_SEC + 60)
        write(PUSHED, 30.0)
        temp, err = th.read_temp()
        self.assertEqual(temp, 30.0)

    def test_missing_local_falls_back_to_pushed(self):
        write(PUSHED, 28.5)
        temp, err = th.read_temp()
        self.assertEqual(temp, 28.5)

    def test_both_stale_is_fail_closed(self):
        write(LOCAL, 26.0, age_sec=th.STALE_SEC + 60)
        write(PUSHED, 30.0, age_sec=th.STALE_SEC + 60)
        temp, err = th.read_temp()
        self.assertIsNone(temp)
        self.assertIn("stale", err)

    def test_both_missing_is_fail_closed(self):
        temp, err = th.read_temp()
        self.assertIsNone(temp)
        self.assertIsNotNone(err)


if __name__ == "__main__":
    unittest.main()
