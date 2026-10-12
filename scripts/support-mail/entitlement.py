#!/usr/bin/env python3
"""Two-source, three-state support entitlement check (SUPPJOGVAK901).

WHY THIS EXISTS: the old support-inbox check queried ONE customer DB
(ai-a-mindennapokban). marveen.io install/lifetime buyers live in a SEPARATE
Supabase project, so a paying marveen.io customer read as "not found" -> the
task's "no support" branch would send a false "you have no support" reply to a
buyer (measured 2026-09-02: 3 active mio customers invisible to the AIAM check).

States:
  VALID     -- an active support/membership found in EITHER source.
  NONE      -- BOTH sources reachable AND neither has active support. Only in
               this state may the caller send the no-support auto-reply.
  UNDECIDED -- at least one source is unreachable/errored, OR the sender address
               is unparseable. NEVER auto-reply here: route to human review.
               ("cannot decide" is not "has no right" -- SUPPJOGVAK901 rule b.)

The sender address is UNTRUSTED (an inbound email header), so it is validated
against a strict pattern and single-quote-escaped before it ever reaches SQL.

Usage:
  python3 entitlement.py <email> [<email> ...]   # prints one JSON line each
  (also importable: from entitlement import check)

Config-driven, nothing operator-specific baked in: the two project refs come
from the project .env (SUPPORT_ENTITLEMENT_AIAM_REF / _MIO_REF), and the
Supabase Management PAT is pulled from the vault at runtime (never stored).
"""
import os
import re
import sys
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _env(key: str, default: str = "") -> str:
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


AIAM_REF = _env("SUPPORT_ENTITLEMENT_AIAM_REF", "ymljpjpjrwbmkfvtahtn")
MIO_REF = _env("SUPPORT_ENTITLEMENT_MIO_REF", "fpxycpxdxgifimbmwgzj")
PAT_VAULT_KEY = _env("SUPPORT_ENTITLEMENT_PAT_KEY", "MARVEEN-CONNECTORS-PAT")
WEB_PORT = _env("WEB_PORT", "3420")

# Strict address shape: anything outside this is rejected (-> UNDECIDED/review),
# so it can never be an SQL-injection vector.
_EMAIL_RE = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$")


def _pat() -> str:
    tok = (ROOT / "store" / ".dashboard-token").read_text().strip()
    req = urllib.request.Request(
        f"http://localhost:{WEB_PORT}/api/vault/{PAT_VAULT_KEY}",
        headers={"Authorization": "Bearer " + tok},
    )
    val = json.load(urllib.request.urlopen(req, timeout=10)).get("value", "")
    if not val:
        raise RuntimeError(f"Management PAT not found in vault ({PAT_VAULT_KEY})")
    return val


def _query(pat: str, ref: str, sql: str):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={
            "Authorization": "Bearer " + pat,
            "Content-Type": "application/json",
            # The Management API rejects the default python User-Agent (403);
            # a named UA is required.
            "User-Agent": "connectors-support-entitlement/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        body = json.load(r)
    if isinstance(body, dict) and body.get("message"):
        raise RuntimeError(body["message"])
    return body


def check(email: str) -> dict:
    """Return {state, reason, aiam?, mio?} for one sender address."""
    email = (email or "").lower().strip()
    if not _EMAIL_RE.match(email):
        return {"state": "UNDECIDED",
                "reason": f"unparseable/invalid sender address -> review: {email!r}"}
    e = email.replace("'", "''")
    try:
        pat = _pat()
    except Exception as ex:
        return {"state": "UNDECIDED", "reason": f"vault/PAT unavailable -> review: {ex}"}

    aiam = mio = None
    errors = []
    try:
        aiam = _query(pat, AIAM_REF, f"""SELECT
          EXISTS(SELECT 1 FROM customers c WHERE lower(c.email)='{e}' AND (
            c.support_valid_until > now()
            OR EXISTS(SELECT 1 FROM marveen_purchases p WHERE p.customer_id=c.id
                      AND (p.standard_support_until > now()
                           OR p.stripe_subscription_id IS NOT NULL))
          )) AS valid,
          EXISTS(SELECT 1 FROM customers c WHERE lower(c.email)='{e}') AS known""")[0]
    except Exception as ex:
        errors.append(f"AIAM:{ex}")
    try:
        mio = _query(pat, MIO_REF, f"""SELECT
          EXISTS(SELECT 1 FROM auth.users u JOIN customers c ON c.user_id=u.id
                 JOIN memberships m ON m.customer_id=c.id
                 WHERE lower(u.email)='{e}' AND m.status='active') AS valid,
          EXISTS(SELECT 1 FROM auth.users u WHERE lower(u.email)='{e}') AS known""")[0]
    except Exception as ex:
        errors.append(f"MIO:{ex}")

    # A source that errored is NOT a source that said "no". Either miss -> review.
    if errors:
        return {"state": "UNDECIDED",
                "reason": "a source unreachable -> review, NOT no-support: " + "; ".join(errors),
                "aiam": aiam, "mio": mio}
    if aiam["valid"] or mio["valid"]:
        src = "AIAM" if aiam["valid"] else "marveen.io"
        return {"state": "VALID", "reason": f"active support in {src}",
                "aiam": aiam, "mio": mio}
    return {"state": "NONE",
            "reason": "both sources reachable, no active support in either",
            "aiam": aiam, "mio": mio}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: entitlement.py <email> [<email> ...]", file=sys.stderr)
        sys.exit(2)
    for addr in sys.argv[1:]:
        print(json.dumps({"email": addr, **check(addr)}))
