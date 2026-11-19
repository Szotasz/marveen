"""GMAILDRAFT1116 (PR #2824 rework): the Gmail draft is written inside the dashboard (POST /api/gmail/draft), and the
agent reaches it through `bash scripts/marveen-api.sh gmail-draft <agent> <json-file>`. That call is not a send: it
holds no address on its command line, no mail API and no mail library, and the endpoint behind it can only write a
draft (src/web/gmail-draft.ts ALLOWED_GMAIL_REQUESTS). The gate has NO special case for it: it passes on the gate's
ordinary rules, which is what this file pins, next to the sends that must stay levelled:
  - a script that calls Gmail's drafts/send or messages/send,
  - send_draft.py,
  - the Gmail MCP send tools and send_email,
  - a run of the removed pinned writer (scripts/hooks/gmail-draft.py, the first version of this PR): with an address
    it is a send again (the gate's command-shape recognition is gone with it).

This file drives the real hook (email-approval-gate.py) as a subprocess at level 2 without an approval, so exit 2 = the
call is stopped, exit 0 = it passes. Nothing is executed: the hook only reads the command text and the script files.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_install(td):
    """A throwaway install with email_send at level 2 and an empty approvals table (as email-approval-gate-substsplit)."""
    os.symlink(SCRIPTS, os.path.join(td, "scripts"))
    store = os.path.join(td, "store")
    os.makedirs(os.path.join(store, "outbox"))
    with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [{"key": "email_send", "label": "Email", "level": 2, "locked": False}]}, fh)
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute("""CREATE TABLE approvals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
        action_description TEXT NOT NULL, action_payload TEXT, status TEXT NOT NULL DEFAULT 'pending',
        timeout_at INTEGER, telegram_message_id INTEGER,
        requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        resolved_at INTEGER, resolved_by TEXT, content_hash TEXT, consumed_at INTEGER)""")
    con.commit()
    con.close()
    return os.path.join(td, "scripts", "hooks", "email-approval-gate.py")


td = tempfile.mkdtemp(prefix="gmaildraft-endpoint-")
try:
    gate = make_install(td)
    W = os.path.join(td, "work")
    os.makedirs(W)

    def rc(tool_name, tool_input, cwd=td):
        payload = {"tool_name": tool_name, "tool_input": tool_input, "cwd": cwd}
        p = subprocess.run([sys.executable, gate], input=json.dumps(payload), capture_output=True, text=True)
        return p.returncode, p.stderr

    def bash(command, cwd=td):
        return rc("Bash", {"command": command}, cwd)

    # The JSON letter names recipients, the drafts endpoint and even the word "send": the gate never reads it.
    letter = os.path.join(td, "store", "outbox", "send-offer.json")
    with open(letter, "w", encoding="utf-8") as fh:
        json.dump({"to": "anna@example.com", "cc": "owner@example.com", "subject": "send the offer",
                   "text": "users/me/messages/send", "attachments": ["offer.pdf"]}, fh)

    print("== the endpoint verb is a draft by the ordinary rules (exit 0 at level 2, no approval)")
    for name, cmd, cwd in (
        ("relative, from the root", "bash scripts/marveen-api.sh gmail-draft marveen store/outbox/send-offer.json", td),
        ("absolute script, absolute letter", f"bash {td}/scripts/marveen-api.sh gmail-draft marveen {letter}", W),
        ("with 2>&1 and a tail", f"bash {td}/scripts/marveen-api.sh gmail-draft grafit {letter} 2>&1 | tail -5", W),
    ):
        code, err = bash(cmd, cwd)
        check(f"{name} -> exit 0", code == 0, f"exit={code} err={err[:300]!r}")

    print("== real sends stay levelled (exit 2 at level 2 without an approval)")
    for fname, body in (
        ("drafts-send.py", 'import urllib.request\nurllib.request.urlopen(urllib.request.Request('
                           '"https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", data=b"{}"))\n'),
        ("messages-send.py", 'import urllib.request\nurllib.request.urlopen(urllib.request.Request('
                             '"https://gmail.googleapis.com/gmail/v1/users/me/messages/send", data=b"{}"))\n'),
        ("gapi-send.py", 'from googleapiclient.discovery import build\n'
                         's = build("gmail", "v1")\ns.users().messages().send(userId="me", body={}).execute()\n'),
    ):
        p = os.path.join(W, fname)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(body)
        code, err = bash(f"python3 {p}", W)
        check(f"a script calling Gmail send ({fname}) -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")

    code, err = bash(f"python3 {td}/scripts/send_draft.py --draft-id r123", td)
    check("send_draft.py -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")

    code, err = bash("python3 -I -S scripts/hooks/gmail-draft.py --subject s --text store/outbox/t.txt --to a@example.com", td)
    check("the removed pinned writer with an address -> exit 2 (no command-shape draft class any more)", code == 2,
          f"exit={code} err={err[:200]!r}")

    for tool, inp in (
        ("mcp__claude_ai_Gmail__send_message", {"to": ["a@example.com"], "subject": "x", "body": "y"}),
        ("mcp__gmail__send_email", {"to": ["a@example.com"], "subject": "x", "body": "y"}),
        ("mcp__claude_ai_Gmail__send_draft", {"draftId": "r123"}),
    ):
        code, err = rc(tool, inp)
        check(f"{tool} -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")

    print("== a draft tool is still a draft (control)")
    code, err = rc("mcp__claude_ai_Gmail__create_draft", {"to": ["a@example.com"], "subject": "x", "body": "y"})
    check("mcp create_draft -> exit 0", code == 0, f"exit={code} err={err[:200]!r}")

    print("== the gate holds no special case for the endpoint or the old writer")
    with open(os.path.join(SCRIPTS, "hooks", "email-approval-gate.py"), encoding="utf-8") as fh:
        src = fh.read()
    for needle in ("canonical_draft_run", "GMAIL_DRAFT_SHA256", "gmail-draft.py", "/api/gmail/draft", "gmail-draft"):
        check(f"email-approval-gate.py does not name {needle!r}", needle not in src)
    check("scripts/hooks/gmail-draft.py is gone", not os.path.exists(os.path.join(SCRIPTS, "hooks", "gmail-draft.py")))
finally:
    shutil.rmtree(td, ignore_errors=True)

print(f"\n{'FAILED: ' + str(len(failed)) if failed else 'ALL PASS'}")
sys.exit(1 if failed else 0)
