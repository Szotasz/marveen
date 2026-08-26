#!/usr/bin/env python3
"""Test agent_id resolution from the session cwd (scripts/hooks/ledger_lib.py).

Regression guard: a session sitting in a SUBDIRECTORY of the install used to log
its outbound messages under an agent id INVENTED from the directory name. That
splits the conversation ledger across two identities and makes the reply guard
block on an already-answered question, because it finds no outbound under the
real id. Anything inside the install tree must resolve to the main agent, and a
cwd outside the tree must never fabricate an id from the directory name.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
sys.path.insert(0, HOOKS)

INSTALL = os.path.dirname(os.path.dirname(HERE))
os.environ.setdefault("MAIN_AGENT_ID", "mainagent")
os.environ.pop("MARVEEN_AGENT_ID", None)

import ledger_lib  # noqa: E402

MAIN = ledger_lib.main_agent_id()

CASES = [
    ("install root is the main agent", INSTALL, MAIN),
    ("subdirectory is STILL the main agent", os.path.join(INSTALL, "store", "some-workdir"), MAIN),
    ("deep subdirectory is still the main agent", os.path.join(INSTALL, "a", "b", "c"), MAIN),
    ("trailing slash tolerated", INSTALL + "/", MAIN),
    ("agent dir maps to that agent", os.path.join(INSTALL, "agents", "dia"), "dia"),
    ("agent subdir maps to that agent", os.path.join(INSTALL, "agents", "dia", "x", "y"), "dia"),
    ("outside the install attributes to the main agent (never invents an id)", "/tmp/someone/marveen", MAIN),
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

# MARVEEN_AGENT_ID lets a launcher name an out-of-tree session explicitly.
os.environ["MARVEEN_AGENT_ID"] = "explicit-agent"
got = ledger_lib.agent_id_from_cwd("/tmp/someone/marveen")
ok = got == "explicit-agent"
if not ok:
    failed.append("MARVEEN_AGENT_ID override for out-of-tree cwd")
print(f"  [{'PASS' if ok else 'FAIL'}] MARVEEN_AGENT_ID override for out-of-tree cwd: "
      f"got={got!r} want='explicit-agent'")
os.environ.pop("MARVEEN_AGENT_ID", None)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All ledger agent-id tests passed.")
