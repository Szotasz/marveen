"""CURLMAILAPI1118: a bare curl/wget to an HTTP mail API send endpoint is in the approval gate's scope.

Before this, only api.resend.com was known on the command line: a curl written straight into a Bash call to
Gmail's messages/send or drafts/send (and to Graph sendMail, SendGrid, Mailgun, Postmark) passed
email-approval-gate.py at level 2 with no approval, while the same call from a script file was stopped
(MAILGATEHTTPAPI1027). The commands come from the shared case list (send-invocation-cases.json, the
CURLMAILAPI1118 entries), so this file names no endpoint itself. Nothing is sent: the gate only judges the
command text, curl never runs.

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
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
TAG = "CURLMAILAPI1118: "

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_install(td, level):
    """A tmp install: <root>/scripts linked to this repo's scripts/ (the gate takes its root from abspath),
    and a store with the email_send level and an empty approvals table."""
    root = os.path.join(td, f"install-l{level}")
    store = os.path.join(root, "store")
    os.makedirs(store)
    os.symlink(os.path.dirname(HOOKS), os.path.join(root, "scripts"))
    cat = {"key": "email_send", "label": "Email", "level": level, "locked": False}
    with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [cat]}, fh)
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute("""
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
        action_description TEXT NOT NULL, action_payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        timeout_at INTEGER, telegram_message_id INTEGER,
        requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        resolved_at INTEGER, resolved_by TEXT,
        content_hash TEXT, consumed_at INTEGER)""")
    con.commit()
    con.close()
    return os.path.join(root, "scripts", "hooks", "email-approval-gate.py")


def run_gate(gate, command, cwd):
    payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}
    p = subprocess.run([sys.executable, gate], input=json.dumps(payload).encode(), capture_output=True)
    return p.returncode, p.stderr.decode()


with open(os.path.join(HOOKS, "send-invocation-cases.json"), encoding="utf-8") as fh:
    CASES = [c for c in json.load(fh)["cases"] if c["name"].startswith(TAG)]
check("the shared list carries the CURLMAILAPI1118 cases, sends and non-sends",
      any(c["expected"] for c in CASES) and any(not c["expected"] for c in CASES), f"{len(CASES)} cases")

D = tempfile.mkdtemp(prefix="curlmailapi-")
try:
    gate2 = make_install(D, 2)
    for c in CASES:
        code, err = run_gate(gate2, c["cmd"], D)
        if c["expected"]:
            check(f"level 2, no approval, DENIED: {c['name'][len(TAG):]}", code == 2, f"exit={code} err={err[:200]!r}")
        else:
            check(f"level 2 passes: {c['name'][len(TAG):]}", code == 0, f"exit={code} err={err[:200]!r}")
    gate1 = make_install(D, 1)
    send = next(c for c in CASES if c["expected"])
    code, err = run_gate(gate1, send["cmd"], D)
    check("level 1 is a hard deny for the same curl send", code == 2, f"exit={code} err={err[:200]!r}")
finally:
    shutil.rmtree(D, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All email-approval-gate-curl-mail-api tests passed.")
