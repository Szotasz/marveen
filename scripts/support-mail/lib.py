#!/usr/bin/env python3
"""Shared config + secret-safe credential loader for a generic IMAP/SMTP mailbox.

All deployment-specific values (mailbox address, vault key, mail hosts) are
config-driven via env / the project .env, with empty or generic defaults --
nothing operator-specific is baked into the repo. The mailbox password lives
ONLY in the vault and is fetched at runtime via the dashboard vault API; it is
never written to disk or printed.
"""
import json, os, urllib.request
from pathlib import Path

# Project root = scripts/support-mail/lib.py -> two levels up. Never hardcode it.
ROOT = Path(__file__).resolve().parents[2]


def _env(key: str, default: str = "") -> str:
    """env var, else the project .env, else default. No operator data in code."""
    v = os.environ.get(key)
    if v:
        return v
    envf = ROOT / ".env"
    if envf.exists():
        for line in envf.read_text().splitlines():
            line = line.strip()
            if line.startswith(key + "="):
                return line[len(key) + 1:].strip().strip('"').strip("'")
    return default


# Mailbox + credentials (empty default -> configure per install in .env).
EMAIL = _env("SUPPORT_MAILBOX")
VAULT_KEY = _env("SUPPORT_VAULT_KEY")

# Mail provider endpoints (generic defaults; override per provider in .env).
IMAP_HOST = _env("SUPPORT_IMAP_HOST", "imap.hostinger.com")
IMAP_PORT = int(_env("SUPPORT_IMAP_PORT", "993"))
SMTP_HOST = _env("SUPPORT_SMTP_HOST", "smtp.hostinger.com")
SMTP_PORT = int(_env("SUPPORT_SMTP_PORT", "465"))  # implicit TLS/SSL

FROM_NAME = _env("SUPPORT_FROM_NAME", "Support")
# Outgoing From address; may differ from the login mailbox (e.g. a product
# alias hosted on a primary account). Defaults to the login address.
FROM_ADDRESS = _env("SUPPORT_FROM_ADDRESS") or EMAIL
WEB_PORT = _env("WEB_PORT", "3420")


def password() -> str:
    if not EMAIL or not VAULT_KEY:
        raise RuntimeError(
            "support mailbox not configured: set SUPPORT_MAILBOX and SUPPORT_VAULT_KEY in .env"
        )
    tok = (ROOT / "store" / ".dashboard-token").read_text().strip()
    req = urllib.request.Request(
        f"http://localhost:{WEB_PORT}/api/vault/{VAULT_KEY}",
        headers={"Authorization": "Bearer " + tok},
    )
    pw = json.load(urllib.request.urlopen(req, timeout=10)).get("value", "")
    if not pw:
        raise RuntimeError("support mailbox password not found in vault")
    return pw
