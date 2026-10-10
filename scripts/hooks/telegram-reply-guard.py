#!/usr/bin/env python3
"""Stop hook: ENFORCE that an inbound Telegram message is answered through the
reply tool before the turn ends.

Root cause this fixes: the "always reply on Telegram, never as plain tmux text"
rule lived only as passive context (CLAUDE.md + memory). Nothing MECHANICALLY
enforced it, so it recurred whenever the model's attention lapsed (classically
during long runs of plain-text heartbeat turns). This hook moves the rule from
"documented" to "enforced": the harness runs it on every Stop and blocks the
turn from ending while an inbound Telegram message is still unanswered.

How it decides (all data comes from the existing conversation_log ledger, so this
hook adds NO new state model -- it reuses ledger_lib.open_question_with_age):
  - open_question_with_age(agent_id) returns the most recent inbound that has NO
    later outbound (i.e. an unanswered message). ledger-outbound.py logs an
    'out' row on every reply-tool call, so a reply flips this to None.
  - If there is no open question -> allow the stop (exit 0, silent).
  - If the open inbound is a pure acknowledgement ("ok", "köszi", 👍, ...) -> allow;
    per the standing rule a bare ack needs no reply.
  - If the open inbound is older than STALE_SECONDS -> allow; never nag forever on
    an abandoned/old message (prevents an endless block loop).
  - If this same message_id has already been blocked MAX_BLOCKS times -> allow;
    a hard backstop so a wedged model can never be trapped in an infinite loop.
  - Otherwise -> BLOCK with a directive telling the model to send the reply via
    the reply tool OF THE CHANNEL THE MESSAGE CAME FROM, with chat_id=...

PROVIDER-AWARENESS (PROVIDERVAK908): this hook used to name
mcp__plugin_telegram_telegram__reply unconditionally, because the ledger recorded
WHAT arrived but not WHERE FROM. Measured 2026-09-07 it demanded a TELEGRAM reply
for an inbound that came from the owner's DISCORD DM.
The block itself was right -- an unanswered inbound IS owed a reply -- but the
directive named a tool that cannot deliver it. The ledger now stores the envelope
source, and the directive is derived from it.

WHEN THE SOURCE DOES NOT NAME A TOOL (rows written before the column existed have
source NULL; a source with a dash, like Slack's plugin:slack-channel:slack, does
not map to a tool name character for character): the directive falls back to the
CONFIGURED channel of this install (CHANNEL_PROVIDER, #1606, _reply_tool_name),
which names a VERIFIED tool from _REPLY_TOOLS. Only when that names no verified
tool either does it use provider-agnostic wording. A source that names a DIFFERENT
provider than the configured one never borrows the configured tool: that would be
the wrong tool, which is exactly the failure being fixed (_directive_target).

Safety: any error -> allow the stop (exit 0). A guard hook must never wedge the
session. agent_id is derived from the session cwd, so it is generic across all
channel agents and never cross-contaminates.
"""
import sys
import os
import time
import json
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def _quiet_defect(msg):
    """The ABSENCE of the quiet-hours brake must not be silent. This never stops the guard
    (a Stop hook must not break over a config), but it leaves a trace: stderr + a log file
    next to the channel state, so the next person can see the brake was not in effect."""
    line = "[reply-guard] QUIET-HOURS DEFECT: " + str(msg)
    try:
        sys.stderr.write(line + "\n")
    except Exception:
        pass
    try:
        sd = os.environ.get("TELEGRAM_STATE_DIR") or os.path.join(
            os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd(), ".claude", "channels", "telegram")
        os.makedirs(sd, exist_ok=True)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())   # `time` mar importalva; a `datetime` NEM
        with open(os.path.join(sd, "quiet-hours-defect.log"), "a", encoding="utf-8") as f:
            f.write(stamp + " " + line + "\n")
    except Exception:
        pass


def _quiet_note(msg):
    """A NORMAL state worth one line (quiet hours not configured): the same log file as the defects, but
    no DEFECT label and nothing on stderr. The module gives the line only once per state dir."""
    try:
        sd = os.environ.get("TELEGRAM_STATE_DIR") or os.path.join(
            os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd(), ".claude", "channels", "telegram")
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with open(os.path.join(sd, "quiet-hours-defect.log"), "a", encoding="utf-8") as f:
            f.write(stamp + " [reply-guard] " + str(msg) + "\n")
    except Exception:
        pass

import ledger_lib  # noqa: E402

# Tunables (overridable via env for tests / ops).
STALE_SECONDS = int(os.environ.get("TG_GUARD_STALE_SECONDS", "1800"))  # 30 min
MAX_BLOCKS = int(os.environ.get("TG_GUARD_MAX_BLOCKS", "3"))

# Pure acknowledgements that do NOT require a reply (standing rule #9). Kept
# deliberately conservative so a short real question is never swallowed.
_ACK_WORDS = (
    "ok", "oke", "okk", "okés", "okes", "rendben", "rdb", "köszi", "koszi",
    "kösz", "kosz", "köszönöm", "koszonom", "thx", "thanks", "ty", "thank you",
    "szuper", "super", "remek", "tökéletes", "tokeletes", "jó", "jo", "oksa",
)
_EMOJI_ACK = ("👍", "🙏", "👌", "❤️", "👏", "🎉", "✅", "🆗", "+1")


def _is_ack(text):
    raw = (text or "").strip()
    if not raw:
        # An empty/attachment-only inbound (e.g. a bare photo) is not a question
        # this guard should block on; the agent handles media on its own terms.
        return True
    # Strip emoji-ack glyphs and punctuation, then require EVERY remaining word to
    # be an acknowledgement word. This catches "köszi 👍", "ok köszi", "👍", etc.,
    # while still treating "ok de miért?" (a real question) as non-ack.
    t = raw.lower()
    for e in _EMOJI_ACK:
        t = t.replace(e, " ")
    for ch in ".!?…,":
        t = t.replace(ch, " ")
    tokens = t.split()
    if not tokens:
        return True  # emoji-only acknowledgement
    return all(tok in _ACK_WORDS for tok in tokens)


_CHANNEL_PROVIDERS = ("telegram", "discord", "slack", "googlechat", "teams")

# A plugin key can be named for the provider without matching the MCP tool
# prefix, so the provider name is what CHANNEL_PROVIDER states, not what a key
# happens to spell.
_PROVIDER_ALIASES = {"slack-channel": "slack"}

# The reply tool's name is NOT f"mcp__plugin_{provider}_{provider}__reply": it is
# mcp__plugin_<plugin directory>_<MCP server>__reply, and the two halves differ
# per provider. Slack is the case that proves it -- the plugin checks in under
# `slack-channel` while its MCP server is `slack`, so the tool is
# mcp__plugin_slack-channel_slack__reply, the spelling the rest of the repo uses.
# Only names verified against a source are listed here: telegram and discord from
# their installed plugins' .mcp.json, slack from this repo's own usages. A
# provider missing from the table falls through to the generic wording below
# rather than to an invented name -- the same principle this guard already
# applies to an unknown provider, and the reason it exists at all.
_REPLY_TOOLS = {
    "telegram": "mcp__plugin_telegram_telegram__reply",
    "discord": "mcp__plugin_discord_discord__reply",
    "slack": "mcp__plugin_slack-channel_slack__reply",
}


def _channel_provider():
    """Which channel this install actually speaks on.

    CHANNEL_PROVIDER in the env, then the install-dir .env -- the same resolution
    order ledger_lib.main_agent_id()/owner_name() already use, and the only source
    that is right regardless of how the plugins got enabled.

    Only if that is missing do we fall back to enabledPlugins. That fallback reads
    the PROJECT settings file, because this fleet runs with an isolated
    CLAUDE_CONFIG_DIR: ~/.claude/settings.json is NOT the active user settings
    here, and reading it was wrong even when it happened to agree. The fallback is
    also order-dependent (a settings file listing telegram before discord picks
    telegram), which is exactly why .env wins.
    """
    v = os.environ.get("CHANNEL_PROVIDER")
    if v and v.strip():
        return v.strip().lower()
    try:
        with open(os.path.join(ledger_lib._install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("CHANNEL_PROVIDER="):
                    name = line.split("=", 1)[1].strip()
                    if name:
                        return name.lower()
    except Exception:
        pass
    try:
        import json as _json
        base = os.environ.get("CLAUDE_PROJECT_DIR") or ledger_lib._install_dir()
        with open(os.path.join(base, ".claude", "settings.json")) as f:
            enabled = _json.load(f).get("enabledPlugins") or {}
        for key, on in enabled.items():
            if not on:
                continue
            name = str(key).split("@", 1)[0].strip().lower()
            name = _PROVIDER_ALIASES.get(name, name)
            if name in _CHANNEL_PROVIDERS:
                return name
    except Exception:
        pass
    return ""


def _reply_tool_name():
    """Name the reply tool of the channel plugin THIS install actually speaks on.

    The guard used to hardcode the Telegram tool name. On a Discord-only install
    that directive named a tool that does not exist in the session, so the model
    could not comply and the guard blocked on a message it had in fact answered.
    """
    provider = _channel_provider()
    tool = _REPLY_TOOLS.get(provider)
    if tool:
        return tool, provider
    # Unknown provider, or one whose real tool name we cannot verify: name no
    # specific tool rather than a wrong one. A wrong name is worse than none,
    # because the model cannot comply with a directive naming a tool that is not
    # in its session -- which is the bug this guard was written to remove.
    return "a csatorna reply tool", provider or "csatorna"


_SOURCE_RX = re.compile(r"^plugin:([A-Za-z0-9_]+):([A-Za-z0-9_]+)$")


def _reply_target(source):
    """(channel_label, reply_tool_name) for an envelope source, or (None, None).

    Only a source whose segments are plain [A-Za-z0-9_] yields a tool name: the
    MCP tool id is mcp__plugin_<provider>_<server>__reply, and a segment with a
    dot or a dash does not map to it character-for-character. In that case the
    caller falls back to provider-agnostic wording -- an invented tool name is
    worse than no tool name, because the model would call it and fail.
    """
    m = _SOURCE_RX.match(source or "")
    if not m:
        return (None, None)
    provider, server = m.group(1), m.group(2)
    return (provider, "mcp__plugin_{}_{}__reply".format(provider, server))


def _directive_target(source):
    """(channel_label, reply_tool) the block directive names, or (None, None).

    Order (Marveen 32905): the message's own source first (_reply_target); when it
    names no tool, the install's configured channel (_reply_tool_name, verified
    table) -- for a NULL source unconditionally, for an unmappable source only if
    it is the same provider; otherwise nothing, and the caller uses agnostic wording.
    """
    label, tool = _reply_target(source)
    if tool:
        return label, tool
    configured_tool, configured = _reply_tool_name()
    if configured_tool not in _REPLY_TOOLS.values():
        return (None, None)
    if not source:
        return configured, configured_tool
    m = re.match(r"^plugin:([^:]+):", source)
    src = m.group(1).strip().lower() if m else ""
    if _PROVIDER_ALIASES.get(src, src) == configured:
        return configured, configured_tool
    return (None, None)


def _statefile(agent_id):
    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in str(agent_id))
    return os.path.join(os.path.dirname(ledger_lib.db_path()), f".tg-reply-guard-{safe}")


def _block_count(path, message_id):
    """How many times this exact message_id has already been blocked."""
    try:
        with open(path) as f:
            mid, n = f.read().strip().split("\t", 1)
        return int(n) if mid == str(message_id) else 0
    except Exception:
        return 0


def _record_block(path, message_id, count):
    try:
        with open(path, "w") as f:
            f.write(f"{message_id}\t{count}")
    except Exception:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    agent_id = ledger_lib.agent_id_from_payload(payload)

    try:
        oq = ledger_lib.open_question_with_age(agent_id)
    except Exception:
        sys.exit(0)  # ledger unavailable -> never wedge the stop
    if not oq:
        sys.exit(0)  # nothing open, or already answered by a reply-tool call

    # open_question_with_age() also returns the inbound's attachment columns.
    # Take only the prefix this hook needs, so the unpack cannot raise (it sits
    # outside the try above, so a mismatch would kill the hook and the harness
    # would read the empty stdout as "allow" -- the guard would never block).
    chat_id, message_id, text, ts, created_at = oq[:5]

    # Pure acknowledgement -> no reply owed.
    if _is_ack(text):
        sys.exit(0)

    # Quiet hours (card 30d968cd; restored 2026-09-22 21:2xZ after the fix was
    # overwritten): inside the chat's window never block, and do not count the
    # stop. A message that ARRIVED in a window ages from the window END, so it is
    # still enforced after the window closes instead of going stale overnight.
    anchor = created_at
    # The module ships in THIS script's directory (line 37 already put it on sys.path).
    # It used to be imported from ~/.claude/hooks -- an un-versioned directory that an
    # installer overwrote on 2026-09-12 (card e6680b3c). A hook must not depend on a file
    # that ships outside the repo: such a dependency has no test, no review and no history.
    _sd = os.environ.get("TELEGRAM_STATE_DIR") or os.path.join(
        os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd(), ".claude", "channels", "telegram")
    _q = None
    try:
        import telegram_quiet_hours as _q
    except ImportError as e:
        # A MISSING MODULE IS A DEPLOYMENT DEFECT, NOT A RUNTIME HICCUP. Swallowing it is how
        # the 09-12 regression stayed invisible for ten days: the guard kept running with no
        # quiet-hours protection and nothing, anywhere, said it was gone.
        _quiet_defect(f"import telegram_quiet_hours failed ({e}) -- QUIET HOURS NOT ENFORCED")
    if _q is not None:
        # One level down, three cases (card 20e178fc): a config that was in use and is gone (LOST) or one
        # that cannot be read is a defect, loud on every run; a missing config this install never recorded
        # is the normal state of an install without quiet hours, noted once; a usable one is recorded.
        _seen = _q.seen_path()
        _case = _q.config_case(_sd, _seen)
        _defect = _q.defect_text(_case, _sd, _seen)
        if _defect:
            _quiet_defect(_defect + " -- QUIET HOURS NOT ENFORCED")
        elif _case == _q.CASE_NOT_CONFIGURED:
            _note = _q.not_configured_note_once(_sd)
            if _note:
                _quiet_note(_note)
        elif _case == _q.CASE_OK:
            _q.remember_configured(_sd, _seen, "telegram-reply-guard")
        try:
            if _q.in_quiet(_sd, chat_id):
                sys.exit(0)
            if created_at is not None:
                _end = _q.quiet_window_end(_sd, chat_id, int(created_at))
                if _end:
                    anchor = _end
        except SystemExit:
            raise
        except Exception as e:
            # A genuine runtime error stays non-fatal -- the guard must not break the Stop
            # hook -- but it is not silent either. That is the whole point of this block.
            _quiet_defect(f"quiet-hours check raised {type(e).__name__}: {e}")

    # Too old -> don't nag forever (abandoned / deliberately-unanswered message).
    try:
        if anchor is not None and (int(time.time()) - int(anchor)) > STALE_SECONDS:
            sys.exit(0)
    except Exception:
        sys.exit(0)

    # Hard backstop against an infinite block loop.
    path = _statefile(agent_id)
    count = _block_count(path, message_id)
    if count >= MAX_BLOCKS:
        sys.exit(0)

    _record_block(path, message_id, count + 1)

    snippet = (text or "").strip().replace("\n", " ")
    if len(snippet) > 160:
        snippet = snippet[:157] + "..."

    try:
        source = ledger_lib.source_for(agent_id, chat_id)
    except Exception:
        source = None  # unknown -> the configured channel, else agnostic wording
    label, tool = _directive_target(source)

    if tool:
        channel = f"{label.upper()}-ÜZENET"
        how = f"a {tool} toolon keresztül (chat_id={chat_id})"
        sees = f"ő csak a(z) {label} csatornát látja"
    else:
        channel = "CSATORNA-ÜZENET"
        how = f"ANNAK a csatornának a reply tooljával, ahonnan jött (chat_id={chat_id})"
        sees = "ő csak a csatornát látja, a transzkriptet nem"

    reason = (
        f"⚠️ VÁLASZOLATLAN {channel} (chat_id={chat_id}): \"{snippet}\"\n"
        f"A fordulót NEM zárhatod le, amíg NEM küldtél választ {how}. "
        f"A sima szöveges (assistant text) kimenet NEM jut el a felhasználóhoz -- "
        f"{sees}. Küldd el a választ a reply toollal MOST, "
        f"utána zárhatod a fordulót."
    )
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


if __name__ == "__main__":
    main()
