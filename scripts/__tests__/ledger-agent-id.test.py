#!/usr/bin/env python3
"""Test agent_id resolution from the session cwd (scripts/hooks/ledger_lib.py).

Regression guard: a session sitting in a SUBDIRECTORY of the install logged its
outbound messages under an agent id taken from the directory name. That splits
the conversation ledger across two identities and makes the reply guard block on
an already-answered question, because it finds no outbound under the real id.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
sys.path.insert(0, HOOKS)

INSTALL = os.path.dirname(os.path.dirname(HERE))
os.environ.setdefault("MAIN_AGENT_ID", "mainagent")

import ledger_lib  # noqa: E402

MAIN = ledger_lib.main_agent_id()

CASES = [
    ("install root is the main agent", INSTALL, MAIN),
    ("subdirectory is STILL the main agent", os.path.join(INSTALL, "store", "some-workdir"), MAIN),
    ("deep subdirectory is still the main agent", os.path.join(INSTALL, "a", "b", "c"), MAIN),
    ("trailing slash tolerated", INSTALL + "/", MAIN),
    ("agent dir maps to that agent", os.path.join(INSTALL, "agents", "dia"), "dia"),
    ("agent subdir maps to that agent", os.path.join(INSTALL, "agents", "dia", "x", "y"), "dia"),
    ("outside the install falls back to basename", "/Users/someone/marveen", "marveen"),
    ("empty cwd falls back to main", "", MAIN),
    ("None cwd falls back to main", None, MAIN),
]

failed = []
for name, cwd, want in CASES:
    got = ledger_lib.agent_id_from_cwd(cwd)
    ok = got == want
    if not ok:
        failed.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All ledger agent-id tests passed.")
