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
#   googlechat config.ts: GOOGLECHAT_STATE_DIR ?? ~/.claude/channels/googlechat
#            (read from the plugin source, buglime/claude-channel-googlechat
#            3421b382a; the plugin is not installed on the host this was written on)
# "??" keeps a set-but-empty variable, "||" skips it: the hook must read the
# file the plugin reads, nothing else.
_STATE_DIR_RULE = {
    "telegram": (("TELEGRAM_STATE_DIR",), True),
    "discord": (("DISCORD_STATE_DIR",), True),
    "slack": (("SLACK_STATE_DIR",), False),
    "teams": (("TEAMS_PLUGIN_STATE_DIR", "TEAMS_STATE_DIR"), False),
    "googlechat": (("GOOGLECHAT_STATE_DIR",), True),
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


# --- Google Chat (PELENKAGCHAT1113) -------------------------------------------
#
# The Google Chat plugin has no pairing and no DM allowlist of sender ids: its
# access.json names ONE `owner` (a Workspace email, or a raw users/<id> when no
# email can be resolved) and the plugin writes the role it derived from that
# into the envelope (role="owner" | "user", src/inbound.ts + src/access.ts
# roleFor). So this channel is gated on the role, the way Gromzo is, and the
# role is then CHECKED against the file it came from:
#
#   1. the source is exactly the plugin's own (another plugin whose server is
#      merely named googlechat is an unknown provider);
#   2. role="owner". Any other role, or none, refuses the WHOLE prompt: only the
#      owner's rows go in, there is no 'paired' Google Chat row (Samu 76792; the
#      replay hands inbound rows back as the owner's words);
#   3. the sender is the `owner` of the access.json THIS session's plugin reads
#      (_state_dir, the plugin's own rule), by the plugin's own comparison: an
#      email owner against the envelope's `user` (the plugin puts the resolved
#      email there), a users/<id> owner against `user_id`;
#   4. and of the MAIN install's Google Chat access.json (owner_chat._state_dir):
#      who the owner is comes from the main install only, never from a
#      sub-agent's own channel dir (the rule of _owner_id below).
#
# A second person the plugin's `roles` map promotes to "owner" also arrives with
# role="owner". They are NOT the install's owner, and the replay would print
# their words under the owner's name, so the prompt is refused. Promoted by
# EMAIL they fail step 3: their `user` is their own resolved email. Promoted by
# users/<id> they would NOT fail it on an email-owner install: the plugin's key
# is `email ?? senderId` (access.ts gate), so an id key is in play exactly when
# no email resolved, and then `user` is the DISPLAY NAME (identity.ts
# displayUser), which the sender writes. A promoted person who names themselves
# after the owner's email would pass the comparison (review finding, Samu). So:
#
#   5. on an email-owner install, an envelope whose user_id is ANY key of the
#      session access.json's `roles` map is refused. role="owner" arises in two
#      ways only (key == owner, or roles[key] == "owner"), and the id-keyed way
#      is the one where `user` is not a resolved email. A `roles` that is there
#      but is not an object: the owner cannot be decided.
#
# Fail-closed wherever the owner cannot be decided: no readable file, no
# `owner`, an `owner` that is neither an email nor a users/<id>. The price of
# step 5: an owner whose own users/<id> is also listed in `roles` is refused.
#
# NOT MEASURED LIVE: there is no Google Chat test environment. The envelope
# shape is taken from the plugin source, not from a real session.
GOOGLECHAT_SOURCE = "plugin:googlechat:googlechat"


def _googlechat_access(access_path):
    """(owner, role keys) of an access.json. The owner is None when the file
    names none. The role keys are the lower-cased keys of its `roles` map: empty
    when there is no map (the plugin reads a missing or null one as {}), None
    when `roles` is there but is not an object."""
    try:
        with open(access_path, encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None, None
    if not isinstance(raw, dict):
        return None, None
    owner = raw.get("owner")
    owner = owner if isinstance(owner, str) and owner else None
    roles = raw.get("roles")
    if roles is None:
        return owner, frozenset()
    if not isinstance(roles, dict):
        return owner, None
    return owner, frozenset(k.lower() for k in roles if isinstance(k, str))


def _attr_text(value):
    """An envelope attribute as the plugin sent it. Claude Code escapes five
    characters in an attribute value (& < > " '; read from the 2.1.323 binary,
    2026-11-13), so an owner email with an apostrophe arrives as &apos;. Used
    only to COMPARE a value with the access.json owner, never to build a tag."""
    for entity, char in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&apos;", "'"), ("&amp;", "&")):
        value = value.replace(entity, char)
    return value


def _googlechat_sender_is(owner, attrs):
    """The plugin's own comparison (access.ts roleFor): the key is the resolved
    email, else the raw users/<id>; it equals the owner case-insensitively."""
    if owner.startswith("users/"):
        return _attr_text(attrs.get("user_id", "")).lower() == owner.lower()
    if "@" not in owner:
        return None  # neither an email nor an id: no owner can be decided
    return _attr_text(attrs.get("user", "")).lower() == owner.lower()


def _googlechat_refusal(source, attrs, cache):
    if source != GOOGLECHAT_SOURCE:
        return "unknown-provider"
    if attrs.get("role") != "owner":
        return "sender-not-owner"
    if not attrs.get("user_id"):
        return "sender-missing"
    if "googlechat" not in cache:
        main_env = os.path.join(_owner_install_dir(), ".env")
        cache["googlechat"] = tuple(
            _googlechat_access(os.path.join(d, "access.json"))
            for d in (_state_dir("googlechat"), owner_chat._state_dir(main_env, "googlechat"))
        )
    for owner, _role_keys in cache["googlechat"]:
        if owner is None:
            return "owner-undecidable"
        same = _googlechat_sender_is(owner, attrs)
        if same is None:
            return "owner-undecidable"
        if not same:
            return "sender-not-owner"
    # Step 5. The session's file is the one the role in this envelope came from.
    session_owner, role_keys = cache["googlechat"][0]
    if not session_owner.startswith("users/"):
        if role_keys is None:
            return "owner-undecidable"
        if _attr_text(attrs.get("user_id", "")).lower() in role_keys:
            return "sender-not-owner"
    return None


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
        if provider == "googlechat":
            why = _googlechat_refusal(source, attrs, cache)
            if why is not None:
                return why
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
#      (a registry setting, overrides-only: the overrides file alone, as
#      settings-store reads it; ENVRELAXGATE1104), Telegram a positive ALLOWED_CHAT_ID (a DM chat id is the
#      user id);
#   2. else the main install's sole DM-allowlist entry (owner_chat._from_access);
#   3. else nobody is the owner.
# One role per PROMPT, the lowest of its envelopes: one 'paired' tag makes every
# row of the prompt 'paired', so text inside a body can only lower a role.
OWNER_KEY_BY_PROVIDER = {"slack": "SLACK_OWNER_USER_ID", "telegram": "ALLOWED_CHAT_ID"}
OVERRIDES_NAME = "config-overrides.json"  # read only, never written here


def _owner_install_dir():
    # The main install is the one this hook lives in, never an environment path
    # (ENVRELAXGATE1104: the hook runs in the captured agent's own environment,
    # and the owner it reads decides which rows are labeled the owner's). A test
    # runs the hook from a tmp install whose scripts/ links to the repo's.
    return ledger_lib._install_dir()


# ENVRELAXGATE1104 step 2: the registry's overrides-only keys read here. Every change of SLACK_OWNER_USER_ID loosens
# it (its registry `loosens`), so a .env line can never tighten it and never counts: the override alone decides, and a
# blank override means "not set", never a fall-through to .env. ALLOWED_CHAT_ID is no registry key: it keeps the .env.
OVERRIDES_ONLY_KEYS = frozenset({"SLACK_OWNER_USER_ID"})


def _setting(install_dir, key):
    """A registry key as settings-store resolves it: the override, then .env (never .env for OVERRIDES_ONLY_KEYS)."""
    overrides_only = key in OVERRIDES_ONLY_KEYS
    try:
        with open(os.path.join(install_dir, "store", OVERRIDES_NAME), encoding="utf-8") as fh:
            ov = json.load(fh)
        v = ov.get(key) if isinstance(ov, dict) else None
        if isinstance(v, (str, int)) and not isinstance(v, bool) and str(v).strip():
            return str(v).strip()
    except (OSError, ValueError):
        pass
    if overrides_only:
        return None
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
        if provider in ("gromzo", "googlechat"):
            continue  # the gate let in only the owner's envelope (Google Chat: the main install's)
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
        if provider == "googlechat":
            sender_id = _attr(attrs, "user_id")  # users/<id>; not in SENDER_KEY, which keys the allowFrom gate
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
