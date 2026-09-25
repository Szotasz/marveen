#!/usr/bin/env python3
"""Shared rule for the Telegram hooks: does an inbound message OWE a reply?

A DM always does. A GROUP message does not: in a shared company group the agents
are typically silent readers and only speak when addressed by name.

This exception used to live inside the reply guard and was lost in a rewrite
(8fa255c/29a1bd9). Nothing broke loudly, because the guard fails toward nagging:
every group message cost one extra blocked turn that the model then had to work
around. It lives in its own module now so the two hooks that need it -- the Stop
guard (telegram-reply-guard.py) and the prompt directive
(telegram-reply-directive.py) -- can never drift apart again.

Detection:
  - group  = Telegram gives groups/supergroups/channels a NEGATIVE chat_id; DMs
             are positive. No config lookup needed, so it works identically for
             every agent and for a group nobody has configured yet.
  - mention = the agent's own id appears as a word, with or without a leading @
             ("@marveen", "Marveen, ...", "marveent"). Extra names
             (a bot username that differs from the agent id) can be added via
             TG_MENTION_NAMES, comma-separated.

Deliberately fails TOWARD a reply: an unclear match counts as a mention. The
cost of a false mention is one needless nag; the cost of a false silence is the
owner addressing the agent in the group and getting nothing back.
"""
import os
import re


def is_group_chat(chat_id):
    """True for a Telegram group/supergroup/channel (negative id)."""
    return str(chat_id or "").strip().startswith("-")


def _mention_names(agent_id):
    names = [str(agent_id or "").strip()]
    names += [n.strip() for n in os.environ.get("TG_MENTION_NAMES", "").split(",")]
    return [n for n in names if n]


def mentions_agent(text, agent_id):
    """True if `text` addresses this agent by name (@-tag optional)."""
    t = str(text or "")
    for name in _mention_names(agent_id):
        # \w* tail so Hungarian suffixes and "<name>bot" still count.
        if re.search(r"(?<![\w@])@?" + re.escape(name) + r"\w*", t, re.IGNORECASE):
            return True
    return False


def reply_owed(chat_id, text, agent_id):
    """Does this inbound message require an outbound reply on the channel?"""
    if not is_group_chat(chat_id):
        return True
    return mentions_agent(text, agent_id)
