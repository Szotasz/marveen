#!/usr/bin/env python3
"""Shared config + secret-safe credential loader for the support@aiamindennapokban.hu mailbox.

Hostinger IMAP/SMTP. The password lives ONLY in the Marveen vault
(key: support@aiamindennapokba.hu_pw -- note the owner's typo in the key name)
and is fetched at runtime via the dashboard vault API. It is never written to
disk or printed.
"""
import json, os, urllib.request

EMAIL = "support@aiamindennapokban.hu"
IMAP_HOST, IMAP_PORT = "imap.hostinger.com", 993
SMTP_HOST, SMTP_PORT = "smtp.hostinger.com", 465  # implicit TLS/SSL
VAULT_KEY = "support@aiamindennapokba.hu_pw"  # owner's typo in the key, kept as-is
_ROOT = "/Users/marvin/ClaudeClaw"


def password() -> str:
    tok = open(os.path.join(_ROOT, "store/.dashboard-token")).read().strip()
    req = urllib.request.Request(
        f"http://localhost:3420/api/vault/{VAULT_KEY}",
        headers={"Authorization": "Bearer " + tok},
    )
    pw = json.load(urllib.request.urlopen(req, timeout=10)).get("value", "")
    if not pw:
        raise RuntimeError("support mailbox password not found in vault")
    return pw
