#!/usr/bin/env python3
"""UserPromptSubmit hook: inject a reply-tool directive whenever an inbound
Telegram TEXT message arrives.

This is the salience half of the Telegram-reply enforcement (the Stop hook
telegram-reply-guard.py is the guarantee half). It mirrors the existing
voice-reply-directive.py -- voice messages already got a hook-injected directive,
plain text messages did not. Injecting the reminder at the TOP of the turn means
the model rarely reaches the Stop-hook block at all.

Claude Code injects a UserPromptSubmit hook's stdout directly into the model
prompt (plain text, no JSON wrapper). This hook is silent for any prompt that
does not carry a Telegram channel tag, so it never disturbs non-channel turns
(e.g. scheduled heartbeats). Never blocks: any error -> silent exit(0).
"""
import sys
import os
import json
import re

CHANNEL_RX = re.compile(
    r'<channel\s+source="plugin:telegram:telegram"([^>]*)>',
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
    m = CHANNEL_RX.search(prompt)
    if not m:
        sys.exit(0)  # not a Telegram message -> stay silent
    chat_id = _attr(m.group(1), "chat_id") or "<a bejövő chat_id>"
    sys.stdout.write(
        f"[TELEGRAM-DIREKTÍVA] Ez az üzenet a Telegram csatornáról érkezett "
        f"(chat_id={chat_id}). A válaszod KÖTELEZŐEN a "
        f"mcp__plugin_telegram_telegram__reply toolon keresztül menjen ki "
        f"(chat_id={chat_id}) -- a sima assistant-szöveg NEM jut el hozzá, csak a "
        f"tmux-ba. Ha csak nyugtázás kell (ok/köszi), akkor sem baj, de érdemi "
        f"választ MINDIG a reply toollal küldj.\n"
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
