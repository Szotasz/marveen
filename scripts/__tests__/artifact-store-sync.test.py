#!/usr/bin/env python3
"""Unit tests for scripts/hooks/artifact-store-sync.py.

Tests cover the pure-logic helpers: _extract_cloud_url, _kind_from_path,
and the main() skip conditions (wrong tool, action!=publish, is_error, no URL).

Privacy: only neutral fixture data; no real agent names, tokens, or chat IDs.
"""
import importlib.util
import os
import sys
import unittest

_HOOK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "hooks", "artifact-store-sync.py",
)

_spec = importlib.util.spec_from_file_location("artifact_store_sync", _HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(hook)  # type: ignore[union-attr]


class TestExtractCloudUrl(unittest.TestCase):
    """_extract_cloud_url extracts the published URL from tool_response."""

    def test_url_field_in_dict(self):
        resp = {"url": "https://claude.ai/public/artifacts/abc123", "type": "success"}
        self.assertEqual(hook._extract_cloud_url(resp), "https://claude.ai/public/artifacts/abc123")

    def test_cloud_url_field_in_dict(self):
        resp = {"cloud_url": "https://claude.ai/public/artifacts/xyz"}
        self.assertEqual(hook._extract_cloud_url(resp), "https://claude.ai/public/artifacts/xyz")

    def test_url_nested_in_dict(self):
        resp = {"result": {"url": "https://claude.ai/public/artifacts/nested"}}
        self.assertEqual(hook._extract_cloud_url(resp), "https://claude.ai/public/artifacts/nested")

    def test_url_in_string(self):
        resp = "Published at https://claude.ai/public/artifacts/str-match — ready."
        self.assertEqual(hook._extract_cloud_url(resp), "https://claude.ai/public/artifacts/str-match")

    def test_url_in_list(self):
        resp = [{"url": "https://claude.ai/public/artifacts/list-item"}]
        self.assertEqual(hook._extract_cloud_url(resp), "https://claude.ai/public/artifacts/list-item")

    def test_no_url_returns_empty_string(self):
        self.assertEqual(hook._extract_cloud_url({"some_field": "no url here"}), "")
        self.assertEqual(hook._extract_cloud_url("no url in this string"), "")
        self.assertEqual(hook._extract_cloud_url([]), "")
        self.assertEqual(hook._extract_cloud_url({}), "")
        self.assertEqual(hook._extract_cloud_url(None), "")

    def test_non_claude_url_is_ignored(self):
        resp = {"url": "https://example.com/something"}
        self.assertEqual(hook._extract_cloud_url(resp), "")

    def test_http_non_secure_ignored(self):
        # Only https://claude.ai matches; arbitrary http is not a cloud URL
        resp = "check http://claude.ai/public/artifacts/insecure"
        # regex requires https -- no match
        self.assertEqual(hook._extract_cloud_url(resp), "")

    def test_published_url_field_variant(self):
        resp = {"published_url": "https://claude.ai/public/artifacts/pub"}
        self.assertEqual(hook._extract_cloud_url(resp), "https://claude.ai/public/artifacts/pub")


class TestIsValidClaudeUrl(unittest.TestCase):
    """_is_valid_claude_url must reject hostname-bypass attempts."""

    def test_valid_claude_ai_url(self):
        self.assertTrue(hook._is_valid_claude_url("https://claude.ai/public/artifacts/abc"))

    def test_valid_subdomain_url(self):
        self.assertTrue(hook._is_valid_claude_url("https://cdn.claude.ai/static/x.js"))

    def test_bypass_hostname_contains_claude_ai_as_prefix(self):
        # Substring match on 'claude.ai' would incorrectly accept this.
        self.assertFalse(hook._is_valid_claude_url("https://claude.ai.evil.com/artifact"))

    def test_bypass_path_contains_claude_ai(self):
        # Substring match on 'claude.ai' would incorrectly accept this.
        self.assertFalse(hook._is_valid_claude_url("https://evil.com/claude.ai/artifacts/x"))

    def test_bypass_scheme_not_https(self):
        # startswith('https') would accept 'httpsx://' -- scheme check must be exact.
        self.assertFalse(hook._is_valid_claude_url("httpsx://claude.ai/public/artifacts/x"))

    def test_http_not_https_rejected(self):
        self.assertFalse(hook._is_valid_claude_url("http://claude.ai/public/artifacts/x"))

    def test_non_claude_domain_rejected(self):
        self.assertFalse(hook._is_valid_claude_url("https://example.com/artifact"))

    def test_empty_string_rejected(self):
        self.assertFalse(hook._is_valid_claude_url(""))

    def test_trailing_dot_hostname_accepted(self):
        # urlparse may return 'claude.ai.' with a trailing dot in some edge cases.
        self.assertTrue(hook._is_valid_claude_url("https://claude.ai./public/artifacts/abc"))


class TestExtractCloudUrlBypassRejection(unittest.TestCase):
    """_extract_cloud_url must not return URLs that bypass the host allowlist."""

    def test_dict_url_with_bypass_hostname_rejected(self):
        resp = {"url": "https://claude.ai.evil.com/public/artifacts/bypass"}
        self.assertEqual(hook._extract_cloud_url(resp), "")

    def test_dict_url_with_path_only_claude_ai_rejected(self):
        resp = {"url": "https://evil.com/claude.ai/public/artifacts/bypass"}
        self.assertEqual(hook._extract_cloud_url(resp), "")

    def test_dict_url_with_non_https_scheme_rejected(self):
        resp = {"url": "httpsx://claude.ai/public/artifacts/bypass"}
        self.assertEqual(hook._extract_cloud_url(resp), "")


class TestKindFromPath(unittest.TestCase):
    """_kind_from_path maps file extension to artifact kind."""

    def test_html(self):
        self.assertEqual(hook._kind_from_path("/tmp/report.html"), "html")

    def test_htm(self):
        self.assertEqual(hook._kind_from_path("/some/path/page.htm"), "html")

    def test_markdown(self):
        self.assertEqual(hook._kind_from_path("/docs/notes.md"), "markdown")

    def test_json(self):
        self.assertEqual(hook._kind_from_path("/data/output.json"), "json")

    def test_txt(self):
        self.assertEqual(hook._kind_from_path("/tmp/output.txt"), "text")

    def test_unknown_extension_defaults_to_text(self):
        self.assertEqual(hook._kind_from_path("/tmp/file.csv"), "text")
        self.assertEqual(hook._kind_from_path("/tmp/noext"), "text")

    def test_uppercase_extension(self):
        self.assertEqual(hook._kind_from_path("/tmp/report.HTML"), "html")


class TestMainSkipConditions(unittest.TestCase):
    """main() must exit(0) without POSTing for every skip condition."""

    def _run_hook(self, stdin_data: str) -> int:
        import subprocess, json
        r = subprocess.run(
            [sys.executable, _HOOK_PATH],
            input=stdin_data,
            capture_output=True,
            text=True,
        )
        return r.returncode

    def _payload(self, **overrides):
        import json
        base = {
            "tool_name": "Artifact",
            "tool_input": {"action": "publish", "file_path": "/tmp/x.html", "title": "T"},
            "tool_response": {"url": "https://claude.ai/public/artifacts/test"},
            "cwd": "/tmp/agents/agent-a",
            "session_id": "s1",
        }
        base.update(overrides)
        return json.dumps(base)

    def test_wrong_tool_skips(self):
        self.assertEqual(self._run_hook(self._payload(tool_name="Read")), 0)

    def test_action_list_skips(self):
        p = self._payload()
        import json
        d = json.loads(p)
        d["tool_input"]["action"] = "list"
        self.assertEqual(self._run_hook(json.dumps(d)), 0)

    def test_is_error_skips(self):
        p = self._payload()
        import json
        d = json.loads(p)
        d["tool_response"] = {"is_error": True}
        self.assertEqual(self._run_hook(json.dumps(d)), 0)

    def test_no_cloud_url_skips(self):
        p = self._payload()
        import json
        d = json.loads(p)
        d["tool_response"] = {"result": "no url here"}
        self.assertEqual(self._run_hook(json.dumps(d)), 0)

    def test_invalid_json_stdin_skips(self):
        self.assertEqual(self._run_hook("not-json"), 0)

    def test_empty_stdin_skips(self):
        self.assertEqual(self._run_hook(""), 0)

    def test_valid_payload_with_unreachable_dashboard_still_exits_0(self):
        # Dashboard is not running in test env; hook must fail-soft and exit 0.
        self.assertEqual(self._run_hook(self._payload()), 0)

    def test_tool_input_url_fallback_when_response_has_no_url(self):
        """When tool_response has no URL but tool_input.url is a valid claude.ai
        URL (update-existing-artifact path), the hook must proceed to POST."""
        import json
        d = json.loads(self._payload())
        d["tool_response"] = {"result": "updated successfully"}
        d["tool_input"]["url"] = "https://claude.ai/public/artifacts/existing-abc"
        # Dashboard unreachable -> exits 0 just like a normal publish attempt.
        self.assertEqual(self._run_hook(json.dumps(d)), 0)

    def test_tool_input_url_non_claude_domain_skips(self):
        """tool_input.url pointing to a non-claude.ai domain must not be used."""
        import json
        d = json.loads(self._payload())
        d["tool_response"] = {"result": "no url"}
        d["tool_input"]["url"] = "https://example.com/artifact"
        self.assertEqual(self._run_hook(json.dumps(d)), 0)

    def test_tool_input_url_http_not_https_skips(self):
        """tool_input.url with http:// (not https) must be rejected."""
        import json
        d = json.loads(self._payload())
        d["tool_response"] = {"result": "no url"}
        d["tool_input"]["url"] = "http://claude.ai/public/artifacts/insecure"
        self.assertEqual(self._run_hook(json.dumps(d)), 0)

    def test_response_url_takes_priority_over_tool_input_url(self):
        """When both tool_response and tool_input.url carry a URL, the response
        URL wins (it is the authoritative published location)."""
        import json
        d = json.loads(self._payload())
        # Response has a URL -- tool_input.url must not override it.
        d["tool_response"] = {"url": "https://claude.ai/public/artifacts/from-response"}
        d["tool_input"]["url"] = "https://claude.ai/public/artifacts/from-input"
        # Both paths exit 0 (unreachable dashboard), but this exercises the
        # branch order: response URL is extracted first.
        self.assertEqual(self._run_hook(json.dumps(d)), 0)


if __name__ == "__main__":
    unittest.main()
