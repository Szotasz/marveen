#!/usr/bin/env python3
"""UserPromptSubmit hook: capture inbound channel messages into the rolling
transcript (direction='in') BEFORE the agent processes the prompt. Deterministic
and agent-independent. agent_id is derived from the session's cwd so the hook is
generic across all three channel agents and never cross-contaminates. Never
blocks the prompt (always exit 0).

PROVIDER-AGNOSTIC: every channel plugin emits the same <channel source="..">
envelope, so the capture matches any `plugin:<provider>:<name>` source rather
than one hardcoded provider. Hardcoding a single provider silently drops the
whole conversation on every other channel -- and the failure is invisible,
because the replay still produces a non-empty block from the one provider that
IS captured.
"""
import sys
import os
import json
import re
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))
import owner_chat  # noqa: E402

# <channel source="plugin:telegram:telegram" chat_id="X" message_id="Y" ... ts="Z">
#   TEXT
# </channel>
# The source is `plugin:<provider>:<server>` for every channel plugin
# (telegram, discord, slack, ...). Matching the shape instead of one literal
# keeps a new provider working without a code change.
# Group 1 is the FULL source ("plugin:discord:discord"); it is recorded with the
# row so the reply guard can name the right provider's reply tool
# (PROVIDERVAK908). Group 2 is the remaining attributes, group 3 the body.
CHANNEL_RX = re.compile(
    r'<channel\s+source="(plugin:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+)"([^>]*)>(.*?)</channel>',
    re.DOTALL,
)

# --- the sender gate (LEDGERROLELABEL1104 (a), Samu 67664) --------------------
#
# The replay hands every inbound row back to a fresh session AS THE OWNER'S
# WORDS (ledger-replay.py: who = owner). So a row may only be written for a
# sender the channel itself trusts as its owner: the agent's own DM allowlist
# (the top-level allowFrom of the plugin's access.json, which pairing fills).
# Measured 2026-11-04: the Discord bootstrap (discord-group-bootstrap.ts) opts a
# server channel in with requireMention:false and allowFrom:[] -- every member's
# every message is delivered -- and a Slack channel opted in without --allow is
# the same. Without this gate any member's text came back as the owner's.
#
# EVERY opening tag in the prompt counts, the ones inside a message body too
# (the sender-role gate's rule): Claude Code does not escape "<" in a channel
# body (measured: raw tag-like "<" in 14 of 292 Slack bodies), so a member can
# write a whole forged envelope naming the owner's id. Such a forgery sits
# behind the member's own real tag, which fails the gate, so one failing tag
# drops the WHOLE prompt: a forged owner envelope can only tighten, never loosen.
#
# Fail-CLOSED wherever the owner cannot be decided (Samu 67664): no readable
# access.json, an empty allowFrom (which the plugins read as "everyone"), a
# provider without a known sender attribute, an unparseable or repeated
# attribute, a sender the channel marks unverified.
CHANNEL_TAG_RE = re.compile(r"<channel\s+([^>]*)>")
ATTR_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"')
ATTRS_FULL_RE = re.compile(r'(?:[A-Za-z_][A-Za-z0-9_]*="[^"]*"\s*)*')

# The envelope attribute that carries the sender id, per provider (the last
# source segment: plugin:slack-channel:slack -> slack), as each plugin writes it.
SENDER_KEY = {"telegram": "user_id", "discord": "user_id", "slack": "user_id", "teams": "aad_object_id"}

# Where each plugin reads its access.json, copied from the plugin itself:
#   telegram server.ts: TELEGRAM_STATE_DIR ?? ~/.claude/channels/telegram
#   discord  server.ts: DISCORD_STATE_DIR ?? ~/.claude/channels/discord
#   slack    server.ts: SLACK_STATE_DIR || ~/.claude/channels/slack
#   teams    config.ts: TEAMS_PLUGIN_STATE_DIR || TEAMS_STATE_DIR || ~/.claude/channels/teams
# "??" keeps a set-but-empty variable, "||" skips it: the hook must read the
# file the plugin reads, nothing else.
_STATE_DIR_RULE = {
    "telegram": (("TELEGRAM_STATE_DIR",), True),
    "discord": (("DISCORD_STATE_DIR",), True),
    "slack": (("SLACK_STATE_DIR",), False),
    "teams": (("TEAMS_PLUGIN_STATE_DIR", "TEAMS_STATE_DIR"), False),
}


def _state_dir(provider):
    names, keep_empty = _STATE_DIR_RULE[provider]
    for name in names:
        value = os.environ.get(name)
        if value is not None and (keep_empty or value != ""):
            return value
    return os.path.join(os.path.expanduser("~"), ".claude", "channels", provider)


def _norm(provider, sender_id):
    # Teams object ids are GUIDs, paired in lower case (pairing/pair.ts).
    return sender_id.lower() if provider == "teams" else sender_id


def _allowlist(provider, cache):
    """The provider's DM allowlist as a set, or None when it cannot decide an
    owner (no readable file, no list, an empty list, a non-string entry)."""
    if provider in cache:
        return cache[provider]
    allowed = None
    try:
        with open(os.path.join(_state_dir(provider), "access.json"), encoding="utf-8") as fh:
            raw = json.load(fh)
        entries = raw.get("allowFrom") if isinstance(raw, dict) else None
        if isinstance(entries, list) and entries and all(isinstance(e, str) and e for e in entries):
            allowed = {_norm(provider, e) for e in entries}
    except (OSError, ValueError):
        allowed = None
    cache[provider] = allowed
    return allowed


def _prompt_refusal(prompt):
    """None when every envelope in the prompt is from its channel's owner, else
    the reason (a fixed token, never the sender id or any text)."""
    cache = {}
    for match in CHANNEL_TAG_RE.finditer(prompt):
        raw = match.group(1).strip()
        if not ATTRS_FULL_RE.fullmatch(raw):
            return "unparseable-envelope"
        pairs = ATTR_RE.findall(raw)
        attrs = dict(pairs)
        if len(attrs) != len(pairs):
            return "repeated-attribute"
        source = attrs.get("source", "")
        if not re.fullmatch(r"plugin:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+", source):
            return "bad-source"
        provider = source.rsplit(":", 1)[-1]
        if "verified" in attrs and attrs["verified"] != "true":
            return "sender-unverified"
        if provider == "gromzo":
            # The Gromzo plugin writes the role itself; only its verified owner counts.
            if attrs.get("sender_role") != "owner" or attrs.get("verified") != "true":
                return "sender-not-owner"
            continue
        key = SENDER_KEY.get(provider)
        if key is None:
            return "unknown-provider"
        sender = attrs.get(key)
        if not sender:
            return "sender-missing"
        allowed = _allowlist(provider, cache)
        if allowed is None:
            return "owner-undecidable"
        if _norm(provider, sender) not in allowed:
            return "sender-not-allowlisted"
    return None


def _trace(reason, **fields):
    """One line, and ONLY when the hook ran and stored nothing.

    WHY: every failure path in this hook is silent. A regex miss, a missing
    chat_id/message_id, a ledger exception and an unparseable payload all leave
    the same trace -- none. So "the hook never ran" and "it ran and matched
    nothing" are indistinguishable from outside, and a gap in the transcript
    cannot be attributed to either. That is not a gap in someone's diligence: it
    is a property of the code, and it makes the question unanswerable rather
    than merely unanswered.

    Measured on one install, 2026-09-04: in a 42-minute window the ledger held
    six outbound replies and one inbound row, and 12 of the 19 Telegram
    message_ids spanning it were unaccounted for. The loss is one-directional --
    a missing inbound row can only ever produce a false "they never replied",
    never a false "answered" -- so the visible cost is the owner being asked a
    question they already answered.

    Deliberately ONLY on the empty outcome: the happy path stays silent, so this
    costs nothing in the common case and every line written is a question worth
    asking. COUNTS ONLY, never message text -- the trace must not become a second
    copy of the transcript.
    """
    try:
        path = os.path.join(os.path.dirname(ledger_lib.db_path()),
                            "ledger-capture-trace.log")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\t%s\n" % (
                time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                reason,
                " ".join("%s=%s" % kv for kv in sorted(fields.items())),
            ))
    except Exception:
        pass  # a trace must never block the prompt either


# --- the sender's role (LEDGERROLELABEL1104 b) ------------------------------
#
# The gate above only says a sender is on the channel's DM allowlist; that list
# can hold more people than the owner (pairing adds anyone). The replay labels a
# row as the owner's words only for 'owner'; everyone else is 'paired'.
#
# Who the owner is comes from the MAIN install only, never from this session's
# environment or this agent's own channel dir (a sub-agent's paired person is
# not the install's owner, owner_chat._state_dir):
#   1. an explicit owner id decides ALONE when set: Slack SLACK_OWNER_USER_ID
#      (a registry setting: the overrides file, then .env, as settings-store
#      reads it), Telegram a positive ALLOWED_CHAT_ID (a DM chat id is the
#      user id);
#   2. else the main install's sole DM-allowlist entry (owner_chat._from_access);
#   3. else nobody is the owner.
# One role per PROMPT, the lowest of its envelopes: one 'paired' tag makes every
# row of the prompt 'paired', so text inside a body can only lower a role.
OWNER_KEY_BY_PROVIDER = {"slack": "SLACK_OWNER_USER_ID", "telegram": "ALLOWED_CHAT_ID"}
OVERRIDES_NAME = "config-overrides.json"  # read only, never written here


def _owner_install_dir():
    # LEDGER_OWNER_INSTALL_DIR is a test seam only: the main install's dir.
    return os.environ.get("LEDGER_OWNER_INSTALL_DIR") or ledger_lib._install_dir()


def _setting(install_dir, key):
    """A registry key as settings-store resolves it: the override, then .env."""
    try:
        with open(os.path.join(install_dir, "store", OVERRIDES_NAME), encoding="utf-8") as fh:
            ov = json.load(fh)
        v = ov.get(key) if isinstance(ov, dict) else None
        if isinstance(v, (str, int)) and not isinstance(v, bool) and str(v).strip():
            return str(v).strip()
    except (OSError, ValueError):
        pass
    v = owner_chat._read_env_value(os.path.join(install_dir, ".env"), key)
    return v.strip() if isinstance(v, str) and v.strip() else None


def _owner_id(provider, cache):
    if provider in cache:
        return cache[provider]
    owner = None
    install_dir = _owner_install_dir()
    key = OWNER_KEY_BY_PROVIDER.get(provider)
    explicit = _setting(install_dir, key) if key else None
    if provider == "telegram" and explicit and not explicit.isdigit():
        explicit = None  # a negative (group) chat id names no person
    if explicit:
        owner = explicit
    elif provider in SENDER_KEY:
        env_file = os.path.join(install_dir, ".env")
        sole, _why = owner_chat._from_access(os.path.join(owner_chat._state_dir(env_file, provider), "access.json"))
        owner = sole
    cache[provider] = _norm(provider, owner) if owner else None
    return cache[provider]


def _prompt_role(prompt):
    """'owner' only when EVERY envelope of the prompt is the owner's; else 'paired'.
    Runs after the gate, so every tag parses and every sender is allowlisted."""
    cache = {}
    for match in CHANNEL_TAG_RE.finditer(prompt):
        attrs = dict(ATTR_RE.findall(match.group(1)))
        provider = attrs.get("source", "").rsplit(":", 1)[-1]
        if provider == "gromzo":
            continue  # the gate let in only the verified owner's envelope
        sender = attrs.get(SENDER_KEY.get(provider, ""), "")
        owner = _owner_id(provider, cache)
        if not owner or _norm(provider, sender) != owner:
            return "paired"
    return "owner"


def _attr(attrs, name):
    # A whole attribute name only: "user_id" must not match "reply_to_user_id".
    m = re.search(r'(?:^|\s)' + re.escape(name) + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        _trace("payload-unparseable")
        sys.exit(0)
    agent_id = ledger_lib.agent_id_from_payload(payload)
    prompt = payload.get("prompt") or ""
    matched = stored = skipped = failed = 0
    refusal = _prompt_refusal(prompt)
    if refusal is not None:
        # Nothing from this prompt goes in (see the sender gate above).
        _trace("sender-gate", agent=agent_id, why=refusal,
               envelopes=len(CHANNEL_TAG_RE.findall(prompt)))
        sys.exit(0)
    role = _prompt_role(prompt)
    for m in CHANNEL_RX.finditer(prompt):
        matched += 1
        source, attrs, text = m.group(1), m.group(2), m.group(3)
        # TEAMSCONV1020: the Teams plugin names its chat conversation_id, not
        # chat_id; without the fallback every Teams inbound was skipped
        # (measured 2026-10-20: matched=1 skipped=1, zero Teams rows).
        chat_id = _attr(attrs, "chat_id") or _attr(attrs, "conversation_id")
        message_id = _attr(attrs, "message_id")
        ts = _attr(attrs, "ts")
        # Voice / video_note that arrived WITHOUT a transcript keeps its
        # attachment identity in the ledger, so a respawned session can still
        # download + transcribe it (the STT-success path strips these attrs and
        # carries the transcript in the body instead, so nothing is stored then).
        att_kind = _attr(attrs, "attachment_kind")
        att_file_id = _attr(attrs, "attachment_file_id")
        # Which earlier message (if any) the sender quoted. Only the id is
        # captured, never reply_to_excerpt (df3b48a7): the excerpt is a copy of
        # that other row's own text, and storing it twice would drift the
        # moment either side is edited/redacted.
        reply_to_message_id = _attr(attrs, "reply_to_message_id")
        provider = source.rsplit(":", 1)[-1]
        sender_id = _attr(attrs, SENDER_KEY[provider]) if provider in SENDER_KEY else None
        sender_name = _attr(attrs, "sender_name" if provider == "gromzo" else "user")
        if chat_id and message_id:
            try:
                ledger_lib.log_inbound(
                    agent_id, chat_id, message_id, text.strip(), ts,
                    attachment_kind=att_kind, attachment_file_id=att_file_id,
                    reply_to_message_id=reply_to_message_id,
                    source=source,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    sender_role=role,
                )
                stored += 1
            except Exception as exc:
                failed += 1
                _trace("ledger-error", agent=agent_id, err=type(exc).__name__)
                # never block the prompt on a ledger error
        else:
            skipped += 1
    if stored == 0:
        # `has_tag` separates "no channel wrapper reached this prompt at all"
        # from "one did and nothing came of it" -- the same distinction the
        # counts below make within a matched wrapper.
        _trace("no-row", agent=agent_id, matched=matched, skipped=skipped,
               failed=failed, prompt_len=len(prompt),
               has_tag=int("<channel" in prompt))
    sys.exit(0)


if __name__ == "__main__":
    main()
