#!/usr/bin/env python3
"""
Deterministic Mail.app triage for an hourly email heartbeat (macOS).

Reads UNREAD inbox messages via osascript (auth-free), applies rule-based
filtering, prints JSON. Does NOT send anything and does NOT mark mail read - the
final nuanced judgment stays with the agent, which reads this compact JSON
instead of raw mail, saving tokens.

Buckets: important (known senders or important keywords), review (ambiguous),
dropped (clear spam/promo - count only).

PRIVACY: DEFAULTS ship with EMPTY important_senders and only generic keywords.
Put your real senders/keywords in `mail_rules.json` next to this file (keep that
file OUT of version control). See mail_rules.example.json.

Usage: mail_triage.py [max_age_min]   # default 90; 0 = all unread
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime

RULES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mail_rules.json")

# Generic, non-personal defaults. Real senders go in the gitignored override.
DEFAULTS = {
    "important_senders": [],          # e.g. ["boss@work.example"] - via mail_rules.json
    "important_keywords": [
        "invoice", "szamla", "számla", "deadline", "hatarid", "határid",
        "fizet", "payment", "urgent", "surgos", "sürgős", "tax", "nav",
        "contract", "szerzod", "szerződ",
    ],
    "spam_keywords": [
        "newsletter", "hirlevel", "hírlevél", "unsubscribe", "leiratkoz",
        "promo", "promó", "sale", "akcio", "akció", "discount", "kedvezmeny",
        "kedvezmény", "marketing", "webshop",
    ],
}


def load_rules():
    rules = {k: list(v) for k, v in DEFAULTS.items()}
    if os.path.isfile(RULES_FILE):
        try:
            override = json.load(open(RULES_FILE))
            for k in rules:
                if isinstance(override.get(k), list):
                    rules[k] = override[k]
        except (ValueError, OSError):
            pass
    return {k: [s.lower() for s in v] for k, v in rules.items()}


def read_unread():
    us, rs = chr(31), chr(30)
    script = '''
    set US to (ASCII character 31)
    set RS to (ASCII character 30)
    set outp to ""
    tell application "Mail"
        set msgs to (messages of inbox whose read status is false)
        repeat with m in msgs
            try
                set outp to outp & (sender of m) & US & (subject of m) & US & (((current date) - (date received of m)) as string) & RS
            end try
        end repeat
    end tell
    return outp
    '''
    try:
        raw = subprocess.run(["osascript", "-e", script], capture_output=True,
                             text=True, timeout=60).stdout
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        sys.stderr.write(f"osascript failed: {e}\n")
        return []
    out = []
    for rec in raw.split(rs):
        parts = rec.strip().split(us)
        if len(parts) < 3:
            continue
        try:
            age = int(float(parts[2]))
        except ValueError:
            age = 0
        out.append((parts[0].strip(), parts[1].strip(), age))
    return out


def _kw_substring(keywords, hay):
    # Substring for IMPORTANT keywords - agglutinative languages (e.g. Hungarian)
    # need 'szamla' to match inside 'villanyszamla'. Over-surfacing is acceptable.
    for kw in keywords:
        if kw in hay:
            return kw
    return None


def _kw_boundary(keywords, hay):
    # Leading word boundary for SPAM keywords so 'akcio' != 'reakcio'.
    for kw in keywords:
        if re.search(r"\b" + re.escape(kw), hay):
            return kw
    return None


def classify(sender, subject, rules):
    hay = (sender + " " + subject).lower()
    for s in rules["important_senders"]:
        if s in hay:
            return "important", f"known sender ({s})"
    kw = _kw_substring(rules["important_keywords"], hay)
    if kw:
        return "important", f"keyword:{kw}"
    kw = _kw_boundary(rules["spam_keywords"], hay)
    if kw:
        return "dropped", f"spam:{kw}"
    return "review", "ambiguous"


def triage(max_age_min=90):
    rules = load_rules()
    important, review, dropped = [], [], 0
    for sender, subject, age_s in read_unread():
        if max_age_min and age_s > max_age_min * 60:
            continue
        bucket, reason = classify(sender, subject, rules)
        item = {"sender": sender, "subject": subject,
                "age_min": round(age_s / 60), "reason": reason}
        if bucket == "important":
            important.append(item)
        elif bucket == "review":
            review.append(item)
        else:
            dropped += 1
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "max_age_min": max_age_min,
        "important": important, "review": review, "dropped": dropped,
        "has_signal": bool(important or review),
    }


if __name__ == "__main__":
    age = int(sys.argv[1]) if len(sys.argv) > 1 else 90
    print(json.dumps(triage(age), ensure_ascii=False, indent=2))
