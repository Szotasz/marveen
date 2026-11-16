"""GMAILDRAFT1116: the canonical Gmail draft writer (scripts/hooks/gmail-draft.py) is a draft, every other form a send.

email-approval-gate.py (canonical_draft_run) lets ONE literal `python3 -I -S <install>/scripts/hooks/gmail-draft.py
--flag value ...` call through without the email_send level, when the file's sha256 is the gate's pin. This file
shows: the pin matches the file; the writer reaches only the drafts endpoint; the canonical call is a draft at
levels 1 and 2 with nothing consumed; an edited copy (a messages/send or drafts/send call added, or one comment
line), a moved copy, a symlinked path, a run without -I -S and every other shape stay sends; the ledger and the
owner-CC check still apply.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import ast
import atexit
import email
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
WRITER = os.path.join(HOOKS, "gmail-draft.py")
GATE_SRC = os.path.join(HOOKS, "email-approval-gate.py")
REL = "scripts/hooks/gmail-draft.py"

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_install(parent, name, level=2, env_lines=(), recipients=None):
    """A real (symlink-free) tmp install: scripts/hooks + scripts/lib copied, a store with the level and approvals DB."""
    root = os.path.join(parent, name)
    skip = shutil.ignore_patterns("__pycache__")
    shutil.copytree(HOOKS, os.path.join(root, "scripts", "hooks"), ignore=skip)
    shutil.copytree(os.path.join(os.path.dirname(HOOKS), "lib"), os.path.join(root, "scripts", "lib"), ignore=skip)
    store = os.path.join(root, "store")
    os.makedirs(store)
    with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [{"key": "email_send", "label": "Email", "level": level,
                                                 "locked": False}]}, fh)
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute("""CREATE TABLE approvals (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
        action_description TEXT NOT NULL, action_payload TEXT, status TEXT NOT NULL DEFAULT 'pending',
        timeout_at INTEGER, telegram_message_id INTEGER,
        requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        resolved_at INTEGER, resolved_by TEXT, content_hash TEXT, consumed_at INTEGER)""")
    con.commit()
    con.close()
    if env_lines:
        with open(os.path.join(root, ".env"), "w", encoding="utf-8") as fh:
            fh.write("".join(line + "\n" for line in env_lines))
    if recipients is not None:
        with open(os.path.join(store, "verified-recipients.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "recipients": {a: {"source": "owner"} for a in recipients}}, fh)
    return root


def run_gate(root, cmd, cwd=None):
    payload = {"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd or root}
    proc = subprocess.run([sys.executable, os.path.join(root, "scripts", "hooks", "email-approval-gate.py")],
                          input=json.dumps(payload).encode(), capture_output=True)
    return proc.returncode, proc.stdout.decode(), proc.stderr.decode()


def approvals(root):
    con = sqlite3.connect(os.path.join(root, "store", "claudeclaw.db"))
    n = con.execute("SELECT COUNT(*) FROM approvals").fetchone()[0]
    con.close()
    return n


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ARGS = " --subject 'Ajánlat' --text /tmp/level.txt --html /tmp/level.html --to partner@example.com"

# --- the pin and the writer's own text ---------------------------------------------------------------------------
gate_mod = load_module(GATE_SRC, "eag_gmaildraft")
with open(WRITER, "rb") as fh:
    writer_bytes = fh.read()
check("the gate's GMAIL_DRAFT_SHA256 is the sha256 of scripts/hooks/gmail-draft.py (update both in one commit)",
      gate_mod.GMAIL_DRAFT_SHA256 == hashlib.sha256(writer_bytes).hexdigest(),
      f"pin={gate_mod.GMAIL_DRAFT_SHA256} file={hashlib.sha256(writer_bytes).hexdigest()}")
check("the gate's GMAIL_DRAFT_REL names the writer", gate_mod.GMAIL_DRAFT_REL == REL)

writer_text = writer_bytes.decode("utf-8")
tree = ast.parse(writer_text)
code_strings = [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
docstring = ast.get_docstring(tree, clean=False)
urls = sorted({s for s in code_strings if s is not docstring and re.match(r"^https?://", s)})
check("the writer's code names exactly the token and the drafts endpoint (+ the local dashboard)",
      urls == ["http://127.0.0.1:%s", "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
               "https://oauth2.googleapis.com/token"], f"urls={urls}")
check("no string in the writer's code says send / messages / insert / import (the Gmail send and import routes)",
      not [s for s in code_strings if s is not docstring and re.search(r"(?i)/send\b|\bmessages/|:send\b|/insert\b|"
                                                                        r"/import\b|smtp", s)])
imports = set()
for n in ast.walk(tree):
    if isinstance(n, ast.Import):
        imports.update(a.name for a in n.names)
    elif isinstance(n, ast.ImportFrom):
        imports.add(n.module)
allowed = {"argparse", "base64", "json", "mimetypes", "os", "re", "sys", "urllib.error", "urllib.parse",
           "urllib.request", "email", "email.header", "email.mime.base", "email.mime.multipart", "email.mime.text"}
check("the writer imports only argparse/base64/json/mimetypes/os/re/sys/urllib/email", imports <= allowed,
      f"extra={sorted(imports - allowed)}")
bare = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
attrs = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
bad = (bare & {"exec", "eval", "compile", "__import__", "getattr", "setattr", "globals", "vars", "open_code"}) | (
    (bare | attrs) & {"import_module", "system", "popen", "subprocess", "socket", "smtplib", "spawn", "fork",
                      "execv", "execve", "run_path", "run_module"})
check("the writer runs no code it does not contain (no exec/eval/import_module/getattr/process/socket)", not bad,
      f"found={sorted(bad)}")
urlopens = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
            and n.func.attr == "urlopen"]
check("the writer has exactly four urlopen calls (vault, token, drafts.create, drafts.get)", len(urlopens) == 4,
      f"n={len(urlopens)}")

# --- the writer itself: isolated start, argparse, the MIME it builds -----------------------------------------------
proc = subprocess.run([sys.executable, "-I", "-S", WRITER, "--help"], capture_output=True, text=True)
check("the writer starts under python3 -I -S (stdlib only, no site)", proc.returncode == 0 and "--signature-text"
      in proc.stdout, f"rc={proc.returncode} err={proc.stderr[:200]!r}")
proc = subprocess.run([sys.executable, "-I", "-S", WRITER, "--subject", "x", "--text", "t", "--also"],
                       capture_output=True, text=True)
check("the writer refuses an abbreviated flag (allow_abbrev=False, so the gate's full-name list is what runs)",
      proc.returncode == 2 and "unrecognized" in proc.stderr, f"rc={proc.returncode}")

WTD = os.path.realpath(tempfile.mkdtemp(prefix="gmaildraft-writer-"))
atexit.register(shutil.rmtree, WTD, True)
WROOT = make_install(WTD, "inst")
w = load_module(os.path.join(WROOT, REL), "gmail_draft_writer")
if True:
    td = os.path.join(WROOT, "store", "levelek")
    os.makedirs(td)
    png = os.path.join(td, "logo.png")
    with open(png, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + (120).to_bytes(4, "big") + (40).to_bytes(4, "big")
                 + b"\x08\x02\x00\x00\x00")
    ics = os.path.join(td, "meghivo.ics")
    with open(ics, "w", encoding="utf-8") as fh:
        fh.write("BEGIN:VCALENDAR\nEND:VCALENDAR\n")
    for name, body in (("l.txt", "Szöveg."), ("l.html", '<p>Szia</p><img src="cid:logo.png">'),
                       ("s.txt", "Aláírás"), ("s.html", "<b>Aláírás</b>")):
        with open(os.path.join(td, name), "w", encoding="utf-8") as fh:
            fh.write(body)
    a = w.parse_args(["--subject", "Árajánlat", "--text", os.path.join(td, "l.txt"), "--html",
                      os.path.join(td, "l.html"), "--to", "a@example.com", "--cc", "b@example.com", "--inline", png,
                      "--attach", ics, "--signature-text", os.path.join(td, "s.txt"), "--signature-html",
                      os.path.join(td, "s.html")])
    m, want = w.build_message(a)
    raw = m.as_string()
    msg = email.message_from_string(raw)
    parts = list(msg.walk())
    img = [p for p in parts if p.get_content_type() == "image/png"]
    cid = (img[0].get("X-Attachment-Id") if img else "") or ""
    html = [p for p in parts if p.get_content_type() == "text/html"][0].get_payload(decode=True).decode()
    check("inline image in Gmail's composer form: X-Attachment-Id ii_<10>, Content-ID <ii_..>, src=cid:ii_..",
          bool(re.match(r"^ii_[a-z0-9]{10}$", cid)) and img[0].get("Content-ID") == f"<{cid}>"
          and f'src="cid:{cid}"' in html and 'width="120" height="40"' in html, f"cid={cid!r} html={html[:160]!r}")
    check("an .ics attachment is application/ics", any(p.get_content_type() == "application/ics" for p in parts))
    check("structure: mixed > related > alternative; To and Cc set; signature appended",
          msg.get_content_type() == "multipart/mixed" and msg["To"] == "a@example.com" and msg["Cc"] == "b@example.com"
          and "gmail_signature" in html and want == ["meghivo.ics", "logo.png"], f"type={msg.get_content_type()}")

    # Revizor 4076 L2 (Marveen 4078): files only from store/, not hidden, not secret-looking, symlinks resolved
    outside = os.path.join(WTD, "outside.txt")
    token = os.path.join(WROOT, "store", ".dashboard-token")
    for f in (outside, token, os.path.join(td, "api-token.txt"), os.path.join(td, "id_ed25519"),
              os.path.join(td, "cert.pem")):
        with open(f, "w", encoding="utf-8") as fh:
            fh.write("x")
    os.makedirs(os.path.join(WROOT, "store", ".rejtett"))
    with open(os.path.join(WROOT, "store", ".rejtett", "a.txt"), "w", encoding="utf-8") as fh:
        fh.write("x")
    os.symlink(outside, os.path.join(td, "link.txt"))
    os.symlink(token, os.path.join(td, "plain.txt"))
    backup = os.path.join(WROOT, "store", "backup", "beeboard", "20261116")
    os.makedirs(backup)
    for name in ("sessions.json", "codes.json", "users.json"):
        with open(os.path.join(backup, name), "w", encoding="utf-8") as fh:
            fh.write("{}")
    os.symlink(os.path.join(backup, "users.json"), os.path.join(td, "lista.json"))
    refused = {"a file outside store/": outside, "store/.dashboard-token": token,
               "a token-named file": os.path.join(td, "api-token.txt"), "an ssh key name": os.path.join(td, "id_ed25519"),
               "a .pem": os.path.join(td, "cert.pem"), "a hidden directory": os.path.join(WROOT, "store", ".rejtett", "a.txt"),
               "a symlink in store/ to outside": os.path.join(td, "link.txt"),
               "a plain-named symlink to the token": os.path.join(td, "plain.txt"),
               # Revizor 4080 / Marveen 4083: the whole store/backup/ tree (state copies under ordinary names)
               "store/backup/.../sessions.json": os.path.join(backup, "sessions.json"),
               "store/backup/.../codes.json": os.path.join(backup, "codes.json"),
               "store/backup/.../users.json": os.path.join(backup, "users.json"),
               "a store/ symlink into store/backup/": os.path.join(td, "lista.json")}
    for label, f in refused.items():
        for flag in ("--attach", "--text"):
            argv = (["--subject", "T", "--text", os.path.join(td, "l.txt"), "--attach", f] if flag == "--attach"
                    else ["--subject", "T", "--text", f])
            try:
                w.build_message(w.parse_args(argv))
                ok = False
            except SystemExit as e:
                ok = "gmail-draft:" in str(e.code)
            check(f"the writer refuses {label} as {flag}", ok)
    try:
        w.build_message(w.parse_args(["--subject", "T", "--text", os.path.join(td, "l.txt"), "--attach",
                                      os.path.join(td, "s.txt")]))
        ok = True
    except SystemExit:
        ok = False
    check("the writer takes a plain file under store/", ok)
    # Revizor 4076 L3: a line break in a header value is refused by the writer itself (harness E)
    for flag, value in (("--subject", "hi\nBcc: evil@example.org"), ("--to", "a@example.com\r\nBcc: e@x.hu"),
                        ("--cc", "b@example.com\n"), ("--bcc", "c@example.com\r"), ("--in-reply-to", "<a@b>\nX: y")):
        proc = subprocess.run([sys.executable, "-I", "-S", os.path.join(WROOT, REL), "--subject", "T", "--text",
                               os.path.join(td, "l.txt"), flag, value], capture_output=True, text=True)
        check(f"the writer refuses a line break in {flag}", proc.returncode == 2 and "line break" in proc.stderr,
              f"rc={proc.returncode} err={proc.stderr[-160:]!r}")

vault_reads = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
               and n.func.id == "vault_get"]
check("the writer reads exactly the two fixed vault keys (one mailbox per install, Marveen 4078)",
      sorted(ast.unparse(c.args[0]) for c in vault_reads) == ["VAULT_CLIENT_KEY", "VAULT_REFRESH_KEY"]
      and w.VAULT_CLIENT_KEY == "GMAIL_DRAFT_OAUTH_CLIENT" and w.VAULT_REFRESH_KEY == "GMAIL_DRAFT_COMPOSE_REFRESH",
      f"reads={[ast.unparse(c.args[0]) for c in vault_reads]}")
check("no --vault-* flag: the mailbox cannot be picked on the command line", "--vault" not in writer_text)
check("Revizor 4076 L4: the proxy and CA-bundle environment is dropped before any request",
      all(k in writer_text for k in ('"HTTPS_PROXY"', '"https_proxy"', '"ALL_PROXY"', '"SSL_CERT_FILE"',
                                     '"SSL_CERT_DIR"')) and "os.environ.pop" in writer_text)

# --- the gate: canonical call = draft ----------------------------------------------------------------------------
TD = os.path.realpath(tempfile.mkdtemp(prefix="eag-gmaildraft-"))
atexit.register(shutil.rmtree, TD, True)
L2 = make_install(TD, "l2", level=2)
L1 = make_install(TD, "l1", level=1)
ABS2 = os.path.join(L2, REL)

drafts = {
    "absolute path, cwd /": ("python3 -I -S " + ABS2 + ARGS, "/"),
    "relative path, cwd = install root": ("python3 -I -S " + REL + ARGS, L2),
    "with 2>&1 at the end": ("python3 -I -S " + ABS2 + ARGS + " 2>&1", "/"),
    "--flag=value forms, repeated --attach, --also-attach": (
        "python3 -I -S " + ABS2 + " --subject=Teszt --text=/tmp/a.txt --to=a@example.com --attach /tmp/x.pdf"
        " --attach /tmp/y.pdf --also-attach", "/"),
    "no recipient at all": ("python3 -I -S " + ABS2 + " --subject T --text /tmp/a.txt", "/"),
}
for label, (cmd, cwd) in drafts.items():
    code, out, err = run_gate(L2, cmd, cwd)
    check(f"draft at level 2: {label} -> allowed, no approval needed or consumed", code == 0 and approvals(L2) == 0,
          f"exit={code} err={err[:200]!r}")
code, out, err = run_gate(L1, "python3 -I -S " + os.path.join(L1, REL) + ARGS, "/")
check("draft at level 1 (signal only) -> allowed: the level stops sends, like for an MCP draft", code == 0,
      f"exit={code} err={err[:200]!r}")

# --- the gate: every other form = send -------------------------------------------------------------------------------
sends = {
    "no -I -S": "python3 " + ABS2 + ARGS,
    "-I only": "python3 -I " + ABS2 + ARGS,
    "-S -I (another spelling)": "python3 -S -I " + ABS2 + ARGS,
    "an extra interpreter option": "python3 -I -S -u " + ABS2 + ARGS,
    "-IS cluster": "python3 -IS " + ABS2 + ARGS,
    "python3 by path": "/usr/bin/python3 -I -S " + ABS2 + ARGS,
    "env prefix": "PYTHONSAFEPATH=1 python3 -I -S " + ABS2 + ARGS,
    "chained ; command": "python3 -I -S " + ABS2 + ARGS + "; python3 /tmp/other.py --to x@example.com",
    "chained && command": "python3 -I -S " + ABS2 + ARGS + " && echo kesz",
    "piped": "python3 -I -S " + ABS2 + ARGS + " | tee /tmp/out",
    "output redirect": "python3 -I -S " + ABS2 + ARGS + " > /tmp/out",
    "stdin heredoc": "python3 -I -S " + ABS2 + ARGS + " <<'EOF'\nx\nEOF",
    "a $VAR value": "python3 -I -S " + ABS2 + ARGS.replace("/tmp/level.txt", "$HOME/level.txt"),
    # quoted: an UNQUOTED $(...) mid-command cuts the segment in the copy gate's tokenizer, and the flags after it
    # leave the script judge's view (a develop gap of its own, reported separately; canonical_draft_run refuses it)
    "a command substitution value": "python3 -I -S " + ABS2 + ARGS.replace("/tmp/level.txt", '"$(cat /tmp/p)"'),
    "an unknown flag": "python3 -I -S " + ABS2 + ARGS + " --send-now",
    "an abbreviated flag": "python3 -I -S " + ABS2 + ARGS.replace("--subject", "--sub"),
    "a repeated --to": "python3 -I -S " + ABS2 + ARGS + " --to other@example.com",
    "a value starting with -": "python3 -I -S " + ABS2 + ARGS.replace("'Ajánlat'", "-x"),
    "a trailing comment": "python3 -I -S " + ABS2 + ARGS + " # draft",
    # Revizor 4076 L1 (harness B, C, D, F): the shell joins a backslash-newline, the scanner would not
    "B backslash-newline in --cc": "python3 -I -S " + ABS2 + ARGS + " --cc\\\n=evil@y.hu",
    "C backslash-newline in --bcc": "python3 -I -S " + ABS2 + ARGS + " --bcc\\\n=evil@y.hu",
    "D backslash-newline in a value": "python3 -I -S " + ABS2 + ARGS.replace("--subject 'Ajánlat'", "--subject\\\n=x"),
    "F a value that starts with =": "python3 -I -S " + ABS2 + ARGS + " --cc =ls",
    "a --cc==x value": "python3 -I -S " + ABS2 + ARGS + " --cc==evil@y.hu",
    "a backslash-newline between two words": "python3 -I -S " + ABS2 + " \\\n" + ARGS,
    "a --vault flag (no longer the writer's)": "python3 -I -S " + ABS2 + ARGS + " --vault-refresh GMAIL_X",
    "a relative path from another cwd": ("python3 -I -S " + REL + ARGS, "/"),
}
for label, cmd in sends.items():
    cwd = "/"
    if isinstance(cmd, tuple):
        cmd, cwd = cmd
    self_mod = gate_mod.canonical_draft_run(cmd, cwd)
    code, out, err = run_gate(L2, cmd, cwd)
    check(f"send at level 2: {label} -> denied without an approval", code == 2 and self_mod is None,
          f"exit={code} out={out[:120]!r}")
code, _, err = run_gate(L2, sends["no -I -S"], "/")
check("the deny names the canonical draft-writer form", "Gmail-piszkozatiro csak ebben az alakban" in err,
      f"err={err[:300]!r}")

# an edited writer at the canonical path: one comment line, a messages/send call, a drafts/send call
edits = {
    "one added comment line": "\n# harmless\n",
    "a messages/send call": "\nurllib.request.urlopen(DRAFTS_URL.replace('drafts', 'messages') + '/send')\n",
    "a drafts/send call": "\nurllib.request.urlopen(DRAFTS_URL + '/send')\n",
}
for i, (label, extra) in enumerate(edits.items()):
    root = make_install(TD, f"edited{i}", level=2)
    with open(os.path.join(root, REL), "a", encoding="utf-8") as fh:
        fh.write(extra)
    code, _, err = run_gate(root, "python3 -I -S " + os.path.join(root, REL) + ARGS, "/")
    check(f"an EDITED writer at the canonical path ({label}) -> a send, denied", code == 2, f"exit={code}")

# a moved (byte-identical) copy, and the canonical file reached through a symlink
moved_dir = os.path.join(TD, "elsewhere")
os.makedirs(moved_dir)
shutil.copy(WRITER, os.path.join(moved_dir, "gmail-draft.py"))
code, _, _ = run_gate(L2, "python3 -I -S " + os.path.join(moved_dir, "gmail-draft.py") + ARGS, "/")
check("a moved byte-identical copy -> a send, denied", code == 2, f"exit={code}")
os.symlink(L2, os.path.join(TD, "l2-link"))
code, _, _ = run_gate(L2, "python3 -I -S " + os.path.join(TD, "l2-link", REL) + ARGS, "/")
check("the canonical file through a symlinked path -> a send, denied", code == 2, f"exit={code}")

# --- the ledger and the owner-CC check still apply ------------------------------------------------------------------
LED = make_install(TD, "ledger", level=2, env_lines=["MAIN_AGENT_RECIPIENT_LEDGER=1"], recipients=["known@example.com"])
code, _, err = run_gate(LED, "python3 -I -S " + os.path.join(LED, REL) + ARGS, "/")
check("ledger on: a draft to an unverified address -> denied", code == 2 and "partner@example.com" in err,
      f"exit={code} err={err[:200]!r}")
code, _, err = run_gate(LED, "python3 -I -S " + os.path.join(LED, REL) + ARGS.replace("partner@", "known@"), "/")
check("ledger on: a draft to a verified address -> allowed", code == 0, f"exit={code} err={err[:200]!r}")
OCC = make_install(TD, "ownercc", level=2, env_lines=["MAIL_OWNER_CC=owner@example.com"])
code, _, err = run_gate(OCC, "python3 -I -S " + os.path.join(OCC, REL) + ARGS, "/")
check("MAIL_OWNER_CC set: a draft without the owner -> denied (MAILCCGATE1016, as for an MCP draft)", code == 2,
      f"exit={code} err={err[:200]!r}")
code, _, err = run_gate(OCC, "python3 -I -S " + os.path.join(OCC, REL) + ARGS + " --cc owner@example.com", "/")
check("MAIL_OWNER_CC set: a draft with the owner in cc -> allowed", code == 0, f"exit={code} err={err[:200]!r}")

print()
if failed:
    print(f"FAILED {len(failed)}:")
    for f in failed:
        print("  - " + f)
    sys.exit(1)
print("ALL PASS")
