#!/usr/bin/env python3
"""Unit tests for scripts/usage-collect.py.

Covers the pure-logic pieces: time formatting (fmt_reset/hours_until), the
generic de-dup gate (_should_fire), and compute_alerts() end-to-end against
synthetic snapshots -- no real network calls, no real ~/.codex or
~/.claude filesystem reads, no writes to store/.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "usage-collect.py",
)

_spec = importlib.util.spec_from_file_location("usage_collect", _MODULE_PATH)
uc = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(uc)  # type: ignore[union-attr]


def _future_ts(**kwargs):
    return int((datetime.now(timezone.utc) + timedelta(**kwargs)).timestamp())


class TestFmtReset(unittest.TestCase):
    def test_none_returns_unknown(self):
        self.assertEqual(uc.fmt_reset(None), ("unknown", "unknown"))

    def test_garbage_returns_unknown(self):
        self.assertEqual(uc.fmt_reset("not-a-timestamp"), ("unknown", "unknown"))

    def test_days_away_relative_format(self):
        ts = _future_ts(days=6, hours=4)
        _, rel = uc.fmt_reset(ts)
        self.assertIn("days", rel)
        self.assertIn("hours", rel)

    def test_hours_away_relative_format(self):
        ts = _future_ts(hours=3, minutes=10)
        _, rel = uc.fmt_reset(ts)
        self.assertIn("hours", rel)
        self.assertIn("minutes", rel)
        self.assertNotIn("days", rel)

    def test_minutes_away_relative_format(self):
        ts = _future_ts(minutes=20)
        _, rel = uc.fmt_reset(ts)
        self.assertIn("minutes", rel)
        self.assertNotIn("hours", rel)

    def test_past_timestamp_is_most(self):
        ts = int((datetime.now(timezone.utc) - timedelta(hours=1)).timestamp())
        _, rel = uc.fmt_reset(ts)
        self.assertEqual(rel, "now")

    def test_local_string_has_the_zone_abbreviation(self):
        # The zone is pinned here: LOCAL_TZ is the install zone, so the runner's
        # own zone (UTC on CI) must not decide the marker.
        from zoneinfo import ZoneInfo
        ts = _future_ts(days=1)
        with patch.object(uc, "LOCAL_TZ", ZoneInfo("Europe/Budapest")):
            local_str, _ = uc.fmt_reset(ts)
        # e.g. "2026-07-23 14:45 CEST"
        self.assertRegex(local_str, r"CES?T$")
        with patch.object(uc, "LOCAL_TZ", ZoneInfo("America/New_York")):
            local_str, _ = uc.fmt_reset(ts)
        self.assertRegex(local_str, r"E[DS]T$")


class TestParseIsoToEpoch(unittest.TestCase):
    """_parse_iso_to_epoch() -- the Claude usage endpoint returns resets_at
    as ISO-8601 strings (e.g. "2026-07-22T16:29:59.627285+00:00"), not unix
    epochs like Codex does."""

    def test_none_returns_none(self):
        self.assertIsNone(uc._parse_iso_to_epoch(None))

    def test_non_string_returns_none(self):
        self.assertIsNone(uc._parse_iso_to_epoch(1784737800))

    def test_garbage_string_returns_none(self):
        self.assertIsNone(uc._parse_iso_to_epoch("not-a-date"))

    def test_iso_with_offset_parses_to_expected_epoch(self):
        epoch = uc._parse_iso_to_epoch("2026-07-22T16:29:59.627285+00:00")
        expected = datetime(2026, 7, 22, 16, 29, 59, 627285, tzinfo=timezone.utc).timestamp()
        self.assertAlmostEqual(epoch, expected, delta=0.001)

    def test_z_suffix_parses(self):
        # USAGE401DIAG910: Codex event timestamps end in 'Z'; fromisoformat
        # rejects that on Python < 3.11, so the parser normalises it.
        epoch = uc._parse_iso_to_epoch("2026-04-26T12:03:04.051Z")
        self.assertIsNotNone(epoch)
        # 2026-04-26T12:03:04Z == the same instant as +00:00
        self.assertAlmostEqual(epoch, uc._parse_iso_to_epoch("2026-04-26T12:03:04.051+00:00"), places=3)

    def test_iso_without_offset_assumes_utc(self):
        epoch = uc._parse_iso_to_epoch("2026-07-22T16:29:59")
        expected = datetime(2026, 7, 22, 16, 29, 59, tzinfo=timezone.utc).timestamp()
        self.assertAlmostEqual(epoch, expected, delta=0.001)

    def test_result_feeds_fmt_reset_without_crashing(self):
        # end-to-end: an ISO string converted here must still format cleanly.
        future_iso = (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat()
        epoch = uc._parse_iso_to_epoch(future_iso)
        local_str, rel = uc.fmt_reset(epoch)
        self.assertNotEqual(local_str, "unknown")
        self.assertIn("hours", rel)


class TestHoursUntil(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(uc.hours_until(None))

    def test_garbage_returns_none(self):
        self.assertIsNone(uc.hours_until("nope"))

    def test_computes_approximately(self):
        ts = _future_ts(hours=10)
        hrs = uc.hours_until(ts)
        self.assertAlmostEqual(hrs, 10, delta=0.1)

    def test_negative_for_past(self):
        ts = int((datetime.now(timezone.utc) - timedelta(hours=2)).timestamp())
        hrs = uc.hours_until(ts)
        self.assertLess(hrs, 0)


class TestShouldFire(unittest.TestCase):
    def test_cross_fires_only_on_new_crossing(self):
        state = {}
        now = 1000.0
        self.assertTrue(uc._should_fire(state, "k", True, "cross", now))
        # still true next run -- must NOT re-fire
        self.assertFalse(uc._should_fire(state, "k", True, "cross", now + 10))
        # drops false -- resets
        self.assertFalse(uc._should_fire(state, "k", False, "cross", now + 20))
        # true again -- new crossing, fires
        self.assertTrue(uc._should_fire(state, "k", True, "cross", now + 30))

    def test_cross_refire_respects_interval(self):
        state = {}
        now = 1000.0
        self.assertTrue(uc._should_fire(state, "k", True, "cross_refire", now, refire_seconds=100))
        # too soon -- no re-fire
        self.assertFalse(uc._should_fire(state, "k", True, "cross_refire", now + 50, refire_seconds=100))
        # interval elapsed -- re-fires while still ongoing
        self.assertTrue(uc._should_fire(state, "k", True, "cross_refire", now + 150, refire_seconds=100))

    def test_throttle_fires_once_then_waits_full_interval(self):
        state = {}
        now = 1000.0
        self.assertTrue(uc._should_fire(state, "k", True, "throttle", now, refire_seconds=200))
        self.assertFalse(uc._should_fire(state, "k", True, "throttle", now + 100, refire_seconds=200))
        self.assertTrue(uc._should_fire(state, "k", True, "throttle", now + 250, refire_seconds=200))

    def test_condition_false_never_fires(self):
        state = {}
        self.assertFalse(uc._should_fire(state, "k", False, "cross", 1000.0))
        self.assertFalse(uc._should_fire(state, "k", False, "throttle", 1000.0, refire_seconds=1))


class TestCollectClaudeAuthoritative(unittest.TestCase):
    """_collect_claude_authoritative() against the REAL api/oauth/usage
    response shape: windows are TOP-LEVEL keys (not nested under
    "rate_limits"), percent comes from "utilization", resets_at is an
    ISO-8601 string, and a window may be null."""

    def _mock_response(self, payload):
        body = json.dumps(payload).encode("utf-8")
        cm = MagicMock()
        cm.__enter__.return_value.read.return_value = body
        cm.__exit__.return_value = False
        return cm

    def test_parses_top_level_windows_with_utilization_and_iso_resets(self):
        payload = {
            "five_hour": {
                "utilization": 10.0,
                "resets_at": "2026-07-22T16:29:59.627285+00:00",
                "limit_dollars": 1, "used_dollars": 0.1, "remaining_dollars": 0.9,
            },
            "seven_day": {
                "utilization": 57.0,
                "resets_at": "2026-07-25T13:59:59.000000+00:00",
            },
            "seven_day_opus": None,
            "seven_day_sonnet": None,
            "seven_day_oauth_apps": {"utilization": 3.0, "resets_at": "2026-07-25T13:59:59Z"},
            "spend": {"amount": 12.3},
            "limits": {"foo": "bar"},
        }
        with patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", return_value=self._mock_response(payload)):
            windows, err, err_kind = uc._collect_claude_authoritative()

        self.assertIsNone(err)
        self.assertIsNone(err_kind)
        self.assertIn("five_hour", windows)
        self.assertIn("seven_day", windows)
        # nulls skipped gracefully, no crash
        self.assertNotIn("seven_day_opus", windows)
        self.assertNotIn("seven_day_sonnet", windows)
        # unrelated top-level keys ignored
        self.assertNotIn("seven_day_oauth_apps", windows)
        self.assertNotIn("spend", windows)

        self.assertEqual(windows["five_hour"]["used_percent"], 10.0)
        self.assertIsInstance(windows["five_hour"]["resets_at"], float)
        expected_epoch = datetime(2026, 7, 22, 16, 29, 59, 627285, tzinfo=timezone.utc).timestamp()
        self.assertAlmostEqual(windows["five_hour"]["resets_at"], expected_epoch, delta=0.001)
        self.assertEqual(windows["seven_day"]["used_percent"], 57.0)

    def test_all_windows_null_returns_error_not_crash(self):
        payload = {"five_hour": None, "seven_day": None, "seven_day_opus": None, "seven_day_sonnet": None}
        with patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", return_value=self._mock_response(payload)):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertIsNotNone(err)
        self.assertEqual(err_kind, "transient")

    # USAGE401FALLBACK1123: a 401 refuses the SOURCE; the next one gets a try.
    def _sources(self, available):
        def read(skip=()):
            for name in ("credentials_file", "keychain", "env_file"):
                if name in available and name not in skip:
                    return available[name], name
            return None, None
        return read

    def _urlopen_by_token(self, answers):
        import urllib.error
        seen = []
        def opener(req, timeout=10):
            token = req.headers["Authorization"].split(" ", 1)[1]
            seen.append(token)
            code = answers[token]
            if code == 200:
                return self._mock_response({"five_hour": {"utilization": 5.0, "resets_at": "2026-07-22T16:29:59Z"}})
            raise urllib.error.HTTPError(req.full_url, code, "x", {}, None)
        return opener, seen

    def test_stale_credentials_file_401_falls_through_to_keychain(self):
        opener, seen = self._urlopen_by_token({"stale": 401, "good": 200})
        with patch.object(uc, "_read_claude_token", side_effect=self._sources({"credentials_file": "stale", "keychain": "good"})), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=opener):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(err)
        self.assertEqual(windows["five_hour"]["used_percent"], 5.0)
        self.assertEqual(seen, ["stale", "good"])

    def test_every_source_401_is_permanent_and_names_them(self):
        opener, seen = self._urlopen_by_token({"a": 401, "b": 401, "c": 401})
        with patch.object(uc, "_read_claude_token", side_effect=self._sources({"credentials_file": "a", "keychain": "b", "env_file": "c"})), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=opener):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertEqual(err_kind, "permanent")
        self.assertIn("HTTP 401", err)
        self.assertIn("credentials_file, keychain, env_file", err)
        self.assertEqual(seen, ["a", "b", "c"])

    def test_403_does_not_fall_through(self):
        opener, seen = self._urlopen_by_token({"a": 403, "b": 200})
        with patch.object(uc, "_read_claude_token", side_effect=self._sources({"credentials_file": "a", "keychain": "b"})), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=opener):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertEqual(err_kind, "permanent")
        self.assertIn("HTTP 403", err)
        self.assertEqual(seen, ["a"])

    def test_env_setup_token_403_alone_says_the_auth_mode(self):
        # ISSUE3159: a 403 on the .env setup-token is by design, not a scope to fix: the error says so.
        opener, seen = self._urlopen_by_token({"setup": 403})
        with patch.object(uc, "_read_claude_token", side_effect=self._sources({"env_file": "setup"})), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=opener):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertEqual(err_kind, "permanent")
        self.assertEqual(err, "HTTP 403 (env_file token): not available on this auth mode (the usage endpoint does not accept a setup-token)")

    def test_401_then_403_reports_the_401_first(self):
        # Geri #3073: a stale file (401) and a .env setup-token (403 by design) must not read as a scope problem.
        opener, seen = self._urlopen_by_token({"stale": 401, "setup": 403})
        with patch.object(uc, "_read_claude_token", side_effect=self._sources({"credentials_file": "stale", "env_file": "setup"})), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=opener):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertEqual(err_kind, "permanent")
        self.assertTrue(err.startswith("HTTP 401 (credentials_file token)"), err)
        self.assertIn("then HTTP 403 (env_file token)", err)

    def test_a_redirect_is_not_followed(self):
        # Dani #3073 N1: the bearer must never follow a redirect to another host.
        import http.server, threading
        hits = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append((self.path, self.headers.get("Authorization")))
                if self.path == "/start":
                    self.send_response(302)
                    self.send_header("Location", "http://127.0.0.1:%d/landed" % srv.server_address[1])
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{}")

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            import urllib.request, urllib.error
            req = urllib.request.Request("http://127.0.0.1:%d/start" % srv.server_address[1], headers={"Authorization": "Bearer x"})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(ctx.exception.code, 302)
            self.assertEqual([p for p, _ in hits], ["/start"])
        finally:
            srv.shutdown()

    def test_read_claude_token_skips_named_sources(self):
        with patch.object(uc, "_read_keychain_token", return_value="kc"), \
             patch("os.path.exists", return_value=False):
            self.assertEqual(uc._read_claude_token(), ("kc", "keychain"))
            self.assertEqual(uc._read_claude_token(skip=("keychain",)), (None, None))

    def test_no_token_returns_no_token_kind(self):
        with patch.object(uc, "_read_claude_token", return_value=(None, None)):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertIn("no oauth token", err)
        self.assertEqual(err_kind, "no_token")

    def test_403_returns_permanent_kind(self):
        http_err = urllib.error.HTTPError("https://api.anthropic.com/api/oauth/usage", 403, "Forbidden", {}, None)
        with patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=http_err):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertEqual(err_kind, "permanent")
        self.assertIn("403", err)

    def test_401_returns_permanent_kind(self):
        # USAGE401DIAG910: 401 (expired/invalid token) must NOT be transient --
        # a transient classification serves the stale authoritative cache and
        # hides that the token needs refreshing. It was misclassified before.
        http_err = urllib.error.HTTPError("https://api.anthropic.com/api/oauth/usage", 401, "Unauthorized", {}, None)
        with patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=http_err):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertEqual(err_kind, "permanent")
        self.assertIn("401", err)

    def test_429_returns_transient_kind(self):
        http_err = urllib.error.HTTPError("https://api.anthropic.com/api/oauth/usage", 429, "Too Many Requests", {}, None)
        with patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=http_err):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertEqual(err_kind, "transient")
        self.assertIn("429", err)

    def test_5xx_returns_transient_kind(self):
        http_err = urllib.error.HTTPError("https://api.anthropic.com/api/oauth/usage", 503, "Service Unavailable", {}, None)
        with patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=http_err):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertEqual(err_kind, "transient")

    def test_timeout_returns_transient_kind(self):
        with patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
             patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
             patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")):
            windows, err, err_kind = uc._collect_claude_authoritative()
        self.assertIsNone(windows)
        self.assertEqual(err_kind, "transient")


class TestReadCachedClaudeAuthoritative(unittest.TestCase):
    """_read_cached_claude_authoritative() -- reused by collect_claude() to
    avoid losing real numbers to a transient 429/5xx during the freshness
    window."""

    def _write_latest(self, path, source, windows, generated_at):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"generated_at": generated_at, "claude": {"source": source, "windows": windows}}, f)

    def test_missing_file_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "nope.json")
            with patch.object(uc, "LATEST_PATH", missing):
                windows, age = uc._read_cached_claude_authoritative(90)
        self.assertIsNone(windows)
        self.assertIsNone(age)

    def test_fresh_authoritative_cache_returned_with_age(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "usage-latest.json")
            ts = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
            windows = {"five_hour": {"used_percent": 11.0, "resets_at": 123.0}}
            self._write_latest(path, "authoritative", windows, ts)
            with patch.object(uc, "LATEST_PATH", path):
                got_windows, age = uc._read_cached_claude_authoritative(90)
        self.assertEqual(got_windows, windows)
        self.assertAlmostEqual(age, 5, delta=0.5)

    def test_stale_cache_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "usage-latest.json")
            ts = (datetime.now(timezone.utc) - timedelta(minutes=200)).isoformat()
            self._write_latest(path, "authoritative", {"five_hour": {"used_percent": 1}}, ts)
            with patch.object(uc, "LATEST_PATH", path):
                got_windows, age = uc._read_cached_claude_authoritative(90)
        self.assertIsNone(got_windows)
        self.assertIsNone(age)

    def test_estimate_source_cache_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "usage-latest.json")
            ts = datetime.now(timezone.utc).isoformat()
            self._write_latest(path, "estimate", {}, ts)
            with patch.object(uc, "LATEST_PATH", path):
                got_windows, age = uc._read_cached_claude_authoritative(90)
        self.assertIsNone(got_windows)
        self.assertIsNone(age)

    def test_previously_cached_source_is_itself_reusable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "usage-latest.json")
            ts = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
            windows = {"seven_day": {"used_percent": 58.0, "resets_at": 456.0}}
            self._write_latest(path, "authoritative_cached", windows, ts)
            with patch.object(uc, "LATEST_PATH", path):
                got_windows, age = uc._read_cached_claude_authoritative(90)
        self.assertEqual(got_windows, windows)

    def test_corrupt_json_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "usage-latest.json")
            with open(path, "w") as f:
                f.write("{not valid json")
            with patch.object(uc, "LATEST_PATH", path):
                got_windows, age = uc._read_cached_claude_authoritative(90)
        self.assertIsNone(got_windows)
        self.assertIsNone(age)


class TestCollectClaudeCacheFallback(unittest.TestCase):
    """collect_claude() end-to-end: a transient failure (429) must reuse a
    fresh cached authoritative snapshot instead of dropping to the token
    estimate; a stale/absent cache, a 403, or no token must still fall
    back to the estimate."""

    def setUp(self):
        # The header entry (TestRatelimitHeaderSource) would spawn node with the fake token: keep it out.
        p = patch.object(uc, "_collect_claude_ratelimit_headers", return_value=(None, "not run in this test"))
        p.start()
        self.addCleanup(p.stop)

    def _write_latest(self, path, source, windows, generated_at):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"generated_at": generated_at, "claude": {"source": source, "windows": windows}}, f)

    def test_429_with_fresh_cache_reuses_authoritative_cached_no_estimate(self):
        with tempfile.TemporaryDirectory() as tmp:
            latest_path = os.path.join(tmp, "usage-latest.json")
            fresh_ts = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
            cached_windows = {"five_hour": {"used_percent": 11.0, "resets_at": 1234.0}}
            self._write_latest(latest_path, "authoritative", cached_windows, fresh_ts)

            http_err = urllib.error.HTTPError("url", 429, "Too Many Requests", {}, None)
            with patch.object(uc, "LATEST_PATH", latest_path), \
                 patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
                 patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
                 patch("urllib.request.urlopen", side_effect=http_err), \
                 patch.object(uc, "_collect_claude_estimate") as mock_estimate:
                result = uc.collect_claude()

            mock_estimate.assert_not_called()
            self.assertEqual(result["source"], "authoritative_cached")
            self.assertEqual(result["windows"], cached_windows)
            self.assertIn("cache_age_minutes", result)
            self.assertLess(result["cache_age_minutes"], 10)

    def test_401_with_fresh_cache_still_falls_back_to_estimate(self):
        # USAGE401DIAG910, the load-bearing case: even with a FRESH cache, a 401
        # must NOT be served from it (that would report the last good numbers as
        # current and mask the expired token). It goes to the estimate instead.
        with tempfile.TemporaryDirectory() as tmp:
            latest_path = os.path.join(tmp, "usage-latest.json")
            fresh_ts = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
            self._write_latest(latest_path, "authoritative", {"five_hour": {"used_percent": 11.0, "resets_at": 1234.0}}, fresh_ts)

            http_err = urllib.error.HTTPError("url", 401, "Unauthorized", {}, None)
            with patch.object(uc, "LATEST_PATH", latest_path), \
                 patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
                 patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
                 patch("urllib.request.urlopen", side_effect=http_err), \
                 patch.object(uc, "_collect_claude_estimate", return_value={"seven_day_est_tokens": 42}) as mock_estimate:
                result = uc.collect_claude()

            mock_estimate.assert_called_once()
            self.assertEqual(result["source"], "estimate")
            self.assertNotEqual(result["source"], "authoritative_cached")
            self.assertIn("401", result.get("auth_error", ""))

    def test_429_with_stale_cache_falls_back_to_estimate(self):
        with tempfile.TemporaryDirectory() as tmp:
            latest_path = os.path.join(tmp, "usage-latest.json")
            stale_ts = (datetime.now(timezone.utc) - timedelta(minutes=200)).isoformat()
            self._write_latest(latest_path, "authoritative", {"five_hour": {"used_percent": 1}}, stale_ts)

            http_err = urllib.error.HTTPError("url", 429, "Too Many Requests", {}, None)
            with patch.object(uc, "LATEST_PATH", latest_path), \
                 patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
                 patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
                 patch("urllib.request.urlopen", side_effect=http_err), \
                 patch.object(uc, "_collect_claude_estimate", return_value={"seven_day_est_tokens": 42}) as mock_estimate:
                result = uc.collect_claude()

            mock_estimate.assert_called_once()
            self.assertEqual(result["source"], "estimate")
            self.assertEqual(result.get("seven_day_est_tokens"), 42)

    def test_429_with_no_cache_file_falls_back_to_estimate(self):
        with tempfile.TemporaryDirectory() as tmp:
            latest_path = os.path.join(tmp, "usage-latest.json")  # never written
            http_err = urllib.error.HTTPError("url", 429, "Too Many Requests", {}, None)
            with patch.object(uc, "LATEST_PATH", latest_path), \
                 patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
                 patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
                 patch("urllib.request.urlopen", side_effect=http_err), \
                 patch.object(uc, "_collect_claude_estimate", return_value={}) as mock_estimate:
                result = uc.collect_claude()

            mock_estimate.assert_called_once()
            self.assertEqual(result["source"], "estimate")

    def test_403_skips_cache_even_if_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            latest_path = os.path.join(tmp, "usage-latest.json")
            fresh_ts = datetime.now(timezone.utc).isoformat()
            self._write_latest(latest_path, "authoritative", {"five_hour": {"used_percent": 11}}, fresh_ts)

            http_err = urllib.error.HTTPError("url", 403, "Forbidden", {}, None)
            with patch.object(uc, "LATEST_PATH", latest_path), \
                 patch.object(uc, "_read_claude_token", return_value=("fake-token", "test")), \
                 patch.object(uc, "_claude_cli_version", return_value="1.2.3"), \
                 patch("urllib.request.urlopen", side_effect=http_err), \
                 patch.object(uc, "_collect_claude_estimate", return_value={}) as mock_estimate:
                result = uc.collect_claude()

            mock_estimate.assert_called_once()
            self.assertEqual(result["source"], "estimate")
            self.assertIn("403", result["auth_error"])

    def test_no_token_skips_cache_even_if_fresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            latest_path = os.path.join(tmp, "usage-latest.json")
            fresh_ts = datetime.now(timezone.utc).isoformat()
            self._write_latest(latest_path, "authoritative", {"five_hour": {"used_percent": 11}}, fresh_ts)

            with patch.object(uc, "LATEST_PATH", latest_path), \
                 patch.object(uc, "_read_claude_token", return_value=(None, None)), \
                 patch.object(uc, "_collect_claude_estimate", return_value={}) as mock_estimate:
                result = uc.collect_claude()

            mock_estimate.assert_called_once()
            self.assertEqual(result["source"], "estimate")


class TestRatelimitHeaderSource(unittest.TestCase):
    """collect_claude() last-resort source: when oauth/usage, the statusLine
    file and (after a transient failure) the fresh authoritative cache gave
    nothing, the compiled entry dist/claude-ratelimit-reading.js reads the
    rate-limit headers (source "ratelimit_headers"). No node, no network:
    subprocess.run is patched; a sentinel string stands in for the token."""

    SENTINEL = "fake-token-SENTINEL-NEVER-PRINT"
    WINDOWS = {
        "five_hour": {"used_percent": 35.0, "resets_at": 1794300000, "status": "allowed"},
        "seven_day": {"used_percent": 22.0, "resets_at": 1794800000, "status": "allowed_warning"},
    }

    def _collect(self, run_result, auth=(None, "HTTP 403 (env_file token)", "permanent"), cached=(None, None), built=True):
        seen = []

        def fake_run(argv, **kw):
            seen.append((argv, kw))
            if isinstance(run_result, BaseException):
                raise run_result
            return subprocess.CompletedProcess(argv, 0, stdout=run_result, stderr="")

        real_isfile = os.path.isfile
        with patch.object(uc, "_collect_claude_authoritative", return_value=auth), \
             patch.object(uc, "_read_claude_statusline", return_value=(None, None)), \
             patch.object(uc, "_read_cached_claude_authoritative", return_value=cached), \
             patch.object(uc, "_read_claude_token", return_value=(self.SENTINEL, "env_file")), \
             patch.object(uc.os.path, "isfile", side_effect=lambda p: built if p == uc.RATELIMIT_ENTRY else real_isfile(p)), \
             patch.object(uc.subprocess, "run", side_effect=fake_run), \
             patch.object(uc, "_collect_claude_estimate", return_value={"files_scanned": 0}) as est:
            result = uc.collect_claude()
        return result, seen, est

    def _ok(self):
        return json.dumps({"ok": True, "windows": self.WINDOWS}) + "\n"

    def test_entry_reading_gives_a_trusted_snapshot(self):
        result, seen, est = self._collect(self._ok())
        est.assert_not_called()
        self.assertEqual(result["source"], "ratelimit_headers")
        self.assertEqual(result["windows"], self.WINDOWS)
        self.assertIn("measured_at", result)
        self.assertIn("403", result["auth_error"])
        # one entry run; the token only in its environment, never in argv
        self.assertEqual(len(seen), 1)
        argv, kw = seen[0]
        self.assertEqual(argv, ["node", uc.RATELIMIT_ENTRY])
        self.assertEqual(kw["env"]["CLAUDE_RATELIMIT_TOKEN"], self.SENTINEL)
        self.assertNotIn(self.SENTINEL, " ".join(argv))

    def test_fresh_cache_after_a_transient_failure_wins_and_the_entry_does_not_run(self):
        # #2839 B1: the authoritative cache is what the plan rotation sees; a header reading must not replace it.
        cached = ({"five_hour": {"used_percent": 50.0, "resets_at": 1794300000}}, 12.0)
        result, seen, est = self._collect(self._ok(), auth=(None, "HTTP 429", "transient"), cached=cached)
        self.assertEqual(result["source"], "authoritative_cached")
        self.assertEqual(seen, [])
        est.assert_not_called()

    def test_transient_failure_without_a_fresh_cache_runs_the_entry(self):
        result, seen, _ = self._collect(self._ok(), auth=(None, "HTTP 429", "transient"), cached=(None, None))
        self.assertEqual(result["source"], "ratelimit_headers")
        self.assertEqual(len(seen), 1)

    def test_entry_without_a_reading_falls_back_to_estimate_with_reason(self):
        out = json.dumps({"ok": False, "reason": "rate_limited (HTTP 429)"}) + "\n"
        result, _, est = self._collect(out)
        est.assert_called_once()
        self.assertEqual(result["source"], "estimate")
        self.assertNotIn("windows", result)
        self.assertEqual(result["ratelimit_headers_error"], "rate_limited (HTTP 429) (env_file token)")

    def test_entry_not_built_falls_back_to_estimate(self):
        result, seen, est = self._collect(self._ok(), built=False)
        self.assertEqual(seen, [])
        est.assert_called_once()
        self.assertEqual(result["ratelimit_headers_error"], "dist/claude-ratelimit-reading.js not built")

    def test_token_never_in_output(self):
        # A crash or garbage output whose text carries the token must not leak it: only the exception type is recorded.
        cases = [
            subprocess.TimeoutExpired(["node", self.SENTINEL], 10, output=self.SENTINEL),
            f"not json {self.SENTINEL}",
            self._ok(),
        ]
        for case in cases:
            result, _, _ = self._collect(case)
            snapshot = {"generated_at": "2026-11-16T00:00:00+00:00", "generated_at_local": "x",
                        "codex": {"ok": False, "error": "n/a"}, "claude": result}
            out = json.dumps(result) + uc.render_summary(snapshot)
            self.assertNotIn("SENTINEL", out)
        self.assertEqual(self._collect(cases[0])[0]["ratelimit_headers_error"], "TimeoutExpired")
        self.assertEqual(self._collect(cases[1])[0]["ratelimit_headers_error"], "JSONDecodeError")

    def test_summary_shows_the_windows_for_the_new_source(self):
        result, _, _ = self._collect(self._ok())
        snapshot = {"generated_at": "2026-11-16T00:00:00+00:00", "generated_at_local": "x",
                    "codex": {"ok": False, "error": "n/a"}, "claude": result}
        text = uc.render_summary(snapshot)
        self.assertIn("rate-limit headers", text)
        self.assertIn("weekly limit: 22.0% used", text)


def _resets_at_for_elapsed(now, window_len_sec, elapsed_fraction):
    """Build a resets_at epoch such that, measured from `now`, exactly
    elapsed_fraction of a window_len_sec-long window has passed."""
    return (now + timedelta(seconds=window_len_sec * (1 - elapsed_fraction))).timestamp()


class TestComputePace(unittest.TestCase):
    """compute_pace() -- the time-proportional usage-vs-elapsed model shared
    by every window of every provider."""

    NOW = datetime(2026, 7, 22, 12, 0, 0, tzinfo=timezone.utc)
    WEEK = 7 * 86400

    def test_missing_used_percent_returns_none(self):
        resets_at = _resets_at_for_elapsed(self.NOW, self.WEEK, 0.2)
        self.assertIsNone(uc.compute_pace(None, resets_at, self.WEEK, self.NOW))

    def test_missing_resets_at_returns_none(self):
        self.assertIsNone(uc.compute_pace(50.0, None, self.WEEK, self.NOW))

    def test_missing_window_length_returns_none(self):
        resets_at = _resets_at_for_elapsed(self.NOW, self.WEEK, 0.2)
        self.assertIsNone(uc.compute_pace(50.0, resets_at, None, self.NOW))
        self.assertIsNone(uc.compute_pace(50.0, resets_at, 0, self.NOW))

    def test_50_percent_at_20_percent_elapsed(self):
        # Example from the spec: 50% used at 20% elapsed -> overuse pace.
        resets_at = _resets_at_for_elapsed(self.NOW, self.WEEK, 0.2)
        pace = uc.compute_pace(50.0, resets_at, self.WEEK, self.NOW)
        self.assertAlmostEqual(pace["elapsed_fraction"], 0.2, places=6)
        self.assertAlmostEqual(pace["used_fraction"], 0.5, places=6)
        self.assertAlmostEqual(pace["pace_ratio"], 2.5, places=6)
        self.assertIsNotNone(pace["projected_exhaustion_epoch"])
        # constant-burn-rate exhaustion happens at elapsed/used_fraction == 2x elapsed time
        expected_epoch = self.NOW.timestamp() + self.WEEK * 0.2
        self.assertAlmostEqual(pace["projected_exhaustion_epoch"], expected_epoch, delta=1.0)
        self.assertLess(pace["projected_exhaustion_epoch"], pace["resets_at"])

    def test_10_percent_at_57_percent_elapsed(self):
        # Example from the spec: 10% used at 57% elapsed -> underuse pace.
        resets_at = _resets_at_for_elapsed(self.NOW, self.WEEK, 0.57)
        pace = uc.compute_pace(10.0, resets_at, self.WEEK, self.NOW)
        self.assertAlmostEqual(pace["elapsed_fraction"], 0.57, places=6)
        self.assertAlmostEqual(pace["pace_ratio"], 10.0 / 57.0, places=4)

    def test_elapsed_fraction_clamped_to_zero_for_future_looking_reset(self):
        # resets_at further out than a full window away -- degenerate/stale
        # input, must clamp instead of going negative.
        resets_at = (self.NOW + timedelta(seconds=self.WEEK * 2)).timestamp()
        pace = uc.compute_pace(10.0, resets_at, self.WEEK, self.NOW)
        self.assertEqual(pace["elapsed_fraction"], 0.0)
        self.assertIsNone(pace["pace_ratio"])  # guarded div-by-~0

    def test_elapsed_fraction_clamped_to_one_when_overdue(self):
        resets_at = (self.NOW - timedelta(hours=1)).timestamp()  # already past reset
        pace = uc.compute_pace(80.0, resets_at, self.WEEK, self.NOW)
        self.assertEqual(pace["elapsed_fraction"], 1.0)
        self.assertAlmostEqual(pace["pace_ratio"], 0.8, places=6)

    def test_zero_used_percent_has_no_projection(self):
        resets_at = _resets_at_for_elapsed(self.NOW, self.WEEK, 0.5)
        pace = uc.compute_pace(0.0, resets_at, self.WEEK, self.NOW)
        self.assertEqual(pace["used_fraction"], 0.0)
        self.assertIsNone(pace["projected_exhaustion_epoch"])


class TestWindowLengthAndIteration(unittest.TestCase):
    """_window_length_seconds() / _iter_pace_windows() -- how windows are
    discovered and sized for the pace engine."""

    def test_claude_window_lengths(self):
        self.assertEqual(uc._window_length_seconds("claude_five_hour", {}), 5 * 3600)
        self.assertEqual(uc._window_length_seconds("claude_seven_day", {}), 7 * 86400)
        self.assertEqual(uc._window_length_seconds("claude_seven_day_opus", {}), 7 * 86400)
        self.assertEqual(uc._window_length_seconds("claude_seven_day_sonnet", {}), 7 * 86400)

    def test_claude_unknown_window_key_returns_none(self):
        self.assertIsNone(uc._window_length_seconds("claude_some_new_window", {}))

    def test_codex_window_length_from_window_minutes(self):
        self.assertEqual(uc._window_length_seconds("codex_weekly", {"window_minutes": 10080}), 10080 * 60)
        self.assertEqual(uc._window_length_seconds("codex_five_hour", {"window_minutes": 300}), 300 * 60)

    def test_codex_missing_window_minutes_returns_none(self):
        self.assertIsNone(uc._window_length_seconds("codex_weekly", {}))

    def test_iter_skips_estimate_source(self):
        snap = {
            "claude": {"ok": True, "source": "estimate", "windows": {
                "seven_day": {"used_percent": 1, "resets_at": 1},
            }},
            "codex": {"ok": True, "source": "authoritative", "windows": {
                "weekly": {"used_percent": 1, "resets_at": 1, "window_minutes": 10080},
            }},
        }
        keys = [k for k, _, _ in uc._iter_pace_windows(snap)]
        self.assertIn("codex_weekly", keys)
        self.assertNotIn("claude_seven_day", keys)

    def test_iter_includes_authoritative_cached_claude(self):
        snap = {
            "claude": {"ok": True, "source": "authoritative_cached", "windows": {
                "seven_day": {"used_percent": 1, "resets_at": 1},
            }},
            "codex": {"ok": False, "source": "authoritative", "windows": {}},
        }
        keys = [k for k, _, _ in uc._iter_pace_windows(snap)]
        self.assertIn("claude_seven_day", keys)

    def test_iter_skips_not_ok(self):
        snap = {
            "claude": {"ok": False, "source": "authoritative", "windows": {
                "seven_day": {"used_percent": 1, "resets_at": 1},
            }},
            "codex": {"ok": False, "source": "authoritative", "windows": {}},
        }
        self.assertEqual(list(uc._iter_pace_windows(snap)), [])


class TestComputeAlerts(unittest.TestCase):
    """compute_alerts() end-to-end: OVERUSE / UNDERUSE / near-exhaustion
    bands, the early-window guard, provider-agnostic pace engine, and
    de-dup throttling -- all against synthetic snapshots with a fixed
    `now` so nothing depends on real wall-clock time."""

    NOW = datetime(2026, 7, 22, 12, 0, 0, tzinfo=timezone.utc)
    WEEK = 7 * 86400
    FIVE_H = 5 * 3600

    def _resets_at(self, window_len_sec, elapsed_fraction, now=None):
        return _resets_at_for_elapsed(now or self.NOW, window_len_sec, elapsed_fraction)

    def _snapshot(self, claude_ok=True, claude_source="authoritative", claude_windows=None,
                  codex_ok=True, codex_source="authoritative", codex_windows=None):
        return {
            "claude": {"ok": claude_ok, "source": claude_source, "windows": claude_windows or {}},
            "codex": {"ok": codex_ok, "source": codex_source, "windows": codex_windows or {}},
        }

    # --- silence when on-pace / too early ---------------------------------

    def test_no_alerts_when_on_pace(self):
        snap = self._snapshot(
            claude_windows={"seven_day": {"used_percent": 20, "resets_at": self._resets_at(self.WEEK, 0.2)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertEqual(alerts, [])

    def test_early_window_stays_silent_even_if_off_pace(self):
        # 50% used at 5% elapsed would normally be wildly over-pace, but the
        # min-elapsed guard (0.15) suppresses early-window noise.
        snap = self._snapshot(
            claude_windows={"seven_day": {"used_percent": 50, "resets_at": self._resets_at(self.WEEK, 0.05)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertEqual(alerts, [])

    def test_estimate_source_never_alerts(self):
        snap = self._snapshot(
            claude_source="estimate",
            claude_windows={"seven_day": {"used_percent": 99, "resets_at": self._resets_at(self.WEEK, 0.99)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertEqual(alerts, [])

    # --- OVERUSE ------------------------------------------------------------

    def test_overuse_fires_with_projection_50pct_at_20pct_elapsed(self):
        snap = self._snapshot(
            claude_windows={"seven_day": {"used_percent": 50, "resets_at": self._resets_at(self.WEEK, 0.2)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertEqual(len(alerts), 1)
        a = alerts[0]
        self.assertIn("OVERUSE", a)
        self.assertIn("weekly limit", a)
        self.assertIn("50%", a)
        self.assertIn("20%", a)
        self.assertIn("2.5x", a)
        self.assertIn("run out", a)
        self.assertIn("reset", a)

    def test_overuse_silent_below_pace_ratio_threshold(self):
        # 25% used at 20% elapsed -> pace 1.25, under the 1.5 over-threshold.
        snap = self._snapshot(
            claude_windows={"seven_day": {"used_percent": 25, "resets_at": self._resets_at(self.WEEK, 0.2)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertEqual(alerts, [])

    def test_overuse_works_on_five_hour_window_too(self):
        snap = self._snapshot(
            claude_windows={"five_hour": {"used_percent": 60, "resets_at": self._resets_at(self.FIVE_H, 0.3)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertTrue(any("OVERUSE" in a and "5-hour limit" in a for a in alerts))

    def test_overuse_authoritative_cached_still_fires(self):
        snap = self._snapshot(
            claude_source="authoritative_cached",
            claude_windows={"seven_day": {"used_percent": 50, "resets_at": self._resets_at(self.WEEK, 0.2)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertTrue(any("OVERUSE" in a for a in alerts))

    # --- UNDERUSE -----------------------------------------------------------

    def test_underuse_fires_10pct_at_57pct_elapsed(self):
        snap = self._snapshot(
            claude_windows={"seven_day": {"used_percent": 10, "resets_at": self._resets_at(self.WEEK, 0.57)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertEqual(len(alerts), 1)
        a = alerts[0]
        self.assertIn("UNDERUSE", a)
        self.assertIn("weekly limit", a)
        self.assertIn("10%", a)
        self.assertIn("57%", a)
        self.assertIn("big project", a)

    def test_underuse_silent_above_pace_ratio_threshold(self):
        # 40% used at 57% elapsed -> pace ~0.70, above the 0.5 under-threshold.
        snap = self._snapshot(
            claude_windows={"seven_day": {"used_percent": 40, "resets_at": self._resets_at(self.WEEK, 0.57)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertEqual(alerts, [])

    def test_underuse_flows_through_codex_window_too(self):
        snap = self._snapshot(
            claude_windows={},
            codex_windows={"weekly": {
                "used_percent": 0, "window_minutes": 10080,
                "resets_at": self._resets_at(10080 * 60, 0.5),
            }},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertTrue(any("UNDERUSE" in a and "Codex weekly limit" in a for a in alerts))

    def test_five_hour_window_never_fires_underuse(self):
        # The 5h window resets constantly -- there's no "stuck" quota to
        # rescue, so under-pace there is the normal resting state, not a
        # signal. Same low pace (10% used at 57% elapsed) that fires
        # UNDERUSE on a weekly window must stay silent on the 5h window.
        snap = self._snapshot(
            claude_windows={"five_hour": {"used_percent": 10, "resets_at": self._resets_at(self.FIVE_H, 0.57)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertFalse(any("UNDERUSE" in a for a in alerts))
        self.assertEqual(alerts, [])

    def test_weekly_window_still_fires_underuse_at_the_same_pace(self):
        # Control case for the above: the exact same 10%@57%-elapsed pace
        # on a weekly-class window still fires -- proves the gate is about
        # window length, not the pace numbers themselves.
        snap = self._snapshot(
            claude_windows={"seven_day": {"used_percent": 10, "resets_at": self._resets_at(self.WEEK, 0.57)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertTrue(any("UNDERUSE" in a for a in alerts))

    def test_five_hour_window_underuse_dedup_state_never_created(self):
        # A band that can never fire on this window shouldn't even grow a
        # dedup-state entry.
        state = {}
        snap = self._snapshot(
            claude_windows={"five_hour": {"used_percent": 10, "resets_at": self._resets_at(self.FIVE_H, 0.57)}},
        )
        uc.compute_alerts(snap, state, now_utc=self.NOW)
        self.assertNotIn("claude_five_hour_under", state)

    def test_codex_five_hour_window_also_exempt_from_underuse(self):
        snap = self._snapshot(
            claude_windows={},
            codex_windows={"five_hour": {
                "used_percent": 5, "window_minutes": 300,
                "resets_at": self._resets_at(300 * 60, 0.57),
            }},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertEqual(alerts, [])

    def test_five_hour_overuse_and_near_exhaustion_still_fire(self):
        # OVERUSE and the near-exhaustion backstop must NOT be gated by
        # underuse_min_window_sec -- only UNDERUSE is.
        snap = self._snapshot(
            claude_windows={"five_hour": {"used_percent": 95, "resets_at": self._resets_at(self.FIVE_H, 0.5)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertTrue(any("OVERUSE" in a and "5-hour limit" in a for a in alerts))
        self.assertTrue(any("nearly exhausted" in a for a in alerts))

    # --- BACKSTOP: near-exhaustion -------------------------------------------

    def test_near_exhaustion_backstop_fires_regardless_of_pace(self):
        # 95% used at 95% elapsed -> pace ~1.0 (neither over nor under band),
        # but the hard backstop (>=92% used) must still fire.
        snap = self._snapshot(
            claude_windows={"seven_day": {"used_percent": 95, "resets_at": self._resets_at(self.WEEK, 0.95)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertTrue(any("nearly exhausted" in a for a in alerts))
        self.assertFalse(any("OVERUSE" in a for a in alerts))
        self.assertFalse(any("UNDERUSE" in a for a in alerts))

    def test_near_exhaustion_and_overuse_can_both_fire(self):
        # 95% used at 50% elapsed -> pace 1.9 (over) AND used >= 92% (near-exhaustion).
        snap = self._snapshot(
            claude_windows={"seven_day": {"used_percent": 95, "resets_at": self._resets_at(self.WEEK, 0.5)}},
        )
        alerts = uc.compute_alerts(snap, {}, now_utc=self.NOW)
        self.assertTrue(any("nearly exhausted" in a for a in alerts))
        self.assertTrue(any("OVERUSE" in a for a in alerts))

    # --- de-dup --------------------------------------------------------------

    def test_overuse_dedup_suppresses_immediate_repeat_then_refires_after_45min(self):
        resets_at = self._resets_at(self.WEEK, 0.2)  # fixed absolute reset instant
        window = {"seven_day": {"used_percent": 50, "resets_at": resets_at}}
        state = {}

        first = uc.compute_alerts(self._snapshot(claude_windows=window), state, now_utc=self.NOW)
        self.assertTrue(any("OVERUSE" in a for a in first))

        # 40 min later: still ongoing, under the 45 min refire interval -- silent.
        soon = self.NOW + timedelta(minutes=40)
        second = uc.compute_alerts(self._snapshot(claude_windows=window), state, now_utc=soon)
        self.assertEqual(second, [])

        # 50 min after the first fire: interval elapsed -- re-fires.
        later = self.NOW + timedelta(minutes=50)
        third = uc.compute_alerts(self._snapshot(claude_windows=window), state, now_utc=later)
        self.assertTrue(any("OVERUSE" in a for a in third))

    def test_underuse_dedup_throttles_for_12_hours(self):
        resets_at = self._resets_at(self.WEEK, 0.57)
        window = {"seven_day": {"used_percent": 10, "resets_at": resets_at}}
        state = {}

        first = uc.compute_alerts(self._snapshot(claude_windows=window), state, now_utc=self.NOW)
        self.assertTrue(any("UNDERUSE" in a for a in first))

        soon = self.NOW + timedelta(hours=6)
        second = uc.compute_alerts(self._snapshot(claude_windows=window), state, now_utc=soon)
        self.assertEqual(second, [])

        later = self.NOW + timedelta(hours=13)
        third = uc.compute_alerts(self._snapshot(claude_windows=window), state, now_utc=later)
        self.assertTrue(any("UNDERUSE" in a for a in third))

    def test_near_exhaustion_dedup_refires_after_45min(self):
        resets_at = self._resets_at(self.WEEK, 0.95)
        window = {"seven_day": {"used_percent": 95, "resets_at": resets_at}}
        state = {}

        first = uc.compute_alerts(self._snapshot(claude_windows=window), state, now_utc=self.NOW)
        self.assertTrue(any("nearly exhausted" in a for a in first))

        soon = self.NOW + timedelta(minutes=30)
        second = uc.compute_alerts(self._snapshot(claude_windows=window), state, now_utc=soon)
        self.assertEqual(second, [])

        later = self.NOW + timedelta(minutes=50)
        third = uc.compute_alerts(self._snapshot(claude_windows=window), state, now_utc=later)
        self.assertTrue(any("nearly exhausted" in a for a in third))


class TestClaudeTokenSources(unittest.TestCase):
    """Token source resolution. The regression this guards: on macOS there is
    no ~/.claude/.credentials.json (Claude Code stores the session token in
    the login Keychain), so the collector fell through to the long-lived
    `claude setup-token` value in .env -- which the oauth/usage endpoint
    rejects with 403. Result: authoritative usage silently degraded to a
    token-count estimate with no percentages and no reset times."""

    KEYCHAIN_PAYLOAD = json.dumps({"claudeAiOauth": {"accessToken": "keychain-tok"}})

    def setUp(self):
        self._tmp = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False)
        self._tmp.write("CLAUDE_CODE_OAUTH_TOKEN=env-tok\n")
        self._tmp.close()
        self.addCleanup(os.unlink, self._tmp.name)

    def _security_ok(self, stdout=None):
        return MagicMock(returncode=0, stdout=stdout if stdout is not None else self.KEYCHAIN_PAYLOAD)

    def test_keychain_used_when_credentials_file_absent(self):
        with patch.object(uc.sys, "platform", "darwin"), \
             patch.object(uc.os.path, "exists", side_effect=lambda p: p == self._tmp.name), \
             patch.object(uc, "ENV_PATH", self._tmp.name), \
             patch.object(uc.subprocess, "run", return_value=self._security_ok()):
            token, source = uc._read_claude_token()
        self.assertEqual(token, "keychain-tok")
        self.assertEqual(source, "keychain")

    def test_keychain_beats_env_file(self):
        """The .env token answers 403, so it must never win over the keychain."""
        # `exists` must NOT be True for the credentials path: expanduser is real,
        # so a blanket True opens the machine's own ~/.claude/.credentials.json
        # and assertEqual prints its token on failure (a real-token leak on any
        # host that HAS the file). Say the intent instead: credentials absent,
        # env present -- keychain still wins over env.
        with patch.object(uc.sys, "platform", "darwin"), \
             patch.object(uc.os.path, "exists", side_effect=lambda p: p == self._tmp.name), \
             patch.object(uc, "ENV_PATH", self._tmp.name), \
             patch.object(uc.subprocess, "run", return_value=self._security_ok()):
            token, source = uc._read_claude_token()
        self.assertEqual(token, "keychain-tok")
        self.assertEqual(source, "keychain")

    def test_credentials_file_still_wins_over_keychain(self):
        cred = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        cred.write(json.dumps({"claudeAiOauth": {"accessToken": "file-tok"}}))
        cred.close()
        self.addCleanup(os.unlink, cred.name)
        with patch.object(uc.sys, "platform", "darwin"), \
             patch.object(uc.os.path, "expanduser", return_value=cred.name), \
             patch.object(uc.subprocess, "run", return_value=self._security_ok()) as run:
            token, source = uc._read_claude_token()
        self.assertEqual(token, "file-tok")
        self.assertEqual(source, "credentials_file")
        run.assert_not_called()

    def test_non_darwin_never_shells_out_to_security(self):
        with patch.object(uc.sys, "platform", "linux"), \
             patch.object(uc.subprocess, "run") as run:
            self.assertIsNone(uc._read_keychain_token())
        run.assert_not_called()

    def test_security_failure_falls_through_to_env_file(self):
        with patch.object(uc.sys, "platform", "darwin"), \
             patch.object(uc.os.path, "exists", side_effect=lambda p: p == self._tmp.name), \
             patch.object(uc, "ENV_PATH", self._tmp.name), \
             patch.object(uc.subprocess, "run", return_value=MagicMock(returncode=1, stdout="")):
            token, source = uc._read_claude_token()
        self.assertEqual(token, "env-tok")
        self.assertEqual(source, "env_file")

    def test_unparseable_keychain_payload_is_silent(self):
        with patch.object(uc.sys, "platform", "darwin"), \
             patch.object(uc.subprocess, "run", return_value=MagicMock(returncode=0, stdout="not json")):
            self.assertIsNone(uc._read_keychain_token())

    def test_keychain_prompt_timeout_does_not_raise(self):
        """A headless/launchd run can hit a blocking GUI prompt; the bounded
        subprocess must degrade to None, never crash the monitor."""
        with patch.object(uc.sys, "platform", "darwin"), \
             patch.object(uc.subprocess, "run", side_effect=subprocess.TimeoutExpired("security", 10)):
            self.assertIsNone(uc._read_keychain_token())

    def test_no_source_at_all_returns_none_pair(self):
        with patch.object(uc.sys, "platform", "linux"), \
             patch.object(uc.os.path, "exists", return_value=False):
            self.assertEqual(uc._read_claude_token(), (None, None))

    # ISSUE3159: an expired ~/.claude/.credentials.json (a setup-token install's leftover first login) is skipped.
    def _cred_file(self, oauth):
        cred = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        cred.write(json.dumps({"claudeAiOauth": oauth}))
        cred.close()
        self.addCleanup(os.unlink, cred.name)
        return cred.name

    def _read_with_file(self, cred):
        with patch.object(uc.sys, "platform", "linux"), \
             patch.object(uc.os.path, "expanduser", return_value=cred), \
             patch.object(uc, "ENV_PATH", self._tmp.name):
            return uc._read_claude_token()

    def test_expired_credentials_file_is_skipped_for_the_env_token(self):
        past_ms = int((datetime.now(timezone.utc) - timedelta(days=30)).timestamp() * 1000)
        cred = self._cred_file({"accessToken": "file-tok", "expiresAt": past_ms})
        self.assertEqual(self._read_with_file(cred), ("env-tok", "env_file"))

    def test_unexpired_credentials_file_still_wins(self):
        future_ms = int((datetime.now(timezone.utc) + timedelta(hours=2)).timestamp() * 1000)
        cred = self._cred_file({"accessToken": "file-tok", "expiresAt": future_ms})
        self.assertEqual(self._read_with_file(cred), ("file-tok", "credentials_file"))

    def test_credentials_file_without_expiry_is_not_judged(self):
        cred = self._cred_file({"accessToken": "file-tok"})
        self.assertEqual(self._read_with_file(cred), ("file-tok", "credentials_file"))


class TestSetupTokenInstall(unittest.TestCase):
    """ISSUE3159 end to end: Linux, the bot on the setup-token, an expired ~/.claude/.credentials.json left over. The
    collector used to spend a 401 on the stale file and then run the rate-limit header probe with it too, so no reading
    ever came. Now the stale file is skipped: the usage endpoint says plainly that it does not take a setup-token, and
    the header probe gets the setup-token. No network, no node: urlopen and subprocess.run are stand-ins."""

    def test_stale_file_skipped_header_probe_gets_the_setup_token(self):
        tmp = tempfile.mkdtemp(prefix="i3159-")
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        past_ms = int((datetime.now(timezone.utc) - timedelta(days=30)).timestamp() * 1000)
        cred = os.path.join(tmp, "credentials.json")
        with open(cred, "w") as f:
            json.dump({"claudeAiOauth": {"accessToken": "stale-tok", "expiresAt": past_ms}}, f)
        env = os.path.join(tmp, ".env")
        with open(env, "w") as f:
            f.write("CLAUDE_CODE_OAUTH_TOKEN=setup-tok\n")
        entry = os.path.join(tmp, "entry.js")
        with open(entry, "w") as f:
            f.write("//")
        calls = []

        def urlopen(req, timeout=10):
            tok = req.headers["Authorization"].split(" ", 1)[1]
            calls.append(("usage", tok))
            raise urllib.error.HTTPError(req.full_url, 401 if tok == "stale-tok" else 403, "x", {}, None)

        def run(argv, **kw):
            if argv[:1] == ["claude"]:
                return subprocess.CompletedProcess(argv, 0, stdout="2.1.0 (Claude Code)\n", stderr="")
            tok = kw["env"]["CLAUDE_RATELIMIT_TOKEN"]
            calls.append(("headers", tok))
            out = {"ok": True, "windows": {"five_hour": {"used_percent": 12.0}}} if tok == "setup-tok" else {"ok": False, "reason": "HTTP 401"}
            return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(out) + "\n", stderr="")

        real_expanduser = os.path.expanduser
        with patch.object(uc.sys, "platform", "linux"), \
             patch.object(uc.os.path, "expanduser", side_effect=lambda p: cred if p.endswith(".credentials.json") else real_expanduser(p)), \
             patch.object(uc, "ENV_PATH", env), \
             patch.object(uc, "RATELIMIT_ENTRY", entry), \
             patch.object(uc, "_read_claude_statusline", return_value=(None, None)), \
             patch("urllib.request.urlopen", side_effect=urlopen), \
             patch.object(uc.subprocess, "run", side_effect=run):
            result = uc.collect_claude()
        self.assertEqual(calls, [("usage", "setup-tok"), ("headers", "setup-tok")])
        self.assertEqual(result["source"], "ratelimit_headers")
        self.assertEqual(result["windows"], {"five_hour": {"used_percent": 12.0}})
        self.assertTrue(result["auth_error"].startswith("HTTP 403 (env_file token): not available on this auth mode"), result["auth_error"])


class TestCodexSnapshotFreshness(unittest.TestCase):
    """USAGE401DIAG910 (c): the Codex numbers come from a rollout file on disk,
    which can be hours or months old. collect_codex() must capture the event's
    timestamp, and render_summary() must show the numbers WITH their age -- or
    say the freshness is unknown -- so no % is read as current when it is not."""

    def _rollout(self, tmp, ts):
        path = os.path.join(tmp, "rollout-x.jsonl")
        event = {"type": "event", "payload": {"rate_limits": {
            "plan_type": "pro",
            "primary": {"used_percent": 12.5, "window_minutes": 10080, "resets_at": 1234.0},
        }}}
        if ts is not None:
            event["timestamp"] = ts
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")
        return path

    def test_collect_codex_captures_snapshot_at_and_age(self):
        with tempfile.TemporaryDirectory() as tmp:
            ts = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat().replace("+00:00", "Z")
            path = self._rollout(tmp, ts)
            with patch.object(uc.glob, "glob", return_value=[path]):
                result = uc.collect_codex()
            self.assertTrue(result["ok"])
            self.assertEqual(result["snapshot_at"], ts)
            self.assertIsNotNone(result["snapshot_age_hours"])
            self.assertAlmostEqual(result["snapshot_age_hours"], 3.0, delta=0.2)

    def test_collect_codex_no_rate_limits_fails_closed_with_named_state(self):
        # Regression guard (Marveen review of #1287): the edit that added the
        # timestamp capture must NOT drop the "no rate_limits entries" raise.
        # An empty/absent rate_limits payload must fail closed (ok False) with a
        # message that NAMES THE STATE ("rate_limits") -- so a later round sees
        # "look at the rollout file", not a bare Python AttributeError.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "rollout-x.jsonl")
            with open(path, "w", encoding="utf-8") as f:
                # a line that mentions rate_limits (so the scan enters the branch)
                # but whose payload rate_limits is empty -> rate_limits stays None
                f.write(json.dumps({"type": "event", "payload": {"rate_limits": {}}}) + "\n")
            with patch.object(uc.glob, "glob", return_value=[path]):
                result = uc.collect_codex()
            self.assertFalse(result["ok"])
            self.assertIn("rate_limits", result.get("error", ""))

    def test_collect_codex_no_timestamp_leaves_snapshot_at_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._rollout(tmp, None)
            with patch.object(uc.glob, "glob", return_value=[path]):
                result = uc.collect_codex()
            self.assertTrue(result["ok"])
            self.assertIsNone(result["snapshot_at"])
            self.assertIsNone(result["snapshot_age_hours"])

    def test_collect_codex_without_sessions_names_reason_no_sessions(self):
        # Codex never ran on this host (the common case): ok False, and a
        # stable reason field the /usage reply keys on instead of the error text.
        with patch.object(uc.glob, "glob", return_value=[]):
            result = uc.collect_codex()
        self.assertFalse(result["ok"])
        self.assertEqual(result.get("reason"), "no_sessions")
        self.assertIn("no ~/.codex/sessions rollout files found", result.get("error", ""))

    def test_collect_codex_real_failure_has_no_no_sessions_reason(self):
        # A real failure (rollout present, no rate_limits) must not be labelled
        # as "Codex never ran".
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "rollout-x.jsonl")
            with open(path, "w", encoding="utf-8") as f:
                f.write(json.dumps({"type": "event", "payload": {"rate_limits": {}}}) + "\n")
            with patch.object(uc.glob, "glob", return_value=[path]):
                result = uc.collect_codex()
        self.assertFalse(result["ok"])
        self.assertNotEqual(result.get("reason"), "no_sessions")

    def _snapshot(self, codex):
        return {
            "generated_at_local": "2026-09-11 14:00:00 CEST",
            "codex": codex,
            "claude": {"ok": True, "source": "estimate", "files_scanned": 0},
        }

    def test_render_shows_stale_marker_for_old_snapshot(self):
        codex = {"ok": True, "source": "authoritative", "plan_type": "pro",
                 "windows": {"weekly": {"used_percent": 12.5, "window_minutes": 10080, "resets_at": 1234.0}},
                 "snapshot_at": "2026-04-26T12:03:04.051Z", "snapshot_age_hours": 24 * 138.0}
        out = uc.render_summary(self._snapshot(codex))
        self.assertIn("snapshot:", out)
        self.assertIn("[STALE]", out)
        self.assertIn("days old", out)

    def test_render_says_freshness_unknown_without_timestamp(self):
        codex = {"ok": True, "source": "authoritative", "plan_type": "pro",
                 "windows": {"weekly": {"used_percent": 12.5, "window_minutes": 10080, "resets_at": 1234.0}},
                 "snapshot_at": None, "snapshot_age_hours": None}
        out = uc.render_summary(self._snapshot(codex))
        self.assertIn("freshness unknown", out)

    def test_render_fresh_snapshot_has_no_stale_marker(self):
        codex = {"ok": True, "source": "authoritative", "plan_type": "pro",
                 "windows": {"weekly": {"used_percent": 12.5, "window_minutes": 10080, "resets_at": 1234.0}},
                 "snapshot_at": "2026-09-11T12:00:00Z", "snapshot_age_hours": 2.0}
        out = uc.render_summary(self._snapshot(codex))
        self.assertIn("snapshot:", out)
        self.assertNotIn("[STALE]", out)
        self.assertIn("h old", out)



class TestInstallZone(unittest.TestCase):
    """ISSUE1895 (#1895): reset stamps follow the install zone, not a fixed Europe/Budapest."""

    def test_explicit_marveen_tz_wins(self):
        with patch.dict(os.environ, {"MARVEEN_TZ": "Europe/London"}):
            self.assertEqual(str(uc._local_tz()), "Europe/London")

    def test_scheduler_tz_from_the_overrides_file(self):
        with tempfile.TemporaryDirectory() as d, patch.object(uc, "STORE_DIR", d), patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MARVEEN_TZ", None)
            with open(os.path.join(d, "config-overrides.json"), "w") as f:
                json.dump({"SCHEDULER_TZ": "America/New_York"}, f)
            self.assertEqual(str(uc._local_tz()), "America/New_York")

    def test_host_fallback_is_a_named_zone_not_a_fixed_offset(self):
        # A fixed offset (datetime.now().astimezone().tzinfo) renders a reset on the
        # other side of a DST switch one hour off; a ZoneInfo keeps the rules.
        from zoneinfo import ZoneInfo
        with tempfile.TemporaryDirectory() as d, patch.object(uc, "STORE_DIR", d), patch.object(uc, "ENV_PATH", os.path.join(d, ".env")):
            env = {k: v for k, v in os.environ.items() if k not in ("MARVEEN_TZ", "TZ")}
            with patch.dict(os.environ, env, clear=True):
                if "/zoneinfo/" not in os.path.realpath("/etc/localtime"):
                    self.skipTest("host has no named zone to fall back to")
                self.assertIsInstance(uc._local_tz(), ZoneInfo)

if __name__ == "__main__":
    unittest.main(verbosity=2)
