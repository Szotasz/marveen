#!/usr/bin/env python3
"""PostToolUse hook (matcher: the Telegram reply tool): when the agent sends a
reply, flip the open ledger rows for that chat to answered=1. Deterministic.

The reply tool sometimes uses chat_id=0/empty as a shorthand for the main chat
(CLAUDE.md), but inbound is stored under the real chat id -- so 0/empty resolves
to the owner chat. Never blocks (exit 0).
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    tool = payload.get("tool_name") or ""
    # Double-check (the matcher should already filter): only the telegram reply.
    if "telegram" not in tool or "reply" not in tool:
        sys.exit(0)
    chat_id = (payload.get("tool_input") or {}).get("chat_id")
    chat_id = "" if chat_id is None else str(chat_id).strip()
    if chat_id in ("", "0"):
        chat_id = ledger_lib.owner_chat_id()
    if chat_id:
        try:
            ledger_lib.mark_answered(chat_id)
        except Exception:
            pass
    sys.exit(0)


if __name__ == "__main__":
    main()
