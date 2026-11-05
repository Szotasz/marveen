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


def gate_for(store, gate):
    """ENVRELAXGATE1104: the gate reads only <its own install>/store (and the
    .env next to it), never a store named by the environment. So:
      - the real gate runs from the tmp install that owns `store`: <root>/scripts
        is linked to this repo's scripts/ (the gate takes its root from abspath,
        not realpath, so <root> stays the root);
      - a disposable copy (copy_hook_tree) gets its store/ and .env linked to
        the ones of `store`, re-pointed on every run."""
    root = os.path.dirname(os.path.abspath(store))
    if gate == GATE:
        link = os.path.join(root, "scripts")
        if not os.path.lexists(link):
            os.symlink(os.path.dirname(HOOKS), link)
        return os.path.join(link, "hooks", "email-approval-gate.py")
    copy_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(gate))))
    for name, target in (("store", os.path.abspath(store)), (".env", os.path.join(root, ".env"))):
        p = os.path.join(copy_root, name)
        if os.path.islink(p):
            os.unlink(p)
        if os.path.exists(target) and not os.path.exists(p):
            os.symlink(target, p)
    return gate

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
        # COPYGATEDRAFTFP1104: an address still makes a script run a send, unless the interpreter is isolated (-I -S)
        # and the script walks clean (see below)
        (f"python3 {D}/plain.py --to b@example.test", D, True, "an address after --to makes a script run a send"),
        (f"python3 -I -S {D}/plain.py --to b@example.test", D, False, "the same, isolated, on a script that does not send"),
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

    # MAILGATEDIRZIP1027: node runs DIR/package.json "main", else DIR/index.js
    for sub_dir in ("r4nmain/lib", "r4nidx", "r4nclean", "r4nbadmain", "r4nbadjson", "r4nempty", "r4nidxmain",
                    "r4ndirmain/index.js"):
        os.makedirs(os.path.join(D, sub_dir), exist_ok=True)
    put("r4nmain/package.json", '{"main": "lib/start.js"}')
    put("r4nmain/lib/start.js", NM)
    put("r4nidx/index.js", NM)
    put("r4nclean/index.js", "console.log(1)\n")
    put("r4nbadmain/package.json", '{"main": "lib/start"}')
    put("r4nbadjson/package.json", "{ not json")
    put("r4nidxmain/package.json", '{"main": "index.js"}')
    put("r4ndirmain/package.json", '{"main": "index.js"}')
    put("r4ndirmain/index.js/index.js", NM)
    for cmd, want, what in [
        ("node r4nmain", True, "a directory whose package.json main sends"),
        ("node r4nidx", True, "a directory whose index.js sends"),
        ("node r4nclean", False, "a directory whose index.js does not send"),
        ("node r4nbadmain", True, "a main that cannot be read as named (fail-closed)"),
        ("node r4nbadjson", True, "an unparseable package.json (fail-closed)"),
        ("node r4nempty", False, "a directory without package.json or index.js"),
        ("node r4nidxmain", True, "a declared main index.js that is missing (fail-closed)"),
        ("node r4ndirmain", True, "a declared main index.js that is a directory (fail-closed)"),
        ("python3 -um pkg.main", True, "-m at the end of a flag cluster"),
        ("python3 -BImpkg.main", True, "-m with its module joined to a flag cluster"),
    ]:
        got = ocg.script_run_sends(cmd, D)
        check(f"MAILGATEDIRZIP1027 {what}: {cmd!r} -> {want}", got is want, f"got {got}")

    # COPYGATEDRAFTFP1104 (Samu 69301): a python script run with --to/--cc/--bcc is judged by its content only when
    # everything it can run is visible: its imports, through its local helpers, are the standard library or local files.
    os.makedirs(os.path.join(D, "cg"), exist_ok=True)
    os.makedirs(os.path.join(D, "cg/shadow"), exist_ok=True)
    os.makedirs(os.path.join(D, "cg/deep"), exist_ok=True)
    DRAFT = ("import argparse, imaplib, os, re, time\n"
             "from email.message import EmailMessage\n"
             "from email.utils import formatdate\n"
             "# a comment may name subprocess or smtplib: it runs nothing\n"
             "PAT = re.compile(r'x')\n"
             "p = argparse.ArgumentParser(); p.add_argument('--to'); a = p.parse_args()\n"
             "m = EmailMessage(); m['To'] = a.to; m['Date'] = formatdate(); m.set_content('x')\n"
             "c = imaplib.IMAP4_SSL(os.environ.get('IMAP_HOST', 'imap.example.invalid'))\n"
             "c.append('Drafts', '\\\\Draft', imaplib.Time2Internaldate(time.time()), m.as_bytes())\n")
    put("cg/draft.py", DRAFT)
    put("cg/drafthelp.py", "import argparse\nfrom cghelper import build\nbuild()\n")
    put("cg/cghelper.py", "import imaplib\ndef build():\n    return imaplib.IMAP4_SSL\n")
    put("cg/smtpto.py", "import argparse, smtplib\ns = smtplib.SMTP('x'); s.sendmail('a', ['b'], 'c')\n")
    put("cg/pkgsend.py", "import argparse\nfrom acme_mail import deliver\ndeliver('x')\n")
    put("cg/helpsend.py", "from cgmailer import go\ngo()\n")
    put("cg/cgmailer.py", "import smtplib\ndef go():\n    smtplib.SMTP('x')\n")
    put("cg/helpproc.py", "from cgproc import go\ngo()\n")
    put("cg/cgproc.py", "import subprocess\ndef go():\n    subprocess.run(['true'])\n")
    put("cg/helppkg.py", "import cgpkghelper\n")
    put("cg/cgpkghelper.py", "import requests\n")
    put("cg/shadow/draft.py", "import imaplib\n")
    put("cg/shadow/imaplib.py", "import smtplib\n")
    put("cg/deep/d0.py", "import d1\n")
    for n in range(1, 7):
        put(f"cg/deep/d{n}.py", f"import d{n + 1}\n" if n < 6 else "print(1)\n")
    put("cg/wide.py", "".join(f"import w{n}\n" for n in range(30)))
    for n in range(30):
        put(f"cg/w{n}.py", "print(1)\n")
    # every branch of Samu 69301 point 1, one script each, all with an address: DENY
    unfollowed = {
        "dyn_importlib": "import importlib\nimportlib.import_module('x')\n",
        "dyn_dunder": "m = __import__('json')\n",
        "dyn_runpy": "import runpy\nrunpy.run_path('x.py')\n",
        "dyn_exec": "exec(open('x.py').read())\n",
        "dyn_eval": "eval('1')\n",
        "dyn_compile": "c = compile('1', 'x', 'eval')\n",
        "proc_subprocess": "import subprocess\nsubprocess.run(['x'])\n",
        "proc_os_system": "import os\nos.system('x')\n",
        "proc_os_popen": "import os\nos.popen('x')\n",
        "proc_os_exec": "import os\nos.execv('/bin/x', ['x'])\n",
        "proc_from_os": "from os import system\nsystem('x')\n",
        "proc_os_alias": "import os as o\no.system('x')\n",
        "net_socket": "import socket\nsocket.create_connection(('x', 25))\n",
        "net_ssl": "import ssl\nssl.create_default_context()\n",
        "net_urllib": "import urllib.request\nurllib.request.urlopen('x')\n",
        "net_http": "import http.client\n",
        "c_half": "import _socket\n",
        "pickle": "import pickle\npickle.loads(b'x')\n",
        "sys_path": "import sys\nsys.path.insert(0, '/x')\nimport imaplib\n",
        "getattr": "import os\ngetattr(os, 'sys' + 'tem')('x')\n",
        "continuation": "import imaplib, \\\n    smtplib\n",
    }
    for name, body in unfollowed.items():
        put(f"cg/u_{name}.py", body)  # u_: a fixture named like a stdlib module would import itself
    for cmd, want, what in [
        # Bence 69343 / Samu 69345: start-up code (.pth, sitecustomize) runs before the script; only an isolated
        # interpreter lets the walk decide
        ("python3 draft.py --to a@example.test", True, "the clean draft writer, NOT isolated: a send"),
        ("python3 -I -S draft.py --to a@example.test", False, "the same, isolated: the walk decides"),
        ("python3 -IS draft.py --to a@example.test", False, "isolated, -IS"),
        ("python3 -SI draft.py --to a@example.test", False, "isolated, -SI"),
        ("python3 -E -s -S draft.py --to a@example.test", False, "isolated, -E -s -S"),
        ("python3 -u -I -B -S draft.py --to a@example.test", False, "isolated among other options"),
        ("python3 -I draft.py --to a@example.test", True, "-I alone leaves the site module on"),
        ("python3 -S draft.py --to a@example.test", True, "-S alone leaves the environment on"),
        ("python3 -E -S draft.py --to a@example.test", True, "-E -S without -s"),
        ("python3 -XIS draft.py --to a@example.test", True, "-X takes its value: IS is no option"),
        ("python3 -W IS draft.py --to a@example.test", True, "-W takes its value: IS is no option"),
        # Bence 69412 / Samu 69415: only the real interpreter is walked; a program merely NAMED python3 is not
        ("/tmp/planted/python3 -I -S draft.py --to a@example.test", True, "an absolute path outside the system bins"),
        ("./python3 -I -S draft.py --to a@example.test", True, "a relative path"),
        ("PATH=/tmp/planted:$PATH python3 -I -S draft.py --to a@example.test", True, "a PATH prefix"),
        ("export PATH=/tmp/planted:$PATH; python3 -I -S draft.py --to a@example.test", True, "an exported PATH"),
        ("python3() { /tmp/planted/x \"$@\"; }; python3 -I -S draft.py --to a@example.test", True, "a function named python3"),
        ("env PATH=/tmp/planted python3 -I -S draft.py --to a@example.test", True, "env PATH="),
        ("cd /tmp/planted && ./python3 -I -S draft.py --to a@example.test", True, "a relative path after a cd"),
        ("PATH+=:/tmp/planted; python3 -I -S draft.py --to a@example.test", True, "PATH+="),
        ("alias python3=/tmp/planted/x; python3 -I -S draft.py --to a@example.test", True, "an alias"),
        ("hash -p /tmp/planted/x python3; python3 -I -S draft.py --to a@example.test", True, "a hash entry"),
        ("function python3 { /tmp/planted/x; }; python3 -I -S draft.py --to a@example.test", True, "function python3"),
        ("/usr/bin/python3 -I -S draft.py --to a@example.test", False, "a system bin path is the real interpreter"),
        ("/opt/homebrew/bin/python3 -I -S draft.py --to a@example.test", False, "the Homebrew bin path too"),
        ("python3.12 -I -S draft.py --to a@example.test", False, "a versioned bare name"),
        ("python3 -I -S draft.py --to a@example.test --subject s", False, "an IMAP draft writer with --to (the customer case)"),
        ("python3 -I -S draft.py --to=a@example.test", False, "the same with --to="),
        ("python3 -I -S draft.py --cc a@example.test --bcc b@example.test", False, "the same with --cc/--bcc"),
        ("python3 -I -S drafthelp.py --to a@example.test", False, "a local helper that only uses imaplib"),
        ("python3 -I -S smtpto.py --to a@example.test", True, "smtplib sendmail with an address"),
        ("python3 smtpto.py", True, "smtplib sendmail without an address"),
        ("python3 -I -S pkgsend.py --to a@example.test", True, "an installed package may send: the address rule holds"),
        ("python3 pkgsend.py", False, "the same without an address (as before)"),
        ("python3 -I -S helpsend.py --to a@example.test", True, "a local helper imports smtplib"),
        ("python3 -I -S helpproc.py --to a@example.test", True, "a local helper starts a process"),
        ("python3 -I -S helppkg.py --to a@example.test", True, "a local helper imports an installed package"),
        ("python3 -I -S shadow/draft.py --to a@example.test", True, "a local imaplib.py shadows the stdlib and sends"),
        ("python3 -I -S deep/d0.py --to a@example.test", True, "the helper chain is deeper than the walk"),
        ("python3 -I -S wide.py --to a@example.test", True, "more helpers than the file budget"),
        ("python3 -I -S nothere.py --to a@example.test", True, "a missing script with an address"),
        ("PYTHONPATH=/x python3 -I -S draft.py --to a@example.test", True, "a PYTHON* setting can change what an import loads"),
        ("python3 -I -S -c 'print(1)' --to a@example.test", True, "a code string with an address"),
        ("python3 -I -S -m draft --to a@example.test", True, "a module run with an address"),
        ("python3 -I -S $S --to a@example.test", True, "an undecidable script with an address"),
    ] + [(f"python3 -I -S u_{n}.py --to a@example.test", True, f"unfollowed code ({n})") for n in unfollowed]:
        got = ocg.script_run_sends(cmd, os.path.join(D, "cg"))
        check(f"COPYGATEDRAFTFP1104 {what}: {cmd!r} -> {want}", got is want, f"got {got}")

    # Bence 69319 (round 2): the stdlib rule is an ALLOWLIST. A stdlib module that sends or runs code, a module reached
    # through another module's attribute, and os/sys beyond their plain attributes are not followed: DENY
    round2 = {
        "log_smtp": "import logging.handlers\nh = logging.handlers.SMTPHandler('x', 'a', ['b'], 's')\n",
        "log_from": "from logging.handlers import SMTPHandler\nSMTPHandler('x', 'a', ['b'], 's')\n",
        "timeit": "import timeit\ntimeit.timeit('1')\n",
        "cprofile": "import cProfile\ncProfile.run('1')\n",
        "trace": "import trace\ntrace.Trace().run('1')\n",
        "pdb": "import pdb\npdb.run('1')\n",
        "doctest": "import doctest\ndoctest.run_docstring_examples(f, {})\n",
        "attrgetter": "import operator, os\noperator.attrgetter('sys' + 'tem')(os)('x')\n",
        "os_dict": "import os\nos.__dict__['sys' + 'tem']('x')\n",
        "os_path_os": "import os\nos.path.os.system('x')\n",
        "bare_os": "import os\ndef f(m):\n    return m\nf(os)\n",
        "sys_alias": "import sys as s\n",
        "sys_modules": "import sys\nsys.modules['x']\n",
        "imaplib_socket": "import imaplib\nimaplib.socket.create_connection(('x', 25))\n",
        "imaplib_subprocess": "import imaplib\nimaplib.subprocess.run(['x'])\n",
        "imap_stream": "import imaplib\nimaplib.IMAP4_stream('x')\n",
        "from_imap_stream": "from imaplib import IMAP4_stream\n",
        "paren_from": "from imaplib import (\n    IMAP4_SSL,\n    IMAP4_stream,\n)\n",
        "from_imaplib_socket": "from imaplib import socket\n",
        "from_star": "from imaplib import *\n",
        "pathlib_os": "import pathlib\npathlib.os.system('x')\n",
        "argparse_private": "import argparse\nargparse._os.system('x')\n",
        "uuid_private": "import uuid\nuuid._get_command_stdout('x')\n",
        "imap_reopen_send": "import imaplib\nc = imaplib.IMAP4_SSL('x')\nc.open('smtp.x', 465)\nc.send(b'EHLO x')\n",
        "imap_subclass": "import imaplib\nclass C(imaplib.IMAP4):\n    def __init__(self):\n        pass\n",
        "type_hints": "import typing\ntyping.get_type_hints(object)\n",
        "help": "help(str)\n",
        "not_allowlisted": "import shutil\n",
        "not_allowlisted_typing": "from typing import Optional\n",
        "not_allowlisted_collections": "import collections\n",
        "os_listdir": "import os\nos.listdir('.')\n",
        "sys_stderr": "import sys\nprint('x', file=sys.stderr)\n",
    }
    for name, body in round2.items():
        put(f"cg/v_{name}.py", body)
    # the allowlist's plain forms a draft writer uses: not a send
    plain = {
        "os_plain": "from os import environ, path\nfrom os.path import join\nimport os.path\nprint(environ, path, join('a'), os.path.join('a'))\n",
        "sys_plain": "import sys\nbody = sys.stdin.read()\nprint(sys.argv[1:], body)\nsys.exit(0)\n",
        "class_self": "import imaplib\nclass D:\n    def __init__(self):\n        self._c = None\n    def f(self):\n        return self._c\n",
    }
    for name, body in plain.items():
        put(f"cg/p_{name}.py", body)
    for cmd, want, what in (
        [(f"python3 -I -S v_{n}.py --to a@example.test", True, f"round 2, not followed ({n})") for n in round2]
        + [(f"python3 -I -S p_{n}.py --to a@example.test", False, f"round 2, plain form ({n})") for n in plain]
    ):
        got = ocg.script_run_sends(cmd, os.path.join(D, "cg"))
        check(f"COPYGATEDRAFTFP1104 {what}: {cmd!r} -> {want}", got is want, f"got {got}")

    # end to end through the hook process, level 2, no approval
    store = make_store(D, level=2)

    def run_gate(command):
        env = dict(os.environ)
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": D}
        p = subprocess.run([sys.executable, gate_for(store, GATE)], input=json.dumps(payload).encode(),
                           capture_output=True, env=env)
        return p.returncode, p.stderr.decode()

    code, err = run_gate(f"node {D}/graph-send.mjs AAMk1")
    check("MAILGATESCRIPT1027 hook: a script-file Graph send at level 2 without approval is DENIED",
          code == 2, f"exit={code} err={err[:200]!r}")
    code, err = run_gate(f"node {D}/harmless.mjs")
    check("MAILGATESCRIPT1027 hook: a harmless script passes", code == 0, f"exit={code} err={err[:200]!r}")
    # COPYGATEDRAFTFP1104 end to end: the draft writer with an address passes the hook, the sender does not
    code, err = run_gate(f"cd {D}/cg && python3 -I -S draft.py --to a@example.test")
    check("COPYGATEDRAFTFP1104 hook: the IMAP draft writer with --to, isolated, passes", code == 0, f"exit={code} err={err[:300]!r}")
    code, err = run_gate(f"cd {D}/cg && python3 draft.py --to a@example.test")
    check("COPYGATEDRAFTFP1104 hook: the same NOT isolated is DENIED and the message names python3 -I -S",
          code == 2 and "python3 -I -S" in err, f"exit={code} err={err[:400]!r}")
    code, err = run_gate(f"cd {D}/cg && python3 pkgsend.py --to a@example.test")
    check("COPYGATEDRAFTFP1104 hook: a real sender gets no -I -S hint", code == 2 and "python3 -I -S" not in err,
          f"exit={code} err={err[:400]!r}")
    for cmd, want in ((f"python3 draft.py --to a@example.test", True), (f"python3 -I -S draft.py --to a@example.test", False),
                      (f"python3 pkgsend.py --to a@example.test", False), (f"python3 draft.py", False)):
        got = ocg.draft_isolation_hint(cmd, os.path.join(D, "cg"))
        check(f"COPYGATEDRAFTFP1104 draft_isolation_hint: {cmd!r} -> {want}", got is want, f"got {got}")
    code, err = run_gate(f"cd {D}/cg && python3 -I -S pkgsend.py --to a@example.test")
    check("COPYGATEDRAFTFP1104 hook: an installed-package sender with --to, isolated, is DENIED", code == 2,
          f"exit={code} err={err[:200]!r}")
    # the same hooks under Python < 3.10 (the walk needs no 3.10 feature): the draft writer passes, the package sender
    # is denied (there by the approval gate's own fail-closed load of its email_extract dependency, EMAILGATEPY39-1104)
    old_py = next((x for x in ("/usr/bin/python3",) if os.path.exists(x)), None)
    if old_py and subprocess.run([old_py, "-c", "import sys; sys.exit(0 if sys.version_info < (3, 10) else 1)"]).returncode == 0:
        for script, want in (("draft.py", 0), ("pkgsend.py", 2)):
            payload = {"tool_name": "Bash", "tool_input": {"command": f"cd {D}/cg && python3 -I -S {script} --to a@example.test"}, "cwd": D}
            p = subprocess.run([old_py, gate_for(store, GATE)], input=json.dumps(payload).encode(), capture_output=True)
            check(f"COPYGATEDRAFTFP1104 hook under Python < 3.10: {script} with an address -> exit {want}",
                  p.returncode == want, f"exit={p.returncode} err={p.stderr.decode()[:300]!r}")
    else:
        print("  [SKIP] no Python < 3.10 at /usr/bin/python3")
finally:
    if os.path.isdir(D):
        shutil.rmtree(D, ignore_errors=True)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All email-approval-gate-script-file tests passed.")
