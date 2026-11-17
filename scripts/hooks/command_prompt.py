"""Is this UserPromptSubmit prompt an owner slash command from Telegram (or a Discord slash command)?

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
DISCORD_SOURCE_RX = re.compile(r'\bsource="[^"]*discord[^"]*"', re.IGNORECASE)


def attr(attrs, name):
    m = re.search(r'\b' + name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


# The attributes the Discord overlay puts on a slash command, and nothing else (the source is added by the host).
# Any other key (reply_to_text, attachments...) means it is not one: user-written text in an attribute value must
# not be able to look like slash="1".
DISCORD_SLASH_KEYS = frozenset({"source", "chat_id", "message_id", "user", "user_id", "ts", "slash"})
ATTR_PAIR_RX = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"')
ATTRS_FULL_RX = re.compile(r'\s*(?:[A-Za-z_][A-Za-z0-9_]*="[^"]*"\s*)*')


def discord_slash(attrs):
    if not ATTRS_FULL_RX.fullmatch(attrs):
        return False
    pairs = ATTR_PAIR_RX.findall(attrs)
    keys = [k for k, _ in pairs]
    return len(keys) == len(set(keys)) and set(keys) <= DISCORD_SLASH_KEYS and dict(pairs).get("slash") == "1"


def provider(attrs):
    """'telegram' or 'discord': which channel the block came from (command_block accepted it)."""
    return "discord" if DISCORD_SOURCE_RX.search(attrs) and not TELEGRAM_SOURCE_RX.search(attrs) else "telegram"


def command_block(prompt):
    """(attrs, body) when the prompt is exactly one Telegram <channel> block
    whose body is a single-line /word command with a chat_id; else None.
    DCEXT1111 F1s: a Discord block counts only with slash="1", which the
    Discord overlay sets on a real slash command (an interaction, only from
    the owner's DM). A typed "/status" in Discord stays an ordinary message."""
    matches = list(CHANNEL_RX.finditer(prompt or ""))
    if len(matches) != 1:
        return None
    attrs, body = matches[0].group(1), matches[0].group(2).strip()
    if not COMMAND_RX.match(body) or "\n" in body:
        return None
    if not TELEGRAM_SOURCE_RX.search(attrs):
        if not (DISCORD_SOURCE_RX.search(attrs) and discord_slash(attrs)):
            return None
    if not attr(attrs, "chat_id"):
        return None
    return attrs, body
