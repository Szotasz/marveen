#!/usr/bin/env python3
"""scripts/support-mail/send.py runs the sender-side checks itself
(scripts/hooks/sender_check.py) on the exact letter it delivers, before the
vault or SMTP.

Every case runs the SHIPPED send.py from a disposable copy of the project
(scripts/support-mail + scripts/hooks + scripts/lib, its own store/ and .env),
never the repo's own store. Two harnesses:
  - `bash` runs a real shell command line in the copy. A run that passes the
    checks goes on to the vault, which is not reachable here (no dashboard
    token, a closed port), so "passed" = not exit 3 and no refusal text, and
    "refused" = exit 3 with the reason;
  - `inproc` runs send.py in-process with SMTP, IMAP and the vault stubbed, and
    reports the RCPT list SMTP would have been given.

The measured holes on the base revision (the hook-only design):
  - a glob or variable script path, python3 -u / -X utf8, or the program read
    from stdin are not a send for the main agent's hook (it exits 0 at level
    1), and the sender checked nothing, so the letter went out at level 1;
  - `--t x` / `--c x` (argparse prefix matching) and SUPPORT_OWNER_CC from the
    environment delivered to an address the approved anchor did not cover.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
SENDER = "scripts/support-mail/" + "se" + "nd.py"
NOW_S = "CAST(strftime('%s','now') AS INTEGER)"

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_project(td, level=2, env_lines=(), ledger=None, config=True):
    root = os.path.realpath(os.path.join(td, "proj"))
    skip = shutil.ignore_patterns("__pycache__")
    for d in ("support-mail", "hooks", "lib"):
        shutil.copytree(os.path.join(SCRIPTS, d), os.path.join(root, "scripts", d), ignore=skip)
    store = os.path.join(root, "store")
    os.makedirs(store)
    if config:
        with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "categories": [{"key": "email_send", "level": level}]}, fh)
    con = sqlite3.connect(os.path.join(store, "claudeclaw.db"))
    con.execute("""CREATE TABLE approvals (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
        action_description TEXT NOT NULL, action_payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending', timeout_at INTEGER, telegram_message_id INTEGER,
        requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        resolved_at INTEGER, resolved_by TEXT, content_hash TEXT, consumed_at INTEGER)""")
    con.commit()
    con.close()
    with open(os.path.join(root, ".env"), "w", encoding="utf-8") as fh:
        fh.write("SUPPORT_MAILBOX=box@example.com\nSUPPORT_VAULT_KEY=example-api-key\n")
        if not any(line.startswith("WEB_PORT=") for line in env_lines):
            fh.write("WEB_PORT=1\n")
        for line in env_lines:
            fh.write(line + "\n")
    if ledger is not None:
        with open(os.path.join(store, "verified-recipients.json"), "w", encoding="utf-8") as fh:
            if isinstance(ledger, str):
                fh.write(ledger)
            else:
                json.dump({"version": 1, "recipients": {a: {"source": "owner"} for a in ledger}}, fh)
    return root


def approve(root, anchor, aid="ap-1", category="email_send"):
    con = sqlite3.connect(os.path.join(root, "store", "claudeclaw.db"))
    con.execute("INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at,"
                f" content_hash) VALUES (?, 'agent-a', ?, 'x', 'approved', {NOW_S}, ?)", (aid, category, anchor))
    con.commit()
    con.close()


def approval_row(root, anchor, aid, status, resolved_sql):
    """An email_send row in a state other than a fresh approval: pending
    (resolved_sql NULL) or approved long ago (outside the window)."""
    con = sqlite3.connect(os.path.join(root, "store", "claudeclaw.db"))
    con.execute("INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at,"
                f" content_hash) VALUES (?, 'agent-a', 'email_send', 'x', ?, {resolved_sql}, ?)",
                (aid, status, anchor))
    con.commit()
    con.close()


def consumed(root, aid="ap-1"):
    con = sqlite3.connect(os.path.join(root, "store", "claudeclaw.db"))
    row = con.execute("SELECT consumed_at FROM approvals WHERE id=?", (aid,)).fetchone()
    con.close()
    return bool(row and row[0] is not None)


def bash(root, command, extra_env=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("SUPPORT_", "EMAIL_APPROVAL"))}
    env.update(extra_env or {})
    p = subprocess.run(["bash", "-c", command], cwd=root, capture_output=True, text=True, env=env, timeout=60)
    return p.returncode, p.stdout, p.stderr


def refused(r):
    return r[0] == 3 and "KULDES MEGTAGADVA" in r[2]


def passed(r):
    return r[0] != 3 and "KULDES MEGTAGADVA" not in r[2]


def anchor_of(err):
    import re
    m = re.search(r"\b([0-9a-f]{64})\b", err)
    return m.group(1) if m else None


INPROC = r"""
import json, os, runpy, smtplib, imaplib, sys
sys.argv = json.loads(os.environ['T_ARGV'])
sys.path.insert(0, os.path.join(os.environ['T_ROOT'], 'scripts', 'support-mail'))
import lib
lib.password = lambda: 'x'
sent = {}
class FakeSMTP:
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def login(self, *a): pass
    def send_message(self, msg, to_addrs=None): sent['rcpt'] = list(to_addrs)
smtplib.SMTP_SSL = FakeSMTP
class FakeIMAP:
    def __init__(self, *a, **k): raise OSError('no imap here')
imaplib.IMAP4_SSL = FakeIMAP
code = 0
try:
    runpy.run_path(os.path.join(os.environ['T_ROOT'], os.environ['T_FILE']), run_name='__main__')
except SystemExit as e:
    code = e.code
print('RESULT=' + json.dumps({'sent': sent, 'exit': code if isinstance(code, int) or code is None else str(code)}))
"""


def inproc(root, args, extra_env=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("SUPPORT_", "EMAIL_APPROVAL"))}
    env.update({"T_ARGV": json.dumps(["x"] + args), "T_ROOT": root, "T_FILE": SENDER}, **(extra_env or {}))
    p = subprocess.run([sys.executable, "-c", INPROC], capture_output=True, text=True, env=env, cwd=root, timeout=60)
    line = [ln for ln in p.stdout.splitlines() if ln.startswith("RESULT=")]
    return (json.loads(line[0][7:]) if line else {"sent": {}, "exit": "no-result"}), p.stderr


SEND = f"python3 {SENDER} --to a@example.com --subject 'Tárgy' --body 'Kedves Ügyfél, ez a levél törzse.'"

with tempfile.TemporaryDirectory() as td:
    # --- level 1: every spelling is refused BY THE SENDER ----------------------
    root = make_project(os.path.join(td, "l1"), level=1)
    for label, cmd in (
        ("the plain call", SEND),
        ("a glob script path", SEND.replace(SENDER, "scripts/support-mail/s?nd.py")),
        ("a variable script path", f"P={SENDER}; " + SEND.replace(SENDER, "$P")),
        ("python3 -u", SEND.replace("python3 ", "python3 -u ")),
        ("python3 -X utf8", SEND.replace("python3 ", "python3 -X utf8 ")),
        ("the program read from stdin", "cd scripts/support-mail && python3 - --to a@example.com --subject "
                                        "'Tárgy' --body 'Kedves Ügyfél.' < " + os.path.basename(SENDER)),
    ):
        r = bash(root, cmd)
        check(f"level 1: {label} -> refused by the sender (exit 3)", refused(r) and "szint 1" in r[2],
              f"rc={r[0]} err={r[2][-200:]!r}")
    r = bash(root, SEND, {"EMAIL_APPROVAL_GATE_STORE": os.path.join(td, "elsewhere")})
    check("level 1: the hook's test-only store override does not reach the sender", refused(r), f"rc={r[0]}")

    # --- level 2: one approval of THIS delivered envelope, consumed once -------
    root = make_project(os.path.join(td, "l2"), level=2)
    r = bash(root, SEND)
    anchor = anchor_of(r[2])
    check("level 2 without an approval: refused, the refusal carries the anchor",
          refused(r) and anchor is not None and "NINCS jovahagyas" in r[2], f"rc={r[0]} err={r[2][-200:]!r}")
    approve(root, anchor)
    r = bash(root, SEND)
    check("level 2 with the approval: the checks pass (the run goes on to the vault)", passed(r),
          f"rc={r[0]} err={r[2][-200:]!r}")
    check("level 2: the sender consumed the approval", consumed(root))
    r = bash(root, SEND)
    check("level 2: the same letter again is refused (one-shot)", refused(r) and "FEL LETT HASZNALVA" in r[2],
          f"rc={r[0]}")
    r = bash(root, SEND.replace("a@example.com", "b@example.com"))
    check("level 2: the approval does not cover another recipient", refused(r), f"rc={r[0]}")
    # pending and expired are refusals too: only an 'allowed' verdict passes
    root = make_project(os.path.join(td, "l2-pending"), level=2)
    anchor = anchor_of(bash(root, SEND)[2])
    approval_row(root, anchor, "ap-p", "pending", "NULL")
    r = bash(root, SEND)
    check("level 2 with a PENDING approval: refused, named as pending", refused(r) and "FUGGOBEN" in r[2],
          f"rc={r[0]} err={r[2][-200:]!r}")
    root = make_project(os.path.join(td, "l2-expired"), level=2)
    anchor = anchor_of(bash(root, SEND)[2])
    approval_row(root, anchor, "ap-e", "approved", f"{NOW_S} - 100000")
    r = bash(root, SEND)
    check("level 2 with an EXPIRED approval: refused, named as expired", refused(r) and "IDOABLAKA" in r[2],
          f"rc={r[0]} err={r[2][-200:]!r}")
    check("level 2: the expired approval was not consumed", not consumed(root, "ap-e"))
    root = make_project(os.path.join(td, "l2-html"), level=2)
    approve(root, anchor_of(bash(root, SEND)[2]))
    for flag in ("--html", "--html-wrap"):
        r = bash(root, SEND + " " + flag)
        check(f"level 2: an approved plain letter cannot go out with {flag}", refused(r), f"rc={r[0]}")
    check("level 2: the plain letter still goes out", passed(bash(root, SEND)))

    # --- level 2: the standing recipient list, as the hook applies it --------
    root = make_project(os.path.join(td, "l2-standing"), level=2,
                        env_lines=("SUPPORT_OWNER_CC=owner@example.com",))
    with open(os.path.join(root, "store", "email-standing-recipients.json"), "w") as fh:
        json.dump({"recipients": ["a@example.com"]}, fh)
    r = bash(root, SEND)
    check("standing, not yet live: refused, naming the address anchor",
          refused(r) and "NINCS ELESITVE" in r[2], f"rc={r[0]} err={r[2][-200:]!r}")
    approve(root, hashlib.sha256(b"a@example.com").hexdigest(), aid="st-1", category="email_standing_recipient")
    r = bash(root, SEND)
    check("standing and live: the checks pass without a per-letter approval (the owner CC is not in the view)",
          passed(r) and "allando cimzett" in r[2], f"rc={r[0]} err={r[2][-200:]!r}")
    log = open(os.path.join(root, "store", "email-standing-sends.log"), encoding="utf-8").read()
    check("standing: the approval-free send left its trace", "a@example.com" in log)
    r = bash(root, SEND + " --cc c@example.com")
    check("standing: an explicit --cc takes the letter off the standing path", refused(r), f"rc={r[0]}")

    # The owner's daily-log notice of a standing send goes to the port in .env;
    # a WEB_PORT prefix in the agent's shell cannot send it elsewhere.
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    posts = []

    class _Log(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            posts.append(self.path)
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass
    srv = HTTPServer(("127.0.0.1", 0), _Log)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    root = make_project(os.path.join(td, "l2-standing-log"), level=2,
                        env_lines=(f"WEB_PORT={srv.server_address[1]}",))
    with open(os.path.join(root, "store", ".dashboard-token"), "w") as fh:
        fh.write("t")
    with open(os.path.join(root, "store", "email-standing-recipients.json"), "w") as fh:
        json.dump({"recipients": ["a@example.com"]}, fh)
    approve(root, hashlib.sha256(b"a@example.com").hexdigest(), aid="st-2", category="email_standing_recipient")
    r = bash(root, SEND, {"WEB_PORT": "1"})
    srv.shutdown()
    check("standing: the owner's daily-log notice uses WEB_PORT from .env, not from the environment",
          "allando cimzett" in r[2] and "/api/daily-log" in posts, f"posts={posts} err={r[2][-200:]!r}")

    # --- level 3 / missing config ---------------------------------------------
    root = make_project(os.path.join(td, "l3"), level=3)
    check("level 3: the checks pass", passed(bash(root, SEND)))
    root = make_project(os.path.join(td, "nocfg"), config=False)
    r = bash(root, SEND)
    check("missing autonomy config: level 2 (needs an approval), with the reason",
          refused(r) and "hianyzik" in r[2] or refused(r) and "nem olvashato" in r[2], f"err={r[2][-200:]!r}")

    # --- the envelope the sender delivers is the one the flags name ------------
    root = make_project(os.path.join(td, "abbr"), level=3)
    for args, label in ((["--to", "a@example.com", "--t", "b@example.org", "--subject", "Tárgy", "--body", "Kedves Ügyfél."], "--t"),
                        (["--to", "a@example.com", "--c", "b@example.org", "--subject", "Tárgy", "--body", "Kedves Ügyfél."], "--c")):
        res, err = inproc(root, args)
        check(f"argparse abbreviation {label} is an error, nothing is sent",
              res["exit"] == 2 and not res["sent"], f"res={res} err={err[-150:]!r}")
    res, err = inproc(root, ["--to", "a@example.com", "--subject", "Tárgy", "--body", "Kedves Ügyfél."],
                      {"SUPPORT_OWNER_CC": "b@example.org"})
    check("SUPPORT_OWNER_CC from the environment is ignored", res["sent"].get("rcpt") == ["a@example.com"], f"res={res}")
    check("... and the sender says so on stderr (the behaviour changed)",
          "SUPPORT_OWNER_CC kornyezeti valtozot a kuldo nem olvassa" in err, err[-200:])
    root = make_project(os.path.join(td, "owner-cc"), level=3, env_lines=("SUPPORT_OWNER_CC=owner@example.com",))
    res, _ = inproc(root, ["--to", "a@example.com", "--subject", "Tárgy", "--body", "Kedves Ügyfél."])
    check("SUPPORT_OWNER_CC from .env is still the default CC",
          res["sent"].get("rcpt") == ["a@example.com", "owner@example.com"], f"res={res}")

    # --- the recipient ledger, when the install turns it on --------------------
    on = ("MAIN_AGENT_RECIPIENT_LEDGER=1",)
    root = make_project(os.path.join(td, "ledger-off"), level=3, ledger=[])
    check("ledger switch off: an address not in the ledger still goes out (unchanged)", passed(bash(root, SEND)))
    root = make_project(os.path.join(td, "ledger-on"), level=3, env_lines=on + ("SUPPORT_OWNER_CC=owner@example.com",),
                        ledger=["a@example.com"])
    r = bash(root, SEND)
    check("ledger on: an owner CC not in the ledger refuses the send", refused(r) and "owner@example.com" in r[2],
          f"err={r[2][-200:]!r}")
    root = make_project(os.path.join(td, "ledger-on2"), level=3, env_lines=on, ledger=["a@example.com"])
    check("ledger on: a known address goes out", passed(bash(root, SEND)))
    r = bash(root, SEND.replace("a@example.com", "b@example.org"))
    check("ledger on: an unknown address is refused", refused(r) and "b@example.org" in r[2], f"err={r[2][-200:]!r}")
    r = bash(root, SEND.replace("--to a@example.com", "--to 'Known <a@example.com>, Bad <b@example.org>'"))
    check("ledger on: a list hiding an unknown address is refused", refused(r), f"err={r[2][-200:]!r}")
    r = bash(root, SEND.replace("--to a@example.com", "--to 'a@example.com <b@example.org>'"))
    check("ledger on: an address in the display name is refused (unparseable)",
          r[0] != 0 and ("KULDES MEGTAGADVA" in r[2] or "refusing to send" in r[2]), f"err={r[2][-200:]!r}")
    root = make_project(os.path.join(td, "ledger-bad"), level=3, env_lines=on, ledger='{"version":1,"recipients":')
    check("ledger on: an unusable ledger refuses", refused(bash(root, SEND)))
    root = make_project(os.path.join(td, "ledger-env"), level=3, ledger=[])
    r = bash(root, SEND.replace("python3", "MAIN_AGENT_RECIPIENT_LEDGER=0 python3"))
    check("the switch is read from .env only (an env value changes nothing)", passed(r))

    # --- fail-closed ------------------------------------------------------------
    root = make_project(os.path.join(td, "nocheck"), level=3)
    os.remove(os.path.join(root, "scripts", "hooks", "sender_check.py"))
    r = bash(root, SEND)
    check("a missing sender_check.py refuses (exit 3, not a traceback)", refused(r) and "sender_check" in r[2],
          f"rc={r[0]} err={r[2][-200:]!r}")
    root = make_project(os.path.join(td, "cli"), level=3)
    cli = os.path.join(root, "scripts", "hooks", "sender_check.py")
    p = subprocess.run([sys.executable, "-I", cli], input="not json", capture_output=True, text=True)
    check("the CLI refuses garbage input (exit 3)", p.returncode == 3, f"rc={p.returncode}")
    p = subprocess.run([sys.executable, "-I", cli], input=json.dumps({"to": ["a@example.com"], "cc": [], "text": "x"}),
                       capture_output=True, text=True)
    check("the CLI passes a letter at level 3 (exit 0)", p.returncode == 0, f"rc={p.returncode} err={p.stderr!r}")

# --- the outgoing-copy content checks run in the sender too ------------------
# The copy gate hook audits only a command it recognises as a send, so the same
# spellings that skipped the level skipped the em dash / accent / name checks
# (measured on the base revision: a glob path and python3 -u exit 0 there).
DASH_SEND = f"python3 {SENDER} --to a@example.com --subject 'Tárgy' --body 'Kedves Ügyfél — ez a levél.'"


def write_rules(root, value):
    with open(os.path.join(root, "store", "outgoing-copy-gate-rules.json"), "w", encoding="utf-8") as fh:
        fh.write(value if isinstance(value, str) else json.dumps(value))


with tempfile.TemporaryDirectory() as td:
    root = make_project(os.path.join(td, "copy"), level=3)
    write_rules(root, {"no_name_rule": True, "no_name_rule_reason": "test"})
    for label, cmd in (
        ("the plain call", DASH_SEND),
        ("a glob script path", DASH_SEND.replace(SENDER, "scripts/support-mail/s?nd.py")),
        ("python3 -u", DASH_SEND.replace("python3 ", "python3 -u ")),
    ):
        r = bash(root, cmd)
        check(f"copy check: an em dash via {label} is refused by the sender", refused(r) and "KIMENO-SZOVEG" in r[2],
              f"rc={r[0]} err={r[2][-200:]!r}")
    r = bash(root, SEND.replace("--subject 'Tárgy'", "--subject 'Tárgy -- fontos'"))
    check("copy check: ' -- ' in the subject is refused", refused(r) and "KIMENO-SZOVEG" in r[2], f"err={r[2][-200:]!r}")
    r = bash(root, SEND.replace("'Kedves Ügyfél, ez a levél törzse.'", "'Koszonom a levelet, udvozlettel es tehat.'"))
    check("copy check: missing Hungarian accents are refused", refused(r) and "KIMENO-SZOVEG" in r[2],
          f"err={r[2][-200:]!r}")
    check("copy check: a clean letter passes", passed(bash(root, SEND)))

    write_rules(root, {"bad_name_patterns": ["Rossz Nev"], "correction": "Jó Név"})
    name_send = SEND.replace("'Kedves Ügyfél, ez a levél törzse.'", "'Kedves Rossz Nev, ez a levél törzse.'")
    r = bash(root, name_send)
    check("copy check: a name rule from store/ refuses", refused(r), f"err={r[2][-200:]!r}")
    empty = os.path.join(td, "empty-rules.json")
    with open(empty, "w") as fh:
        json.dump({"no_name_rule": True}, fh)
    r = bash(root, name_send, {"OUTGOING_COPY_GATE_RULES": empty})
    check("copy check: the hook's rules override from the environment does not reach the sender", refused(r),
          f"rc={r[0]}")
    write_rules(root, "{not json")
    r = bash(root, SEND)
    check("copy check: an INVALID name-rules file refuses", refused(r) and "ervenytelen" in r[2], f"err={r[2][-200:]!r}")
    os.remove(os.path.join(root, "store", "outgoing-copy-gate-rules.json"))
    r = bash(root, SEND)
    check("copy check: a MISSING name-rules file passes with a loud warning", passed(r) and "HIANYZIK" in r[2],
          f"rc={r[0]} err={r[2][-200:]!r}")

    root = make_project(os.path.join(td, "copy-l2"), level=2)
    write_rules(root, {"no_name_rule": True})
    sys.path.insert(0, os.path.join(root, "scripts", "hooks"))
    import importlib.util
    spec = importlib.util.spec_from_file_location("gate_for_test", os.path.join(root, "scripts", "hooks", "email-approval-gate.py"))
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    dash_anchor = g.content_anchor({"to": ["a@example.com"], "cc": [],
                                    "text": "Tárgy\nKedves Ügyfél — ez a levél."})
    approve(root, dash_anchor)
    r = bash(root, DASH_SEND)
    check("copy check: runs BEFORE the level, so a refused letter does not consume its approval",
          refused(r) and "KIMENO-SZOVEG" in r[2] and not consumed(root), f"err={r[2][-200:]!r}")

    root = make_project(os.path.join(td, "copy-missing"), level=3)
    os.remove(os.path.join(root, "scripts", "hooks", "outgoing-copy-gate.py"))
    r = bash(root, SEND)
    check("copy check: a missing copy gate module refuses (fail-closed)", refused(r) and "KIMENO-SZOVEG" in r[2],
          f"err={r[2][-200:]!r}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All support-mail sender-check tests passed.")
