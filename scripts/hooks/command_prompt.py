"""Is this UserPromptSubmit prompt an owner slash command from Telegram?

One definition for every hook that must agree on it. marveen-commands.py
blocks such a prompt (exit 2) when the dashboard answers it, so the model
never sees that turn. The hooks running ALONGSIDE it must not consume state
into it: inbox-drain.py marked an inter-agent message "delivered" and printed
it into a prompt the command hook then blocked, and the message was gone
(measured on the test bot, 2026-09-23: a custom /osszefoglalo prompt, agent
message #10, never reached the model). A drain skips these prompts; the next
prompt, or the inbox nudge watcher, delivers.
"""
import re

CHANNEL_RX = re.compile(r'<channel\s+([^>]*)>(.*?)</channel>', re.DOTALL)
COMMAND_RX = re.compile(r'^/([A-Za-z][A-Za-z0-9_]{0,31})(?:@[A-Za-z0-9_]+)?(?:\s|$)')
TELEGRAM_SOURCE_RX = re.compile(r'\bsource="[^"]*telegram[^"]*"', re.IGNORECASE)


def attr(attrs, name):
    m = re.search(r'\b' + name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def command_block(prompt):
    """(attrs, body) when the prompt is exactly one Telegram <channel> block
    whose body is a single-line /word command with a chat_id; else None."""
    matches = list(CHANNEL_RX.finditer(prompt or ""))
    if len(matches) != 1:
        return None
    attrs, body = matches[0].group(1), matches[0].group(2).strip()
    if not COMMAND_RX.match(body) or "\n" in body:
        return None
    if not TELEGRAM_SOURCE_RX.search(attrs):
        return None
    if not attr(attrs, "chat_id"):
        return None
    return attrs, body
