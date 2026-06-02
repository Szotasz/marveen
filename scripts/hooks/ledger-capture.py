#!/usr/bin/env python3
"""UserPromptSubmit hook: capture inbound Telegram messages into the ledger
(answered=0) BEFORE the agent processes the prompt. Deterministic and
agent-independent -- the continuity does not depend on the LLM remembering to do
anything. Never blocks the prompt (always exit 0), even on errors.
"""
import sys
import os
import json
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# <channel source="plugin:telegram:telegram" chat_id="X" message_id="Y" ... ts="Z">
#   TEXT
# </channel>
CHANNEL_RX = re.compile(
    r'<channel\s+source="plugin:telegram:telegram"([^>]*)>(.*?)</channel>',
    re.DOTALL,
)


def _attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    prompt = payload.get("prompt") or ""
    for m in CHANNEL_RX.finditer(prompt):
        attrs, text = m.group(1), m.group(2)
        chat_id = _attr(attrs, "chat_id")
        message_id = _attr(attrs, "message_id")
        ts = _attr(attrs, "ts")
        if chat_id and message_id:
            try:
                ledger_lib.upsert_inbound(chat_id, message_id, text.strip(), ts)
            except Exception:
                pass  # never block the prompt on a ledger error
    sys.exit(0)


if __name__ == "__main__":
    main()
