#!/usr/bin/env python3
"""
Kozos HTML-email kuldo a fiREG boss@ fiokrol. Attila ismetelt korrekcioja
(2026-06-16): a plain-text email OLVASHATATLAN neki, HTML kell olvashato,
nagyobb fonttal, az o stilusahoz hasonloan.

A body egyszeru szovegbol / konnyu markdownbol (#/##/### fejlec, - bullet,
**bold**, ures sor = bekezdes) olvashato HTML-le alakul (Arial/Helvetica,
~16px torzs, 1.6 sorkoz), es multipart/alternative-kent megy (HTML + plain
fallback), opcionalis csatolmanyokkal.

Hasznalat:
  echo "Szia Attila, ..." | python3 scripts/send_html_email.py \
    --subject "Targy" [--to a@fireg.hu] [--attach /abs/kep.jpg ...]
"""
import sys, os, argparse, smtplib, html, re
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from email.header import Header
from email.utils import formataddr

ACCENTED = set("áéíóöőúüűÁÉÍÓÖŐÚÜŰ")
HU_MARKERS = ["kerdes","koszi","valasz","kezbesit","verzio","datum","tovabbi",
              "ertesit","keszit","udvozlet","csatol","koszonjuk","megfelel"]

def _pw():
    path = os.path.join(os.path.dirname(__file__), "..", "store", ".email-creds")
    with open(path) as f:
        for line in f:
            for k in ("EMAIL_PASS=", "IMAP_PASS=", "SMTP_PASS="):
                if line.startswith(k):
                    return line.strip().split("=", 1)[1]
    raise SystemExit("EMAIL_PASS nincs a store/.email-creds-ben")

def accent_ok(text):
    if any(c in ACCENTED for c in text):
        return True
    low = text.lower()
    return not any(m in low for m in HU_MARKERS)  # all-ASCII de nem magyar-gyanus -> ok

def md_to_html(text):
    """Egyszeru, biztonsagos markdown -> HTML (escape-elt)."""
    out, in_ul = [], False
    def esc(s):
        s = html.escape(s)
        s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
        return s
    for raw in text.split("\n"):
        line = raw.rstrip()
        if line.startswith("### "):
            if in_ul: out.append("</ul>"); in_ul=False
            out.append(f"<h3>{esc(line[4:])}</h3>")
        elif line.startswith("## "):
            if in_ul: out.append("</ul>"); in_ul=False
            out.append(f"<h2>{esc(line[3:])}</h2>")
        elif line.startswith("# "):
            if in_ul: out.append("</ul>"); in_ul=False
            out.append(f"<h1>{esc(line[2:])}</h1>")
        elif line.strip() in ("---", "***"):
            if in_ul: out.append("</ul>"); in_ul=False
            out.append("<hr>")
        elif line.lstrip().startswith("- "):
            if not in_ul: out.append("<ul>"); in_ul=True
            out.append(f"<li>{esc(line.lstrip()[2:])}</li>")
        elif line.strip() == "":
            if in_ul: out.append("</ul>"); in_ul=False
            out.append("")
        else:
            if in_ul: out.append("</ul>"); in_ul=False
            out.append(f"<p>{esc(line)}</p>")
    if in_ul: out.append("</ul>")
    return "\n".join(out)

HTML_TMPL = """<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;">
<div style="max-width:680px;margin:0 auto;padding:28px 32px;background:#ffffff;
font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#222;">
{content}
</div></body></html>"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", required=True)
    ap.add_argument("--to", default="a@fireg.hu")
    ap.add_argument("--cc", action="append", default=[])
    ap.add_argument("--attach", action="append", default=[])
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    body = sys.stdin.read().rstrip("\n")
    if not body:
        raise SystemExit("ures torzs")
    if not accent_ok(body) and not args.force:
        sys.stderr.write("BLOKKOLVA: ekezet nelkuli magyarnak tunik. Ird ujra ekezettel vagy --force.\n")
        sys.exit(2)

    inner = md_to_html(body)
    # h1/h2/h3 inline-stilus (email-kliensek nem mind eszik a <style>-t)
    inner = inner.replace("<h1>", '<h1 style="font-size:24px;margin:18px 0 10px;">')
    inner = inner.replace("<h2>", '<h2 style="font-size:20px;margin:16px 0 8px;">')
    inner = inner.replace("<h3>", '<h3 style="font-size:17px;margin:14px 0 6px;">')
    inner = inner.replace("<p>", '<p style="margin:0 0 12px;">')
    inner = inner.replace("<ul>", '<ul style="margin:0 0 12px 22px;padding:0;">')
    inner = inner.replace("<li>", '<li style="margin:0 0 5px;">')
    inner = inner.replace("<hr>", '<hr style="border:none;border-top:1px solid #ddd;margin:18px 0;">')
    html_body = HTML_TMPL.format(content=inner)

    PW = _pw(); SENDER = "boss@fireg.hu"
    outer = MIMEMultipart("mixed")
    outer["Subject"] = str(Header(args.subject, "utf-8"))
    outer["From"] = formataddr((str(Header("Boss (fiREG)", "utf-8")), SENDER))
    outer["To"] = args.to
    if args.cc:
        outer["Cc"] = ", ".join(args.cc)
    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(body, "plain", "utf-8"))
    alt.attach(MIMEText(html_body, "html", "utf-8"))
    outer.attach(alt)
    for path in args.attach:
        ctype = "image" if path.lower().endswith((".jpg",".jpeg",".png",".gif")) else "application"
        sub = path.rsplit(".",1)[-1].lower()
        part = MIMEBase(ctype, sub)
        with open(path, "rb") as f:
            part.set_payload(f.read())
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{os.path.basename(path)}"')
        outer.attach(part)

    s = smtplib.SMTP("mail.fws.hu", 587, timeout=40)
    s.starttls(); s.login(SENDER, PW)
    s.sendmail(SENDER, [args.to] + list(args.cc), outer.as_string()); s.quit()
    cc_note = f" cc {', '.join(args.cc)}" if args.cc else ""
    print(f"OK: HTML email sent to {args.to}{cc_note} ({len(args.attach)} attachment)")

if __name__ == "__main__":
    main()
