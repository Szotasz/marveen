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
    if chat_id and text is not None:
        try:
            ledger_lib.log_outbound(agent_id, chat_id, str(text))
        except Exception:
            pass
    sys.exit(0)


if __name__ == "__main__":
    main()
