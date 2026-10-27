"""MAILGATESCRIPT1027: the main agent's approval gate sees a mail send done by a script FILE.

script_run_sends (outgoing-copy-gate.py) reads the script an interpreter runs and calls it a send when it
imports an SMTP library or nodemailer, or names a Microsoft Graph send endpoint; email-approval-gate.py
puts such a Bash call in scope next to is_send_invocation. A script that cannot be read is a send.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
GATE = os.path.join(HOOKS, "email-approval-gate.py")

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_store(td, level=2):
    """The temporary store of email-approval-gate.test.py: the autonomy config and an empty approvals DB."""
    store = os.path.join(td, "store")
    os.makedirs(store, exist_ok=True)
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
    return store


spec = importlib.util.spec_from_file_location("outgoing_copy_gate", os.path.join(HOOKS, "outgoing-copy-gate.py"))
ocg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocg)

GRAPH_SEND = ("const id = process.argv[2]\n"
              "await fetch('https://graph.microsoft.com/v1.0/me/messages/' + id + '/send', { method: 'POST' })\n")
GRAPH_REPLY = ("const u = 'x'\n"
               "await fetch(`https://graph.microsoft.com/v1.0/users/${u}/messages/1/reply`, { method: 'POST' })\n")
GRAPH_READ = "await fetch('https://graph.microsoft.com/v1.0/me/messages?top=5')\n"
SMTP_SEND = "import smtplib\ns = smtplib.SMTP('localhost')\n"
NM = "const nodemailer = require('nodemailer')\n"
HARMLESS = "console.log('hello')\n"
MAIN = "import './lib.mjs'\nconsole.log('main')\n"
LIB = "await fetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST' })\n"

D = tempfile.mkdtemp(prefix="gate-script-file-")
try:
    def put(name, text):
        path = os.path.join(D, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    put("graph-send.mjs", GRAPH_SEND)
    put("graph-reply.ts", GRAPH_REPLY)
    put("graph-read.mjs", GRAPH_READ)
    put("smtp-send.py", SMTP_SEND)
    put("nm.cjs", NM)
    put("harmless.mjs", HARMLESS)
    put("main.mjs", MAIN)
    put("lib.mjs", LIB)
    put("big.mjs", "console.log(1)\n" * (1024 * 1024 // 15 + 2))
    put("plain.py", "print('x')\n")
    os.makedirs(os.path.join(D, "sub"))
    put("sub/harmless.mjs", GRAPH_SEND)  # same name as the harmless one in D, but it sends
    locked = put("locked.mjs", "console.log('x')\n")
    can_lock = os.geteuid() != 0
    if can_lock:
        os.chmod(locked, 0)

    cases = [
        (f"node {D}/graph-send.mjs AAMk1", D, True, "node script with a Graph send"),
        (f"tsx {D}/graph-reply.ts", D, True, "tsx script with a Graph reply"),
        (f"node {D}/graph-read.mjs", D, False, "node script with a Graph read"),
        (f"python3 {D}/smtp-send.py", D, True, "python script importing smtplib"),
        (f"node {D}/nm.cjs", D, True, "node script requiring nodemailer"),
        (f"node {D}/harmless.mjs", D, False, "harmless node script"),
        (f"node {D}/main.mjs", D, True, "a local helper sends"),
        (f"node {D}/big.mjs", D, True, "a file over the read limit"),
        (f"node {D}/missing.mjs", D, True, "a missing script is a send (fail-closed)"),
        ("node graph-send.mjs", D, True, "relative script under cwd"),
        ("node graph-send.mjs", "/", True, "relative script found nowhere (fail-closed)"),
        ("node harmless.mjs", "/", True, "harmless script found nowhere (fail-closed)"),
        (f"cd {D} && node harmless.mjs", "/", False, "harmless script found through the cd target"),
        (f"cd {D} && node graph-send.mjs", "/", True, "sending script found through the cd target"),
        (f"cd {D}/sub && node harmless.mjs", D, True, "a harmless file under cwd does not hide the sending one in the cd target"),
        (f"bun run {D}/graph-send.mjs", D, True, "bun run"),
        (f"npx tsx {D}/graph-send.mjs", D, True, "npx tsx"),
        ("npx vitest run", D, False, "npx with another package"),
        ("bun test", D, False, "bun test is no script"),
        ("node --version", D, False, "no script operand"),
        ("node $SCRIPT", D, True, "undecidable operand (fail-closed)"),
        (f'bash -c "node {D}/graph-send.mjs"', D, True, "shell -c recursion"),
        (f"python3 {D}/plain.py --to b@example.test", D, True, "an address after --to makes any script run a send"),
        (f"python3 {D}/plain.py", D, False, "the same script without an address"),
        (f"{D}/missing-direct.py", D, True, "a directly run .py file that cannot be read (fail-closed)"),
    ]
    if can_lock:
        cases.append((f"node {D}/locked.mjs", D, True, "an unreadable script (fail-closed)"))
    else:
        print("  [SKIP] unreadable script: running as root")
    for cmd, cwd, want, what in cases:
        got = ocg.script_run_sends(cmd, cwd)
        check(f"MAILGATESCRIPT1027 {what}: {cmd!r} cwd={cwd!r} -> {want}", got is want, f"got {got}")

    direct = put("direct-send.py", "#!/usr/bin/env python3\n" + SMTP_SEND)
    os.chmod(direct, 0o755)
    check("MAILGATESCRIPT1027 a directly executed file with a python #! line importing smtplib",
          ocg.script_run_sends(direct, D) is True)

    # end to end through the hook process, level 2, no approval
    store = make_store(D, level=2)

    def run_gate(command):
        env = dict(os.environ, EMAIL_APPROVAL_GATE_STORE=store,
                   OUTGOING_COPY_GATE_RULES=os.path.join(store, "no-rules.json"))
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": D}
        p = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(),
                           capture_output=True, env=env)
        return p.returncode, p.stderr.decode()

    code, err = run_gate(f"node {D}/graph-send.mjs AAMk1")
    check("MAILGATESCRIPT1027 hook: a script-file Graph send at level 2 without approval is DENIED",
          code == 2, f"exit={code} err={err[:200]!r}")
    code, err = run_gate(f"node {D}/harmless.mjs")
    check("MAILGATESCRIPT1027 hook: a harmless script passes", code == 0, f"exit={code} err={err[:200]!r}")
finally:
    if os.path.isdir(D):
        shutil.rmtree(D, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All email-approval-gate-script-file tests passed.")
