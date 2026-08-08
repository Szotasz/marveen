#!/usr/bin/env python3
"""PostToolUse hook (matcher: the Telegram reply tool): record the OUTBOUND reply
text into the rolling transcript (direction='out'). This both (a) gives the
SessionStart replay full conversation context and (b) closes the open question
(an inbound with a later outbound is considered answered). Deterministic.

agent_id is derived from the session's cwd (generic across the three agents). The
reply tool sometimes uses chat_id=0/empty as a shorthand for the main chat
(CLAUDE.md), resolved to the agent's owner chat. Never blocks (exit 0).
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def _owner_chat():
    v = os.environ.get("LEDGER_OWNER_CHAT") or os.environ.get("ALLOWED_CHAT_ID")
    return v.strip() if v else ""


def _extract_message_id(payload):
    """Extract the Telegram message_id from the tool result, or return None.

    The MCP plugin may return the result in several shapes:
      - dict directly: {"message_id": 123, "ok": true}
      - list of content blocks: [{"type": "text", "text": "{\"message_id\": 123}"}]
      - JSON string encoding either of the above

    We try the most common paths and fall back to None so a missing or
    unexpected result format never prevents the outbound from being logged.
    """
    result = payload.get("tool_result")
    if result is None:
        return None

    # Unwrap a JSON string at the top level.
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except Exception:
            return None

    # Direct dict: {"message_id": 123, ...}
    if isinstance(result, dict):
        mid = result.get("message_id")
        if mid is not None:
            return str(mid)

    # MCP content-block list: [{"type": "text", "text": "<json>"}]
    if isinstance(result, list):
        for block in result:
            if not isinstance(block, dict):
                continue
            text = block.get("text") or block.get("content") or ""
            if not isinstance(text, str):
                continue
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    mid = parsed.get("message_id")
                    if mid is not None:
                        return str(mid)
            except Exception:
                continue

    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    tool = payload.get("tool_name") or ""
    # Double-check (the matcher should already filter): only the telegram reply.
    if "telegram" not in tool or "reply" not in tool:
        sys.exit(0)
    agent_id = ledger_lib.agent_id_from_cwd(payload.get("cwd"))
    tool_input = payload.get("tool_input") or {}
    chat_id = tool_input.get("chat_id")
    chat_id = "" if chat_id is None else str(chat_id).strip()
    if chat_id in ("", "0"):
        chat_id = _owner_chat()
    text = tool_input.get("text")
    message_id = _extract_message_id(payload)
    if chat_id and text is not None:
        try:
            ledger_lib.log_outbound(agent_id, chat_id, str(text), message_id)
        except Exception:
            pass
    sys.exit(0)


if __name__ == "__main__":
    main()
