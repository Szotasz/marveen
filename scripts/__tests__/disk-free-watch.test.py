#!/usr/bin/env python3
"""Tests for scripts/disk-free-watch.py (DISKFREEWATCH1027): levels, hysteresis, exit codes."""
import importlib.util, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "disk-free-watch.py")
spec = importlib.util.spec_from_file_location("dfw", SCRIPT)
dfw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dfw)


def run(prev, free, now, warn=50, crit=20):
    return dfw.decide(prev, free, now, warn, crit)


class Decide(unittest.TestCase):
    def test_levels(self):
        self.assertEqual(dfw.level_of(60, 50, 20), "ok")
        self.assertEqual(dfw.level_of(49.9, 50, 20), "warn")
        self.assertEqual(dfw.level_of(19.9, 50, 20), "crit")
        self.assertEqual(dfw.level_of(20, 50, 20), "warn")

    def test_alerts_only_when_it_gets_worse(self):
        s, k = run({}, 100, 1000)
        self.assertEqual((s["level"], k), ("ok", None))
        s, k = run(s, 45, 1100)
        self.assertEqual((s["level"], k), ("warn", "warn"))
        s, k = run(s, 40, 1200)
        self.assertEqual((s["level"], k), ("warn", None), "still warn: no repeat")
        s, k = run(s, 15, 1300)
        self.assertEqual((s["level"], k), ("crit", "crit"))

    def test_crit_repeats_at_most_hourly(self):
        s, _ = run({}, 10, 1000)
        s, k = run(s, 9, 1000 + dfw.CRIT_REPEAT_S - 1)
        self.assertIsNone(k)
        s, k = run(s, 9, 1000 + dfw.CRIT_REPEAT_S)
        self.assertEqual(k, "crit")
        self.assertEqual(s["alerted_at"], 1000 + dfw.CRIT_REPEAT_S)

    def test_recovery_needs_the_margin_and_is_said_once(self):
        s, _ = run({}, 45, 1000)
        s, k = run(s, 55, 1100)
        self.assertEqual((s["level"], k), ("warn", None), "inside the margin: no flapping")
        s, k = run(s, 50 + dfw.RECOVER_MARGIN_GB, 1200)
        self.assertEqual((s["level"], k), ("ok", "recovered"))
        s, k = run(s, 90, 1300)
        self.assertEqual((s["level"], k), ("ok", None))
        # From crit up to warn: no message, the level stays crit until the margin.
        s, _ = run({}, 10, 2000)
        s, k = run(s, 30, 2100)
        self.assertEqual((s["level"], k), ("crit", None))

    def test_message_names_the_folders_as_du(self):
        t = dfw.message("crit", 12.3, 1800, 50, 20, [("/x/a", 5.0), ("/x/b", None)])
        self.assertIn("KRITIKUS: 12.3 GB", t)
        self.assertIn("du szerint", t)
        self.assertIn("/x/b: nincs meg", t)


class Cli(unittest.TestCase):
    def test_dry_run_writes_state_and_exits_zero(self):
        with tempfile.TemporaryDirectory() as d:
            st = os.path.join(d, "s.json")
            r = subprocess.run([sys.executable, SCRIPT, "--path", d, "--state", st, "--free-gb", "10", "--dry-run"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("KRITIKUS", r.stdout)
            self.assertEqual(json.load(open(st))["level"], "crit")
            r = subprocess.run([sys.executable, SCRIPT, "--path", d, "--state", st, "--free-gb", "10", "--dry-run"], capture_output=True, text=True)
            self.assertNotIn("KRITIKUS", r.stdout, "no repeat within the hour")

    def _root(self, d, notify_rc):
        os.makedirs(os.path.join(d, "scripts"))
        os.makedirs(os.path.join(d, "store"))
        n = os.path.join(d, "scripts", "notify.sh")
        with open(n, "w") as f:
            f.write("#!/bin/sh\nexit %d\n" % notify_rc)
        os.chmod(n, 0o755)
        return d

    def test_a_send_that_fails_everywhere_keeps_the_state_and_exits_1(self):
        # Dani 50671 (2): the alert must not be counted as sent when nothing went out.
        with tempfile.TemporaryDirectory() as d:
            root = self._root(d, 1)  # notify.sh fails, and there is no token for the agent message
            st = os.path.join(d, "s.json")
            r = subprocess.run([sys.executable, SCRIPT, "--path", d, "--state", st, "--free-gb", "10", "--root", root], capture_output=True, text=True)
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertIn("could NOT be sent", r.stderr)
            self.assertFalse(os.path.exists(st), "the state did not move")

    def test_a_send_that_goes_out_on_one_channel_moves_the_state(self):
        with tempfile.TemporaryDirectory() as d:
            root = self._root(d, 0)
            st = os.path.join(d, "s.json")
            r = subprocess.run([sys.executable, SCRIPT, "--path", d, "--state", st, "--free-gb", "10", "--root", root], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertEqual(json.load(open(st))["level"], "crit")

    def test_the_token_never_reaches_an_argv(self):
        # Dani 50671 (1): no subprocess carries the token; the agent message goes through urllib.
        src = open(SCRIPT).read()
        self.assertNotIn('"curl"', src)
        self.assertIn("urllib.request.Request(", src)

    def test_cannot_measure_is_exit_1(self):
        r = subprocess.run([sys.executable, SCRIPT, "--path", "/no/such/volume/path", "--dry-run"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)


if __name__ == "__main__":
    unittest.main()
