#!/usr/bin/env python3
"""extra_accentless: an install's own accentless entries in its local rules file.

The shipped ACCENTLESS holds no proper names. An install keeps its own (its town's name, say) in
store/outgoing-copy-gate-rules.json under "extra_accentless", instead of editing the gate. Pinned here:

  a valid entry            -> its accentless form is caught like a shipped one (exit 2, "word -> Accented");
  no key                   -> the same text passes (control: the entry is what catches it);
  a clash with a shipped   -> the shipped form wins, and the clash is logged;
  an invalid block         -> dropped as a whole and logged; the name rule keeps working.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from copy_gate_install import copy_gate_install  # noqa: E402

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def run_gate(rules_path, body):
    payload = {"tool_name": "mcp__server-gmail-autoauth-mcp__send_email",
               "tool_input": {"to": ["a@b.hu"], "subject": "Rendben", "body": body}}
    proc = subprocess.run([sys.executable, copy_gate_install(rules_path)[0]], input=json.dumps(payload).encode(),
                          capture_output=True, env=dict(os.environ))
    return proc.returncode, proc.stderr.decode()


def write_rules(path, extra=None, patterns=None):
    data = {"bad_name_patterns": patterns or [], "name_check_disabled": not patterns}
    if extra is not None:
        data["extra_accentless"] = extra
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)


def gate_log(rules_path):
    p = os.path.join(rules_path + ".inst", "store", "outgoing-copy-gate.log")
    return open(p, encoding="utf-8").read() if os.path.exists(p) else ""


# Accented Hungarian prose with one accentless place name in it ("pecsen" = Pécsen).
BODY = "Kedves Ügyfelünk! Köszönjük a levelét, jövő héten pecsen leszünk, és minden rendben van."

with tempfile.TemporaryDirectory() as td:
    plain = os.path.join(td, "plain.json")
    write_rules(plain)
    code, err = run_gate(plain, BODY)
    check("control: without extra_accentless the place name passes (exit 0)", code == 0, f"exit={code} err={err[:200]!r}")

    extra = os.path.join(td, "extra.json")
    write_rules(extra, {"pecsen": "Pécsen"})
    code, err = run_gate(extra, BODY)
    check("an extra entry is caught (exit 2)", code == 2, f"exit={code}")
    check("the message names it with its accented form", "HIANYZO EKEZETEK" in err and "pecsen -> Pécsen" in err, err[:300])

    clash = os.path.join(td, "clash.json")
    write_rules(clash, {"belul": "Bélül-X"})
    code, err = run_gate(clash, "Kedves Ügyfelünk! Köszönjük, a héten belul válaszolunk.")
    check("a clash keeps the shipped form", code == 2 and "belul -> belül" in err and "Bélül-X" not in err, err[:300])
    check("the clash is logged", "nem irja felul: belul" in gate_log(clash), gate_log(clash)[-300:])

    for i, (label, bad) in enumerate((("uppercase key", {"Pecsen": "Pécsen"}), ("value without an accent", {"pecsen": "Pecsen"}),
                       ("not an object", ["pecsen"]))):
        path = os.path.join(td, f"bad-{i}.json")
        write_rules(path, bad, patterns=["Tilos Nev"])
        code, err = run_gate(path, BODY)
        check(f"invalid ({label}): the block is dropped, the place name passes", code == 0, f"exit={code} err={err[:200]!r}")
        check(f"invalid ({label}): logged", "extra_accentless ERVENYTELEN" in gate_log(path), gate_log(path)[-300:])
        code, err = run_gate(path, "Kedves Ügyfelünk! Üdvözlettel: Tilos Nev")
        check(f"invalid ({label}): the name rule still blocks", code == 2 and "HELYTELEN NEV" in err, f"exit={code} err={err[:200]!r}")

print("OK" if not failed else f"FAILED: {len(failed)}")
sys.exit(1 if failed else 0)
