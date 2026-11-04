"""The dashboard's Security switches (src/config-registry.ts, module 'security'), read from a hook.

The value comes from store/config-overrides.json only (an empty string included), then the default
the caller passes. The install .env is NOT read: a loosening write to the overrides file needs the
owner (SettingDefinition.loosens on the settings route), a line in .env does not, so a .env source
would let a gate be loosened around the owner-only rule. The registry marks these keys
`overridesOnly`, so the dashboard shows the value the hooks use. The Python twin of
scripts/lib/security-settings.mjs.

Fail safe: an unreadable or malformed overrides file, or a value outside `allowed`, reads as the
default, and every default the callers pass is the strict, shipped behaviour.

SECURITY_SETTINGS_ROOT points the reader at another install root (tests).
"""
import json
import os

_DEFAULT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


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


def override(key: str, root=None):
    """The raw overrides-file value of `key`, or None when the file does not
    set it. An empty string is a set value (the owner cleared the switch)."""
    return _override_value(root or settings_root(), key)


def security_setting(key: str, default: str, allowed=None, root=None) -> str:
    """The effective value of `key`, or `default` when it is unset or (with
    `allowed`) not one of the allowed values."""
    v = override(key, root)
    if v is None:
        return default
    v = v.strip()
    if allowed is not None and v not in allowed:
        return default
    return v
