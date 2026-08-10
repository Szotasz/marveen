"""Unit tests for _id_from_text and _extract_message_id in ledger-outbound.py.

Imported directly via importlib to keep the sys.path manipulation isolated.
"""
import importlib.util
import os
import sys
import pytest

_HOOK_PATH = os.path.join(os.path.dirname(__file__), "ledger-outbound.py")
spec = importlib.util.spec_from_file_location("ledger_outbound", _HOOK_PATH)
_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(_mod)

_id_from_text = _mod._id_from_text
_extract_message_id = _mod._extract_message_id


class TestIdFromText:
    def test_parenthesized_form(self):
        assert _id_from_text("sent (id: 3461)") == "3461"

    def test_parenthesized_form_no_space(self):
        assert _id_from_text("sent (id:3461)") == "3461"

    def test_parenthesized_form_case_insensitive(self):
        assert _id_from_text("Sent (ID: 99)") == "99"

    def test_word_boundary_fallback_colon(self):
        assert _id_from_text("id: 42") == "42"

    def test_word_boundary_fallback_space(self):
        assert _id_from_text("id 42") == "42"

    def test_no_false_positive_from_invalid_word(self):
        # "invalid" contains "id" but lacks a word boundary before the substring
        assert _id_from_text("invalid message") is None

    def test_no_false_positive_from_random_id_substring(self):
        # "middle" contains no "id" word
        assert _id_from_text("middle of nowhere") is None

    def test_returns_none_on_empty_string(self):
        assert _id_from_text("") is None

    def test_returns_none_on_no_numeric_id(self):
        assert _id_from_text("error: something went wrong") is None

    def test_parenthesized_wins_over_fallback(self):
        # Both patterns could match; parenthesized form is priority 1.
        result = _id_from_text("id: 10, sent (id: 20)")
        assert result == "20"


class TestExtractMessageId:
    def test_none_when_tool_response_missing(self):
        assert _extract_message_id({}) is None

    def test_none_when_tool_response_is_none(self):
        assert _extract_message_id({"tool_response": None}) is None

    def test_plain_text_response(self):
        # Current Telegram plugin format: plain string
        assert _extract_message_id({"tool_response": "sent (id: 3461)"}) == "3461"

    def test_content_block_list_text(self):
        payload = {"tool_response": [{"type": "text", "text": "sent (id: 999)"}]}
        assert _extract_message_id(payload) == "999"

    def test_content_block_list_content_key(self):
        payload = {"tool_response": [{"type": "text", "content": "sent (id: 777)"}]}
        assert _extract_message_id(payload) == "777"

    def test_direct_dict_message_id(self):
        payload = {"tool_response": {"message_id": 123, "chat_id": 456}}
        assert _extract_message_id(payload) == "123"

    def test_json_string_wrapping_dict(self):
        import json
        inner = json.dumps({"message_id": 55})
        payload = {"tool_response": inner}
        assert _extract_message_id(payload) == "55"

    def test_json_string_wrapping_list(self):
        import json
        inner = json.dumps([{"type": "text", "text": "sent (id: 88)"}])
        payload = {"tool_response": inner}
        assert _extract_message_id(payload) == "88"

    def test_advisory_fallback_on_network_error_shape(self):
        # Malformed / unexpected payload: must return None, not raise
        assert _extract_message_id({"tool_response": [None, 42, "garbage"]}) is None

    def test_old_wrong_key_tool_result_returns_none(self):
        # Before #936 the key was `tool_result` -- must not be picked up
        payload = {"tool_result": [{"type": "text", "text": "sent (id: 1)"}]}
        assert _extract_message_id(payload) is None

    def test_none_when_content_block_has_no_id(self):
        payload = {"tool_response": [{"type": "text", "text": "OK, message sent."}]}
        assert _extract_message_id(payload) is None
