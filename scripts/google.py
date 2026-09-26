#!/usr/bin/env python3
"""Multi-account Google helper: Gmail, Calendar and Drive, read-first.

Why this and not an MCP server (decided 2026-09-17, kanban f38d6fc9): the
morning briefing needs mail and calendar, and the only routes on offer were a
third-party MCP server with access to the owner's mailbox, or repo-owned code.
This is the repo-owned one, built on the same OAuth shape scripts/gdocs.py
already uses -- with two deliberate differences:

  * MANY ACCOUNTS, not one. Tokens live in store/.google/<alias>.json, the
    Console client (shared by all of them) in store/.google/client.json.
  * NO third-party libraries. gdocs.py needs google-api-python-client in a
    venv; a scheduled round that has to activate a venv is one more thing that
    can silently not happen. Everything here is stdlib urllib against the REST
    endpoints, so `python3 scripts/google.py ...` works from any context.

Commands:
  auth-url <alias> [--write|--mail-only]
                                  print the consent URL for one account
  auth-exchange <alias> <code>    store the refresh token for that account
  accounts                        list configured aliases (and whose mailbox)
  mail <alias> [--hours N] [--max N] [--query Q] [--briefing]
  calendar <alias> [--date YYYY-MM-DD] [--days N] [--primary-only]
  drive <alias> [--query Q] [--max N]

EGRESS: this host denies outbound traffic that is not on the allowlist
(store/egress-allowlist.json). The four prefixes below are what the commands
touch; without them every call fails closed, which is the intended behaviour,
not a bug to work around.
"""
import sys
import os
import json
import time
import base64
import datetime
import urllib.parse
import urllib.request
import urllib.error

STORE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "store"))
GDIR = os.path.join(STORE, ".google")
CLIENT = os.path.join(GDIR, "client.json")
REDIRECT = "http://localhost"
TOKEN_URI = "https://oauth2.googleapis.com/token"
AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
GMAIL = "https://gmail.googleapis.com/gmail/v1"
CALENDAR = "https://www.googleapis.com/calendar/v3"
DRIVE = "https://www.googleapis.com/drive/v3"

# Read-only by default. Write scopes are opt-in per account at auth time
# (--write), because widening scopes later costs one browser login PER account,
# and narrowing them costs the same -- so the choice is made once, on purpose.
READ_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
]
WRITE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/userinfo.email",
]
# Least privilege for the mail-only accounts: two of the three accounts are used
# for mail only (measured 2026-09-17, Laci), so asking them for calendar and
# drive would buy nothing and widen the blast radius of a leaked token.
MAIL_ONLY_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
]


def die(msg):
    raise SystemExit(f"ERROR: {msg}")


def _client_cfg():
    """Client id/secret from the Console download (installed-app shape or flat)."""
    if not os.path.exists(CLIENT):
        die(f"missing OAuth client file: {CLIENT}\n"
            "Create a Desktop OAuth client in the Google Cloud Console and save "
            "the downloaded JSON there (chmod 600).")
    with open(CLIENT) as f:
        cfg = json.load(f)
    node = cfg.get("installed") or cfg.get("web") or cfg
    cid, secret = node.get("client_id"), node.get("client_secret")
    if not cid or not secret:
        die("client.json has no client_id/client_secret")
    return cid, secret


def _token_path(alias):
    if not alias or "/" in alias or alias.startswith("."):
        die(f"bad alias: {alias!r}")
    return os.path.join(GDIR, f"{alias}.json")


def _load_account(alias):
    p = _token_path(alias)
    if not os.path.exists(p):
        die(f"account {alias!r} is not connected yet (no {p}). "
            f"Run: auth-url {alias}")
    with open(p) as f:
        return json.load(f)


def _save_account(alias, data):
    os.makedirs(GDIR, mode=0o700, exist_ok=True)
    p = _token_path(alias)
    with open(p, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(p, 0o600)
    return p


def _post_form(url, params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        die(f"{url} -> HTTP {e.code}: {body}")


def _get_json(url, token, params=None):
    if params:
        # doseq=True is not cosmetic: Gmail takes metadataHeaders as a REPEATED
        # query parameter, and without it urlencode ships the Python list repr
        # ("['From', 'Subject']"), which Gmail silently ignores -- the call still
        # returns 200 and every header comes back empty (measured 2026-09-17,
        # the first live mail listing printed five blank rows).
        url = f"{url}?{urllib.parse.urlencode(params, doseq=True)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        die(f"{url.split('?')[0]} -> HTTP {e.code}: {body}")


def access_token(alias):
    """Fresh access token for one account (refresh tokens are long-lived)."""
    acct = _load_account(alias)
    tok = _post_form(TOKEN_URI, {
        "client_id": acct["client_id"],
        "client_secret": acct["client_secret"],
        "refresh_token": acct["refresh_token"],
        "grant_type": "refresh_token",
    })
    if "access_token" not in tok:
        die(f"no access_token in refresh response for {alias}: {tok}")
    return tok["access_token"]


# ---- auth -------------------------------------------------------------------

def build_auth_url(client_id, scopes):
    """Pure: the consent URL. access_type=offline + prompt=consent is what makes
    Google return a refresh_token at all; without them the exchange succeeds and
    the account is unusable an hour later."""
    return AUTH_URI + "?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": " ".join(scopes),
        "access_type": "offline",
        "prompt": "consent",
    })


def extract_code(raw):
    """Pure: accept either a bare code or the whole redirected localhost URL.

    The browser lands on a localhost error page -- that is expected -- and the
    code sits in its query string. Asking for the bare code invites a truncated
    paste, so take either."""
    raw = raw.strip()
    if raw.startswith("http://") or raw.startswith("https://"):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(raw).query)
        if "error" in q:
            die(f"the redirect carries an error: {q['error'][0]}")
        if "code" not in q:
            die("no code= in the pasted URL")
        return q["code"][0]
    return raw


def cmd_auth_url(alias, write=False, mail_only=False):
    cid, _ = _client_cfg()
    if write and mail_only:
        die("--write and --mail-only are mutually exclusive")
    scopes = WRITE_SCOPES if write else (MAIL_ONLY_SCOPES if mail_only else READ_SCOPES)
    kind = "read+write" if write else ("read-only, mail only" if mail_only else "read-only")
    print(f"Account alias: {alias}   scopes: {kind}")
    print("Open this in a browser, sign in AS THAT ACCOUNT, approve, then copy the")
    print("whole localhost URL from the address bar (the error page is expected):\n")
    print(build_auth_url(cid, scopes))
    print(f"\nThen: python3 scripts/google.py auth-exchange {alias} '<pasted URL>'")


def cmd_auth_exchange(alias, raw_code):
    cid, secret = _client_cfg()
    tok = _post_form(TOKEN_URI, {
        "code": extract_code(raw_code),
        "client_id": cid,
        "client_secret": secret,
        "redirect_uri": REDIRECT,
        "grant_type": "authorization_code",
    })
    if "refresh_token" not in tok:
        die("no refresh_token in the response. Re-run auth-url (the consent "
            "screen must be re-approved with prompt=consent) and try again.")
    data = {
        "refresh_token": tok["refresh_token"],
        "client_id": cid,
        "client_secret": secret,
        "scopes": tok.get("scope", "").split(),
        "connected_at": int(time.time()),
    }
    p = _save_account(alias, data)
    try:
        prof = _get_json(f"{GMAIL}/users/me/profile", tok["access_token"])
        data["email"] = prof.get("emailAddress")
        _save_account(alias, data)
        print(f"OK: {alias} connected as {data['email']} -> {p}")
    except SystemExit:
        print(f"OK: {alias} connected -> {p} (mailbox address not read back)")


def cmd_accounts():
    if not os.path.isdir(GDIR):
        print("no accounts connected yet")
        return
    rows = sorted(f[:-5] for f in os.listdir(GDIR)
                  if f.endswith(".json") and f != "client.json")
    if not rows:
        print("no accounts connected yet")
        return
    for alias in rows:
        a = _load_account(alias)
        kind = "read+write" if any("gmail.modify" in s for s in a.get("scopes", [])) else "read-only"
        when = datetime.datetime.fromtimestamp(a.get("connected_at", 0)).strftime("%Y-%m-%d %H:%M")
        print(f"{alias:12} {a.get('email') or '(unknown address)':32} {kind:10} connected {when}")


# ---- read commands ----------------------------------------------------------

def _header(msg, name):
    for h in msg.get("payload", {}).get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


# What the morning briefing must never show, and HOW it is recognised.
#
# Measured 2026-09-17 on the two mail-only accounts, because the obvious answers
# both failed silently: Gmail's own "category:promotions" and the smart labels
# ("-label:^smartlabel_promo") changed the result count by ZERO on these
# mailboxes, and no message carried a CATEGORY_* labelId at all -- the tabbed
# inbox is off, so Gmail never classified anything. A filter that returns the
# same 13 messages it was asked to trim is worse than no filter: it reads as
# working.
#
# List-Unsubscribe is the signal that actually separates them, because bulk
# senders are legally and practically obliged to carry it while a human reply is
# not. On the measured sample it caught every promotional mail (New Balance,
# Kraken, Electrolux, SuperShop, Allegro, Springfield, a crypto newsletter) plus
# the GitHub notification mail the owner also keeps out of the briefing, and it
# caught nothing the owner would have wanted to see.
BULK_HEADER = "List-Unsubscribe"


def _is_bulk(msg):
    """Pure: does this message advertise an unsubscribe route (i.e. is it a mailing)."""
    return bool(_header(msg, BULK_HEADER))


def cmd_mail(alias, hours=12, maxn=15, query=None, briefing=False):
    token = access_token(alias)
    q = query or f"newer_than:{max(1, int(hours / 24) or 1)}d"
    if query is None and hours < 24:
        # Gmail's query language has no hour granularity; filter client-side below.
        q = "newer_than:1d"

    lst = _get_json(f"{GMAIL}/users/me/messages", token, {"q": q, "maxResults": maxn})
    ids = [m["id"] for m in lst.get("messages", [])]
    cutoff = time.time() - hours * 3600
    shown = 0
    dropped = 0
    for mid in ids:
        m = _get_json(f"{GMAIL}/users/me/messages/{mid}", token,
                      {"format": "metadata",
                       "metadataHeaders": ["From", "Subject", "Date", BULK_HEADER]})
        ts = int(m.get("internalDate", "0")) / 1000
        if ts < cutoff:
            continue
        if briefing and _is_bulk(m):
            dropped += 1
            continue
        when = datetime.datetime.fromtimestamp(ts).strftime("%m-%d %H:%M")
        print(f"{when} | {_header(m, 'From')[:38]:38} | {_header(m, 'Subject')[:60]}")
        shown += 1
    # The dropped count is printed on purpose: a briefing that says "no mail"
    # must be distinguishable from one that filtered everything away.
    tail = f", {dropped} bulk/promo kiszurve" if briefing else ""
    print(f"-- {shown} message(s) in the last {hours}h for {alias}{tail}")


def _event_key(e):
    """Pure sort key: (day, time). All-day events carry only a date and must sort
    to the top of their own day, not to the end of the list."""
    st = e.get("start", {})
    raw = st.get("dateTime") or st.get("date") or ""
    if "T" in raw:
        return (raw[:10], raw[11:16])
    return (raw[:10], "")


def cmd_calendar(alias, date=None, days=1, primary_only=False):
    """Every calendar the account can see, not just 'primary'.

    Measured 2026-09-17: Laci's family calendar is a SECONDARY calendar shared
    into his account, so a primary-only query reported zero events on a day that
    had them -- a false negative that would have been invisible in the morning
    briefing. The cost of asking calendarList first is one extra request."""
    token = access_token(alias)
    start = datetime.datetime.fromisoformat(date) if date else datetime.datetime.now().replace(
        hour=0, minute=0, second=0, microsecond=0)
    end = start + datetime.timedelta(days=days)
    params = {
        "timeMin": start.astimezone().isoformat(),
        "timeMax": end.astimezone().isoformat(),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": 50,
    }

    if primary_only:
        cals = [{"id": "primary", "summary": "primary"}]
    else:
        cals = _get_json(f"{CALENDAR}/users/me/calendarList", token,
                         {"maxResults": 250}).get("items", [])

    rows, skipped = [], []
    for c in cals:
        cid = c.get("id") or "primary"
        try:
            ev = _get_json(f"{CALENDAR}/calendars/{urllib.parse.quote(cid, safe='')}/events",
                           token, params)
        except SystemExit:
            skipped.append(c.get("summary") or cid)
            continue
        label = c.get("summary") or cid
        for e in ev.get("items", []):
            rows.append((label, e))

    rows.sort(key=lambda r: _event_key(r[1]))
    for label, e in rows:
        st = e.get("start", {})
        raw = st.get("dateTime") or st.get("date") or "?"
        when = raw[11:16] if "T" in raw else "egesz nap"
        day = raw[:10]
        print(f"{day} {when:9} | {label[:24]:24} | {(e.get('summary') or '(nincs cim)')[:52]}")
    tail = f", {len(skipped)} calendar(s) unreadable: {', '.join(skipped)}" if skipped else ""
    print(f"-- {len(rows)} event(s) for {alias} from {start.date()} ({days}d), "
          f"{len(cals)} calendar(s){tail}")


def cmd_drive(alias, query=None, maxn=15):
    token = access_token(alias)
    params = {"pageSize": maxn, "orderBy": "modifiedTime desc",
              "fields": "files(name,mimeType,modifiedTime,webViewLink)"}
    if query:
        params["q"] = f"name contains '{query}'"
    res = _get_json(f"{DRIVE}/files", token, params)
    files = res.get("files", [])
    for f in files:
        print(f"{f.get('modifiedTime','')[:16]:16} | {f.get('name','')[:50]:50} | {f.get('mimeType','').split('.')[-1]}")
    print(f"-- {len(files)} file(s) for {alias}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd, args = sys.argv[1], sys.argv[2:]

    def opt(name, default=None):
        return args[args.index(name) + 1] if name in args else default

    if cmd == "auth-url" and args:
        cmd_auth_url(args[0], write="--write" in args, mail_only="--mail-only" in args)
    elif cmd == "auth-exchange" and len(args) >= 2:
        cmd_auth_exchange(args[0], args[1])
    elif cmd == "accounts":
        cmd_accounts()
    elif cmd == "mail" and args:
        cmd_mail(args[0], hours=int(opt("--hours", 12)), maxn=int(opt("--max", 15)),
                 query=opt("--query"), briefing="--briefing" in args)
    elif cmd == "calendar" and args:
        cmd_calendar(args[0], date=opt("--date"), days=int(opt("--days", 1)),
                     primary_only="--primary-only" in args)
    elif cmd == "drive" and args:
        cmd_drive(args[0], query=opt("--query"), maxn=int(opt("--max", 15)))
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
