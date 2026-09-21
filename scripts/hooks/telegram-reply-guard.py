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
    THIS install's channel reply tool (resolved from CHANNEL_PROVIDER; see
    _channel_provider) with chat_id=..., before stopping.

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
# prefix (slack-channel@... serves mcp__plugin_slack_channel_...), so the
# provider name is what CHANNEL_PROVIDER states, not what a key happens to spell.
_PROVIDER_ALIASES = {"slack-channel": "slack"}


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
    if provider in _CHANNEL_PROVIDERS:
        return f"mcp__plugin_{provider}_{provider}__reply", provider
    # Unknown/absent provider: name no specific tool rather than a wrong one.
    return "a csatorna reply tool", "csatorna"


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

    # Too old -> don't nag forever (abandoned / deliberately-unanswered message).
    try:
        if created_at is not None and (int(time.time()) - int(created_at)) > STALE_SECONDS:
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

    reply_tool, provider = _reply_tool_name()
    label = provider.upper()

    reason = (
        f"⚠️ VÁLASZOLATLAN {label}-ÜZENET (chat_id={chat_id}): \"{snippet}\"\n"
        f"A fordulót NEM zárhatod le, amíg NEM küldtél csatorna-választ a "
        f"{reply_tool} toolon keresztül (chat_id={chat_id}). "
        f"A sima szöveges (assistant text) kimenet NEM jut el a felhasználóhoz -- "
        f"ő csak a(z) {provider} csatornát látja. Küldd el a választ a reply toollal MOST, "
        f"utána zárhatod a fordulót."
    )
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


if __name__ == "__main__":
    main()
