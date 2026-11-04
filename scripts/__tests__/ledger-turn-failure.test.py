#!/usr/bin/env python3
"""Test the StopFailure hook (scripts/hooks/ledger-turn-failure.py).

Drives the hook as a subprocess from a tmp install (<tmp>/scripts linked to the
repo's), so its ledger DB is <tmp>/store/claudeclaw.db and the failures file lands
next to it. Since ENVRELAXGATE1104 no environment variable picks the ledger DB. Run:  python3 <thisfile>
Exit 0 = all pass; non-zero = a failure.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
sys.path.insert(0, HOOKS)


def install(tmp):
    """<tmp> as an install: store/ plus scripts/ linked to the repo's (the hooks
    take their root from abspath, not realpath). Returns its hooks dir."""
    os.makedirs(os.path.join(tmp, "store"), exist_ok=True)
    link = os.path.join(tmp, "scripts")
    if not os.path.lexists(link):
        os.symlink(os.path.dirname(HOOKS), link)
    return os.path.join(link, "hooks")


def hook(tmp):
    return os.path.join(install(tmp), "ledger-turn-failure.py")


def lib(tmp):
    """ledger_lib loaded from the tmp install, so its DB is <tmp>/store/claudeclaw.db."""
    spec = importlib.util.spec_from_file_location("ledger_lib_" + os.path.basename(tmp),
                                                  os.path.join(install(tmp), "ledger_lib.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

failed = []


def check(name, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        failed.append(name)


def run(tmp, payload, notify=None):
    env = dict(os.environ)
    env.pop("LEDGER_DB_PATH", None)
    env["MARVEEN_AGENT_ID"] = "tester"
    if notify is None:
        env.pop("LEDGER_TURN_FAILURE_NOTIFY", None)
    else:
        env["LEDGER_TURN_FAILURE_NOTIFY"] = notify
    env["LEDGER_TURN_FAILURE_NOTIFY_CMD"] = os.path.join(tmp, "fake-notify.sh")
    return subprocess.run([sys.executable, hook(tmp)], input=json.dumps(payload),
                          capture_output=True, text=True, env=env, timeout=30)


def rows(tmp):
    p = os.path.join(tmp, "store", "ledger-turn-failures.jsonl")
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
    ledger_lib = lib(tmp)
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
    env = dict(os.environ)
    r = subprocess.run([sys.executable, hook(tmp)], input="not json",
                       capture_output=True, text=True, env=env, timeout=30)
    check("garbage payload: exit 0, no row", r.returncode == 0 and rows(tmp) == [])

# ENVRELAXGATE1104: a ledger DB named in the environment is not used.
with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as elsewhere:
    setup(tmp, answered=False)
    open_db = os.path.join(elsewhere, "claudeclaw.db")
    r = subprocess.run([sys.executable, hook(tmp)], input=json.dumps(FAIL), capture_output=True, text=True,
                       env=dict(os.environ, LEDGER_DB_PATH=open_db, MARVEEN_AGENT_ID="tester"), timeout=30)
    check("ENVRELAXGATE1104: LEDGER_DB_PATH in the environment is ignored (the install DB answers)",
          r.returncode == 0 and len(rows(tmp)) == 1 and not os.path.exists(open_db)
          and not os.path.exists(os.path.join(elsewhere, "ledger-turn-failures.jsonl")))

if failed:
    print(f"FAIL: {len(failed)} check(s): {failed}", file=sys.stderr)
    sys.exit(1)
print("ALL PASS")
