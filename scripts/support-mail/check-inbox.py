#!/usr/bin/env python3
"""List recent messages in the support@aiamindennapokban.hu INBOX (read-only).

Usage: python3 check-inbox.py [N]   (default N=10 most recent)
Prints: index, date, from, subject, unread-flag. Bodies are NOT fetched here.
"""
import sys, ssl, imaplib, email
from email.header import decode_header
sys.path.insert(0, "/Users/marvin/ClaudeClaw/scripts/support-mail")
import lib


def _dec(v):
    if not v:
        return ""
    out = []
    for part, enc in decode_header(v):
        out.append(part.decode(enc or "utf-8", "replace") if isinstance(part, bytes) else part)
    return "".join(out)


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    M = imaplib.IMAP4_SSL(lib.IMAP_HOST, lib.IMAP_PORT, ssl_context=ssl.create_default_context())
    M.login(lib.EMAIL, lib.password())
    M.select("INBOX", readonly=True)
    typ, data = M.search(None, "ALL")
    ids = data[0].split()
    unseen = set(M.search(None, "UNSEEN")[1][0].split())
    recent = ids[-n:][::-1]
    print(f"INBOX: {len(ids)} total, {len(unseen)} unread. Last {len(recent)}:")
    for i in recent:
        typ, msg_data = M.fetch(i, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        hdr = email.message_from_bytes(msg_data[0][1])
        flag = "●UNREAD" if i in unseen else "       "
        print(f"  [{i.decode()}] {flag} {_dec(hdr.get('Date',''))[:31]:31} | {_dec(hdr.get('From',''))[:34]:34} | {_dec(hdr.get('Subject',''))[:50]}")
    M.logout()


if __name__ == "__main__":
    main()
