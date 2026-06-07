#!/usr/bin/env python3
"""Read the body of a specific support@ inbox message (read-only, no \\Seen flag set).

Usage: python3 read.py <imap_id>
Prints: From, Subject, Date, then the plain-text body (HTML stripped to text if needed).
Does NOT mark the message as read (uses BODY.PEEK).
"""
import sys, ssl, imaplib, email, re
from email.header import decode_header
sys.path.insert(0, "/Users/marvin/ClaudeClaw/scripts/support-mail")
import lib


def _dec(v):
    if not v:
        return ""
    return "".join(p.decode(e or "utf-8", "replace") if isinstance(p, bytes) else p
                   for p, e in decode_header(v))


def _body(msg):
    if msg.is_multipart():
        # prefer text/plain
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition", "")):
                return part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace")
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                html = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace")
                return re.sub(r"<[^>]+>", " ", html)
        return ""
    payload = msg.get_payload(decode=True)
    if not payload:
        return ""
    text = payload.decode(msg.get_content_charset() or "utf-8", "replace")
    if msg.get_content_type() == "text/html":
        text = re.sub(r"<[^>]+>", " ", text)
    return text


def main():
    if len(sys.argv) < 2:
        print("usage: read.py <imap_id>"); sys.exit(1)
    mid = sys.argv[1]
    M = imaplib.IMAP4_SSL(lib.IMAP_HOST, lib.IMAP_PORT, ssl_context=ssl.create_default_context())
    M.login(lib.EMAIL, lib.password())
    M.select("INBOX", readonly=True)
    typ, data = M.fetch(mid, "(BODY.PEEK[])")
    if typ != "OK" or not data or not data[0]:
        print("not found"); M.logout(); sys.exit(2)
    msg = email.message_from_bytes(data[0][1])
    print("From:", _dec(msg.get("From")))
    print("Subject:", _dec(msg.get("Subject")))
    print("Date:", _dec(msg.get("Date")))
    print("---")
    print(_body(msg).strip()[:4000])
    M.logout()


if __name__ == "__main__":
    main()
