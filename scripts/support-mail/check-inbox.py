#!/usr/bin/env python3
"""List recent messages in the configured support mailbox (read-only).

Scans the INBOX in detail, PLUS the folders Zoho auto-files mail into
(Newsletter, Notification, spam): 2026-08-10 two real correspondence
confirmations from an outreach target sat in "Newsletter" for 12 days while
every INBOX-only check reported green. A watcher that looks only at the INBOX
is blind to whatever the provider re-files -- so the main scan covers those
folders too, not a side-check.

Usage: python3 check-inbox.py [N]   (default N=10 most recent, INBOX detail)
Prints: index, date, from, subject, unread-flag. Bodies are NOT fetched here.
For the extra folders the last 5 items are listed whenever the folder is
non-empty; an unlisted folder is named with a zero so its absence is visible.
"""
import sys, os, ssl, imaplib, email
from email.header import decode_header
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

# Zoho auto-categorization targets. The spam folder name is the localized
# "Kéretlen levél" in IMAP UTF-7. If a select fails (renamed/localized
# differently), the folder is reported as UNREADABLE instead of silently
# skipped -- a scan that cannot see a folder must say so.
EXTRA_FOLDERS = [
    ("Newsletter", '"Newsletter"'),
    ("Notification", '"Notification"'),
    ("Keretlen level (spam)", '"K&AOk-retlen lev&AOk-l"'),
]


def _dec(v):
    if not v:
        return ""
    out = []
    for part, enc in decode_header(v):
        out.append(part.decode(enc or "utf-8", "replace") if isinstance(part, bytes) else part)
    return "".join(out)


def _list_recent(M, ids, unseen, n):
    for i in ids[-n:][::-1]:
        typ, msg_data = M.fetch(i, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        raw = next((p[1] for p in msg_data if isinstance(p, tuple) and p[1]), None)
        if raw is None:
            print(f"  [{i.decode()}] FETCH-hiba")
            continue
        hdr = email.message_from_bytes(raw)
        flag = "●UNREAD" if i in unseen else "       "
        print(f"  [{i.decode()}] {flag} {_dec(hdr.get('Date',''))[:31]:31} | {_dec(hdr.get('From',''))[:34]:34} | {_dec(hdr.get('Subject',''))[:50]}")


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    M = imaplib.IMAP4_SSL(lib.IMAP_HOST, lib.IMAP_PORT, ssl_context=ssl.create_default_context())
    M.login(lib.EMAIL, lib.password())

    M.select("INBOX", readonly=True)
    typ, data = M.search(None, "ALL")
    ids = data[0].split()
    unseen = set(M.search(None, "UNSEEN")[1][0].split())
    print(f"INBOX: {len(ids)} total, {len(unseen)} unread. Last {min(n, len(ids))}:")
    _list_recent(M, ids, unseen, n)

    for label, mailbox in EXTRA_FOLDERS:
        typ, cnt = M.select(mailbox, readonly=True)
        if typ != "OK":
            print(f"{label}: NEM OLVASHATO (select {typ}) -- ellenorizd a mappa-nevet")
            continue
        typ, data = M.search(None, "ALL")
        ids = data[0].split()
        unseen = set(M.search(None, "UNSEEN")[1][0].split())
        print(f"{label}: {len(ids)} total, {len(unseen)} unread.")
        if ids:
            _list_recent(M, ids, unseen, 5)

    M.logout()


if __name__ == "__main__":
    main()
