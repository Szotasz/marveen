#!/usr/bin/env python3
"""Send an email FROM the configured support mailbox via SMTP (implicit TLS:465).

Usage:
  python3 send.py --to a@b.hu --subject "..." --body "..." [--cc you@example.com] [--html]
Body can also be piped on stdin if --body is omitted.
Mailbox / hosts come from config (.env); password is pulled from the vault at
runtime (never stored/printed). --html sends the body as an HTML alternative.
"""
import sys, os, ssl, smtplib, argparse
from email.message import EmailMessage
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body", default=None)
    ap.add_argument("--cc", default=None)
    ap.add_argument("--html", action="store_true")
    # --html-wrap takes PLAIN text and builds the light HTML itself, keeping the
    # original text as the text/plain alternative. Prefer it over --html: --html
    # replaces the plain part with a useless "look at this in an HTML client"
    # stub, which is what plain-text readers and previews then show.
    ap.add_argument("--html-wrap", action="store_true")
    a = ap.parse_args()
    body = a.body if a.body is not None else sys.stdin.read()

    msg = EmailMessage()
    msg["From"] = f"{lib.FROM_NAME} <{lib.FROM_ADDRESS}>"
    msg["To"] = a.to
    if a.cc:
        msg["Cc"] = a.cc
    msg["Subject"] = a.subject
    if a.html_wrap:
        import html_wrap
        msg.set_content(body)
        msg.add_alternative(html_wrap.to_html(body), subtype="html")
    elif a.html:
        msg.set_content("A levél HTML formátumú; nézd HTML-képes kliensben.")
        msg.add_alternative(body, subtype="html")
    else:
        msg.set_content(body)

    rcpts = [a.to] + ([a.cc] if a.cc else [])
    # FQDN EHLO name is REQUIRED: some SMTP providers reject EHLO with a private/bare
    # IP ([192.168.x.x]) -> "421 4.4.2 timeout exceeded". local_hostname forces a
    # proper FQDN; derive it from the mailbox domain.
    ehlo_host = lib.EMAIL.split("@")[-1] if "@" in lib.EMAIL else "localhost"
    with smtplib.SMTP_SSL(lib.SMTP_HOST, lib.SMTP_PORT,
                          local_hostname=ehlo_host,
                          context=ssl.create_default_context(), timeout=45) as s:
        s.login(lib.EMAIL, lib.password())
        s.send_message(msg, to_addrs=rcpts)
    print(f"SENT from {lib.FROM_ADDRESS} to {a.to}" + (f" cc {a.cc}" if a.cc else ""))


if __name__ == "__main__":
    main()
