"""ISSUE3049: a file operand after a process substitution was judged as a script run.

`cmp <(curl -s http://localhost:3420/app.js) web/app.js` is a read-only check, but the tokenizer ended the command at
the substitution's `)`, so `web/app.js` became the head of a command of its own. The gate read it as a script, and a
file over the script read limit (1 MiB, the fail-closed size branch) made the line a send: at email_send level 1 the
main agent's approval gate refused it. Now the substitution is one word of the command around it; its own command is
still judged, and a large file that an interpreter really runs is still refused.

This file drives the real hook (email-approval-gate.py) as a subprocess at level 1, so exit 2 = refused, exit 0 =
passes. The row-by-row contract of both gates is script-run-cases.json (ISSUE3049 rows). Nothing is executed: the hook
only reads the command text and the files.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
LIMIT = 1024 * 1024  # _SCRIPT_READ_LIMIT in outgoing-copy-gate.py

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


td = tempfile.mkdtemp(prefix="issue3049-")
try:
    os.symlink(SCRIPTS, os.path.join(td, "scripts"))
    os.makedirs(os.path.join(td, "store"))
    with open(os.path.join(td, "store", "autonomy-config.json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "categories": [{"key": "email_send", "level": 1, "locked": False, "maxLevel": 3}]}, fh)
    gate = os.path.join(td, "scripts", "hooks", "email-approval-gate.py")
    D = os.path.join(td, "work")
    os.makedirs(os.path.join(D, "web"))
    with open(os.path.join(D, "web", "big.js"), "w") as fh:
        fh.write("a" * (LIMIT + 1))
    with open(os.path.join(D, "web", "small.css"), "w") as fh:
        fh.write("body{}\n")
    with open(os.path.join(D, "bigsend.py"), "w") as fh:
        fh.write("import smtplib\n" + "#" * (LIMIT + 16) + "\n")

    def rc(command):
        payload = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": D, "hook_event_name": "PreToolUse"}
        p = subprocess.run([sys.executable, gate], input=json.dumps(payload), capture_output=True, text=True, cwd=D)
        return p.returncode, p.stderr

    print("== a file after a process substitution is an operand, not a script (passes)")
    for name, cmd in (
        ("cat <(echo x) big file", "cat <(echo x) web/big.js"),
        ("cmp <(echo x) big file", "cmp <(echo x) web/big.js"),
        ("diff <(echo x) big file", "diff <(echo x) web/big.js"),
        ("the reported check: cmp <(curl ...) big file", "cmp <(curl -s http://localhost:3420/app.js) web/big.js"),
        ("two substitutions, then the big file", "diff <(sort a) <(sort b) web/big.js"),
        ("control: the substitution after the file", "wc -c web/big.js <(echo x)"),
        ("control: a small file after the substitution", "cmp <(echo x) web/small.css"),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 0", code == 0, f"exit={code} err={err[:200]!r}")

    print("== a large file an interpreter really runs is still refused (fail-closed size branch)")
    for name, cmd in (
        ("python3 big script", "python3 bigsend.py"),
        ("python3 big script, then a substitution", "python3 bigsend.py <(echo x)"),
        ("a substitution as the script operand (undecidable)", "python3 <(echo x) bigsend.py"),
        ("a send inside the substitution", "cat <(python3 bigsend.py) web/small.css"),
    ):
        code, err = rc(cmd)
        check(f"{name} -> exit 2", code == 2, f"exit={code} err={err[:200]!r}")
finally:
    shutil.rmtree(td, ignore_errors=True)

if failed:
    print(f"\n{len(failed)} FAILED")
    sys.exit(1)
print("\nAll ISSUE3049 tests passed.")
