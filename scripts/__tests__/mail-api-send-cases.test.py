"""MAILGATEHTTPAPI1027: an HTTP mail API send (Gmail REST or client, Resend, SendGrid, Mailgun, Postmark) in a
script file or a -c code string is a send for the main agent's approval gate.

Reads scripts/hooks/mail-api-send-cases.json, the case list shared with the sub-agent gate's vitest twin
(src/__tests__/mail-api-send-cases.test.ts). Each case runs through script_run_sends (the body as a script
file) and is_send_invocation (the body as a `python3 -c` / `node -e` code string).

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import shlex
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")

spec = importlib.util.spec_from_file_location("outgoing_copy_gate", os.path.join(HOOKS, "outgoing-copy-gate.py"))
ocg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocg)

with open(os.path.join(HOOKS, "mail-api-send-cases.json"), encoding="utf-8") as fh:
    CASES = json.load(fh)["cases"]

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def prog_for(file):
    return "python3" if file.endswith(".py") else "node"


td = tempfile.mkdtemp(prefix="mail-api-send-")
try:
    check("the shared list has send and no-send cases",
          any(c["expected"] for c in CASES) and any(not c["expected"] for c in CASES))
    for c in CASES:
        for name, body in [(c["file"], c["body"])] + list(c.get("helpers", {}).items()):
            with open(os.path.join(td, name), "w", encoding="utf-8") as fh:
                fh.write(body)
    for c in CASES:
        prog = prog_for(c["file"])
        got = ocg.script_run_sends(f"{prog} {c['file']}", td)
        check(f"script file: {c['name']}", got == c["expected"], f"got {got}")
        if c.get("helpers") or c.get("file_only"):
            continue
        flag = "-c" if prog == "python3" else "-e"
        got = ocg.is_send_invocation(f"{prog} {flag} {shlex.quote(c['body'])}")
        check(f"code string: {c['name']}", got == c["expected"], f"got {got}")
finally:
    shutil.rmtree(td, ignore_errors=True)

print(f"\n{len(failed)} failed" if failed else "\nall passed")
sys.exit(1 if failed else 0)
