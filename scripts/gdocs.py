#!/usr/bin/env python3
"""
Google Docs reader/editor helper.

Lets an agent read and edit Google Docs from the command line. Authentication
is service-account based by default; an OAuth user-token path is also supported
so edits can appear under a human account.

Auth resolution order (first match wins):
  1. OAuth user token at store/.gdocs-oauth.json (refresh_token + client id/secret)
     -> edits appear as the authorizing user. No Workspace admin required.
  2. Service account key at store/.gdocs-sa.json (override with GDOCS_SA).
     Share the target document with the service account's client_email
     (Editor) -- the address shown by `whoami`. Edits appear as the service
     account. Set GDOCS_SUBJECT=<user@domain> to impersonate a user via
     Google Workspace domain-wide delegation (Workspace admin required).

Usage (run with a venv that has the deps from scripts/gdocs-requirements.txt):
  gdocs.py whoami                                   # print service-account email
  gdocs.py read   <doc_id_or_url>
  gdocs.py replace <doc_id_or_url> "old text" "new text"
  gdocs.py replace-batch <doc_id_or_url> <pairs.json>   # [{"old":"..","new":".."}, ...]
  gdocs.py set-content <doc_id_or_url> <source.txt>     # replace the whole body
  gdocs.py auth-url                                  # OAuth: print consent URL
  gdocs.py auth-exchange <code>                      # OAuth: store the refresh token

set-content markers: '# ' -> Heading 1, '## ' -> Heading 2, '- ' -> bullet,
anything else -> normal paragraph. Blank lines are dropped (paragraph spacing
handles separation).

See docs/google-docs.md for setup.
"""
import sys, os, json, re, urllib.parse, urllib.request
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials as UserCredentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/documents",
          "https://www.googleapis.com/auth/drive"]
STORE = os.path.join(os.path.dirname(__file__), "..", "store")
OAUTH_CLIENT = os.path.join(STORE, ".gdocs-oauth-client.json")  # client_id + client_secret
OAUTH_TOKEN = os.path.join(STORE, ".gdocs-oauth.json")          # + refresh_token
REDIRECT = "http://localhost"
TOKEN_URI = "https://oauth2.googleapis.com/token"

def _sa_path():
    return os.environ.get("GDOCS_SA", os.path.join(STORE, ".gdocs-sa.json"))

def _client_cfg():
    """Read the OAuth client (Desktop) id+secret; supports Google's downloaded
    {'installed': {...}} wrapper or a flat {client_id, client_secret} object."""
    with open(OAUTH_CLIENT) as f:
        d = json.load(f)
    d = d.get("installed", d.get("web", d))
    return d["client_id"], d["client_secret"]

def _svc():
    # Preferred: OAuth user creds -> edits appear as the authorizing user.
    if os.path.exists(OAUTH_TOKEN):
        with open(OAUTH_TOKEN) as f:
            t = json.load(f)
        creds = UserCredentials(
            token=None, refresh_token=t["refresh_token"],
            client_id=t["client_id"], client_secret=t["client_secret"],
            token_uri=TOKEN_URI, scopes=SCOPES)
        return build("docs", "v1", credentials=creds, cache_discovery=False)
    # Fallback: service account, optionally impersonating via domain-wide delegation.
    creds = service_account.Credentials.from_service_account_file(_sa_path(), scopes=SCOPES)
    subject = os.environ.get("GDOCS_SUBJECT", "")
    if subject:
        creds = creds.with_subject(subject)
    return build("docs", "v1", credentials=creds, cache_discovery=False)

def _doc_id(s):
    m = re.search(r"/document/d/([a-zA-Z0-9_-]+)", s)
    return m.group(1) if m else s

def _text(doc):
    out = []
    for el in doc.get("body", {}).get("content", []):
        para = el.get("paragraph")
        if not para:
            continue
        out.append("".join(r.get("textRun", {}).get("content", "") for r in para.get("elements", [])))
    return "".join(out)

def cmd_whoami():
    with open(_sa_path()) as f:
        print(json.load(f).get("client_email", "(no client_email in key)"))

def cmd_read(doc_id):
    sys.stdout.write(_text(_svc().documents().get(documentId=doc_id).execute()))

def cmd_replace(doc_id, old, new):
    _apply(doc_id, [{"old": old, "new": new}])

def cmd_replace_batch(doc_id, pairs_file):
    with open(pairs_file) as f:
        _apply(doc_id, json.load(f))

def _apply(doc_id, pairs):
    reqs = [{"replaceAllText": {
        "containsText": {"text": p["old"], "matchCase": True},
        "replaceText": p["new"]}} for p in pairs]
    res = _svc().documents().batchUpdate(documentId=doc_id, body={"requests": reqs}).execute()
    total = 0
    for p, r in zip(pairs, res.get("replies", [])):
        n = r.get("replaceAllText", {}).get("occurrencesChanged", 0)
        total += n
        flag = "" if n else "  <-- 0 matches, check the 'old' text"
        print(f"[{n}] {p['old'][:50]!r} -> {p['new'][:50]!r}{flag}")
    print(f"Total occurrences changed: {total}")

def cmd_set_content(doc_id, src_file):
    """Replace the entire document body from a source file. Markers:
    '# ' -> Heading 1, '## ' -> Heading 2, '- ' -> bullet, else normal."""
    with open(src_file) as f:
        raw = f.read()
    lines = []
    for ln in raw.split("\n"):
        s = ln.rstrip()
        if not s.strip():
            continue
        if s.startswith("## "):
            lines.append(("h2", s[3:]))
        elif s.startswith("# "):
            lines.append(("h1", s[2:]))
        elif s.lstrip().startswith("- "):
            lines.append(("bullet", s.lstrip()[2:]))
        else:
            lines.append(("normal", s))
    text = "\n".join(t for _, t in lines)
    svc = _svc()
    doc = svc.documents().get(documentId=doc_id).execute()
    end = doc["body"]["content"][-1]["endIndex"]
    reqs = []
    if end > 2:
        reqs.append({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end - 1}}})
    reqs.append({"insertText": {"location": {"index": 1}, "text": text}})
    svc.documents().batchUpdate(documentId=doc_id, body={"requests": reqs}).execute()
    # second pass: paragraph styles + bullets (indices computed on the inserted text)
    style_reqs, bullets, idx = [], [], 1
    for kind, t in lines:
        start, endi = idx, idx + len(t)
        if kind in ("h1", "h2"):
            style_reqs.append({"updateParagraphStyle": {
                "range": {"startIndex": start, "endIndex": endi},
                "paragraphStyle": {"namedStyleType": "HEADING_1" if kind == "h1" else "HEADING_2"},
                "fields": "namedStyleType"}})
        elif kind == "bullet":
            bullets.append((start, endi))
        idx = endi + 1
    spans = []
    for s, e in bullets:
        if spans and s == spans[-1][1] + 1:
            spans[-1][1] = e
        else:
            spans.append([s, e])
    for s, e in spans:
        style_reqs.append({"createParagraphBullets": {
            "range": {"startIndex": s, "endIndex": e},
            "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE"}})
    if style_reqs:
        svc.documents().batchUpdate(documentId=doc_id, body={"requests": style_reqs}).execute()
    print(f"OK: body replaced -- {len(lines)} paragraphs, "
          f"{sum(1 for k, _ in lines if k in ('h1', 'h2'))} headings, {len(bullets)} bullets.")

def cmd_auth_url():
    cid, _ = _client_cfg()
    params = {"client_id": cid, "redirect_uri": REDIRECT, "response_type": "code",
              "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent"}
    print("Open this URL, sign in, approve, then copy the 'code=' value from the")
    print("redirected URL (the localhost error page is expected):\n")
    print("https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params))

def cmd_auth_exchange(code):
    cid, secret = _client_cfg()
    data = urllib.parse.urlencode({
        "code": code, "client_id": cid, "client_secret": secret,
        "redirect_uri": REDIRECT, "grant_type": "authorization_code"}).encode()
    with urllib.request.urlopen(urllib.request.Request(TOKEN_URI, data=data)) as r:
        tok = json.load(r)
    if "refresh_token" not in tok:
        raise SystemExit(f"No refresh_token in response: {tok}")
    with open(OAUTH_TOKEN, "w") as f:
        json.dump({"refresh_token": tok["refresh_token"], "client_id": cid, "client_secret": secret}, f)
    os.chmod(OAUTH_TOKEN, 0o600)
    print("OK: refresh token saved ->", OAUTH_TOKEN)

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "whoami":
        cmd_whoami()
    elif cmd == "read":
        cmd_read(_doc_id(sys.argv[2]))
    elif cmd == "replace":
        cmd_replace(_doc_id(sys.argv[2]), sys.argv[3], sys.argv[4])
    elif cmd == "replace-batch":
        cmd_replace_batch(_doc_id(sys.argv[2]), sys.argv[3])
    elif cmd == "set-content":
        cmd_set_content(_doc_id(sys.argv[2]), sys.argv[3])
    elif cmd == "auth-url":
        cmd_auth_url()
    elif cmd == "auth-exchange":
        cmd_auth_exchange(sys.argv[2])
    else:
        print(f"unknown command: {cmd}\n{__doc__}"); sys.exit(1)

if __name__ == "__main__":
    main()
