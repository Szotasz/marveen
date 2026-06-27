#!/usr/bin/env python3
"""Direct Zoho CRM REST connector (EU DC) -- bypasses the Zoho MCP gateway.

Why this exists: the hosted Zoho MCP gateway (zohomcp.eu) returns
"Connection Error while executing tool." with a ~20s timeout on every
tool call, in BOTH "Authorize on Demand" and "Authorize via Connection"
modes, even though the console Connection shows Connected. The same
account/token hits the CRM REST API directly in <0.5s. So agents talk
to the CRM REST API straight, not through the MCP server.

Token store: store/zoho-crm/token.json
  {
    "access_token": "...",        # short-lived (1h)
    "refresh_token": "...",       # used iff client creds below are present
    "client_id": "...",           # Zoho Self Client (api-console.zoho.eu)
    "client_secret": "...",
    "api_domain": "https://www.zohoapis.eu"
  }
If client_id+client_secret+refresh_token are present this refreshes the
access_token automatically against accounts.zoho.eu. Without them it uses
the stored access_token as-is (expires in 1h).
"""
import json, sys, time, urllib.parse, urllib.request, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_PATH = os.path.join(ROOT, "store", "zoho-crm", "token.json")
ACCOUNTS = "https://accounts.zoho.eu"


def _load():
    with open(TOKEN_PATH) as f:
        return json.load(f)


def _save(tok):
    with open(TOKEN_PATH, "w") as f:
        json.dump(tok, f, indent=2)


def _http(method, url, headers=None, data=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.getcode(), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _refresh(tok):
    """Refresh access_token via a Zoho Self Client. No-op if creds absent.

    Lazy: callers refresh only when the current token is missing or has been
    rejected (HTTP 401). Refreshing on every call hammers the Zoho token
    endpoint and trips its rate limit ("too many requests continuously").
    """
    if not (tok.get("refresh_token") and tok.get("client_id") and tok.get("client_secret")):
        return tok
    body = urllib.parse.urlencode({
        "refresh_token": tok["refresh_token"],
        "client_id": tok["client_id"],
        "client_secret": tok["client_secret"],
        "grant_type": "refresh_token",
    }).encode()
    code, txt = _http("POST", f"{ACCOUNTS}/oauth/v2/token",
                      {"Content-Type": "application/x-www-form-urlencoded"}, body)
    try:
        j = json.loads(txt)
    except ValueError:
        j = {}
    if code == 200 and j.get("access_token"):
        tok["access_token"] = j["access_token"]
        tok["api_domain"] = j.get("api_domain", tok.get("api_domain", "https://www.zohoapis.eu"))
        tok["_refreshed_at"] = int(time.time())
        _save(tok)
    else:
        sys.stderr.write(f"[warn] refresh failed {code}: {txt}\n")
    return tok


def call(path, params=None, method="GET", body=None, _retried=False):
    tok = _load()
    if not tok.get("access_token"):
        tok = _refresh(tok)
    domain = tok.get("api_domain", "https://www.zohoapis.eu")
    url = f"{domain}/crm/v8/{path.lstrip('/')}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"Authorization": f"Zoho-oauthtoken {tok.get('access_token','')}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    code, txt = _http(method, url, headers, data)
    # Token expired/invalid: refresh once and retry. Subsequent calls reload
    # the freshly-saved token from disk, so a multi-page fetch refreshes once.
    if code == 401 and not _retried and tok.get("refresh_token"):
        _refresh(_load())
        return call(path, params, method, body, _retried=True)
    return code, txt


def main():
    args = sys.argv[1:]
    if not args:
        print("usage: zoho_crm.py <deals|leads|get|raw> [opts]", file=sys.stderr)
        sys.exit(2)
    cmd = args[0]
    if cmd in ("deals", "leads"):
        module = "Deals" if cmd == "deals" else "Leads"
        per = "10"
        fields = "Deal_Name,Stage,Amount,Closing_Date" if cmd == "deals" else "Last_Name,Company,Email,Lead_Status"
        for i, a in enumerate(args[1:]):
            if a == "--per-page":
                per = args[1:][i + 1]
            elif a == "--fields":
                fields = args[1:][i + 1]
        code, txt = call(module, {"per_page": per, "fields": fields,
                                  "sort_by": "Modified_Time", "sort_order": "desc"})
        print(txt if code == 200 else f"HTTP {code}: {txt}")
    elif cmd == "get":  # get <Module> <id>
        code, txt = call(f"{args[1]}/{args[2]}")
        print(txt)
    elif cmd == "raw":  # raw <path> [k=v ...]
        params = dict(kv.split("=", 1) for kv in args[2:]) if len(args) > 2 else None
        code, txt = call(args[1], params)
        print(txt)
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
