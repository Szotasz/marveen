#!/usr/bin/env python3
"""Test the StopFailure hook (scripts/hooks/ledger-turn-failure.py).

Drives the hook as a subprocess against an isolated ledger DB (LEDGER_DB_PATH);
the failures file lands next to it. Run:  python3 <thisfile>
Exit 0 = all pass; non-zero = a failure.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
HOOK = os.path.join(HOOKS, "ledger-turn-failure.py")
sys.path.insert(0, HOOKS)

failed = []


def check(name, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        failed.append(name)


def run(tmp, payload, notify=None):
    env = dict(os.environ)
    env["LEDGER_DB_PATH"] = os.path.join(tmp, "claudeclaw.db")
    env["MARVEEN_AGENT_ID"] = "tester"
    if notify is None:
        env.pop("LEDGER_TURN_FAILURE_NOTIFY", None)
    else:
        env["LEDGER_TURN_FAILURE_NOTIFY"] = notify
    env["LEDGER_TURN_FAILURE_NOTIFY_CMD"] = os.path.join(tmp, "fake-notify.sh")
    return subprocess.run([sys.executable, HOOK], input=json.dumps(payload),
                          capture_output=True, text=True, env=env, timeout=30)


def rows(tmp):
    p = os.path.join(tmp, "ledger-turn-failures.jsonl")
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return [json.loads(line) for line in f if line.strip()]


def notified(tmp):
    p = os.path.join(tmp, "notified.txt")
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return [line for line in f if line.strip()]


def setup(tmp, answered):
    os.environ["LEDGER_DB_PATH"] = os.path.join(tmp, "claudeclaw.db")
    import ledger_lib
    ledger_lib.log_inbound("tester", "42", "827", "a question", "2026-09-22T10:28:49Z")
    if answered:
        ledger_lib.log_outbound("tester", "42", "the answer", message_id="828")
    with open(os.path.join(tmp, "fake-notify.sh"), "w") as f:
        f.write('printf "%s\\n" "$1" >> "$(dirname "$0")/notified.txt"\n')


FAIL = {"hook_event_name": "StopFailure", "error": "invalid_request",
        "error_details": "Prompt is too long"}

print("ledger-turn-failure: StopFailure leaves a trace for an unanswered inbound")

with tempfile.TemporaryDirectory() as tmp:
    setup(tmp, answered=False)
    r = run(tmp, FAIL)
    got = rows(tmp)
    check("exit 0", r.returncode == 0)
    check("one row for the open inbound", len(got) == 1)
    check("row names the message, chat and error",
          got[:1] and got[0]["message_id"] == "827" and got[0]["chat_id"] == "42"
          and got[0]["agent_id"] == "tester" and got[0]["error"] == "invalid_request"
          and got[0]["error_details"] == "Prompt is too long")
    check("notify off by default: nothing sent", notified(tmp) == [])

with tempfile.TemporaryDirectory() as tmp:
    setup(tmp, answered=True)
    run(tmp, FAIL, notify="1")
    check("CONTROL: an answered inbound leaves no row", rows(tmp) == [])
    check("CONTROL: and no notification", notified(tmp) == [])

with tempfile.TemporaryDirectory() as tmp:
    setup(tmp, answered=False)
    run(tmp, FAIL, notify="1")
    run(tmp, FAIL, notify="1")
    sent = notified(tmp)
    check("two failures on the same message: two rows", len(rows(tmp)) == 2)
    check("but ONE notification", len(sent) == 1)
    check("the notification names the message and the error",
          sent[:1] and "827" in sent[0] and "invalid_request" in sent[0])

with tempfile.TemporaryDirectory() as tmp:
    setup(tmp, answered=False)
    env = dict(os.environ, LEDGER_DB_PATH=os.path.join(tmp, "claudeclaw.db"))
    r = subprocess.run([sys.executable, HOOK], input="not json",
                       capture_output=True, text=True, env=env, timeout=30)
    check("garbage payload: exit 0, no row", r.returncode == 0 and rows(tmp) == [])

if failed:
    print(f"FAIL: {len(failed)} check(s): {failed}", file=sys.stderr)
    sys.exit(1)
print("ALL PASS")
