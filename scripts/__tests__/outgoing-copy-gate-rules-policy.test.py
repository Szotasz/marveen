#!/usr/bin/env python3
"""CLCOPYGATEHIANY902: a MISSING rules file is not the same as a BROKEN one.

Owner decision (TG 14442): the rules file is deliberately not shipped (it
names a private person), so on every fresh customer install it is ABSENT --
and the old email path fail-closed on that, blocking a paying customer's
outbound mail entirely. New policy, pinned here:

  missing / valid-but-empty  -> email goes OUT (fail-open) with a LOUD,
                                user-visible systemMessage -- the warning is
                                asserted, not just the exit code, because a
                                silent pass is indistinguishable from
                                protection that does not exist;
  present but INVALID        -> email stays BLOCKED (negative control: a fix
                                that fail-opens both branches is WORSE than
                                the bug and would look green without this);
  valid with patterns        -> the name check still enforces (regression
                                guard on the thing the gate is for).

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(os.path.dirname(HERE), "hooks", "outgoing-copy-gate.py")

failed = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def run_gate(rules_path, payload):
    proc = subprocess.run(
        [sys.executable, GATE], input=json.dumps(payload).encode(),
        capture_output=True,
        env=dict(os.environ, OUTGOING_COPY_GATE_RULES=rules_path),
    )
    return proc.returncode, proc.stdout.decode(), proc.stderr.decode()


# A letter that passes every copy check: flawless accents, no em dash, no
# double-hyphen prose, no mixed script.
CLEAN_MAIL = {
    "tool_name": "mcp__server-gmail-autoauth-mcp__send_email",
    "tool_input": {"to": ["a@b.hu"], "subject": "Rendben",
                   "body": "Kedves Ügyfelünk! Köszönjük a levelét, minden rendben van."},
}

with tempfile.TemporaryDirectory() as td:
    missing = os.path.join(td, "nincs-ilyen.json")

    # --- missing: OPEN + LOUD --------------------------------------------
    code, out, err = run_gate(missing, CLEAN_MAIL)
    check("missing rules: the email goes OUT (exit 0, not blocked)",
          code == 0, f"exit={code} err={err[:150]!r}")
    check("missing rules: the pass is LOUD (systemMessage names the absent check)",
          "systemMessage" in out and "HIANYZIK" in out and "nev-ellenorzes NELKUL" in out,
          f"out={out[:200]!r}")

    # --- valid but empty: OPEN + LOUD ------------------------------------
    empty = os.path.join(td, "empty.json")
    with open(empty, "w") as fh:
        json.dump({"bad_name_patterns": []}, fh)
    code, out, _ = run_gate(empty, CLEAN_MAIL)
    check("valid-empty rules: email goes OUT and the pass is loud",
          code == 0 and "URES" in out, f"exit={code} out={out[:160]!r}")

    # --- invalid variants: CLOSED (the negative control) ------------------
    invalid_cases = [
        ("not-json", "{ez nem json"),
        ("wrong-schema (patterns not a list)", json.dumps({"bad_name_patterns": "Szota"})),
        ("uncompilable regex", json.dumps({"bad_name_patterns": ["[unclosed"]})),
        ("top-level not a dict", json.dumps(["Szota"])),
    ]
    for label, content in invalid_cases:
        bad = os.path.join(td, "bad.json")
        with open(bad, "w") as fh:
            fh.write(content)
        code, _, err = run_gate(bad, CLEAN_MAIL)
        check(f"invalid rules ({label}): email stays BLOCKED (exit 2)",
              code == 2 and "ervenytelen" in err, f"exit={code} err={err[:150]!r}")

    # --- valid with patterns: the check still enforces --------------------
    good = os.path.join(td, "good.json")
    with open(good, "w") as fh:
        json.dump({"bad_name_patterns": [r"Szóta"], "correction": "Helyesen: Szota."}, fh)
    bad_name_mail = {
        "tool_name": "mcp__server-gmail-autoauth-mcp__send_email",
        "tool_input": {"to": ["a@b.hu"], "subject": "Rendben",
                       "body": "Kedves Szóta Úr! Köszönjük a levelét, minden rendben van."},
    }
    code, _, err = run_gate(good, bad_name_mail)
    check("valid rules: a bad name is still BLOCKED (the gate still gates)",
          code == 2 and "HELYTELEN NEV" in err, f"exit={code} err={err[:150]!r}")
    code, out, _ = run_gate(good, CLEAN_MAIL)
    check("valid rules: a clean letter passes WITHOUT the missing-rules warning",
          code == 0 and "systemMessage" not in out, f"exit={code} out={out[:120]!r}")

    # --- telegram branch: unchanged fail-open on missing ------------------
    tg = {"tool_name": "mcp__plugin_telegram_telegram__reply",
          "tool_input": {"chat_id": 1, "text": "Rendben, köszönöm szépen."}}
    code, out, _ = run_gate(missing, tg)
    check("telegram + missing rules: still fail-open with its own warning",
          code == 0 and "systemMessage" in out, f"exit={code}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All rules-policy tests passed.")
