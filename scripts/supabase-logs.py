#!/usr/bin/env python3
"""supabase-logs.py -- Supabase analytics log query an agent can run WITHOUT
ever handling the PAT (SUPALOGS822; the token-hiding shape of
scripts/supabase-q.sh and scripts/support-mail/entitlement.py, PATSZIVARGAS912).

    scripts/supabase-logs.py <project-ref> "<ClickHouse SQL>" [--hours N]
                             [--start ISO --end ISO] [--vault-key KEY]

Calls GET /v1/projects/<ref>/analytics/endpoints/logs -- the successor of the
`logs.all` endpoint the vendor removes on 2026-09-23. Read-only, one host.

THE PROPERTY THIS SCRIPT HAS: the agent's command line carries no secret. The
PAT is read from the local vault INSIDE this process (dashboard token from
store/.dashboard-token) and travels only in the HTTP Authorization header of
one request; it is never printed, never put in argv, never written to disk.

WHAT THE SUCCESSOR ENDPOINT NEEDS (vendor docs, changelog 48235):
  * `iso_timestamp_start` / `iso_timestamp_end` are effectively mandatory --
    without them only the last minute is queried; the window may not exceed
    24 hours and is rounded to the minute. `--hours` (default 6, max 24)
    builds the window ending now; `--start/--end` set it explicitly.
  * The SQL is ClickHouse dialect against ONE unified `logs` table, filtered
    per source:  select count(*) c from logs where source = 'edge_logs'
    MEASURED 2026-09-20 on the live endpoint: the column is `source`; the
    `source_name` the changelog summary named answers HTTP 200 with
    {"result": null, "error": "Backend error..."} (exit 4 here). Run the count
    above as the POSITIVE CONTROL before trusting any empty result.
  * Same-window A/B against the deprecated logs.all (--legacy), six pairs,
    identical to the digit, incl. a LIKE '%...%' pattern on a known positive
    row (SUPALOGS822 card, comment 16959).
  * An empty `result` is a finding ONLY next to a non-zero positive control on
    the same window; `error` non-null means the query did not run at all.

EXIT CODES, three states kept apart on purpose:
  0  the request ran; the JSON body is on stdout, the HTTP status on stderr
  2  usage error
  3  the token could not be fetched, or SUPABASE_API_BASE is not loopback -- FAIL CLOSED, nothing is sent
  4  the request failed (HTTP error or network); the vendor's message on stderr
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DASH = os.environ.get("CLAW_DASHBOARD_ORIGIN", "http://localhost:3420")
VENDOR_API = "https://api.supabase.com"
MAX_HOURS = 24


def _api_base() -> str:
    """Where the PAT goes. Only the vendor host, or a LOOPBACK stub.

    SUPABASE_API_BASE exists for the hermetic test (a stub on 127.0.0.1). An
    unrestricted override would let anyone who controls the environment redirect
    the Bearer token to a host of their choosing (review of #1427), so anything
    that is not plain-http loopback is refused BEFORE the vault is read: exit 3,
    nothing fetched, nothing sent.
    """
    raw = os.environ.get("SUPABASE_API_BASE")
    if not raw:
        return VENDOR_API
    u = urllib.parse.urlsplit(raw)
    if u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1") and not u.path.strip("/"):
        return raw.rstrip("/")
    raise RuntimeError(
        "FAIL-CLOSED, SUPABASE_API_BASE csak http://localhost vagy http://127.0.0.1 gyokeru lehet "
        f"(teszt-seam); kapott: {raw!r}. Semmit nem olvastam, semmit nem kuldtem."
    )


def _pat(vault_key: str) -> str:
    token_file = ROOT / "store" / ".dashboard-token"
    if not token_file.is_file():
        raise RuntimeError(f"FAIL-CLOSED, a dashboard-token nem olvashato: {token_file}")
    tok = token_file.read_text().strip()
    req = urllib.request.Request(
        f"{DASH}/api/vault/{urllib.parse.quote(vault_key, safe='')}",
        headers={"Authorization": "Bearer " + tok},
    )
    try:
        val = json.load(urllib.request.urlopen(req, timeout=10)).get("value", "")
    except Exception as ex:  # noqa: BLE001 - any vault failure is fail-closed
        raise RuntimeError(f"FAIL-CLOSED, a vault nem elerheto ({vault_key}): {type(ex).__name__}") from ex
    if not val:
        raise RuntimeError(f"FAIL-CLOSED, a vault nem adott erteket ({vault_key}). Semmit nem kuldtem.")
    return val


def _iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def window(hours: float | None, start: str | None, end: str | None) -> tuple[str, str]:
    if start or end:
        if not (start and end):
            raise ValueError("--start es --end egyutt kell")
        s = dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
        e = dt.datetime.fromisoformat(end.replace("Z", "+00:00"))
    else:
        h = MAX_HOURS if hours is None else hours
        if h <= 0:
            raise ValueError("--hours legyen pozitiv")
        e = dt.datetime.now(dt.timezone.utc)
        s = e - dt.timedelta(hours=h)
    if e <= s:
        raise ValueError("az ablak vege nem korabbi a kezdetenel")
    if (e - s) > dt.timedelta(hours=MAX_HOURS):
        raise ValueError(f"az ablak legfeljebb {MAX_HOURS} ora lehet (vendor-korlat); szeleteld")
    return _iso(s), _iso(e)


def query(pat: str, ref: str, sql: str, start: str, end: str, legacy: bool = False, api_base: str = VENDOR_API) -> tuple[int, str]:
    qs = urllib.parse.urlencode({"sql": sql, "iso_timestamp_start": start, "iso_timestamp_end": end})
    endpoint = "logs.all" if legacy else "logs"
    req = urllib.request.Request(
        f"{api_base}/v1/projects/{urllib.parse.quote(ref, safe='')}/analytics/endpoints/{endpoint}?{qs}",
        headers={
            "Authorization": "Bearer " + pat,
            # The Management API rejects the default python User-Agent (403).
            "User-Agent": "claudeclaw-supabase-logs/1.0",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as ex:
        return ex.code, ex.read().decode("utf-8", "replace")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("ref", nargs="?")
    ap.add_argument("sql", nargs="?")
    ap.add_argument("--hours", type=float, default=6.0)
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--vault-key", default=os.environ.get("SUPABASE_VAULT_KEY", "SUPABASE_NEW_TOKEN"))
    # TRANSITION ONLY: the deprecated logs.all endpoint (dies 2026-09-23). Lets a
    # same-window old/new baseline be taken while it still answers. Old-style
    # SQL (per-source tables, e.g. `from function_logs`), no unified table.
    ap.add_argument("--legacy", action="store_true", help="call the deprecated logs.all endpoint (until 2026-09-23)")
    a = ap.parse_args(argv)
    if not a.ref or not a.sql:
        print("usage: supabase-logs.py <project-ref> <SQL> [--hours N | --start ISO --end ISO] [--vault-key KEY]", file=sys.stderr)
        return 2
    try:
        start, end = window(a.hours if not (a.start or a.end) else None, a.start, a.end)
    except ValueError as ex:
        print(f"supabase-logs: {ex}", file=sys.stderr)
        return 2
    try:
        api_base = _api_base()  # destination first: a bad seam must not even read the vault
        pat = _pat(a.vault_key)
    except RuntimeError as ex:
        print(f"supabase-logs: {ex}", file=sys.stderr)
        return 3
    try:
        status, body = query(pat, a.ref, a.sql, start, end, legacy=a.legacy, api_base=api_base)
    except Exception as ex:  # noqa: BLE001 - network/URL errors: message only, never the token
        print(f"supabase-logs: a keres nem ment el ({type(ex).__name__}: {ex})", file=sys.stderr)
        return 4
    finally:
        pat = ""  # not a security boundary; just no lingering reference
    print(f"http={status} window={start}..{end} endpoint={'logs.all (DEPRECATED, dies 2026-09-23)' if a.legacy else 'logs'}", file=sys.stderr)
    sys.stdout.write(body if body.endswith("\n") else body + "\n")
    if not (200 <= status < 300):
        return 4
    # A 200 with a non-null `error` is NOT a result: the vendor answers a
    # rejected query (wrong dialect, wrong column, backend hiccup) with
    # {"result": null, "error": "..."} and HTTP 200. Measured 2026-09-20:
    # `source_name = ...` gave exactly this, `source = ...` returned rows. An
    # exit 0 here would let "no rows" and "did not run" look the same.
    try:
        parsed = json.loads(body)
    except ValueError:
        return 0
    if isinstance(parsed, dict) and parsed.get("error"):
        print(f"supabase-logs: a lekerdezes NEM futott le (error mezo): {parsed['error']}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
