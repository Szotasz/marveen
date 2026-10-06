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
