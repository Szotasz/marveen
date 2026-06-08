#!/usr/bin/env python3
"""Dependency-free tests for the email-digest pure matching logic.

Run: python3 scripts/email-digest/test_digest.py  (exit 0 = all passed)
Covers the rules that decide where a mail goes, WITHOUT touching IMAP/network:
  - domain rules cover subdomains
  - an exact-address rule beats a domain rule in the OTHER list (specificity)
  - routes match on sender + optional local subject keyword
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import digest  # noqa: E402

failures = []
def check(name, cond):
    print(f"{'ok  ' if cond else 'FAIL'}  {name}")
    if not cond:
        failures.append(name)


# --- matches(): domain covers subdomains; exact is exact -----------------
check("domain rule matches the domain itself",
      digest.matches("a@shop.com", ["@shop.com"]))
check("domain rule matches a subdomain",
      digest.matches("a@news.shop.com", ["@shop.com"]))
check("domain rule does NOT match a lookalike suffix",
      not digest.matches("a@notshop.com", ["@shop.com"]))
check("exact rule matches only that address",
      digest.matches("boss@work.com", ["boss@work.com"])
      and not digest.matches("other@work.com", ["boss@work.com"]))

# --- classify(): specificity (exact beats domain across lists) -----------
important = ["messages@social.com"]
archive = ["@social.com"]
check("exact important beats domain archive",
      digest.classify("messages@social.com", important, archive) == "important")
check("domain archive still applies to other senders",
      digest.classify("ads@social.com", important, archive) == "archive")
check("unmatched address classifies as None",
      digest.classify("nobody@elsewhere.com", important, archive) is None)
check("on a tie (both domain) important wins",
      digest.classify("x@dual.com", ["@dual.com"], ["@dual.com"]) == "important")

# --- match_route(): sender + optional local subject keyword --------------
routes = [{"from": "@shop.com",
           "subject_contains": ["order", "shipped"],
           "folder": "Orders", "notify": True}]
check("route matches sender + subject keyword",
      digest.match_route("x@shop.com", "Your order shipped", routes) is not None)
check("route does NOT match when subject keyword absent",
      digest.match_route("x@shop.com", "Weekend sale!", routes) is None)
check("route does NOT match a different sender",
      digest.match_route("x@other.com", "Your order shipped", routes) is None)
route_no_kw = [{"from": "@shop.com", "folder": "Orders"}]
check("route with no subject_contains matches any subject",
      digest.match_route("x@shop.com", "anything", route_no_kw) is not None)

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all passed")
