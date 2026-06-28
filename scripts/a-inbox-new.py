#!/usr/bin/env python3
"""
Detect NEW messages in Attila's a@fireg.hu inbox since the last check.

- Uses BODY.PEEK so it NEVER marks Attila's mail as read (he reads this inbox).
- Tracks the highest processed IMAP UID in store/a-inbox-state.json so it only
  reports genuinely new arrivals, not the existing backlog.
- First run: baselines to the current max UID (does NOT report the backlog).

Reads a@ creds (A_FIREG_USER / A_FIREG_PASS) from store/.email-creds.
Read-only: this script never sends, replies, or flags anything.

Usage: a-inbox-new.py [--init]   (--init forces re-baseline to current max UID)
"""
import imaplib, email, os, json, sys
from email.header import decode_header

STATE = os.path.join(os.path.dirname(__file__), "..", "store", "a-inbox-state.json")
CREDS = os.path.join(os.path.dirname(__file__), "..", "store", ".email-creds")


def cred(key):
    for line in open(CREDS):
        if line.startswith(key + "="):
            return line.strip().split("=", 1)[1]
    return None


def dec(s):
    if not s:
        return ""
    return "".join(p.decode(e or "utf-8", "replace") if isinstance(p, bytes) else str(p)
                    for p, e in decode_header(s))


def load_state():
    try:
        return json.load(open(STATE))
    except FileNotFoundError:
        return {}


def main():
    force_init = "--init" in sys.argv
    user = cred("A_FIREG_USER") or "a@fireg.hu"
    pw = cred("A_FIREG_PASS")
    if not pw:
        sys.exit("a@ password missing (A_FIREG_PASS in store/.email-creds)")
    imap = imaplib.IMAP4_SSL("mail.fws.hu", 993)
    imap.login(user, pw)
    imap.select("INBOX")
    _, data = imap.uid("search", None, "ALL")
    uids = [int(x) for x in data[0].split()]
    max_uid = max(uids) if uids else 0

    state = load_state()
    last = state.get("last_uid")

    if last is None or force_init:
        json.dump({"last_uid": max_uid}, open(STATE, "w"))
        print(f"[a-inbox] baseline set to UID {max_uid} ({len(uids)} existing, NOT processed)")
        imap.logout()
        return

    new_uids = [u for u in uids if u > last]
    if not new_uids:
        print("[a-inbox] no new mail")
        imap.logout()
        return

    print(f"[a-inbox] {len(new_uids)} NEW message(s):")
    for u in sorted(new_uids):
        _, d = imap.uid("fetch", str(u), "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        if not d or not d[0]:
            continue
        h = email.message_from_bytes(d[0][1])
        print(f"--- UID {u}")
        print(f"FROM: {dec(h.get('From'))}")
        print(f"DATE: {h.get('Date','')}")
        print(f"SUBJECT: {dec(h.get('Subject'))}")
    json.dump({"last_uid": max(new_uids)}, open(STATE, "w"))
    imap.logout()


if __name__ == "__main__":
    main()
