#!/usr/bin/env python3
"""Send an email FROM the configured support mailbox via SMTP (implicit TLS:465).

Usage:
  python3 send.py --to a@b.hu --subject "..." --body "..." [--cc you@example.com] [--html]
Body can also be piped on stdin if --body is omitted.
Mailbox / hosts come from config (.env); password is pulled from the vault at
runtime (never stored/printed). --html sends the body as an HTML alternative.
"""
import sys, os, ssl, smtplib, argparse, imaplib, time
from email.message import EmailMessage
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

# A gazda cime: a kimeno support-levelek KOTELEZO masolati cimzettje.
OWNER_CC = os.environ.get("SUPPORT_OWNER_CC", "szota.szabolcs@gmail.com")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body", default=None)
    # A GAZDA-CC MOSTANTOL ALAPERTELMEZES, NEM EMLEKEZET (Marveen, mert eset 2026-09-14).
    # A CLAUDE.md kimondja, hogy MINDEN kimeno levelnek CC-znie kell a gazdat, kivetel nelkul.
    # Ez a szabaly eddig CSAK PROZABAN letezett: a `--cc` opcionalis volt, default None.
    # Merve: a mai negy Comline-levelbol HAROM CC nelkul ment ki (INBOX.Sent fejlecek), ezert a
    # gazda a sajat postalada-jaban nem latta a megoldast, es ugy jelezte vissza, mintha az ugy
    # meg allna. Nem a szabaly volt rossz, hanem az, hogy nem volt KODUTBA kotve.
    ap.add_argument("--cc", default=OWNER_CC,
                    help=f"CC-cim (alapertelmezes: {OWNER_CC}); kikapcsolas: --no-owner-cc")
    ap.add_argument("--no-owner-cc", action="store_true",
                    help="KIMONDOTT lemondas a gazda-CC-rol -- csak akkor, ha a cimzettnek nem szabad latnia")
    ap.add_argument("--html", action="store_true")
    # --html-wrap takes PLAIN text and builds the light HTML itself, keeping the
    # original text as the text/plain alternative. Prefer it over --html: --html
    # replaces the plain part with a useless "look at this in an HTML client"
    # stub, which is what plain-text readers and previews then show.
    ap.add_argument("--html-wrap", action="store_true")
    a = ap.parse_args()
    if a.no_owner_cc and a.cc == OWNER_CC:
        a.cc = None
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
    pw = lib.password()
    with smtplib.SMTP_SSL(lib.SMTP_HOST, lib.SMTP_PORT,
                          local_hostname=ehlo_host,
                          context=ssl.create_default_context(), timeout=45) as s:
        s.login(lib.EMAIL, pw)
        s.send_message(msg, to_addrs=rcpts)
    print(f"SENT from {lib.FROM_ADDRESS} to {a.to}" + (f" cc {a.cc}" if a.cc else " CC NELKUL (--no-owner-cc)"))

    # AUDIT TRAIL (SUPPJOGVAK901): SMTP send alone does NOT populate the mailbox
    # Sent folder, so an outgoing auto-reply used to leave no readable record --
    # a later "did we ever send X to a paying customer?" question then had no
    # source to answer from. Append a copy to Sent over IMAP so every send is
    # auditable. Fail-safe: the mail is ALREADY sent by this point, so an append
    # error is logged (stderr) but never raised -- the reply must not be treated
    # as failed just because its audit copy could not be filed.
    try:
        M = imaplib.IMAP4_SSL(lib.IMAP_HOST, lib.IMAP_PORT,
                              ssl_context=ssl.create_default_context())
        M.login(lib.EMAIL, pw)
        M.append("INBOX.Sent", "(\\Seen)",
                 imaplib.Time2Internaldate(time.time()), msg.as_bytes())
        M.logout()
        print("audit: copy appended to INBOX.Sent")
    except Exception as e:
        print(f"audit: Sent-append FAILED (mail WAS sent to {a.to}): {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
