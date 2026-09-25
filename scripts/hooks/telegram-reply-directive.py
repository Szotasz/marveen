#!/usr/bin/env python3
"""UserPromptSubmit hook: inject a reply-tool directive whenever an inbound
Telegram TEXT message arrives.

This is the salience half of the Telegram-reply enforcement (the Stop hook
telegram-reply-guard.py is the guarantee half). It mirrors the existing
voice-reply-directive.py -- voice messages already got a hook-injected directive,
plain text messages did not. Injecting the reminder at the TOP of the turn means
the model rarely reaches the Stop-hook block at all.

A GROUP message that does not address the agent by name gets the OPPOSITE
directive: there the standing rule is silent reading, so pushing a reply would
demand exactly the post that rule forbids. The group/mention test is shared with
the Stop guard (channel_scope.reply_owed) so the two can never disagree.

Claude Code injects a UserPromptSubmit hook's stdout directly into the model
prompt (plain text, no JSON wrapper). This hook is silent for any prompt that
does not carry a Telegram channel tag, so it never disturbs non-channel turns
(e.g. scheduled heartbeats). Never blocks: any error -> silent exit(0).
"""
import sys
import os
import json
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402
import channel_scope  # noqa: E402

CHANNEL_RX = re.compile(
    r'<channel\s+source="plugin:telegram:telegram"([^>]*)>(.*?)</channel>',
    re.DOTALL,
)
OPEN_TAG_RX = re.compile(r'<channel\s+source="plugin:telegram:telegram"([^>]*)>')


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
    text = m.group(2) if m else ""
    if not m:
        # Fall back to the attrs-only form: a wrapper without its closing tag is
        # still a Telegram message and still owes the DM directive.
        m = OPEN_TAG_RX.search(prompt)
    if not m:
        sys.exit(0)  # not a Telegram message -> stay silent
    attrs = m.group(1)
    chat_id = _attr(attrs, "chat_id") or "<a bejövő chat_id>"
    agent_id = ledger_lib.agent_id_from_payload(payload)
    # A Telegram quote-reply carries reply_to_message_id; a reply to one of the
    # agent's own (ledgered) messages addresses it even without a name.
    reply_to = _attr(attrs, "reply_to_message_id")

    # Group message that does not address this agent -> the correct behaviour is
    # silent reading, so the directive must NOT push a reply into the group.
    if not channel_scope.reply_owed(
            chat_id, text, agent_id,
            replies_to_agent=lambda: ledger_lib.replies_to_own(agent_id, chat_id, reply_to)):
        sys.stdout.write(
            f"[TELEGRAM-CSOPORT] Ez az üzenet egy Telegram CSOPORTBÓL érkezett "
            f"(chat_id={chat_id}), és NEM szólít meg névvel. A helyes viselkedés a "
            f"csendes olvasás: NE posztolj a csoportba. Ha az üzenet nyomán teendő "
            f"van, azt a gazda DM-jében intézd, vagy jegyezd fel.\n"
        )
        sys.exit(0)

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
