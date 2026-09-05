#!/usr/bin/env python3
"""The gate log has to say WHEN, and it has to name the real cause.

Two defects found 2026-09-05 while tracing a fail-open pass-through:

  (a) store/outgoing-copy-gate.log carried bare text, no timestamps. 8005 lines,
      four distinct messages, one of them recording that a Telegram message went
      out UNAUDITED -- and no way to tell which day, let alone which message. A
      gate log whose entries cannot be placed in time cannot be used to check
      anything.
  (b) that fail-open line read AttributeError("'int' object has no attribute
      'get'"), which looks like a bug inside the audit. The real cause is a
      tool_input that is not a dict, and the gate should say so.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")
TELEGRAM = "mcp__plugin_telegram_telegram__reply"
# ISO 8601 local time with a numeric offset -- never UTC in our logs.
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4} ")

failed = []


def check(name, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{'' if cond else ': ' + detail}")
    if not cond:
        failed.append(name)


def run(payload, rules_path):
    env = dict(os.environ, OUTGOING_COPY_GATE_RULES=rules_path)
    proc = subprocess.run([sys.executable, GATE], input=json.dumps(payload).encode(),
                          capture_output=True, env=env)
    log = os.path.join(os.path.dirname(rules_path), "outgoing-copy-gate.log")
    lines = []
    if os.path.exists(log):
        with open(log, encoding="utf-8") as fh:
            lines = [l.rstrip("\n") for l in fh if l.strip()]
    return proc.returncode, proc.stderr.decode(), lines


with tempfile.TemporaryDirectory() as tmp:
    rules = os.path.join(tmp, "rules.json")

    # (1) every line written to the gate log carries a timestamp
    rc, _, lines = run({"tool_name": TELEGRAM, "tool_input": {"text": "Rendben van."}}, rules)
    check("a hianyzo nev-szabaly sora naploba kerul", len(lines) >= 1, f"sorok={lines}")
    check("minden naplosor idobelyeggel kezdodik",
          bool(lines) and all(STAMP.match(l) for l in lines),
          f"idobelyeg nelkuli sor: {[l for l in lines if not STAMP.match(l)][:2]}")

with tempfile.TemporaryDirectory() as tmp:
    rules = os.path.join(tmp, "rules.json")
    with open(rules, "w", encoding="utf-8") as fh:
        json.dump({"bad_name_patterns": ["Kovacs Jozsef"], "correction": "Kovács József"}, fh)

    # (2) a non-dict tool_input names the CAUSE, not an AttributeError
    rc, err, lines = run({"tool_name": TELEGRAM, "tool_input": 7}, rules)
    check("telegram + nem-szotar tool_input: fail-open marad", rc == 0, f"exit={rc}")
    joined = "\n".join(lines)
    check("a naplo a valodi okot nevezi meg", "nem szotar" in joined and "int" in joined,
          f"naplo={joined!r}")
    check("a naplo nem AttributeError-t ir", "AttributeError" not in joined, joined)
    check("a naplo megmondja melyik toolrol van szo", "telegram" in joined.lower(), joined)
    check("ez a sor is idobelyeges", bool(lines) and all(STAMP.match(l) for l in lines), joined)

    # (3) the same shape on the email path still BLOCKS, and says why
    rc, err, lines = run({"tool_name": "mcp__google-workspace__manage_email",
                          "tool_input": 7}, rules)
    check("email + nem-szotar tool_input: blokk", rc == 2, f"exit={rc}")
    check("a blokk-uzenet a hivo szemebe mondja az okot", "nem szotar" in err, err[:200])

    # (4) the net must not widen the gate to tools this hook does not police
    _, _, before = run({"tool_name": TELEGRAM, "tool_input": {"text": "Rendben van."}}, rules)
    rc, err, lines = run({"tool_name": "Read", "tool_input": ["x"]}, rules)
    check("nem-kuldo tool valtozatlanul atmegy", rc == 0, f"exit={rc}")
    check("nem-kuldo toolrol egy sort sem ir a naploba",
          len(lines) == len(before), f"uj sorok={lines[len(before):]}")

    # (5) a real problem still blocks: the gate is not weakened by any of this
    rc, err, _ = run({"tool_name": TELEGRAM, "tool_input": {"text": "Ez egy — gondolatjel."}}, rules)
    check("em dash tovabbra is blokkol", rc == 2, f"exit={rc}")
    rc, err, _ = run({"tool_name": TELEGRAM,
                      "tool_input": {"text": "Masd:\n```\nls\n```", "format": "text"}}, rules)
    check("plain textes kodblokk tovabbra is blokkol", rc == 2, f"exit={rc}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All outgoing-copy-gate log tests passed.")
