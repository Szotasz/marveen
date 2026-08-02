#!/usr/bin/env python3
"""UserPromptSubmit hook: Telegram receipt acknowledgement (👍).

When an inbound Telegram message arrives, the sender gets an immediate 👍
reaction confirming the agent received it -- BEFORE the model even processes
the turn. This runs as a hook (harness-executed), so it is:
  - reliable (fires on every prompt submit, not model-dependent),
  - token-free (pure Bot API call, no Claude turn),
  - fleet-wide (lives in ~/.claude/settings.json; each agent reads its OWN
    channel bot token, so every agent acks on its own bot).

Mechanism: parse each <channel source="...telegram..." chat_id="X" message_id="Y">
tag from the submitted prompt and POST setMessageReaction 👍 to the Bot API.
Dedups on chat_id:message_id so the same message is never re-acked (e.g. if the
same prompt is re-submitted after a restart/backfill).

NEVER blocks the prompt (always exit 0) and stays silent. Best-effort: any failure
(no token, network error, non-telegram channel) is swallowed.
"""
import sys
import os
import re
import json
import urllib.request

CHANNEL_RX = re.compile(r'<channel\s+([^>]*)>', re.DOTALL)
ATTR_RX = re.compile(r'(\w+)="([^"]*)"')
STATE_FILE = os.path.expanduser("~/.claude/.telegram-ack-state")
MAX_STATE = 500  # keep the last N acked keys, bounded
TOKEN_ENV = os.path.expanduser("~/.claude/channels/telegram/.env")
TOKEN_RX = re.compile(r'[0-9]+:[A-Za-z0-9_-]+')


def load_state():
    try:
        with open(STATE_FILE) as f:
            return [ln.strip() for ln in f if ln.strip()]
    except OSError:
        return []


def save_state(keys):
    keys = keys[-MAX_STATE:]
    try:
        with open(STATE_FILE, "w") as f:
            f.write("\n".join(keys) + "\n")
    except OSError:
        pass


def bot_token():
    try:
        with open(TOKEN_ENV) as f:
            m = TOKEN_RX.search(f.read())
            return m.group(0) if m else None
    except OSError:
        return None


def react(token, chat_id, message_id):
    url = f"https://api.telegram.org/bot{token}/setMessageReaction"
    body = json.dumps({
        "chat_id": chat_id,
        "message_id": int(message_id),
        "reaction": [{"type": "emoji", "emoji": "\U0001F44D"}],
    }).encode()
    req = urllib.request.Request(url, data=body,
                                headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=8).read()
    except Exception:
        pass  # best-effort; never surface


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    prompt = payload.get("prompt") or ""
    if "telegram" not in prompt:
        return
    token = bot_token()
    if not token:
        return
    state = load_state()
    seen = set(state)
    changed = False
    for attrs_str in CHANNEL_RX.findall(prompt):
        attrs = dict(ATTR_RX.findall(attrs_str))
        src = attrs.get("source", "")
        if "telegram" not in src:
            continue
        chat_id = attrs.get("chat_id", "")
        message_id = attrs.get("message_id", "")
        if not chat_id or not message_id or not message_id.isdigit():
            continue
        key = f"{chat_id}:{message_id}"
        if key in seen:
            continue
        react(token, chat_id, message_id)
        state.append(key)
        seen.add(key)
        changed = True
    if changed:
        save_state(state)


if __name__ == "__main__":
    main()
