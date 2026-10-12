#!/usr/bin/env python3
"""
Deterministic Mail.app triage for an hourly email heartbeat (macOS).

Reads UNREAD inbox messages directly from the Mail.app SQLite envelope index
(auth-free, read-only, never locks/modifies the DB), applies rule-based
filtering, prints JSON. Does NOT send anything and does NOT mark mail read - the
final nuanced judgment stays with the agent, which reads this compact JSON
instead of raw mail, saving tokens.

The envelope index is used instead of AppleScript: on a large mailbox (tens of
thousands of unread) the Mail scripting bridge times out (>60s), while the
SQLite index answers in milliseconds and filters by date window in SQL.

Buckets: important (known senders or important keywords), review (ambiguous),
dropped (clear spam/promo - count only).

PRIVACY: DEFAULTS ship with EMPTY important_senders and only generic keywords.
Put your real senders/keywords in `mail_rules.json` next to this file (keep that
file OUT of version control). See mail_rules.example.json.

Usage: mail_triage.py [max_age_min]   # default 90; 0 = all unread
"""
import glob
import json
import os
import re
import sqlite3
import sys
import time
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


def _envelope_index_path():
    # macOS bumps the V-version per release (V10 on current); pick the newest.
    cands = glob.glob(os.path.expanduser(
        "~/Library/Mail/V*/MailData/Envelope Index"))
    if not cands:
        return None
    return max(cands, key=os.path.getmtime)


def read_unread(max_age_min=90):
    """Return [(sender, subject, age_seconds)] for unread INBOX messages.

    Reads the Mail.app SQLite envelope index read-only (immutable=1 never locks
    or checkpoints the live DB). Filters to the time window in SQL so a mailbox
    with tens of thousands of unread messages is never fully materialised.
    max_age_min=0 means no time filter (all unread).
    """
    db = _envelope_index_path()
    if not db:
        sys.stderr.write("mail_triage: Envelope Index not found\n")
        return []
    now = int(time.time())
    where = ["mb.url LIKE '%/INBOX'", "m.read=0", "m.deleted=0"]
    params = []
    if max_age_min:
        where.append("m.date_received >= ?")
        params.append(now - max_age_min * 60)
    sql = (
        "SELECT COALESCE(a.comment,''), COALESCE(a.address,''), "
        "COALESCE(s.subject,''), m.date_received "
        "FROM messages m "
        "JOIN mailboxes mb ON m.mailbox=mb.ROWID "
        "LEFT JOIN addresses a ON m.sender=a.ROWID "
        "LEFT JOIN subjects s ON m.subject=s.ROWID "
        "WHERE " + " AND ".join(where)
    )
    try:
        con = sqlite3.connect(f"file:{db}?immutable=1", uri=True, timeout=5)
        rows = con.execute(sql, params).fetchall()
        con.close()
    except sqlite3.Error as e:
        sys.stderr.write(f"mail_triage: sqlite error: {e}\n")
        return []
    out = []
    for comment, address, subject, date_received in rows:
        sender = f"{comment} <{address}>".strip() if address else comment
        age = max(0, now - int(date_received or now))
        out.append((sender.strip(), subject.strip(), age))
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
    for sender, subject, age_s in read_unread(max_age_min):
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
