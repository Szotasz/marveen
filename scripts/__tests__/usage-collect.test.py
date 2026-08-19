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

    def test_local_string_has_budapest_offset_marker(self):
        ts = _future_ts(days=1)
        local_str, _ = uc.fmt_reset(ts)
        # e.g. "2026-07-23 14:45 CEST" -- must contain a plausible tz abbrev
        self.assertRegex(local_str, r"CES?T$")


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
        with patch.object(uc.sys, "platform", "darwin"), \
             patch.object(uc.os.path, "exists", return_value=True), \
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
