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
import zipfile

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
    # MAILGATESCRIPT1027 R1: fixtures of the review fixes
    for sub_dir in ("a/b", "sub", "real", "link", "pkg"):
        os.makedirs(os.path.join(D, sub_dir), exist_ok=True)
    put("job.mjs", HARMLESS)
    put("a/b/job.mjs", GRAPH_SEND)
    os.chmod(put("task", "echo hi\n"), 0o755)
    os.chmod(put("sub/task", "#!/usr/bin/python3\nimport smtplib\n"), 0o755)
    put("real/main.mjs", "import './transport.mjs'\n")
    put("real/transport.mjs", GRAPH_SEND)
    os.symlink(os.path.join(D, "real", "main.mjs"), os.path.join(D, "link", "main.mjs"))
    put("pkg/__init__.py", "")
    put("pkg/main.py", "import smtplib\n")
    put("reexp.mjs", "export * from './transport2.mjs'\n")
    put("transport2.mjs", GRAPH_SEND)
    put("escaped.mjs", 'await fetch("https:\\/\\/graph.microsoft.com\\/v1.0\\/me\\/sendMail", { method: "POST" })\n')
    put("routes.mjs", "app.get('/me/messages/:id/reply', showReplyPage)\n")
    put("preview.mjs", "await fetch('https://graph.microsoft.com/v1.0/me/messages/1/send-preview')\n")
    # MAILGATESCRIPT1027 R2: fixtures of the second-round review fixes
    for sub_dir in ("r2pkg", "-P", "r2real", "r2link", "r2rel", "r2rel2"):
        os.makedirs(os.path.join(D, sub_dir), exist_ok=True)
    put("r2pkg/__init__.py", "")
    put("r2pkg/__main__.py", "print('x')\n")
    os.chmod(put("r2task", "echo hi\n"), 0o755)
    put("-P/r2job.mjs", GRAPH_SEND)
    put("r2job.mjs", "console.log(1)\n")
    put("r2real/main.mjs", "".join(f"import './h{n}.mjs'\n" for n in range(5)))
    put("r2real/h0.mjs", "const n = require('nodemailer')\n")
    for n in range(1, 5):
        put(f"r2real/h{n}.mjs", "console.log(1)\n")
    os.symlink(os.path.join(D, "r2real", "main.mjs"), os.path.join(D, "r2link", "main.mjs"))
    put("r2rel/__init__.py", "")
    put("r2rel/__main__.py", "from . import mailer\n")
    put("r2rel/mailer.py", "import smtplib\n")
    put("r2rel2/__init__.py", "")
    put("r2rel2/__main__.py", "from .mail import go\n")
    put("r2rel2/mail.py", "import smtplib\n")
    put("r2types.ts", "export type { T } from './r2sender.mjs'\nimport type { U } from './r2sender.mjs'\nconsole.log(1)\n")
    put("r2sender.mjs", GRAPH_SEND)
    put("r2uni.mjs", "await fetch('https://graph.microsoft.com/v1.0/me/messages/1/reply\u00e9')\n")
    # MAILGATESCRIPT1027 R3: the forms the round-2 commit lost, and a value import named `type`
    put("r3mailer.py", "import smtplib\n")
    put("r3star.py", "from r3mailer import *\n")
    put("r3paren.py", "from r3mailer import (\n    send,\n)\n")
    put("r3nospace.py", "from r3mailer import(send)\n")
    put("r3esc.mjs", 'const u = "https://graph.microsoft.com/v1.0/me/sendMail\\"; await fetch(u)\n')
    put("r3fstr.py", "import requests\nrequests.post(f'https://graph.microsoft.com/v1.0/me/sendMail{qs}')\n")
    put("r3sender.mjs", "import nodemailer from 'nodemailer'\nexport default 1\n")
    put("r3typedefault.mjs", "import type from './r3sender.mjs'\nvoid type\n")
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
        ("cd $DEST && node job.mjs", D, True, "cd to a variable: fail-closed"),
        ("cd a && cd b && node job.mjs", D, True, "chained relative cd"),
        ("cd -- a/b && node job.mjs", D, True, "cd -- DIR"),
        ("cd sub && ./task", D, True, "direct run: each candidate judged with its own kind"),
        ("./task", D, False, "a shell script run directly is not judged"),
        ("node link/main.mjs", D, True, "helper next to the real path of a symlinked entry"),
        ("python3 -m pkg.main", D, True, "python -m a local module that sends"),
        ("python3 -m pytest", D, False, "python -m an installed module"),
        ("node reexp.mjs", D, True, "an ESM re-export loads the helper"),
        ("node escaped.mjs", D, True, "escaped slashes in a Graph URL"),
        ("node routes.mjs", D, False, "an application route of the same shape, no Graph evidence"),
        ("node preview.mjs", D, False, "send-preview is no send action"),
        ("npx harmless-report --to qa@example.test", D, False, "npx with another package and an address"),
        (f"npx tsx {D}/harmless.mjs --to qa@example.test", D, True, "npx runner with an address"),
        ("cd $DEST && node --version", D, False, "no script operand under a variable cd"),
        ('cd "$DEST" && python3 -m r2pkg', D, True, "python -m after a variable cd: fail-closed"),
        ('cd "$DEST" && ./r2task', D, True, "an extensionless file after a variable cd: fail-closed"),
        ("cd -- -P && node r2job.mjs", D, True, "cd -- ends the options: -P is the directory"),
        ("node r2link/main.mjs", D, True, "a symlinked entry with five imports: the real-path helpers are read"),
        ("python3 -m r2rel", D, True, "python -m with a package-relative helper"),
        ("python3 -m r2rel2", D, True, "from .module import name"),
        ("tsx r2types.ts", D, False, "type-only export and import load nothing"),
        ("node r2uni.mjs", D, False, "a letter after the action word, also outside ASCII, ends no action"),
        ("python3 r3star.py", D, True, "from X import *"),
        ("python3 r3paren.py", D, True, "from X import ( over several lines"),
        ("python3 r3nospace.py", D, True, "from X import(name)"),
        ("node r3esc.mjs", D, True, "an escaped quote after the action word"),
        ("python3 r3fstr.py", D, True, "an f-string brace after the action word"),
        ("node r3typedefault.mjs", D, True, "a value import named type loads the module"),
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

    # MAILGATEDIRZIP1027: python runs a directory's __main__.py and a zip app; the zip is not unpacked: a send
    for sub_dir in ("r4dir", "r4clean", "r4empty"):
        os.makedirs(os.path.join(D, sub_dir), exist_ok=True)
    put("r4dir/__main__.py", SMTP_SEND)
    put("r4clean/__main__.py", "print('x')\n")
    for name in ("r4app.zip", "r4app.pyz"):
        with zipfile.ZipFile(os.path.join(D, name), "w") as z:
            z.writestr("__main__.py", "print('x')\n")
    with open(os.path.join(D, "r4app.zip"), "rb") as fh:
        zip_bytes = fh.read()
    shebang = os.path.join(D, "r4shebang.pyz")
    with open(shebang, "wb") as fh:
        fh.write(b"#!/usr/bin/env python3\n" + zip_bytes)
    os.chmod(shebang, 0o755)
    for cmd, want, what in [
        ("python3 r4dir", True, "a directory whose __main__.py sends"),
        ("python3 r4dir/", True, "the same directory with a trailing slash"),
        (f"python3 {D}/r4dir", True, "the same directory by absolute path"),
        ("python3 r4clean", False, "a directory whose __main__.py does not send"),
        ("python3 r4empty", False, "a directory without __main__.py"),
        ("python3 r4app.zip", True, "a zip app (not unpacked: a send)"),
        ("python3 r4app.pyz", True, "a .pyz app (not unpacked: a send)"),
        (shebang, True, "a directly executed zip app with a python #! line"),
        ("python3 plain.py", False, "control: a plain script that does not send"),
    ]:
        got = ocg.script_run_sends(cmd, D)
        check(f"MAILGATEDIRZIP1027 {what}: {cmd!r} -> {want}", got is want, f"got {got}")

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
