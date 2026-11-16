"""GMAILDRAFT1116: the project's canonical Gmail DRAFT writer. It writes one draft and never sends.

    python3 -I -S <install>/scripts/hooks/gmail-draft.py --subject S --text FILE [--html FILE]
        [--to A] [--cc A] [--bcc A] [--inline IMG ...] [--attach FILE ...] [--also-attach]
        [--signature-html FILE --signature-text FILE] [--thread ID --in-reply-to MSGID]

Every file (body, signature, image, attachment) must be under the install's store/, not hidden, not secret-looking.
The mailbox is the one whose OAuth client and gmail.compose refresh token the owner stored in the vault as
GMAIL_DRAFT_OAUTH_CLIENT and GMAIL_DRAFT_COMPOSE_REFRESH; no other vault key is read.

What it does, and the whole of what it reaches on the network:
  1. GET  http://127.0.0.1:<dashboard port>/api/vault/GMAIL_DRAFT_*   the OAuth client and the refresh token
  2. POST https://oauth2.googleapis.com/token                  a fresh access token (refresh_token grant)
  3. POST https://gmail.googleapis.com/gmail/v1/users/me/drafts    drafts.create: the draft
  4. GET  https://gmail.googleapis.com/gmail/v1/users/me/drafts/<id>?format=full   the read-back
There is no drafts.send, no messages.send, no messages.insert/import, no SMTP, no process and no dynamic import.

Why it exists: email-approval-gate.py levels a Bash send (email_send), and a python script given --to is a send
unless it is a stdlib allowlist draft writer (COPYGATEDRAFTFP1104); an HTTPS Gmail-API draft writer needs urllib, so
it needed an approval like a sender. This file is recognised as a DRAFT by the gate (canonical_draft_run), but only
when the whole command is one literal `python3 -I -S <this exact path> --known-flag value ...` call AND the file's
sha256 equals GMAIL_DRAFT_SHA256 in email-approval-gate.py. Any edit of this file makes it a send again until the
gate's pin is updated in the same commit (a test keeps the two equal), and a copy elsewhere is a send. It lives in
scripts/hooks/ because that tree is write-protected for agents (db-write-gate.mjs).

The draft lands in the mailbox of the refresh token; a person sends it later, through the levelled paths. Inline
images get Gmail's own composer form (Content-ID / X-Attachment-Id ii_<10 alnum>, src="cid:ii_..."); the HTML refers
to an inline image as cid:<file name>. An .ics attachment is typed application/ics (Gmail drops text/calendar parts
of API-created drafts). Prints the draft id on stdout, READBACK_OK / READBACK_BAD on stderr (exit 3 on a mismatch).
"""
import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from email import encoders
from email.header import Header
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOKEN_URL = "https://oauth2.googleapis.com/token"
DRAFTS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts"
# Revizor 4076 L2 (Marveen 4078): ONE mailbox per install, by fixed vault key names. The owner stores his own
# mailbox's OAuth client JSON and gmail.compose refresh token under these names; no other key is read.
VAULT_CLIENT_KEY = "GMAIL_DRAFT_OAUTH_CLIENT"
VAULT_REFRESH_KEY = "GMAIL_DRAFT_COMPOSE_REFRESH"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_FILE = 25 * 1024 * 1024
SECRET_NAME = re.compile(r"(?i)token|vault|secret|credential|passw|\.(pem|key|p12|pfx|der|crt|kdbx)$|^id_|_ed25519|_rsa")

# Revizor 4076 L4: -I drops the PYTHON* settings only. A proxy or a CA bundle from the environment would route the
# access token (which can send) through someone else's TLS endpoint, so they are dropped before any request.
for _k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
           "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE"):
    os.environ.pop(_k, None)


def checked_file(path):
    """Revizor 4076 L2 (Marveen 4078): every file the draft carries (body, signature, image, attachment) must be a
    regular file of at most 25 MB under the install's store/, symlinks resolved, with no hidden (dot) component and
    no name that looks like a secret (token, vault, secret, credential, password, a key or certificate file)."""
    real = os.path.realpath(path)
    store = os.path.realpath(os.path.join(ROOT, "store"))
    if not real.startswith(store + os.sep):
        sys.exit("gmail-draft: only a file under the install's store/ is used: %s" % path)
    parts = real[len(store) + 1:].split(os.sep)
    # Revizor 4080 / Marveen 4083: store/backup/ holds copies of state files (sessions, codes, users) under
    # ordinary names, so the whole tree is out
    # Revizor 4089 L5: on a case-insensitive file system store/BACKUP is the same folder, and realpath keeps the
    # spelling it was given: compared case-folded AND as the same directory
    backup = os.path.join(store, "backup")
    first = os.path.join(store, parts[0])
    if parts[0].casefold() == "backup" or (os.path.isdir(backup) and os.path.exists(first)
                                           and os.path.samefile(first, backup)):
        sys.exit("gmail-draft: a file under store/backup/ is not used: %s" % path)
    if any(part.startswith(".") or SECRET_NAME.search(part) for part in parts):
        sys.exit("gmail-draft: a hidden or secret-looking file is not used: %s" % path)
    if not os.path.isfile(real):
        sys.exit("gmail-draft: not a regular file: %s" % path)
    if os.path.getsize(real) > MAX_FILE:
        sys.exit("gmail-draft: file over 25 MB: %s" % path)
    return real


def dashboard_base():
    """The local dashboard only: a port from the environment is taken as digits, the host is fixed."""
    port = os.environ.get("MARVEEN_WEB_PORT") or os.environ.get("WEB_PORT") or "3420"
    if not port.isdigit():
        sys.exit("gmail-draft: the dashboard port is not a number")
    return "http://127.0.0.1:%s" % port


def vault_get(key):
    with open(os.path.join(ROOT, "store", ".dashboard-token"), encoding="utf-8") as fh:
        tok = fh.read().strip()
    rq = urllib.request.Request(dashboard_base() + "/api/vault/" + key, headers={"Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(rq, timeout=15) as resp:
            value = json.load(resp).get("value", "")
    except urllib.error.HTTPError as e:
        sys.exit("gmail-draft: vault read %s failed (%d)" % (key, e.code))
    if not value:
        sys.exit("gmail-draft: vault key %s is empty" % key)
    return value


def access_token():
    raw = json.loads(vault_get(VAULT_CLIENT_KEY))
    c = raw.get("installed") or raw.get("web") or raw
    form = {"client_id": c["client_id"], "client_secret": c["client_secret"],
            "refresh_token": vault_get(VAULT_REFRESH_KEY), "grant_type": "refresh_token"}
    rq = urllib.request.Request(TOKEN_URL, data=urllib.parse.urlencode(form).encode(), method="POST",
                                headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(rq, timeout=20) as resp:
            return json.load(resp)["access_token"]
    except urllib.error.HTTPError as e:
        sys.exit("gmail-draft: token refresh failed (%d)" % e.code)


def new_id():
    return "ii_" + base64.b32encode(os.urandom(10)).decode().lower()[:10]


def img_size(data):
    """(width, height) of a PNG or JPEG, else None."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        if data[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                mk = data[i + 1]
                if mk in (0xC0, 0xC1, 0xC2):
                    return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
                i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    except (IndexError, ValueError):
        pass
    return None


def file_part(path, data, cid=None):
    ct = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if path.lower().endswith(".ics"):
        ct = "application/ics"
    mt, st = ct.split("/", 1)
    name = os.path.basename(path)
    p = MIMEBase(mt, st, name=name)
    p.set_payload(data)
    encoders.encode_base64(p)
    p.add_header("Content-Disposition", "attachment", filename=name)
    if cid:
        p.add_header("X-Attachment-Id", cid)
        p.add_header("Content-ID", "<%s>" % cid)
    return p


def fix_img_tag(tag, size):
    if not size:
        return tag
    w, h = size
    wm = re.search(r'\swidth="?(\d+)', tag)
    hm = re.search(r'\sheight="?(\d+)', tag)
    if wm and not hm and w:
        return tag[:-1].rstrip("/ ") + ' height="%d">' % round(int(wm.group(1)) * h / w)
    if not wm and not hm:
        return tag[:-1].rstrip("/ ") + ' width="%d" height="%d">' % (w, h)
    return tag


def read_text(path):
    with open(checked_file(path), encoding="utf-8") as fh:
        return fh.read()


def read_bytes(path):
    with open(checked_file(path), "rb") as fh:
        return fh.read()


def build_message(a):
    """The MIME letter: [multipart/mixed >] multipart/related > (alternative(text, html), inline images)."""
    text = read_text(a.text)
    html = read_text(a.html) if a.html else None
    if a.signature_text:
        text = text.rstrip() + "\n\n-- \n" + read_text(a.signature_text)
    if a.signature_html and html is not None:
        html += '<br><div class="gmail_signature">' + read_text(a.signature_html) + "</div>"
    imgs = []
    for path in a.inline:
        if html is None:
            sys.exit("gmail-draft: --inline needs --html")
        data = read_bytes(path)
        iid = new_id()
        imgs.append((path, data, iid))
        html = html.replace("cid:%s" % os.path.basename(path), "cid:%s" % iid)
        size = img_size(data)
        html = re.sub(r"<img\b[^>]*>",
                      lambda m, iid=iid, size=size: fix_img_tag(m.group(0), size) if ("cid:%s" % iid) in m.group(0)
                      else m.group(0), html)
    if html is None:
        body = MIMEText(text, "plain", "utf-8")
    else:
        body = MIMEMultipart("alternative")
        body.attach(MIMEText(text, "plain", "utf-8"))
        body.attach(MIMEText(html, "html", "utf-8"))
    if imgs:
        rel = MIMEMultipart("related")
        rel.attach(body)
        for path, data, iid in imgs:
            rel.attach(file_part(path, data, cid=iid))
        body = rel
    extra = [(p, read_bytes(p)) for p in a.attach]
    if a.also_attach:
        extra += [(p, d) for p, d, _ in imgs]
    if extra:
        m = MIMEMultipart("mixed")
        m.attach(body)
        for p, d in extra:
            m.attach(file_part(p, d))
    else:
        m = body
    m["Subject"] = a.subject if a.subject.isascii() else Header(a.subject, "utf-8").encode()
    for field, value in (("To", a.to), ("Cc", a.cc), ("Bcc", a.bcc)):
        if value:
            m[field] = value
    if a.in_reply_to:
        m["In-Reply-To"] = a.in_reply_to
        m["References"] = a.in_reply_to
    want = [os.path.basename(p) for p, _ in extra] + [os.path.basename(p) for p, _, _ in imgs]
    return m, want


def create_draft(at, m, thread):
    body = {"message": {"raw": base64.urlsafe_b64encode(m.as_bytes()).decode()}}
    if thread:
        body["message"]["threadId"] = thread
    rq = urllib.request.Request(DRAFTS_URL, method="POST", data=json.dumps(body).encode(),
                                headers={"Authorization": "Bearer " + at, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(rq, timeout=60) as resp:
            did = json.load(resp)["id"]
    except urllib.error.HTTPError as e:
        sys.exit("gmail-draft: gmail error %d: %s" % (e.code, e.read()[:200].decode("utf-8", "replace")))
    if not SAFE_ID.match(str(did)):
        sys.exit("gmail-draft: unexpected draft id")
    return did


def readback(at, did, recipients, want_files):
    """Read the draft back and verify every recipient and attachment; exit 3 on a mismatch."""
    rq = urllib.request.Request(DRAFTS_URL + "/" + did + "?format=full", headers={"Authorization": "Bearer " + at})
    try:
        with urllib.request.urlopen(rq, timeout=60) as resp:
            msg = json.load(resp)["message"]
    except urllib.error.HTTPError as e:
        sys.exit("READBACK_BAD: cannot read draft back (%d)" % e.code)
    names, stack = [], [msg["payload"]]
    while stack:
        part = stack.pop()
        if part.get("filename"):
            names.append(part["filename"])
        stack.extend(part.get("parts") or [])
    hdr = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
    problems = ["missing attachment: %s" % f for f in want_files
                if f not in names and not any(n.endswith(f) for n in names)]
    for field, value in recipients:
        got = hdr.get(field, "").lower()
        for addr in [x.strip().lower() for x in (value or "").split(",") if x.strip()]:
            if addr not in got:
                problems.append("missing %s recipient: %s" % (field, addr))
    if problems:
        print("READBACK_BAD: " + "; ".join(problems), file=sys.stderr)
        sys.exit(3)
    print("READBACK_OK: to=%s attachments=%s" % (hdr.get("to", ""), ",".join(names) or "-"), file=sys.stderr)


def parse_args(argv):
    ap = argparse.ArgumentParser(prog="gmail-draft.py", allow_abbrev=False, description="Write one Gmail draft.")
    ap.add_argument("--subject", required=True)
    ap.add_argument("--text", required=True, help="plain-text body file")
    ap.add_argument("--html", help="HTML body file")
    ap.add_argument("--to")
    ap.add_argument("--cc")
    ap.add_argument("--bcc")
    ap.add_argument("--inline", action="append", default=[], help="inline image (repeatable)")
    ap.add_argument("--attach", action="append", default=[], help="attachment (repeatable)")
    ap.add_argument("--also-attach", action="store_true", help="every inline image again as an attachment")
    ap.add_argument("--signature-html")
    ap.add_argument("--signature-text")
    ap.add_argument("--thread")
    ap.add_argument("--in-reply-to")
    a = ap.parse_args(argv)
    if a.thread and not SAFE_ID.match(a.thread):
        ap.error("--thread is not a Gmail thread id")
    # Revizor 4076 L3: a CR or LF in a header value would add a header (a Bcc nobody read); refused here, not left
    # to the email package's version
    for flag, value in (("subject", a.subject), ("to", a.to), ("cc", a.cc), ("bcc", a.bcc),
                        ("in-reply-to", a.in_reply_to)):
        if value and ("\r" in value or "\n" in value):
            ap.error("--%s holds a line break" % flag)
    return a


def main(argv=None):
    a = parse_args(sys.argv[1:] if argv is None else argv)
    m, want = build_message(a)
    at = access_token()
    did = create_draft(at, m, a.thread)
    print(did)
    readback(at, did, (("to", a.to), ("cc", a.cc)), want)


if __name__ == "__main__":
    main()
