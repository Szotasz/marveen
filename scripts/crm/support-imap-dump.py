#!/usr/bin/env python3
"""support@ IMAP dump for the CRM mail sync (CRM1MAILSYNC922). READ-ONLY.

Reuses scripts/support-mail/lib.py for the mailbox config and the vault-held
password (fetched inside this process, never printed, never in argv). Selects
each mailbox readonly and fetches with BODY.PEEK[], so nothing is marked read.

Output: one JSON object per line (UTF-8) with the parsed headers and the text
body; the TypeScript side (src/crm/imap-sync.ts) normalises and upserts.

    python3 scripts/crm/support-imap-dump.py --mailbox INBOX --mailbox INBOX.Sent \
        --since INBOX=120 --since INBOX.Sent=40 --limit 500

    python3 scripts/crm/support-imap-dump.py --parse-file some.eml   # offline, for tests

Exit codes: 0 ok; 2 usage; 3 config/credential missing (fail-closed, nothing
fetched); 4 IMAP error (partial output may precede it on stdout).
"""
import argparse, email, json, os, ssl, sys
from email import policy
from email.utils import parsedate_to_datetime, getaddresses

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "support-mail"))


def body_parts(msg):
    text, html = [], []
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        ct = part.get_content_type()
        if ct not in ("text/plain", "text/html"):
            continue
        try:
            payload = part.get_content()
        except Exception:
            raw = part.get_payload(decode=True) or b""
            payload = raw.decode(part.get_content_charset() or "utf-8", "replace")
        (text if ct == "text/plain" else html).append(payload)
    return ("\n".join(text).strip() or None), ("\n".join(html).strip() or None)


def addr_list(msg, name):
    vals = msg.get_all(name, [])
    return [a.lower() for _, a in getaddresses(vals) if a]


def parse_message(raw_bytes, mailbox, uid):
    msg = email.message_from_bytes(raw_bytes, policy=policy.default)
    date_epoch = None
    d = msg.get("Date")
    if d:
        try:
            date_epoch = int(parsedate_to_datetime(d).timestamp())
        except Exception:
            date_epoch = None
    text, html = body_parts(msg)
    return {
        "mailbox": mailbox,
        "uid": str(uid),
        "message_id": (msg.get("Message-ID") or None),
        "in_reply_to": (msg.get("In-Reply-To") or None),
        "references": (msg.get("References") or None),
        "from": (addr_list(msg, "From") or [None])[0],
        "to": addr_list(msg, "To"),
        "cc": addr_list(msg, "Cc"),
        "subject": (str(msg.get("Subject")) if msg.get("Subject") is not None else None),
        "date_epoch": date_epoch,
        "x_forwarded_to": (msg.get("X-Forwarded-To") or None),
        "body_text": text,
        "body_html": html if text is None else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mailbox", action="append", default=[])
    ap.add_argument("--since", action="append", default=[], help="MAILBOX=UID, fetch strictly greater")
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--parse-file", help="offline: parse one RFC822 file and print one line")
    a = ap.parse_args()

    if a.parse_file:
        with open(a.parse_file, "rb") as f:
            print(json.dumps(parse_message(f.read(), "FILE", 0), ensure_ascii=False))
        return 0

    if not a.mailbox:
        print("usage: --mailbox INBOX [--mailbox INBOX.Sent] [--since MAILBOX=UID] [--limit N]", file=sys.stderr)
        return 2
    try:
        import lib  # noqa: E402  (scripts/support-mail/lib.py)
        pw = lib.password()
    except Exception as ex:  # fail-closed: no config or no vault value -> nothing fetched
        print(f"FAIL-CLOSED: support mailbox config/credential missing ({type(ex).__name__}: {ex})", file=sys.stderr)
        return 3
    since = {}
    for s in a.since:
        k, _, v = s.partition("=")
        if k and v.isdigit():
            since[k] = int(v)
    import imaplib
    try:
        M = imaplib.IMAP4_SSL(lib.IMAP_HOST, lib.IMAP_PORT, ssl_context=ssl.create_default_context())
        M.login(lib.EMAIL, pw)
    except Exception as ex:
        print(f"IMAP login failed: {type(ex).__name__}", file=sys.stderr)
        return 4
    emitted = 0
    try:
        for mb in a.mailbox:
            typ, _ = M.select(mb, readonly=True)
            if typ != "OK":
                print(f"IMAP select failed: {mb}", file=sys.stderr)
                continue
            lo = since.get(mb, 0) + 1
            typ, data = M.uid("search", None, f"UID {lo}:*")
            if typ != "OK" or not data or not data[0]:
                continue
            uids = [int(u) for u in data[0].split()]
            uids = [u for u in uids if u >= lo][: max(0, a.limit - emitted)]
            for u in uids:
                typ, fetched = M.uid("fetch", str(u), "(BODY.PEEK[])")
                if typ != "OK" or not fetched or not isinstance(fetched[0], tuple):
                    continue
                print(json.dumps(parse_message(fetched[0][1], mb, u), ensure_ascii=False), flush=True)
                emitted += 1
                if emitted >= a.limit:
                    break
    finally:
        try:
            M.logout()
        except Exception:
            pass
    print(f"dumped {emitted} message(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
