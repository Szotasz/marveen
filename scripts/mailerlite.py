#!/usr/bin/env python3
"""
MailerLite CLI (Classic v2 API) a fiREG flottahoz.
A kulcsot a vaultbol olvassa (MAILERLITE_API_KEY) a dashboard API-n keresztul,
igy nincs hardcode-olt titok.

Hasznalat:
  python3 scripts/mailerlite.py groups
  python3 scripts/mailerlite.py subscribers --group <GROUP_ID> [--limit 50]
  python3 scripts/mailerlite.py campaigns [--status sent|draft|outbox]
  python3 scripts/mailerlite.py stats
  python3 scripts/mailerlite.py add-subscriber --email x@y.hu [--name "Nev"] [--group <GROUP_ID>]

Megjegyzes: kampany/email KIKULDEST ez a CLI szandekosan NEM csinal automatikusan.
"""
import sys, os, json, argparse, urllib.request, urllib.parse, urllib.error

BASE = "https://api.mailerlite.com/api/v2"
DASH = "http://localhost:3420"

def _dash_token():
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", "store", ".dashboard-token")) as f:
        return f.read().strip()

def _api_key():
    if os.environ.get("MAILERLITE_API_KEY"):
        return os.environ["MAILERLITE_API_KEY"]
    req = urllib.request.Request(
        f"{DASH}/api/vault/MAILERLITE_API_KEY",
        headers={"Authorization": f"Bearer {_dash_token()}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["value"]

def _call(method, path, params=None, body=None):
    key = _api_key()
    url = f"{BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "X-MailerLite-ApiKey": key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "fiREG-Boss/1.0 (+mailerlite-cli)",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode()[:500]}

def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("groups")
    sp = sub.add_parser("subscribers"); sp.add_argument("--group", required=True); sp.add_argument("--limit", type=int, default=50)
    cp = sub.add_parser("campaigns"); cp.add_argument("--status", default="sent")
    sub.add_parser("stats")
    ap = sub.add_parser("add-subscriber"); ap.add_argument("--email", required=True); ap.add_argument("--name", default=""); ap.add_argument("--group", default=None)
    a = p.parse_args()

    if a.cmd == "groups":
        out = _call("GET", "/groups", {"limit": 200})
    elif a.cmd == "subscribers":
        out = _call("GET", f"/groups/{a.group}/subscribers", {"limit": a.limit})
    elif a.cmd == "campaigns":
        out = _call("GET", f"/campaigns/{a.status}", {"limit": 50})
    elif a.cmd == "stats":
        out = _call("GET", "/stats")
    elif a.cmd == "add-subscriber":
        body = {"email": a.email}
        if a.name: body["name"] = a.name
        path = f"/groups/{a.group}/subscribers" if a.group else "/subscribers"
        out = _call("POST", path, body=body)
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
