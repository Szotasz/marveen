#!/usr/bin/env python3
"""Consume an email_send approval on the SEND path, right before the letter goes out (f2c5edb0).

The email approval gate (scripts/hooks/email-approval-gate.py) consumes an approval only when it can
read the send in the command text. A tool that mails through a script on another host (ssh + a
mailer) is invisible to it, so its approved row was never consumed and could authorize a second send.
Such a tool calls this helper immediately BEFORE it sends and sends ONLY when it exits 0: the dashboard
flips consumed_at in one conditional write (POST /api/approvals/<id>/consume), so of two attempts on
the same approval exactly one gets a yes.

Usage:
  approval-consume.py --id <approval id> --content-hash <64-hex anchor> --consumer <tool name>
                      [--message-id '<local@domain>'] [--api http://localhost:3420] [--token-file PATH]
  --message-id: the Message-Id the tool generated and will hand to its mailer, so the approval row
                names the letter that used it.

Exit codes (the caller sends only on 0; everything else means DO NOT SEND):
  0  consumed: this letter may go out now
  3  refused (409): already_consumed, not_approved, hash_mismatch, expired or wrong_category
  4  unknown approval id (404)
  2  usage error, missing token, unreachable dashboard, any other status or an unreadable answer
One JSON line on stdout says what happened; nothing secret is printed.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_API = os.environ.get("APPROVALS_API", "http://localhost:3420")
DEFAULT_TOKEN_FILE = os.path.join(ROOT, "store", ".dashboard-token")

RC_CONSUMED, RC_USAGE, RC_REFUSED, RC_NOT_FOUND = 0, 2, 3, 4
_HASH = re.compile(r"^[0-9a-f]{64}$")
_MSGID = re.compile(r"^<[^<>\s@]+@[^<>\s@]+>$")


def consume(api, token, approval_id, content_hash, consumer, message_id=None, timeout=15):
    """Return (rc, body). Never raises for an HTTP or network failure: any outcome other than a
    200 maps to a non-zero rc, so a caller that sends only on rc 0 fails closed."""
    if not _HASH.match(content_hash or ""):
        return RC_USAGE, {"error": "content_hash must be the 64-char lowercase sha256 hex anchor"}
    if not consumer or not consumer.strip():
        return RC_USAGE, {"error": "consumer is required"}
    if message_id is not None and not _MSGID.match(message_id):
        return RC_USAGE, {"error": "message_id must look like <local@domain>"}
    if not approval_id or "/" in approval_id:
        return RC_USAGE, {"error": "approval id is required and may not contain '/'"}
    payload = {"content_hash": content_hash, "consumer": consumer.strip()}
    if message_id is not None:
        payload["message_id"] = message_id
    req = urllib.request.Request(
        api.rstrip("/") + "/api/approvals/" + approval_id + "/consume",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read()
    except Exception as exc:  # noqa: BLE001 -- unreachable dashboard: do not send
        return RC_USAGE, {"error": "dashboard unreachable: %s" % type(exc).__name__}
    try:
        body = json.loads(raw.decode("utf-8") or "{}")
    except Exception:  # noqa: BLE001 -- an unreadable answer is not a yes
        return RC_USAGE, {"error": "unreadable answer", "status": status}
    if status == 200 and body.get("ok") is True:
        return RC_CONSUMED, body
    if status == 409:
        return RC_REFUSED, body
    if status == 404:
        return RC_NOT_FOUND, body
    return RC_USAGE, {"error": "unexpected answer", "status": status, "body": body}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--id", required=True)
    ap.add_argument("--content-hash", required=True)
    ap.add_argument("--consumer", required=True)
    ap.add_argument("--message-id")
    ap.add_argument("--api", default=DEFAULT_API)
    ap.add_argument("--token-file", default=DEFAULT_TOKEN_FILE)
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return RC_USAGE
    try:
        token = open(a.token_file, encoding="utf-8").read().strip()
    except OSError:
        print(json.dumps({"consumed": False, "rc": RC_USAGE, "error": "token file not readable"}))
        return RC_USAGE
    if not token:
        print(json.dumps({"consumed": False, "rc": RC_USAGE, "error": "token file is empty"}))
        return RC_USAGE
    rc, body = consume(a.api, token, a.id, a.content_hash, a.consumer, a.message_id)
    out = {"consumed": rc == RC_CONSUMED, "rc": rc}
    if rc == RC_CONSUMED:
        appr = body.get("approval") or {}
        out.update({k: appr.get(k) for k in ("id", "consumed_at", "consumed_by", "consumed_ref")})
    else:
        out.update({k: body[k] for k in ("reason", "error", "status") if k in body})
        if isinstance(body.get("approval"), dict):
            out["approval"] = body["approval"]
    print(json.dumps(out, ensure_ascii=False))
    return rc


if __name__ == "__main__":
    sys.exit(main())
