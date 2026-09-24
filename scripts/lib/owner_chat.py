"""owner_chat.py -- Python port of src/owner-chat.ts resolveOwnerChatId (CHATID0).

The installer default ALLOWED_CHAT_ID=0 is not empty and not falsy, so every
Python consumer that tested for emptiness sent straight to chat 0 and earned a
silent Bot API 400. This is the ONE place Python scripts decide "owner chat or
nothing" -- import it, do not reimplement the heuristic.

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
    """channelStateDir(provider), Python side: <PROVIDER>_STATE_DIR env
    override, else install-scoped <install>/.claude/channels/<provider>, else
    legacy ~/.claude/channels/<provider> while the install-scoped one has no
    .env yet (channel-provider.ts #915)."""
    install_dir = os.path.dirname(os.path.abspath(env_file))
    subdir = _SUBDIR_BY_PROVIDER.get(provider, "telegram")
    override = os.environ.get(f"{provider.upper()}_STATE_DIR")
    if override:
        return override
    installed = os.path.join(install_dir, ".claude", "channels", subdir)
    if os.path.isfile(os.path.join(installed, ".env")):
        return installed
    legacy = os.path.join(os.path.expanduser("~"), ".claude", "channels", subdir)
    if os.path.isfile(os.path.join(legacy, ".env")):
        return legacy
    return installed


def _from_access(access_path):
    try:
        with open(access_path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    allow_from = raw.get("allowFrom")
    if isinstance(allow_from, list):
        for entry in allow_from:
            entry_id = _normalize(entry)
            if entry_id:
                return entry_id
    for map_key in ("groups", "channels"):
        m = raw.get(map_key)
        if not isinstance(m, dict):
            continue
        for k in m.keys():
            entry_id = _normalize(k)
            if entry_id:
                return entry_id
    return None


def resolve_owner_chat_id(env, provider="telegram"):
    """env: a dict (already-parsed .env, e.g. from read_env), or an env-file
    path (str). provider: 'telegram' | 'slack' | 'discord' | 'googlechat' |
    'teams'. Returns the chat id, or None when this install has no owner
    chat."""
    key = _env_key(provider)
    if isinstance(env, dict):
        raw = env.get(key)
        env_file = env.get("__env_file__")
    else:
        raw = _read_env_value(env, key)
        env_file = env
    normalized = _normalize(raw)
    if normalized:
        return normalized
    if not env_file:
        return None
    state_dir = _state_dir(env_file, provider)
    return _from_access(os.path.join(state_dir, "access.json"))
