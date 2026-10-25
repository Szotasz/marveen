"""The dashboard's Security switches (src/config-registry.ts, module 'security'), read from a hook.

Same resolution order as the TypeScript settings store (getEffectiveSettingSource): a key present
in store/config-overrides.json wins (an empty string included), then a KEY= line in the install
.env, then the default the caller passes. The Python twin of scripts/lib/security-settings.mjs.

Fail safe: an unreadable or malformed overrides file, or a value outside `allowed`, reads as the
default, and every default the callers pass is the strict, shipped behaviour.

SECURITY_SETTINGS_ROOT points the reader at another install root (tests).
"""
import json
import os
import re

_DEFAULT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")


def settings_root() -> str:
    return os.environ.get("SECURITY_SETTINGS_ROOT") or _DEFAULT_ROOT


def _override_value(root: str, key: str):
    try:
        with open(os.path.join(root, "store", "config-overrides.json"), encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None
    if isinstance(raw, dict) and key in raw:
        return str(raw[key])
    return None


def _env_file_value(root: str, key: str):
    try:
        with open(os.path.join(root, ".env"), encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    for line in lines:
        m = _ENV_LINE.match(line)
        if not m or m.group(1) != key:
            continue
        v = m.group(2).strip()
        if len(v) >= 2 and v[0] in "\"'" and v[-1] == v[0]:
            v = v[1:-1]
        return v
    return None


def security_setting(key: str, default: str, allowed=None, root=None) -> str:
    """The effective value of `key`, or `default` when it is unset or (with
    `allowed`) not one of the allowed values."""
    root = root or settings_root()
    v = _override_value(root, key)
    if v is None:
        v = _env_file_value(root, key)
    if v is None:
        return default
    v = v.strip()
    if allowed is not None and v not in allowed:
        return default
    return v
