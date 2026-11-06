#!/usr/bin/env python3
"""scripts/support-mail/send.py --attach: a file attachment that the approval
anchor covers, in the main agent's hook and in the sender's own check alike.

The gap on the base revision: send.py had no --attach (argparse refused it),
and the hook's pass-through for this project's own sender did not know the
flag, so a canonical send.py call with --attach was denied as "not canonical".
graph-mail.ts already attaches a file from the drop directory and puts its
{name, sha256, size} into the anchor; send.py does the same now:
  - the file must sit inside <root>/store/mail-attachments (realpath on both
    sides, a symlink cannot reach out); a relative path is relative to the
    working directory, as every CLI and the hook's own extractor read it;
  - the bytes are read ONCE: the digest in the anchor and the bytes in the
    letter are the same read, so a file swapped after the check cannot go out;
  - the descriptor is the hook's own (email_extract.collect_bash_attachments):
    name = the basename of the path as given, sorted by (name, sha256), so the
    same letter has the same anchor in the hook and in the sender;
  - a missing, unreadable, non-regular or outside file refuses (exit 3) before
    the level check, so no approval is consumed.

Every case runs the SHIPPED send.py from a disposable copy of the project, as
support-mail-sender-check.test.py does (`bash` = a real command line that goes
on to the unreachable vault when the checks pass; `inproc` = SMTP, IMAP and the
vault stubbed, the delivered message captured).

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import hashlib
import importlib.util
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
DROP = "store/mail-attachments"

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_project(td, level=2):
    root = os.path.realpath(os.path.join(td, "proj"))
    skip = shutil.ignore_patterns("__pycache__")
    for d in ("support-mail", "hooks", "lib"):
        shutil.copytree(os.path.join(SCRIPTS, d), os.path.join(root, "scripts", d), ignore=skip)
    store = os.path.join(root, "store")
    os.makedirs(os.path.join(root, DROP))
    with open(os.path.join(store, "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [{"key": "email_send", "level": level}]}, fh)
    with open(os.path.join(store, "outgoing-copy-gate-rules.json"), "w", encoding="utf-8") as fh:
        json.dump({"no_name_rule": True}, fh)
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
        fh.write("SUPPORT_MAILBOX=box@example.com\nSUPPORT_VAULT_KEY=example-api-key\nWEB_PORT=1\n")
    return root


def put(root, rel, data):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as fh:
        fh.write(data)
    return p


def approve(root, anchor, aid="ap-1"):
    con = sqlite3.connect(os.path.join(root, "store", "claudeclaw.db"))
    con.execute("INSERT INTO approvals (id, agent_id, category, action_description, status, resolved_at,"
                f" content_hash) VALUES (?, 'agent-a', 'email_send', 'x', 'approved', {NOW_S}, ?)", (aid, anchor))
    con.commit()
    con.close()


def consumed(root, aid="ap-1"):
    con = sqlite3.connect(os.path.join(root, "store", "claudeclaw.db"))
    row = con.execute("SELECT consumed_at FROM approvals WHERE id=?", (aid,)).fetchone()
    con.close()
    return bool(row and row[0] is not None)


def bash(root, command):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("SUPPORT_", "EMAIL_APPROVAL"))}
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


def gate_module(root):
    spec = importlib.util.spec_from_file_location("gate_for_attach_test",
                                                  os.path.join(root, "scripts", "hooks", "email-approval-gate.py"))
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    return g


# inproc: SMTP / IMAP / vault stubbed; the delivered message's attachments are
# reported as {filename: sha256}. T_SWAP=<path>: the FIRST read of that file
# gets its bytes, and the file on disk is replaced right after that read, so a
# sender that reads it a second time (for the letter, after the digest) attaches
# bytes nobody checked.
INPROC = r"""
import hashlib, json, os, runpy, smtplib, imaplib, sys
sys.argv = json.loads(os.environ['T_ARGV'])
sys.path.insert(0, os.path.join(os.environ['T_ROOT'], 'scripts', 'support-mail'))
sys.path.insert(0, os.path.join(os.environ['T_ROOT'], 'scripts', 'hooks'))
import lib
lib.password = lambda: 'x'
sent = {}
class FakeSMTP:
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def login(self, *a): pass
    def send_message(self, msg, to_addrs=None):
        sent['rcpt'] = list(to_addrs)
        sent['att'] = {p.get_filename(): hashlib.sha256(p.get_payload(decode=True)).hexdigest()
                       for p in msg.iter_attachments()}
smtplib.SMTP_SSL = FakeSMTP
class FakeIMAP:
    def __init__(self, *a, **k): raise OSError('no imap here')
imaplib.IMAP4_SSL = FakeIMAP
# "unreadable" without relying on file modes (the test may run as root): every
# read path of the interpreter refuses the file named olvashatatlan.pdf
import builtins, io
_real_open, _real_os_open = builtins.open, os.open
def _deny(path):
    if str(path).endswith('olvashatatlan.pdf'):
        raise PermissionError(13, 'Permission denied', str(path))
_swap = {'path': os.path.realpath(os.environ['T_SWAP']) if os.environ.get('T_SWAP') else None, 'done': False}
def _open(path, *a, **k):
    _deny(path)
    mode = a[0] if a else k.get('mode', 'r')
    if (_swap['path'] and not _swap['done'] and isinstance(path, (str, bytes, os.PathLike))
            and os.path.realpath(path) == _swap['path'] and 'r' in mode and 'b' in mode):
        _swap['done'] = True
        with _real_open(path, 'rb') as fh:
            data = fh.read()
        with _real_open(path, 'wb') as fh:
            fh.write(b'%PDF-1.4 KICSERELT AZ ELSO OLVASAS UTAN')
        return io.BytesIO(data)
    return _real_open(path, *a, **k)
def _os_open(path, *a, **k):
    _deny(path)
    if (_swap['path'] and not _swap['done'] and isinstance(path, str)
            and os.path.basename(path) == os.path.basename(_swap['path'])):
        # a descriptor-based reader: open the file, then replace it on disk with a NEW inode -- the open
        # descriptor still reads the checked bytes, a second open by path gets the swapped ones
        fd = _real_os_open(path, *a, **k)
        _swap['done'] = True
        os.unlink(_swap['path'])
        with _real_open(_swap['path'], 'wb') as fh:
            fh.write(b'%PDF-1.4 KICSERELT AZ ELSO OLVASAS UTAN')
        return fd
    return _real_os_open(path, *a, **k)
builtins.open = io.open = _open
_dirfd_ok = os.open in os.supports_dir_fd
os.open = _os_open
if _dirfd_ok:
    os.supports_dir_fd.add(_os_open)   # the stub keeps the platform's dir_fd support visible to the sender
# T_RACE=<path in the drop directory>|<outside file>: right after the sender resolves that path (realpath),
# the file is replaced by a symlink to the outside file -- the window between a path check and the open
_race = os.environ.get('T_RACE', '').split('|') if os.environ.get('T_RACE') else None
_real_realpath = os.path.realpath
def _realpath(p, *a, **k):
    r = _real_realpath(p, *a, **k)
    if _race and r == _real_realpath(_race[0]) and not os.path.islink(_race[0]):
        os.unlink(_race[0])
        os.symlink(_race[1], _race[0])
    return r
os.path.realpath = _realpath
code = 0
try:
    runpy.run_path(os.path.join(os.environ['T_ROOT'], os.environ['T_FILE']), run_name='__main__')
except SystemExit as e:
    code = e.code
print('RESULT=' + json.dumps({'sent': sent, 'exit': code if isinstance(code, int) or code is None else str(code)}))
"""


def inproc(root, args, swap=None, extra_env=None, race=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("SUPPORT_", "EMAIL_APPROVAL"))}
    env.update({"T_ARGV": json.dumps(["x"] + args), "T_ROOT": root, "T_FILE": SENDER}, **(extra_env or {}))
    if swap:
        env["T_SWAP"] = swap
    if race:
        env["T_RACE"] = "|".join(race)
    p = subprocess.run([sys.executable, "-c", INPROC], capture_output=True, text=True, env=env, cwd=root, timeout=60)
    line = [ln for ln in p.stdout.splitlines() if ln.startswith("RESULT=")]
    return (json.loads(line[0][7:]) if line else {"sent": {}, "exit": "no-result"}), p.stderr


SUBJ, BODY = "Tárgy", "Kedves Ügyfél, ez a levél törzse."
LETTER = ["--to", "a@example.com", "--subject", SUBJ, "--body", BODY]
SEND = f"python3 {SENDER} --to a@example.com --subject '{SUBJ}' --body '{BODY}'"
PDF1, PDF2 = b"%PDF-1.4 elso melleklet", b"%PDF-1.4 masodik melleklet"


def desc(name, data):
    return {"name": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


with tempfile.TemporaryDirectory() as td:
    # --- level 3: the attachment goes out, the bytes are the checked bytes -------
    root = make_project(os.path.join(td, "l3"), level=3)
    a1 = put(root, DROP + "/ajanlat.pdf", PDF1)
    res, err = inproc(root, LETTER + ["--attach", DROP + "/ajanlat.pdf"])
    check("A1 level 3: --attach from the drop directory is delivered as an attachment, its bytes = the file",
          res["exit"] in (0, None) and res["sent"].get("att") == {"ajanlat.pdf": hashlib.sha256(PDF1).hexdigest()},
          f"res={res} err={err[-300:]!r}")
    res, err = inproc(root, LETTER + ["--attach", a1], swap=a1)
    check("A1c the file swapped right after its first read: the letter carries the bytes the digest was taken of "
          "(one read)",
          res["sent"].get("att") == {"ajanlat.pdf": hashlib.sha256(PDF1).hexdigest()}, f"res={res} err={err[-300:]!r}")
    put(root, DROP + "/ajanlat.pdf", PDF1)
    put(root, DROP + "/b-masik.pdf", PDF2)
    res, err = inproc(root, LETTER + ["--attach", DROP + "/ajanlat.pdf", "--attach", DROP + "/b-masik.pdf"])
    check("A1d --attach is repeatable: both files are delivered",
          res["sent"].get("att") == {"ajanlat.pdf": hashlib.sha256(PDF1).hexdigest(),
                                     "b-masik.pdf": hashlib.sha256(PDF2).hexdigest()}, f"res={res} err={err[-300:]!r}")

    # --- refusals before the level: nothing is consumed, nothing is sent ---------
    outside = os.path.join(td, "kint.pdf")
    with open(outside, "wb") as fh:
        fh.write(PDF1)
    os.symlink(outside, os.path.join(root, DROP, "link.pdf"))
    os.makedirs(os.path.join(root, DROP, "mappa.pdf"))
    put(root, DROP + "/olvashatatlan.pdf", PDF1)
    put(root, DROP + "/al/belso.pdf", PDF1)
    for label, ref, token in (
        ("a missing file", DROP + "/nincs.pdf", "nincs.pdf"),
        ("an unreadable file", DROP + "/olvashatatlan.pdf", "olvashatatlan.pdf"),
        ("a directory", DROP + "/mappa.pdf", "mappa.pdf"),
        ("a file outside the drop directory (absolute)", outside, "kint.pdf"),
        ("a path that starts in the drop directory and leaves it with ../",
         os.path.join(DROP, os.path.relpath(outside, os.path.join(root, DROP))), "kint.pdf"),
        ("a symlink in the drop directory pointing outside", DROP + "/link.pdf", "link.pdf"),
        # only DIRECT children: a subdirectory could be moved out of the tree under an open descriptor
        ("a file in a subdirectory of the drop directory", DROP + "/al/belso.pdf", "belso.pdf"),
    ):
        res, err = inproc(root, LETTER + ["--attach", ref])
        # (a string SystemExit is printed to stderr by the interpreter; this harness catches it, so it is in res["exit"])
        check(f"N-{label} (a): nothing is sent, the file is named on stderr",
              res["exit"] not in (0, None) and (token in err or token in str(res["exit"])) and not res["sent"],
              f"res={res} err={err[-300:]!r}")
        check(f"N-{label} (b): the sender's refusal contract -- exit 3, KULDES MEGTAGADVA, no traceback",
              res["exit"] == 3 and "KULDES MEGTAGADVA" in err and "Traceback" not in err, f"res={res} err={err[-300:]!r}")
    # N8: the drop directory is not widened from the environment. send.py reads its settings from the project .env
    # only (see OWNER_CC: `VAR=... python3 send.py` in the agent's shell is read by no gate), so a
    # SUPPORT_MAIL_ATTACH_DIR in the environment pointing elsewhere must not make an outside file attachable.
    res, err = inproc(root, LETTER + ["--attach", outside], extra_env={"SUPPORT_MAIL_ATTACH_DIR": td})
    check("N8 an environment SUPPORT_MAIL_ATTACH_DIR does not widen the drop directory: the outside file is refused, "
          "nothing sent", res["exit"] not in (0, None) and not res["sent"], f"res={res} err={err[-300:]!r}")
    with open(os.path.join(root, ".env"), "a", encoding="utf-8") as fh:
        fh.write(f"SUPPORT_MAIL_ATTACH_DIR={td}\n")
    res, err = inproc(root, LETTER + ["--attach", outside])
    check("N8b a SUPPORT_MAIL_ATTACH_DIR in the project .env does not move the drop directory either (a '/' would lift the "
          "limit): the outside file is refused, nothing sent", res["exit"] not in (0, None) and not res["sent"],
          f"res={res} err={err[-300:]!r}")
    # N-race: the file passes the path check, then -- before the open -- it is swapped for a symlink to an outside
    # file (a concurrent writer in the agent's own shell can do this). The open must not follow it.
    put(root, DROP + "/verseny.pdf", PDF2)
    res, err = inproc(root, LETTER + ["--attach", DROP + "/verseny.pdf"],
                      race=(os.path.join(root, DROP, "verseny.pdf"), outside))
    check("N-race a file swapped for an outward symlink between the path check and the open: nothing is sent "
          "(the outside bytes never go out)", not res["sent"] and res["exit"] not in (0, None), f"res={res} err={err[-300:]!r}")

    # --- level 2: the anchor covers the attachment, in the sender and in the hook -
    root = make_project(os.path.join(td, "l2"), level=2)
    put(root, DROP + "/ajanlat.pdf", PDF1)
    att_cmd = SEND + f" --attach {DROP}/ajanlat.pdf"
    r = bash(root, att_cmd)
    anchor = anchor_of(r[2])
    g = gate_module(root)
    expected = g.content_anchor({"to": ["a@example.com"], "cc": [], "text": f"{SUBJ}\n{BODY}",
                                 "attachments": [desc("ajanlat.pdf", PDF1)]})
    check("L2a level 2 without an approval: refused, the anchor printed = content_anchor with the attachment "
          "descriptor {name, sha256, size}", refused(r) and anchor == expected, f"rc={r[0]} err={r[2][-300:]!r}")
    sys.path.insert(0, os.path.join(root, "scripts", "hooks"))
    spec = importlib.util.spec_from_file_location("extract_for_attach_test",
                                                  os.path.join(root, "scripts", "hooks", "email_extract.py"))
    ex = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ex)
    _, hook_atts, why = ex.collect_bash_attachments(f"python3 x.py --attach {os.path.join(root, DROP, 'ajanlat.pdf')}")
    check("L2b the sender's descriptor is the hook's own (email_extract.collect_bash_attachments) for the same file",
          why is None and hook_atts == [desc("ajanlat.pdf", PDF1)], f"{hook_atts} {why}")
    put(root, DROP + "/b-masik.pdf", PDF2)
    ab = anchor_of(bash(root, att_cmd + f" --attach {DROP}/b-masik.pdf")[2])
    ba = anchor_of(bash(root, SEND + f" --attach {DROP}/b-masik.pdf --attach {DROP}/ajanlat.pdf")[2])
    check("L2d the order of the --attach flags does not change the anchor (sorted like the hook's), "
          "and two attachments anchor differently from one", ab is not None and ab == ba and ab != anchor, f"{ab} {ba}")
    os.symlink("ajanlat.pdf", os.path.join(root, DROP, "alias.pdf"))
    al = anchor_of(bash(root, SEND + f" --attach {DROP}/alias.pdf")[2])
    _, al_hook, _ = ex.collect_bash_attachments(f"python3 x.py --attach {os.path.join(root, DROP, 'alias.pdf')}")
    check("L2e a symlink INSIDE the drop directory to an inside file: the sender names it as the hook's extractor does "
          "(the path as given), so one call has one anchor",
          al is not None and al == g.content_anchor({"to": ["a@example.com"], "cc": [], "text": f"{SUBJ}\n{BODY}",
                                                     "attachments": al_hook}), f"{al} {al_hook}")
    approve(root, anchor)
    r = bash(root, att_cmd)
    check("L2c with the approval: the checks pass and the approval is consumed", passed(r) and consumed(root),
          f"rc={r[0]} err={r[2][-300:]!r}")
    # P1: two sends of the same approved letter at the same time -- the DELIVERIES are counted (the stubbed SMTP
    # send_message), not exit codes: exactly one letter reaches SMTP, the other is refused before it
    approve(root, anchor, aid="ap-par")
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2) as pool:
        outs = list(pool.map(lambda _: inproc(root, LETTER + ["--attach", DROP + "/ajanlat.pdf"]), range(2)))
    delivered = [o for o, _ in outs if o["sent"].get("att")]
    check("P1 two parallel sends with ONE approval: exactly ONE delivery reaches SMTP (with the approved attachment), "
          "the other exits 3 without a delivery",
          len(delivered) == 1 and delivered[0]["sent"]["att"] == {"ajanlat.pdf": hashlib.sha256(PDF1).hexdigest()}
          and sorted(o["exit"] for o, _ in outs if not o["sent"]) == [3] and consumed(root, "ap-par"),
          f"{[(o['exit'], bool(o['sent'])) for o, _ in outs]} {[e[-120:] for _, e in outs]}")

    # the three cases the request names, each with an approval that must SURVIVE
    root = make_project(os.path.join(td, "l2-neg"), level=2)
    put(root, DROP + "/ajanlat.pdf", PDF1)
    approve(root, anchor_of(bash(root, att_cmd)[2]), aid="ap-att")
    put(root, DROP + "/ajanlat.pdf", PDF2)
    r = bash(root, att_cmd)
    check("N1 the attachment replaced after the approval: refused, the approval is NOT consumed",
          refused(r) and "NINCS jovahagyas" in r[2] and not consumed(root, "ap-att"), f"rc={r[0]} err={r[2][-300:]!r}")
    put(root, DROP + "/ajanlat.pdf", PDF1)
    approve(root, anchor_of(bash(root, SEND)[2]), aid="ap-plain")
    put(root, DROP + "/b-masik.pdf", PDF2)
    r = bash(root, SEND + f" --attach {DROP}/b-masik.pdf")
    check("N2 an attachment in the call that the approval does not have: refused, the plain approval is NOT consumed",
          refused(r) and not consumed(root, "ap-plain"), f"rc={r[0]} err={r[2][-300:]!r}")
    r = bash(root, SEND + f" --attach {DROP}/nincs.pdf")
    check("N3 a missing file: stopped before the level (not the vault, the file named), no approval consumed",
          r[0] not in (0, None) and "nincs.pdf" in r[2] and "NINCS jovahagyas" not in r[2]
          and not consumed(root, "ap-plain") and not consumed(root, "ap-att"),
          f"rc={r[0]} err={r[2][-300:]!r}")
    r = bash(root, att_cmd + f" --attach {DROP}/b-masik.pdf")
    check("N4 an ADDED attachment next to the approved one: refused, the approval is NOT consumed",
          refused(r) and not consumed(root, "ap-att"), f"rc={r[0]} err={r[2][-300:]!r}")
    os.rename(os.path.join(root, DROP, "ajanlat.pdf"), os.path.join(root, DROP, "atnevezett.pdf"))
    r = bash(root, SEND + f" --attach {DROP}/atnevezett.pdf")
    check("N5 the same bytes under another name: refused (the name is in the anchor)",
          refused(r) and not consumed(root, "ap-att"), f"rc={r[0]} err={r[2][-300:]!r}")
    os.rename(os.path.join(root, DROP, "atnevezett.pdf"), os.path.join(root, DROP, "ajanlat.pdf"))
    r = bash(root, SEND)
    check("N6 (INVARIANS) the plain letter still uses ITS approval (the attachment cases left it intact)",
          passed(r) and consumed(root, "ap-plain"), f"rc={r[0]} err={r[2][-300:]!r}")
    r = bash(root, att_cmd)
    check("N7 the approved attachment letter still uses ITS approval", passed(r) and consumed(root, "ap-att"),
          f"rc={r[0]} err={r[2][-300:]!r}")
    # N9: approved with TWO attachments, called with only one of them
    two_cmd = att_cmd + f" --attach {DROP}/b-masik.pdf"
    approve(root, anchor_of(bash(root, two_cmd)[2]), aid="ap-two")
    r = bash(root, att_cmd)
    check("N9 approved with two attachments, called with one: refused, the approval is NOT consumed",
          refused(r) and not consumed(root, "ap-two"), f"rc={r[0]} err={r[2][-300:]!r}")

    # --- I1: the hook and the real sender together (the project copy's OWN hook, its own store) ------------------
    hook_own = os.path.join(root, "scripts", "hooks", "email-approval-gate.py")

    def hook_then_sender(cmd):
        henv = {k: v for k, v in os.environ.items() if not k.startswith(("SUPPORT_", "EMAIL_APPROVAL"))}
        h = subprocess.run([sys.executable, hook_own], input=json.dumps(
            {"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": root}),
            capture_output=True, text=True, env=henv, timeout=60)
        return h.returncode, h.stdout, (bash(root, cmd) if h.returncode == 0 else None)

    i_cmd = f"python3 {SENDER} --to a@example.com --subject 'Integrációs próba' --body '{BODY}' --attach {DROP}/ajanlat.pdf"
    hc, hout, _ = hook_then_sender(i_cmd)   # no approval yet: the hook passes it through, the sender refuses
    i_anchor = anchor_of(bash(root, i_cmd)[2])
    approve(root, i_anchor, aid="ap-int")
    put(root, DROP + "/ajanlat.pdf", PDF2)
    hc2, _, sr2 = hook_then_sender(i_cmd)
    check("I1a hook -> real sender, the attachment changed after the approval: the hook passes it through, the sender "
          "refuses, the approval is NOT consumed", hc == 0 and "a kuldo maga ellenorzi" in hout and hc2 == 0
          and sr2 is not None and refused(sr2) and not consumed(root, "ap-int"), f"{hc} {hc2} {sr2 and sr2[2][-200:]!r}")
    put(root, DROP + "/ajanlat.pdf", PDF1)
    hc3, _, sr3 = hook_then_sender(i_cmd)
    check("I1b hook -> real sender with the approved attachment: passed through, the sender passes and consumes it once",
          hc3 == 0 and sr3 is not None and passed(sr3) and consumed(root, "ap-int"), f"{hc3} {sr3 and sr3[2][-200:]!r}")

    # --- the hook: the canonical send.py call with --attach is passed through -----
    # The gate reads the store of the install it sits in (no environment override) and passes only a sender
    # that sits in its own, symlink-free project root: run it from a tmp install (a copy, level 2).
    hook_root = make_project(os.path.join(td, "hook"), level=2)
    gate = os.path.join(hook_root, "scripts", "hooks", "email-approval-gate.py")

    def run_hook(cmd):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("SUPPORT_", "EMAIL_APPROVAL"))}
        p = subprocess.run([sys.executable, gate], input=json.dumps(
            {"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": hook_root}),
            capture_output=True, text=True, env=env, timeout=60)
        return p.returncode, p.stdout, p.stderr

    base = f"python3 {SENDER} --to a@example.com --subject 'Teszt targy' --body 'Kedves Ugyfelunk! Torzs.'"
    code, out, err = run_hook(base + f" --attach {DROP}/ajanlat.pdf")
    check("H1 hook, level 2: the canonical send.py call WITH --attach is passed through (the sender checks itself)",
          code == 0 and "a kuldo maga ellenorzi" in out, f"exit={code} out={out[:160]!r} err={err[:200]!r}")
    code, out, err = run_hook(base + f" --attach={DROP}/ajanlat.pdf --attach {DROP}/b.pdf")
    check("H1b hook: --attach=VALUE and a repeated --attach are canonical too", code == 0 and "a kuldo maga ellenorzi" in out,
          f"exit={code} err={err[:200]!r}")
    for label, cmd in (("a command substitution in --attach", base + ' --attach "$(ls store/mail-attachments)"'),
                       ("a value starting with -", base + " --attach -x"),
                       ("--attach without a value", base + " --attach")):
        code, out, err = run_hook(cmd)
        check(f"H2 hook: {label} -> not canonical, denied", code == 2, f"exit={code} err={err[:200]!r}")

    # --- hardening cases: a non-regular file, a control-character name, a linked drop directory, a size cap -------
    # K1 a non-regular file, K2 a CR/LF file name, K3 a linked drop directory, K4 a size cap.
    def inproc_boxed(proj, args, seconds=20, preexec=None):
        """inproc with its own short timeout: a sender that hangs (a FIFO opened without O_NONBLOCK) is a
        FAILED check here, not a test run that dies on the 60 s limit."""
        env = {k: v for k, v in os.environ.items() if not k.startswith(("SUPPORT_", "EMAIL_APPROVAL"))}
        env.update({"T_ARGV": json.dumps(["x"] + args), "T_ROOT": proj, "T_FILE": SENDER})
        try:
            p = subprocess.run([sys.executable, "-c", INPROC], capture_output=True, text=True, env=env, cwd=proj,
                               timeout=seconds, preexec_fn=preexec)
        except subprocess.TimeoutExpired:
            return {"sent": {}, "exit": "timeout"}, f"no answer within {seconds} s"
        line = [ln for ln in p.stdout.splitlines() if ln.startswith("RESULT=")]
        return (json.loads(line[0][7:]) if line else {"sent": {}, "exit": "no-result"}), p.stderr

    def contract_refused(res, err):
        return res["exit"] == 3 and "KULDES MEGTAGADVA" in err and "Traceback" not in err and not res["sent"]

    k_root = make_project(os.path.join(td, "k"), level=3)
    # K1: a FIFO in the drop directory. O_NONBLOCK keeps the open from hanging, fstat S_ISREG refuses it; a
    # directory (the case above) is refused by the read error alone, so only a FIFO tells S_ISREG apart.
    os.mkfifo(os.path.join(k_root, DROP, "cso.pdf"))
    res, err = inproc_boxed(k_root, LETTER + ["--attach", DROP + "/cso.pdf"])
    check("K1 a FIFO in the drop directory: refused (exit 3, KULDES MEGTAGADVA, no traceback), no hang, nothing sent "
          "(without O_NONBLOCK the open hangs; without the S_ISREG check an empty attachment goes out)",
          contract_refused(res, err) and "cso.pdf" in err, f"res={res} err={err[-300:]!r}")
    # K2: a regular file whose name carries CR or LF: a refusal under the sender's contract, not a ValueError
    # traceback with exit 1 from the message builder
    # (and the other characters splitlines() breaks a header on, VT/FF/FS/GS/RS, and a name that is not UTF-8)
    for label, fname in (("LF", "a\nb.pdf"), ("CR", "c\rd.pdf"), ("VT", "e\x0bf.pdf"), ("FF", "g\x0ch.pdf"),
                         ("RS", "i\x1ej.pdf"), ("non-UTF-8 byte", "k\udcffl.pdf")):
        try:
            put(k_root, DROP + "/" + fname, PDF1)
        except (OSError, UnicodeError):
            print(f"  [SKIP] K2 {label}: this filesystem cannot hold such a name")
            continue
        res, err = inproc_boxed(k_root, LETTER + ["--attach", DROP + "/" + fname])
        check(f"K2 a file name with a {label} character: refused (exit 3, KULDES MEGTAGADVA, no traceback), nothing sent",
              contract_refused(res, err), f"res={res} err={err[-300:]!r}")
    # K3: the drop directory itself is a symlink to an outside directory. realpath would follow it and make the
    # outside directory the "drop directory"; it is refused instead (the link is not what the owner approved).
    l_root = make_project(os.path.join(td, "l"), level=3)
    l_out = os.path.join(td, "l-kint")
    os.makedirs(l_out)
    with open(os.path.join(l_out, "x.pdf"), "wb") as fh:
        fh.write(PDF1)
    os.rmdir(os.path.join(l_root, DROP))
    os.symlink(l_out, os.path.join(l_root, DROP))
    for label, ref in (("through the project path", DROP + "/x.pdf"), ("by its resolved path", os.path.join(l_out, "x.pdf"))):
        res, err = inproc_boxed(l_root, LETTER + ["--attach", ref])
        check(f"K3 the drop directory is a symlink to an outside directory, a file {label}: refused "
              "(exit 3, KULDES MEGTAGADVA, no traceback), nothing sent", contract_refused(res, err),
              f"res={res} err={err[-300:]!r}")
    # K4: a size cap, 10 MiB per file (sparse files: cheap to make, the bytes are zeros). The read is bounded, so a
    # huge file cannot be pulled into memory (and again into base64 and the IMAP copy).
    cap = 10 * 1024 * 1024
    for fname, size in (("pont-a-hatar.bin", cap), ("egy-bajttal-tobb.bin", cap + 1)):
        with open(os.path.join(k_root, DROP, fname), "wb") as fh:
            fh.truncate(size)
    res, err = inproc_boxed(k_root, LETTER + ["--attach", DROP + "/pont-a-hatar.bin"])
    check("K4a a file of exactly 10 MiB is delivered (the cap is inclusive)",
          res["exit"] in (0, None) and res["sent"].get("att") == {"pont-a-hatar.bin": hashlib.sha256(bytes(cap)).hexdigest()},
          f"res={res} err={err[-300:]!r}")
    res, err = inproc_boxed(k_root, LETTER + ["--attach", DROP + "/egy-bajttal-tobb.bin"])
    check("K4b a file one byte over 10 MiB: refused (exit 3, KULDES MEGTAGADVA, no traceback), nothing sent",
          contract_refused(res, err) and "egy-bajttal-tobb.bin" in err, f"res={res} err={err[-300:]!r}")
    # K4c: the read itself is bounded. A 1 GiB sparse file under a 512 MiB address-space limit: an unbounded read
    # dies with MemoryError (no refusal), the bounded read stops after the cap and refuses. (Linux: RLIMIT_AS.)
    if sys.platform.startswith("linux"):
        import resource
        with open(os.path.join(k_root, DROP, "hatalmas.bin"), "wb") as fh:
            fh.truncate(1 << 30)
        res, err = inproc_boxed(k_root, LETTER + ["--attach", DROP + "/hatalmas.bin"], seconds=60,
                                preexec=lambda: resource.setrlimit(resource.RLIMIT_AS, (512 << 20, 512 << 20)))
        check("K4c a 1 GiB file with the address space limited to 512 MiB: refused (exit 3, KULDES MEGTAGADVA, no "
              "traceback), nothing sent -- the read is bounded, the file is never pulled into memory",
              contract_refused(res, err) and "hatalmas.bin" in err, f"res={res} err={err[-300:]!r}")
    else:
        print("  [SKIP] K4c needs RLIMIT_AS (Linux)")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All support-mail attach tests passed.")
