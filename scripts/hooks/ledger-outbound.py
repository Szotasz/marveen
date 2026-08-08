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
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def _owner_chat():
    v = os.environ.get("LEDGER_OWNER_CHAT") or os.environ.get("ALLOWED_CHAT_ID")
    return v.strip() if v else ""


def _id_from_text(text):
    """Extract a numeric id from a plain-text string, or return None.

    Two patterns in priority order:
    1. Parenthesized exact form: "sent (id: 3461)" -> "3461"
       Matches the current Telegram plugin response format.
    2. Word-boundary fallback: matches "id: 42" or "id 42" but not
       "invalid 42" (the word boundary \b prevents partial-word hits
       that would produce false positives from error messages).
    """
    # Exact parenthesized form first.
    m = re.search(r"\(id:\s*(\d+)\)", text, re.IGNORECASE)
    if m:
        return str(m.group(1))
    # Word-boundary fallback for looser formats.
    m = re.search(r"\bid[:\s]+(\d+)", text, re.IGNORECASE)
    return str(m.group(1)) if m else None


def _extract_message_id(payload):
    """Extract the Telegram message_id from the tool response, or return None.

    The hook payload key is `tool_response` (not `tool_result`).
    The MCP plugin returns a content-block list:
      [{"type": "text", "text": "sent (id: 3461)"}]
    The text is NOT JSON -- it is a plain sentence. We first try json.loads
    in case the format ever changes, then fall back to a regex.
    Falls back to None on any parse error so the caller is never blocked.
    """
    result = payload.get("tool_response")
    if result is None:
        return None

    # Unwrap a JSON string at the top level.
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except Exception:
            # Plain string -- try regex directly.
            return _id_from_text(result)

    # Direct dict: {"message_id": 123, ...}
    if isinstance(result, dict):
        mid = result.get("message_id")
        if mid is not None:
            return str(mid)

    # Content-block list: [{"type": "text", "text": "sent (id: 3461)"}]
    if isinstance(result, list):
        for block in result:
            if not isinstance(block, dict):
                continue
            text = block.get("text") or block.get("content") or ""
            if not isinstance(text, str):
                continue
            # Try JSON first (future-proof), then regex for the current format.
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    mid = parsed.get("message_id")
                    if mid is not None:
                        return str(mid)
            except Exception:
                pass
            mid = _id_from_text(text)
            if mid is not None:
                return mid

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
