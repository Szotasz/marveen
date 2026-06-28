#!/usr/bin/env python3
"""
HTML-email kuldo INLINE (torzsbe agyazott) kepekkel, a fiREG boss@ fiokrol.
A send_html_email.py kiterjesztese: ez nem csatolmanykent, hanem a szovegbe
agyazva (cid) helyezi el a kepeket a [[PLACEHOLDER]] markerek helyere.

Hasznalat:
  python3 scripts/send_html_email_inline.py --subject "Targy" --to a@fireg.hu \
    --body /abs/body.md --img HERO=/abs/hero.jpg --img CHART=/abs/chart.png

A body markdownjaban a [[HERO]] / [[CHART]] sajat soraikban allnak; ezek
helyere kerul a megfelelo inline kep. Stilus/akcentus-guard a send_html_email.py-bol.
"""
import sys, os, argparse, smtplib, html, re, mimetypes
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from email.header import Header
from email.utils import formataddr, make_msgid

ACCENTED = set("áéíóöőúüűÁÉÍÓÖŐÚÜŰ")
HU_MARKERS = ["kerdes","koszi","valasz","kezbesit","verzio","datum","tovabbi",
              "ertesit","keszit","udvozlet","csatol","koszonjuk","megfelel","szia"]

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
    return not any(m in low for m in HU_MARKERS)

def md_to_html(text, cids):
    """Egyszeru markdown -> HTML; a [[CID]] sorok helyere inline img kerul."""
    out, in_ul = [], False
    def esc(s):
        s = html.escape(s)
        s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
        return s
    for raw in text.split("\n"):
        line = raw.rstrip()
        m = re.fullmatch(r'\[\[([A-Z0-9_]+)\]\]', line.strip())
        if m and m.group(1) in cids:
            if in_ul: out.append("</ul>"); in_ul=False
            cid = cids[m.group(1)]
            out.append(
                f'<div style="margin:18px 0;text-align:center;">'
                f'<img src="cid:{cid}" alt="" '
                f'style="max-width:100%;height:auto;border-radius:8px;'
                f'border:1px solid #eee;"></div>')
            continue
        if line.startswith("### "):
            if in_ul: out.append("</ul>"); in_ul=False
            out.append(f'<h3 style="font-size:17px;margin:14px 0 6px;">{esc(line[4:])}</h3>')
        elif line.startswith("## "):
            if in_ul: out.append("</ul>"); in_ul=False
            out.append(f'<h2 style="font-size:20px;margin:18px 0 8px;color:#1a1a1a;">{esc(line[3:])}</h2>')
        elif line.startswith("# "):
            if in_ul: out.append("</ul>"); in_ul=False
            out.append(f'<h1 style="font-size:25px;margin:18px 0 10px;color:#111;">{esc(line[2:])}</h1>')
        elif line.strip() in ("---", "***"):
            if in_ul: out.append("</ul>"); in_ul=False
            out.append('<hr style="border:none;border-top:1px solid #ddd;margin:20px 0;">')
        elif line.lstrip().startswith("- "):
            if not in_ul: out.append('<ul style="margin:0 0 12px 22px;padding:0;">'); in_ul=True
            out.append(f'<li style="margin:0 0 5px;">{esc(line.lstrip()[2:])}</li>')
        elif line.strip() == "":
            if in_ul: out.append("</ul>"); in_ul=False
            out.append("")
        else:
            if in_ul: out.append("</ul>"); in_ul=False
            out.append(f'<p style="margin:0 0 12px;">{esc(line)}</p>')
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
    ap.add_argument("--body", required=True, help="markdown body file")
    ap.add_argument("--img", action="append", default=[], help="NAME=/abs/path")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    with open(args.body) as f:
        body = f.read().rstrip("\n")
    if not body:
        raise SystemExit("ures torzs")
    if not accent_ok(body) and not args.force:
        sys.stderr.write("BLOKKOLVA: ekezet nelkuli magyarnak tunik. Ird ujra ekezettel vagy --force.\n")
        sys.exit(2)

    # cid-ek generalasa kepenkent
    images = {}  # NAME -> (cid, path)
    for spec in args.img:
        name, path = spec.split("=", 1)
        if not os.path.isfile(path):
            raise SystemExit(f"kep nem talalhato: {path}")
        cid = make_msgid(domain="fireg.hu")[1:-1]  # < > nelkul
        images[name] = (cid, path)
    cids = {name: cid for name, (cid, _) in images.items()}

    inner = md_to_html(body, cids)
    html_body = HTML_TMPL.format(content=inner)
    # plain fallback: placeholderek + markdown jelek kiszedese
    plain = re.sub(r'\[\[[A-Z0-9_]+\]\]', '', body)

    PW = _pw(); SENDER = "boss@fireg.hu"
    outer = MIMEMultipart("related")
    outer["Subject"] = str(Header(args.subject, "utf-8"))
    outer["From"] = formataddr((str(Header("Boss (fiREG)", "utf-8")), SENDER))
    outer["To"] = args.to
    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(plain, "plain", "utf-8"))
    alt.attach(MIMEText(html_body, "html", "utf-8"))
    outer.attach(alt)
    for name, (cid, path) in images.items():
        ctype, _ = mimetypes.guess_type(path)
        subtype = (ctype or "image/jpeg").split("/", 1)[1]
        with open(path, "rb") as f:
            img = MIMEImage(f.read(), _subtype=subtype)
        img.add_header("Content-ID", f"<{cid}>")
        img.add_header("Content-Disposition", "inline", filename=os.path.basename(path))
        outer.attach(img)

    s = smtplib.SMTP("mail.fws.hu", 587, timeout=40)
    s.starttls(); s.login(SENDER, PW)
    s.sendmail(SENDER, [args.to], outer.as_string()); s.quit()
    print(f"OK: inline HTML email sent to {args.to} ({len(images)} inline image)")

if __name__ == "__main__":
    main()
