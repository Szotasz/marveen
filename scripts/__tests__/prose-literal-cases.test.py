"""MAILGATEHEREDOCFP1027: the prose-literal masker of the main agent's gates returns the shared expectation.

Reads scripts/hooks/prose-literal-cases.json, the case list shared with the sub-agent gate's vitest twin
(src/__tests__/prose-literal-cases.test.ts), and checks _mask_prose_literals byte for byte on every case.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")

spec = importlib.util.spec_from_file_location("outgoing_copy_gate", os.path.join(HOOKS, "outgoing-copy-gate.py"))
ocg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocg)

with open(os.path.join(HOOKS, "prose-literal-cases.json"), encoding="utf-8") as fh:
    CASES = json.load(fh)["cases"]

failed = []
for c in CASES:
    got = ocg._mask_prose_literals(c["input"], c["lang"])
    ok = got == c["expected"]
    print(f"  [{'PASS' if ok else 'FAIL'}] {c['name']}" + ("" if ok else f" -- got {got!r}"))
    if not ok:
        failed.append(c["name"])
if len(CASES) < 10:
    print("  [FAIL] the shared list is too short to mean anything")
    failed.append("case count")

print(f"\n{len(failed)} failed" if failed else "\nall passed")
sys.exit(1 if failed else 0)
