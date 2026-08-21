#!/usr/bin/env python3
"""Arity-contract guard for hook call sites (HOOKARITAS821).

Class this pins: a hook unpacks a shared-module tuple with FIXED arity, the
tuple widens in a later change, the unpack raises ValueError outside any
try/except, the hook dies -- and the harness reads the empty output as "allow"
or "nothing to do". The telegram-reply-guard was born broken exactly this way
and blocked nothing for ten days (#898 widened the tuple two minutes before
#856 shipped the five-name unpack; fixed in #1028).

Two layers:
  1. Structural: every known cross-boundary call site uses a PREFIX SLICE
     (oq[:N]), which is widening-proof.
  2. Behavioral: open_question() keeps working when open_question_with_age()
     returns a WIDER tuple than today (simulated via monkeypatch).

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOOKS = os.path.join(ROOT, "scripts", "hooks")
sys.path.insert(0, HOOKS)

failed = []


def check(name, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        failed.append(name)


def src(fname):
    with open(os.path.join(HOOKS, fname)) as f:
        return f.read()


# --- 1. structural pins: prefix slices at the known call sites --------------
# The telegram-reply-guard call site is fixed and pinned by #1028 (its own
# regression test); once both are merged, adding its pin here is a one-liner.
check("ledger-live-drain unpacks a prefix slice",
      "= oq[:7]" in src("ledger-live-drain.py"))
check("ledger-replay unpacks a prefix slice",
      "= open_q[:6]" in src("ledger-replay.py"))
check("ledger_lib.open_question unpacks a prefix slice",
      "= oq[:7]" in src("ledger_lib.py"))

# --- 2. behavioral: a WIDER with_age tuple must not break open_question -----
import ledger_lib  # noqa: E402

_orig = ledger_lib.open_question_with_age
try:
    ledger_lib.open_question_with_age = lambda agent_id: (
        "111", "42", "szoveg", "2026-08-21T16:00:00Z", 1787300000,
        "voice", "file-1", "EXTRA-8", "EXTRA-9",
    )
    got = ledger_lib.open_question("anyagent")
    check("open_question survives a 9-wide with_age tuple",
          got == ("111", "42", "szoveg", "2026-08-21T16:00:00Z", "voice", "file-1"))
finally:
    ledger_lib.open_question_with_age = _orig

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All hook-arity contract tests passed.")
