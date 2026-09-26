#!/usr/bin/env python3
"""Offline tests for scripts/google.py -- the parts that must be right BEFORE
anyone spends a browser login on them.

Run: python3 scripts/test_google.py

Deliberately no network and no credentials: everything here is pure. The live
calls are covered by running the commands once each account is connected; what
cannot wait for that is the auth URL (a missing access_type=offline yields a
token that dies in an hour, and the mistake only shows up the next morning) and
the code extraction (a truncated paste is the most likely human error in the
whole flow).
"""
import importlib.util
import sys
import urllib.parse
from pathlib import Path

spec = importlib.util.spec_from_file_location("gmod", Path(__file__).resolve().parent / "google.py")
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

fails = []


def check(name, cond, detail=""):
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        fails.append(name)


print("auth URL")
url = g.build_auth_url("cid-123", g.READ_SCOPES)
q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
check("offline access is requested", q.get("access_type") == ["offline"],
      "without it there is no refresh_token and the account dies in an hour")
check("consent is forced", q.get("prompt") == ["consent"],
      "a second auth without it returns no refresh_token at all")
check("client id is carried", q.get("client_id") == ["cid-123"])
check("redirect matches the exchange", q.get("redirect_uri") == [g.REDIRECT])
check("every read scope is present", set(q.get("scope", [""])[0].split()) == set(g.READ_SCOPES))
check("read scopes carry no write grant",
      not any(s.endswith("/drive") or s.endswith("/calendar") or "gmail.modify" in s
              for s in g.READ_SCOPES),
      "read-only must not silently include write")
check("write scopes do carry one",
      any("gmail.modify" in s for s in g.WRITE_SCOPES))

print("pasted redirect handling")
check("bare code passes through", g.extract_code("4/0AX-bare") == "4/0AX-bare")
check("full localhost URL is accepted",
      g.extract_code("http://localhost/?code=4/0ABC&scope=x%20y") == "4/0ABC")
check("whitespace is tolerated", g.extract_code("  4/0AX  ") == "4/0AX")
try:
    g.extract_code("http://localhost/?error=access_denied")
    check("a denied consent is reported, not stored", False)
except SystemExit as e:
    check("a denied consent is reported, not stored", "access_denied" in str(e))
try:
    g.extract_code("http://localhost/?state=nothing")
    check("a URL without a code is refused", False)
except SystemExit:
    check("a URL without a code is refused", True)

print("scope selection")
mail_q = urllib.parse.parse_qs(urllib.parse.urlparse(g.build_auth_url("cid", g.MAIL_ONLY_SCOPES)).query)
mail_scopes = mail_q["scope"][0].split()
check("mail-only asks for gmail read", "https://www.googleapis.com/auth/gmail.readonly" in mail_scopes)
check("mail-only asks for nothing else",
      not any("calendar" in s or "drive" in s for s in mail_scopes),
      "the two mail-only accounts must not hand over calendar or drive")
check("read-only never asks for a write scope",
      not any(s.endswith("/gmail.modify") or s.endswith("/drive") or s.endswith("/calendar")
              for s in g.READ_SCOPES),
      "a read-only login that quietly carries write scope is the worst outcome")

print("bulk filter")
def _msg(*headers):
    return {"payload": {"headers": [{"name": n, "value": v} for n, v in headers]}}
check("a mailing with an unsubscribe route is bulk",
      g._is_bulk(_msg(("From", "shop@x.hu"), ("List-Unsubscribe", "<https://x.hu/u>"))))
check("a human reply is not bulk",
      not g._is_bulk(_msg(("From", "adam@example.com"), ("Subject", "Re: terv"))))
check("the header match is case-insensitive",
      g._is_bulk(_msg(("list-unsubscribe", "<mailto:u@x.hu>"))),
      "Gmail returns header names in whatever case the sender used")

print("calendar merge")
allday = {"start": {"date": "2026-09-17"}, "summary": "all day"}
morning = {"start": {"dateTime": "2026-09-17T08:00:00+02:00"}, "summary": "08:00"}
nextday = {"start": {"date": "2026-09-18"}, "summary": "tomorrow"}
order = [e["summary"] for e in sorted([morning, nextday, allday], key=g._event_key)]
check("all-day sorts to the top of its own day, not to the end",
      order == ["all day", "08:00", "tomorrow"], f"got {order}")

print("alias safety")
for bad in ("../escape", "a/b", ".hidden"):
    try:
        g._token_path(bad)
        check(f"alias {bad!r} refused", False, "it would write outside store/.google")
    except SystemExit:
        check(f"alias {bad!r} refused", True)
check("normal alias resolves inside store/.google",
      g._token_path("laci").endswith("/store/.google/laci.json"))

print()
if fails:
    print(f"{len(fails)} FAILED: {', '.join(fails)}")
    sys.exit(1)
print("all green")
