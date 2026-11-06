"""owner_chat.py -- Python port of src/owner-chat.ts resolveAlertOwnerChat (CHATID0).

The installer default ALLOWED_CHAT_ID=0 is not empty and not falsy, so every
Python consumer that tested for emptiness sent straight to chat 0 and earned a
silent Bot API 400. This is the ONE place Python scripts decide "owner chat or
nothing" -- import it, do not reimplement the heuristic.

Every sender of this module is an alert, so the access.json fallback is the
strict one: only the MAIN install's channel dir, and only when its DM
allowlist holds exactly one usable entry (see scripts/lib/owner-chat.sh).

Stdlib only, importable with sys.path.insert(0, <this dir>) the way
ledger-outbound.py:21 already imports its siblings.
"""
import json
import os
import re
import sys

_ENV_KEY_BY_PROVIDER = {
    "slack": "SLACK_CHANNEL_ID",
    "discord": "DISCORD_CHANNEL_ID",
    "googlechat": "GOOGLECHAT_SPACE_ID",
    "teams": "TEAMS_ALLOWED_CONVERSATION_ID",
}

_SUBDIR_BY_PROVIDER = {
    "slack": "slack",
    "discord": "discord",
    "googlechat": "googlechat",
    "teams": "teams",
}


def _normalize(raw):
    """None (unset) or the trimmed id. "0" is the installer placeholder
    (src/owner-chat.ts normalizeChatId): neither empty nor falsy, refused
    explicitly."""
    if raw is None:
        return None
    v = str(raw).strip().strip("\r")
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        v = v[1:-1]
    v = v.strip()
    if not v or v == "0":
        return None
    return v


def _env_key(provider):
    return _ENV_KEY_BY_PROVIDER.get(provider, "ALLOWED_CHAT_ID")


def _read_env_value(env_file, key):
    try:
        with open(env_file, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if line.startswith(f"{key}="):
                    return line[len(key) + 1:]
    except OSError:
        return None
    return None


def _state_dir(env_file, provider):
    """The MAIN install's channel state dir: install-scoped
    <install>/.claude/channels/<provider>, else legacy
    ~/.claude/channels/<provider> while the install-scoped one has no .env yet
    (channel-provider.ts #915). The inherited <PROVIDER>_STATE_DIR is not
    honoured: in a sub-agent's environment it names the sub-agent's channel,
    whose paired person is not the main install's owner (owner-chat.sh)."""
    install_dir = os.path.dirname(os.path.abspath(env_file))
    subdir = _SUBDIR_BY_PROVIDER.get(provider, "telegram")
    installed = os.path.join(install_dir, ".claude", "channels", subdir)
    if os.path.isfile(os.path.join(installed, ".env")):
        return installed
    legacy = os.path.join(os.path.expanduser("~"), ".claude", "channels", subdir)
    if os.path.isfile(os.path.join(legacy, ".env")):
        return legacy
    return installed


def _from_access(access_path):
    """(chat_id, None) for the single usable DM entry of allowFrom, else
    (None, reason). groups/channels keys and "-"-prefixed (group/channel)
    ids are never used (owner-chat.ts soleDmOwner)."""
    try:
        with open(access_path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return None, "no owner chat: .env placeholder/empty and no readable access.json"
    ids = []
    allow_from = raw.get("allowFrom") if isinstance(raw, dict) else None
    if isinstance(allow_from, list):
        for entry in allow_from:
            if isinstance(entry, bool) or not isinstance(entry, (str, int, float)):
                continue
            entry_id = _normalize(entry)
            if entry_id and not entry_id.startswith("-") and entry_id not in ids:
                ids.append(entry_id)
    if len(ids) == 1:
        return ids[0], None
    if not ids:
        return None, "no owner chat: .env placeholder/empty and access.json has no DM entry (groups/channels are never used)"
    return None, f"no owner chat: .env placeholder/empty and access.json has {len(ids)} DM entries, refusing to guess"


def resolve_owner_chat(env, provider="telegram"):
    """(chat_id, None), or (None, reason) when this install has no owner chat
    for an alert. env: a dict (already-parsed .env, with "__env_file__" naming
    its path), or an env-file path (str). provider: 'telegram' | 'slack' |
    'discord' | 'googlechat' | 'teams'."""
    key = _env_key(provider)
    if isinstance(env, dict):
        raw = env.get(key)
        env_file = env.get("__env_file__")
    else:
        raw = _read_env_value(env, key)
        env_file = env
    normalized = _normalize(raw)
    if normalized:
        return normalized, None
    if not env_file:
        return None, "no owner chat: .env placeholder/empty and no install dir to look in"
    return _from_access(os.path.join(_state_dir(env_file, provider), "access.json"))


def resolve_owner_chat_id(env, provider="telegram"):
    """The chat id, or None when this install has no owner chat for an alert
    (resolve_owner_chat gives the reason)."""
    return resolve_owner_chat(env, provider)[0]


# ---------------------------------------------------------------- OWNER_ALERT_CHAT_ID (ISSUE2556X, marveen#2556)
# The owner's alert chat, set on the dashboard's settings page: an overrides-only registry key, so it is read from
# <install>/store/config-overrides.json only (a .env line never counts), exactly as settings-store answers it. A
# DELIVERY target only: resolve_owner_chat / resolve_owner_chat_id are unchanged, because their non-alert callers
# (the inbound prober, ledger-outbound's owner label) ask who the owner is, not where an alert goes. It applies only
# when the caller's provider is the install's CHANNEL_PROVIDER. The patterns are src/alert-chat-format.ts's.
OWNER_ALERT_CHAT_KEY = "OWNER_ALERT_CHAT_ID"
_ALERT_CHAT_FORMATS = {
    "telegram": re.compile(r"-?[1-9][0-9]{0,19}"),
    "slack": re.compile(r"[CDGU][A-Z0-9]{6,}"),
    "discord": re.compile(r"[1-9][0-9]{14,24}"),
    "googlechat": re.compile(r"spaces/[A-Za-z0-9_-]+"),
    "teams": re.compile(r"[A-Za-z0-9:@._-]{3,}"),
}


def _install_provider(env_file):
    raw = _read_env_value(env_file, "CHANNEL_PROVIDER")
    v = (raw or "").strip().strip("\r")
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        v = v[1:-1].strip()
    return v if v in _ALERT_CHAT_FORMATS else "telegram"


def alert_chat_override(env_file, provider="telegram"):
    """(chat_id, None) when the owner set a valid OWNER_ALERT_CHAT_ID for this provider; (None, None) when it is unset
    or the install's channel is another provider; (None, reason) when it is set but not a chat id of this provider
    (also written to stderr: a wrong value must not fall back silently)."""
    if provider != _install_provider(env_file):
        return None, None
    path = os.path.join(os.path.dirname(os.path.abspath(env_file)), "store", "config-overrides.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None, None
    raw = data.get(OWNER_ALERT_CHAT_KEY) if isinstance(data, dict) else None
    if isinstance(raw, bool) or not isinstance(raw, (str, int)):
        return None, None
    v = str(raw).strip()
    if not v or v == "0":
        return None, None
    if _ALERT_CHAT_FORMATS[provider].fullmatch(v):
        return v, None
    reason = f"{OWNER_ALERT_CHAT_KEY} is set but is not a {provider} chat id -- NOT used"
    sys.stderr.write(f"owner_chat: {reason}\n")
    return None, reason


def resolve_alert_chat(env, provider="telegram"):
    """resolve_owner_chat with the owner's OWNER_ALERT_CHAT_ID in front: for an ALERT sender only."""
    env_file = env if isinstance(env, str) else (env.get("__env_file__") if isinstance(env, dict) else None)
    invalid = None
    if env_file:
        chat, invalid = alert_chat_override(env_file, provider)
        if chat:
            return chat, None
    chat, reason = resolve_owner_chat(env, provider)
    if chat is None and invalid:
        reason = f"{reason}; {OWNER_ALERT_CHAT_KEY} is set but invalid for {provider}"
    return chat, reason


def resolve_alert_chat_id(env, provider="telegram"):
    """The alert chat id, or None (resolve_alert_chat gives the reason)."""
    return resolve_alert_chat(env, provider)[0]
