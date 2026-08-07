#!/usr/bin/env python3
"""Unit tests for seed-skills/fleet-helper/scripts/local_router.py.

The client is meant to be called from inside a bigger task, which is why the
behaviour under test is mostly about what happens when the router says NO: a
refusal has to come back as data, with enough of the reason for the caller to
choose between retrying, paying for the cloud, or fixing the request. An
exception thrown here would surface as a crash in whatever job was running.

No network: urlopen is patched throughout.
"""
import importlib.util
import io
import json
import os
import unittest
import urllib.error
from unittest.mock import patch

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "seed-skills",
    "fleet-helper",
    "scripts",
    "local_router.py",
)
_spec = importlib.util.spec_from_file_location("local_router", _MODULE_PATH)
lr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lr)


class _Response(io.BytesIO):
    """Minimal stand-in for the object urlopen returns in a with-block."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _ok_body(text="hello", host="air903max", model="qwen3-coder:latest"):
    return _Response(
        json.dumps(
            {
                "choices": [{"message": {"role": "assistant", "content": text}}],
                "x_router_host": host,
                "model": model,
                "usage": {"prompt_tokens": 10, "completion_tokens": 3},
            }
        ).encode()
    )


def _http_error(status, code, message, retry_after=None):
    headers = {"Retry-After": retry_after} if retry_after else {}
    body = json.dumps({"error": {"code": code, "message": message}}).encode()
    return urllib.error.HTTPError("http://router", status, message, headers, io.BytesIO(body))


class AnswerTest(unittest.TestCase):
    def test_returns_the_text_and_who_served_it(self):
        with patch.object(lr.urllib.request, "urlopen", return_value=_ok_body()):
            r = lr.ask([{"role": "user", "content": "hi"}], task_class="summary")
        self.assertTrue(lr.is_ok(r))
        self.assertEqual(r["text"], "hello")
        # Reported rather than assumed: the caller asked for a class, not a model.
        self.assertEqual(r["host"], "air903max")
        self.assertEqual(r["model"], "qwen3-coder:latest")

    def test_sends_the_task_class_in_the_header_and_the_body(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["headers"] = {k.lower(): v for k, v in req.headers.items()}
            captured["body"] = json.loads(req.data.decode())
            return _ok_body()

        with patch.object(lr.urllib.request, "urlopen", side_effect=fake_urlopen):
            lr.ask([{"role": "user", "content": "hi"}], task_class="structured")

        self.assertEqual(captured["headers"].get("X-task-class".lower()), "structured")
        self.assertEqual(captured["body"]["task_class"], "structured")

    def test_passes_harmless_options_through(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode())
            return _ok_body()

        with patch.object(lr.urllib.request, "urlopen", side_effect=fake_urlopen):
            lr.ask([], task_class="code", options={"temperature": 0.2})

        self.assertEqual(captured["body"]["temperature"], 0.2)


class RefusalTest(unittest.TestCase):
    """Every one of these would be an exception if the client were naive."""

    def test_busy_comes_back_as_data_with_a_retry_hint(self):
        with patch.object(lr.urllib.request, "urlopen", side_effect=_http_error(503, "all-busy", "every machine busy", "15")):
            r = lr.ask([], task_class="summary")
        self.assertFalse(lr.is_ok(r))
        self.assertEqual(r["refusal"], "all-busy")
        self.assertEqual(r["retry_after"], 15)
        # Busy is temporary: retrying is the cheaper first move.
        self.assertEqual(r["fallback"], "retry")

    def test_a_class_the_router_does_not_serve_points_at_the_cloud(self):
        with patch.object(lr.urllib.request, "urlopen", side_effect=_http_error(501, "cloud-only", "not measured locally")):
            r = lr.ask([], task_class="agent-loop")
        self.assertEqual(r["refusal"], "cloud-only")
        self.assertEqual(r["fallback"], "cloud")

    def test_an_oversized_prompt_asks_the_caller_to_change_the_request(self):
        # Retrying this unchanged cannot help, and paying a cloud model for a
        # prompt that may simply need splitting is the wrong reflex.
        with patch.object(
            lr.urllib.request,
            "urlopen",
            side_effect=_http_error(413, "prompt-too-long-for-fallback", "prompt is 9000 tokens; limit 8000"),
        ):
            r = lr.ask([], task_class="structured")
        self.assertEqual(r["fallback"], "fix-request")
        self.assertIn("8000", r["detail"])

    def test_carries_the_reason_in_words_not_only_a_code(self):
        with patch.object(lr.urllib.request, "urlopen", side_effect=_http_error(503, "no-healthy-host", "no local machine is answering")):
            r = lr.ask([])
        self.assertIn("no local machine", r["detail"])

    def test_a_dead_router_is_data_too(self):
        with patch.object(lr.urllib.request, "urlopen", side_effect=urllib.error.URLError("Connection refused")):
            r = lr.ask([])
        self.assertEqual(r["refusal"], "unreachable")
        self.assertEqual(r["fallback"], "cloud")

    def test_a_timeout_is_distinguished_from_a_refusal(self):
        with patch.object(lr.urllib.request, "urlopen", side_effect=urllib.error.URLError("timed out")):
            r = lr.ask([])
        self.assertEqual(r["refusal"], "timeout")

    def test_an_unexpected_error_still_does_not_escape(self):
        # A helper called inside another task must never be the thing that
        # takes that task down.
        with patch.object(lr.urllib.request, "urlopen", side_effect=RuntimeError("something odd")):
            r = lr.ask([])
        self.assertFalse(lr.is_ok(r))
        self.assertEqual(r["refusal"], "unreachable")

    def test_a_non_json_error_body_does_not_break_the_parse(self):
        err = urllib.error.HTTPError("http://router", 502, "Bad Gateway", {}, io.BytesIO(b"<html>nope</html>"))
        with patch.object(lr.urllib.request, "urlopen", side_effect=err):
            r = lr.ask([])
        self.assertEqual(r["status"], 502)
        self.assertFalse(lr.is_ok(r))


class NoSilentCloudTest(unittest.TestCase):
    def test_the_module_never_calls_anything_but_the_router(self):
        # The decision to spend cloud money is the caller's. This asserts the
        # boundary rather than trusting the docstring.
        with open(_MODULE_PATH, encoding="utf-8") as fh:
            source = fh.read()
        for forbidden in ("anthropic", "openai.com", "api.openai", "claude.ai"):
            self.assertNotIn(forbidden, source.lower())

    def test_fallback_is_advice_and_the_call_is_not_made(self):
        with patch.object(lr.urllib.request, "urlopen", side_effect=_http_error(503, "no-healthy-host", "down")) as m:
            r = lr.ask([])
        self.assertEqual(m.call_count, 1)  # one attempt, no second target
        self.assertIn(r["fallback"], ("cloud", "retry", "fix-request"))


class CallerMistakeTest(unittest.TestCase):
    # Found in review: a bare-string call went to the router, came back as an
    # upstream 400, and the client suggested "cloud" -- a typo priced as a
    # cloud recommendation. The string form is now accepted, and malformed
    # input is refused locally as fix-request before any network happens.
    def test_a_bare_string_becomes_a_single_user_message(self):
        body = _Response(json.dumps({
            "model": "qwen3-coder:latest", "x_router_host": "air903max",
            "choices": [{"message": {"content": "ok"}}], "usage": {},
        }).encode())
        with patch.object(lr.urllib.request, "urlopen", return_value=body) as mocked:
            r = lr.ask("just a prompt", task_class="general")
        self.assertTrue(r["ok"])
        sent = json.loads(mocked.call_args[0][0].data.decode())
        self.assertEqual(sent["messages"], [{"role": "user", "content": "just a prompt"}])

    def test_malformed_messages_are_refused_before_the_network(self):
        with patch.object(lr.urllib.request, "urlopen", side_effect=AssertionError("no network call allowed")):
            r = lr.ask([{"role": "user"}])  # content missing
        self.assertFalse(r["ok"])
        self.assertEqual(r["refusal"], "bad-request")
        self.assertEqual(r["fallback"], "fix-request")


class HealthTest(unittest.TestCase):
    def test_reports_what_the_router_sees(self):
        body = _Response(json.dumps({"up": {"air903max": True, "strikex": False}, "busy": []}).encode())
        with patch.object(lr.urllib.request, "urlopen", return_value=body):
            r = lr.health()
        self.assertTrue(r["ok"])
        self.assertEqual(r["up"]["strikex"], False)

    def test_an_unreachable_router_is_not_an_exception_here_either(self):
        with patch.object(lr.urllib.request, "urlopen", side_effect=urllib.error.URLError("nope")):
            self.assertEqual(lr.health()["refusal"], "unreachable")


if __name__ == "__main__":
    unittest.main()
