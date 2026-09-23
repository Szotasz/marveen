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
import shutil
import sqlite3
import subprocess
import tempfile
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


# MAILINDEXFAGYOTT914, root cause measured 2026-09-23 06:44 on the live install.
#
# The reader opened the envelope index with `immutable=1`, which promises SQLite
# the file cannot change -- so SQLite SKIPS THE WAL entirely. Mail.app runs the
# index in WAL mode, and everything since the last checkpoint lives in
# `Envelope Index-wal` (2 MB at the time of measurement). Measured, same second,
# same database:
#
#   immutable=1 (what this file did):  newest message 2026-09-22 22:15, 40485 rows
#   WAL-aware read:                    newest message 2026-09-23 02:02, 40487 rows
#
# Two messages that had arrived hours earlier were invisible, and the result came
# back as a clean zero with exit 0. That is the false zero behind fourteen
# consecutive "no mail" briefings between 2026-09-08 and 09-22: not (only) a
# frozen index, but a reader that could not see the newest mail even while
# Mail.app was running and writing.
#
# Order of attempts, all read-only, none of which writes to the live database:
#   1. mode=ro       -- WAL-aware, instant (0.00s measured). A WAL reader does not
#                       block Mail's writers.
#   2. temp copy     -- db + -wal + -shm copied out, then opened; 0.02s for 129 MB
#                       on APFS (clonefile). Used when SQLite refuses a read-only
#                       WAL open (SQLITE_READONLY_RECOVERY and friends).
#   3. immutable=1   -- the old path, kept as the last resort because a stale read
#                       beats no read; `read_mode` says so, and index_health()
#                       reports it, so the caller can never mistake it for fresh.
def _connect(db):
    """Open the envelope index read-only. Returns (connection, read_mode, tmpdir).
    tmpdir is None unless a copy was made (the caller removes it)."""
    try:
        return sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5), "ro", None
    except sqlite3.Error:
        pass
    tmp = tempfile.mkdtemp(prefix="mail-triage-")
    try:
        for suffix in ("", "-wal", "-shm"):
            src = db + suffix
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(tmp, os.path.basename(db) + suffix))
        copy = os.path.join(tmp, os.path.basename(db))
        return sqlite3.connect(f"file:{copy}?mode=ro", uri=True, timeout=10), "copy", tmp
    except (OSError, sqlite3.Error):
        shutil.rmtree(tmp, ignore_errors=True)
    return sqlite3.connect(f"file:{db}?immutable=1", uri=True, timeout=5), "immutable", None


# 180 minutes: long enough that a quiet night is not called broken, short enough
# that a morning read cannot sit on a dead index unnoticed. The WAL mtime below
# is the second, independent signal -- a recently written WAL proves the pipeline
# is alive even when no new mail happened to arrive.
STALE_AFTER_MIN = int(os.environ.get("MAIL_INDEX_STALE_MIN", "180"))
WAL_FRESH_MIN = int(os.environ.get("MAIL_INDEX_WAL_FRESH_MIN", "30"))


def index_health(db=None, now=None):
    """Measure whether a ZERO result from this index means anything.

    `usable` False means the emptiness is NOT a measurement: it must be reported
    as "cannot tell", never as "no mail". Two independent signals are combined,
    because neither alone can tell a frozen index from a genuinely quiet mailbox:
    the age of the newest indexed message, and the mtime of the WAL (anything
    writing the index at all)."""
    now = int(now if now is not None else time.time())
    db = db or _envelope_index_path()
    health = {
        "index_path": db, "read_mode": None, "index_latest": None,
        "index_age_min": None, "wal_age_min": None, "mail_running": None,
        "usable": False, "note": None,
    }
    # os.path.exists as well as the None check: a path that was handed in but
    # does not exist used to fall through to sqlite and come back as
    # "sqlite error: unable to open database file", which reads like a corrupt
    # database instead of an absent one. Found by this function's own test.
    if not db or not os.path.exists(db):
        health["note"] = "Envelope Index not found"
        return health
    wal = db + "-wal"
    if os.path.exists(wal):
        health["wal_age_min"] = max(0, int((now - os.path.getmtime(wal)) // 60))
    try:
        con, mode, tmp = _connect(db)
        health["read_mode"] = mode
        try:
            row = con.execute("SELECT MAX(date_received) FROM messages").fetchone()
        finally:
            con.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
    except sqlite3.Error as e:
        health["note"] = f"sqlite error: {e}"
        return health
    latest = int(row[0]) if row and row[0] else None
    if latest is None:
        health["note"] = "index holds no messages"
        return health
    health["index_latest"] = datetime.fromtimestamp(latest).isoformat(timespec="seconds")
    health["index_age_min"] = max(0, (now - latest) // 60)
    # pgrep is the cheapest honest signal for "is Mail even running". A missing
    # pgrep leaves it None (unknown), never False (which would be a claim).
    try:
        health["mail_running"] = subprocess.run(
            ["pgrep", "-x", "Mail"], capture_output=True, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        health["mail_running"] = None
    fresh_mail = health["index_age_min"] <= STALE_AFTER_MIN
    fresh_wal = health["wal_age_min"] is not None and health["wal_age_min"] <= WAL_FRESH_MIN
    health["usable"] = bool(fresh_mail or fresh_wal)
    if fresh_mail:
        health["note"] = f"newest indexed message {health['index_age_min']} min old"
    elif fresh_wal:
        health["note"] = (
            f"no new mail for {health['index_age_min']} min, but the index was written"
            f" {health['wal_age_min']} min ago -- the mail pipeline is alive")
    else:
        health["note"] = (
            f"cannot tell: newest indexed message is {health['index_age_min']} min old"
            f" and the index itself was last written"
            f" {health['wal_age_min'] if health['wal_age_min'] is not None else 'never'} min ago."
            " A frozen index and a quiet mailbox look the same from here, so a zero"
            " proves nothing.")
    return health


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
        con, _mode, tmp = _connect(db)
        try:
            rows = con.execute(sql, params).fetchall()
        finally:
            con.close()
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
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
    health = index_health()
    out = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "max_age_min": max_age_min,
        "important": important, "review": review, "dropped": dropped,
        "has_signal": bool(important or review),
        "source": health,
        # Read this BEFORE the buckets: with an unusable index an empty result
        # says nothing about the mailbox, and reporting it as "no mail" is the
        # false zero this card is about.
        "zero_means": "no-unread" if health["usable"] else "cannot-tell",
    }
    if not health["usable"]:
        out["warning"] = (
            "A nulla NEM meres: a Mail.app envelope indexe nem hasznalhato ("
            + str(health["note"]) + "). Ezt ki kell mondani, nem 'nincs level'-kent jelenteni.")
    return out


if __name__ == "__main__":
    age = int(sys.argv[1]) if len(sys.argv) > 1 else 90
    print(json.dumps(triage(age), ensure_ascii=False, indent=2))
