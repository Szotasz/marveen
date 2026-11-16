"""EMAILGATESUBST1116: a send command built by process substitution, a here-string, a stdin heredoc or xargs is
refused as unverifiable by the main agent's two mail hooks.

This file drives the real hooks as subprocesses in a throwaway install: email-approval-gate.py at level 2 AND at
level 3 (the refusal holds at every level: the envelope cannot be anchored), and outgoing-copy-gate.py. Exit 2 with
the refusal text = refused; exit 0 = passes. The row-by-row contract of the predicate (python and JS twin) is
unverifiable-construction-cases.json. Nothing is executed: the hooks only read the command text.

Run: python3 -I <thisfile>   Exit 0 = all pass.
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
REFUSAL = "nem ellenorizheto"

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def make_install(td, level):
    """A throwaway install with email_send at `level` and an empty approvals table."""
    os.symlink(SCRIPTS, os.path.join(td, "scripts"))
    store = os.path.join(td, "store")
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
    return os.path.join(td, "scripts", "hooks")


A = "a" + "@" + "example.com"
REFUSED = (
    ("a shell reads its program from a process substitution", f"bash <(echo 'python3 tool.py --to {A}')"),
    ("source reads a process substitution", f"source <(echo 'python3 tool.py --to {A}')"),
    ("a shell reads its program from a here-string", f"bash <<< 'python3 tool.py --to {A}'"),
    ("an interpreter reads its program from a here-string", "python3 - <<< 'import smtplib'"),
    ("a shell reads its program from a stdin heredoc", f"sh -s <<'EOF'\npython3 tool.py --to {A}\nEOF"),
    ("xargs puts its input in a recipient value", f"printf '{A}' | xargs -I{{}} python3 tool.py --to {{}}"),
    ("xargs appends its input after a recipient flag", "xargs -a addrs.txt python3 tool.py --to"),
)
NOT_SENDS = (
    ("control: xargs runs grep", "find . -name '*.py' | xargs grep -n foo"),
    ("control: a here-string program with no send marker", "bash <<< 'ls -la'"),
    ("control: process substitutions as data arguments", "diff <(sort a) <(sort b)"),
)
LEGIT_SEND = f"python3 scripts/support-mail/send.py --to {A} --subject S < BODY"

roots = []
try:
    for level in (2, 3):
        td = tempfile.mkdtemp(prefix="unverifiable-")
        roots.append(td)
        hooks = make_install(td, level)
        work = os.path.join(td, "work")
        os.makedirs(work)
        with open(os.path.join(work, "tool.py"), "w") as fh:
            fh.write('print("tool")\n')
        body = os.path.join(work, "body.txt")
        with open(body, "w") as fh:
            fh.write("Szia, köszönöm a gyors választ.\n")

        def run(hook, command):
            payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": work}
            p = subprocess.run([sys.executable, os.path.join(hooks, hook)], input=json.dumps(payload),
                               capture_output=True, text=True)
            return p.returncode, p.stderr

        for hook in ("email-approval-gate.py", "outgoing-copy-gate.py"):
            if hook == "outgoing-copy-gate.py" and level == 3:
                continue  # the copy gate has no level
            tag = f"{hook} level {level}" if hook == "email-approval-gate.py" else hook
            print(f"== {tag}: refused as unverifiable")
            for name, cmd in REFUSED:
                code, err = run(hook, cmd)
                check(f"{tag}: {name} -> exit 2, refusal", code == 2 and REFUSAL in err, f"exit={code} err={err[:200]!r}")
            print(f"== {tag}: controls pass")
            for name, cmd in NOT_SENDS:
                code, err = run(hook, cmd)
                check(f"{tag}: {name} -> exit 0", code == 0, f"exit={code} err={err[:200]!r}")
            code, err = run(hook, LEGIT_SEND.replace("BODY", body))
            check(f"{tag}: control: send.py with stdin from a file is not refused as unverifiable",
                  REFUSAL not in err and (code == 0 or hook == "email-approval-gate.py"), f"exit={code} err={err[:200]!r}")
            if hook == "email-approval-gate.py" and level == 3:
                check(f"{tag}: control: the same send passes at level 3", code == 0, f"exit={code} err={err[:200]!r}")
finally:
    for td in roots:
        shutil.rmtree(td, ignore_errors=True)

print(f"\n{'ALL PASS' if not failed else f'{len(failed)} FAILED'}")
sys.exit(1 if failed else 0)
