#!/usr/bin/env python3
"""Send an email FROM support@aiamindennapokban.hu via Hostinger SMTP (implicit TLS:465).

Usage:
  python3 send.py --to a@b.hu --subject "..." --body "..." [--cc you@example.com] [--html]
Body can also be piped on stdin if --body is omitted.
Password is pulled from the vault at runtime (never stored/printed).
"""
import sys, ssl, smtplib, argparse
from email.message import EmailMessage
sys.path.insert(0, "/Users/marvin/ClaudeClaw/scripts/support-mail")
import lib


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body", default=None)
    ap.add_argument("--cc", default=None)
    ap.add_argument("--html", action="store_true")
    a = ap.parse_args()
    body = a.body if a.body is not None else sys.stdin.read()

    msg = EmailMessage()
    msg["From"] = f"AI a mindennapokban support <{lib.EMAIL}>"
    msg["To"] = a.to
    if a.cc:
        msg["Cc"] = a.cc
    msg["Subject"] = a.subject
    if a.html:
        msg.set_content("A levél HTML formátumú; nézd HTML-képes kliensben.")
        msg.add_alternative(body, subtype="html")
    else:
        msg.set_content(body)

    rcpts = [a.to] + ([a.cc] if a.cc else [])
    # FQDN EHLO name is REQUIRED: Hostinger SMTP rejects EHLO with a private/bare IP
    # ([192.168.x.x]) -> "421 4.4.2 timeout exceeded". local_hostname forces a proper FQDN.
    with smtplib.SMTP_SSL(lib.SMTP_HOST, lib.SMTP_PORT,
                          local_hostname="aiamindennapokban.hu",
                          context=ssl.create_default_context(), timeout=45) as s:
        s.login(lib.EMAIL, lib.password())
        s.send_message(msg, to_addrs=rcpts)
    print(f"SENT from {lib.EMAIL} to {a.to}" + (f" cc {a.cc}" if a.cc else ""))


if __name__ == "__main__":
    main()
