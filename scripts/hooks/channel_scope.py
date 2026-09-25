#!/usr/bin/env python3
"""Shared rule for the Telegram hooks: does an inbound message OWE a reply?

A DM always does. A GROUP message does not: in a shared company group the agents
are typically silent readers and only speak when addressed.

This exception used to live inside the reply guard and was lost in a rewrite
(8fa255c/29a1bd9). Nothing broke loudly, because the guard fails toward nagging:
every group message cost one extra blocked turn that the model then had to work
around. It lives in its own module now so the hooks that need it -- the Stop
guard (telegram-reply-guard.py), the prompt directive
(telegram-reply-directive.py), the live drain and the replay -- can never drift
apart again. src/reply-owed.ts is its TypeScript twin; the two MUST agree.

Detection:
  - group   = Telegram gives groups/supergroups/channels a NEGATIVE chat_id; DMs
              are positive. No config lookup needed, so it works identically for
              every agent and for a group nobody has configured yet.
  - addressed = either
      a) a reply (Telegram quote-reply) to one of the agent's own messages --
         the caller resolves that against the ledger and passes
         replies_to_agent; or
      b) one of the agent's NAME FORMS appears in the text. Matching is
         accent-folded (NFD, combining marks dropped, lower-cased) and
         inflection-tolerant:
           - "@<form>" followed by anything ("@name", "@name_helper_bot");
           - "<form>" as the start of a word followed by at most
             MAX_SUFFIX more letters, which covers Hungarian case endings and
             linking letters ("Zárát" -> zara+t, "Írisz" -> iris+z,
             "Írisszel" -> iris+szel).
         Name forms are: the agent id; the agent's `displayName` and the
         optional `mentionNames` list in agents/<id>/agent-config.json; and
         TG_MENTION_NAMES (comma-separated, env) for a bot username or a
         spoken form that differs from all of those.

Deliberately fails TOWARD a reply: an unclear match counts as a mention. The
cost of a false mention is one needless nag; the cost of a false silence is the
owner addressing the agent in the group and getting a "do not post" instruction
instead. That is why the suffix window is generous and an @-tag takes any tail.
"""
import json
import os
import re
import unicodedata

# Letters allowed after a bare name form. Hungarian stacks case endings on a
# stem ("-nak", "-nál", "-tól", "-val", "-ként"), sometimes after a linking
# consonant ("Írisz", "Írisszel"); 5 covers those without letting a short name
# swallow unrelated long words.
MAX_SUFFIX = 5


def is_group_chat(chat_id):
    """True for a Telegram group/supergroup/channel (negative id)."""
    return str(chat_id or "").strip().startswith("-")


def fold(text):
    """Accent- and case-insensitive form: NFD, combining marks dropped, lower."""
    decomposed = unicodedata.normalize("NFD", str(text or ""))
    return "".join(c for c in decomposed
                   if not unicodedata.category(c).startswith("M")).lower()


def _agents_dir():
    # Test override; otherwise <install>/agents, resolved from this file.
    override = os.environ.get("CHANNEL_SCOPE_AGENTS_DIR")
    if override:
        return override
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(os.path.dirname(os.path.dirname(here)), "agents")


def _configured_names(agent_id):
    """displayName + mentionNames from agents/<id>/agent-config.json, if any."""
    aid = str(agent_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", aid) or aid in (".", ".."):
        return []
    try:
        with open(os.path.join(_agents_dir(), aid, "agent-config.json"),
                  encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return []
    if not isinstance(cfg, dict):
        return []
    names = []
    if isinstance(cfg.get("displayName"), str):
        names.append(cfg["displayName"])
    extra = cfg.get("mentionNames")
    if isinstance(extra, list):
        names += [n for n in extra if isinstance(n, str)]
    return names


def mention_names(agent_id):
    """Every name form this agent answers to, folded and de-duplicated."""
    names = [str(agent_id or "")]
    names += _configured_names(agent_id)
    names += os.environ.get("TG_MENTION_NAMES", "").split(",")
    out = []
    for n in names:
        f = fold(n).strip().lstrip("@")
        if f and f not in out:
            out.append(f)
    return out


def _form_rx(form):
    # A multi-word form ("Front Desk") matches across any whitespace run.
    body = r"\s+".join(re.escape(p) for p in form.split())
    return re.compile(
        r"@" + body + r"\w*"
        r"|(?<![\w@])" + body + r"\w{0,%d}(?!\w)" % MAX_SUFFIX
    )


def mentions_agent(text, agent_id, names=None):
    """True if `text` addresses this agent by one of its name forms."""
    t = fold(text)
    for form in (names if names is not None else mention_names(agent_id)):
        if _form_rx(form).search(t):
            return True
    return False


def reply_owed(chat_id, text, agent_id, replies_to_agent=False, names=None):
    """Does this inbound message require an outbound reply on the channel?

    replies_to_agent: True (or a zero-arg callable returning it) when the
    message is a Telegram reply to one of this agent's own messages. The
    callable form is evaluated only for a group message without a name, so a
    DM never pays for the ledger lookup.
    """
    if not is_group_chat(chat_id):
        return True
    if mentions_agent(text, agent_id, names):
        return True
    if callable(replies_to_agent):
        try:
            replies_to_agent = replies_to_agent()
        except Exception:
            # Cannot tell -> unclear -> counts as addressed.
            replies_to_agent = True
    return bool(replies_to_agent)
