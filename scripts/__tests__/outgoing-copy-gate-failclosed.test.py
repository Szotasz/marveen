#!/usr/bin/env python3
"""Exit-code contract of scripts/hooks/outgoing-copy-gate.py on malformed input.

Regression guard: a non-dict tool_input crashed the gate with an unhandled
AttributeError -> exit 1. PreToolUse treats exit 1 as NON-blocking, so the
send ran UNCHECKED -- the exact opposite of the email path's fail-closed
contract. The fix is a top-level fail-closed net: any unexpected crash on the
email/Bash send paths exits 2 (block), while the telegram path keeps its own
deliberate fail-open handling (exit 0) and non-send tools stay untouched.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")


def run_gate(payload) -> int:
    data = payload if isinstance(payload, str) else json.dumps(payload)
    proc = subprocess.run(
        [sys.executable, GATE], input=data.encode(), capture_output=True,
    )
    return proc.returncode


CASES = [
    ("email with non-dict tool_input BLOCKS (was: crash, exit 1, send ran unchecked)",
     {"tool_name": "mcp__x__send_email", "tool_input": ["x"]}, 2),
    ("Bash with non-dict tool_input BLOCKS (command is uninspectable)",
     {"tool_name": "Bash", "tool_input": "not-a-dict"}, 2),
    ("telegram reply with non-dict tool_input stays FAIL-OPEN by design",
     {"tool_name": "mcp__plugin_telegram_telegram__reply", "tool_input": 42}, 0),
    ("non-send tool with malformed input passes (the net never widens the gate)",
     {"tool_name": "Read", "tool_input": ["x"]}, 0),
    ("unparseable stdin still exits 0 (must not wedge the session)",
     "this is not json", 0),
]

failed = []
for name, payload, want in CASES:
    got = run_gate(payload)
    ok = got == want
    if not ok:
        failed.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: exit={got} want={want}")

# --- THE SHARED RULE'S OWN IMPORT MUST FAIL CLOSED TOO -----------------------
# MSGGATE924: the mixed-script rule moved to scripts/lib/mixed_script.py so both
# gates share it. That import fires during MODULE LOAD, so a bare ImportError
# escapes the __main__ net above and exits 1 -- which PreToolUse reads as
# NON-blocking. An extraction that turns "checked" into "ran unchecked" is a
# worse bug than the duplication it removed, so the failure mode is pinned here.
#
# The rule file is removed while email_extract stays, otherwise the block could
# come from the email stub and this case would measure nothing.
import shutil
import tempfile

with tempfile.TemporaryDirectory() as _tmp:
    _root = os.path.join(_tmp, "scripts")
    shutil.copytree(os.path.join(os.path.dirname(HERE), "hooks"), os.path.join(_root, "hooks"))
    shutil.copytree(os.path.join(os.path.dirname(HERE), "lib"), os.path.join(_root, "lib"))
    os.remove(os.path.join(_root, "lib", "mixed_script.py"))
    _gate = os.path.join(_root, "hooks", "outgoing-copy-gate.py")
    _payload = json.dumps({
        "tool_name": "Bash",
        "tool_input": {"command": "curl -s -X POST http://localhost:3420/api/messages "
                                  "-d '{\"from\":\"igor\",\"to\":\"hex\",\"content\":\"tiszta szoveg\"}'"},
    })
    _proc = subprocess.run([sys.executable, _gate], input=_payload.encode(), capture_output=True)
    _err = _proc.stderr.decode("utf-8", "replace")
    _name = "a missing mixed_script.py BLOCKS (was: exit 1, i.e. NON-blocking)"
    _ok = _proc.returncode == 2
    failed.append(_name) if not _ok else None
    print(f"  [{'PASS' if _ok else 'FAIL'}] {_name}: exit={_proc.returncode} want=2")

    _name2 = "  ...and it says the RULE could not load, not that a homoglyph was found"
    _ok2 = ("NEM TOLTHETO BE" in _err) and ("mixed_script" in _err)
    failed.append(_name2) if not _ok2 else None
    print(f"  [{'PASS' if _ok2 else 'FAIL'}] {_name2}: stderr={_err[:120]!r}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate fail-closed tests passed.")
