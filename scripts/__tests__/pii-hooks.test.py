#!/usr/bin/env python3
"""Test the PII channel hooks (scripts/hooks/pii-*.py) without Presidio.

- merge_mapping: a marker keeps its meaning for the whole session (Presidio
  numbers from _1 on every call, which used to overwrite earlier markers).
- outbound hook: rewrites the reply through hookSpecificOutput.updatedInput
  (echoing the payload back is ignored by Claude Code), reads session_id from
  stdin, and never lets SZEMELY_1 eat the prefix of SZEMELY_10.
Run:  python3 <thisfile>    Exit 0 = all pass.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
INBOUND = os.path.join(HOOKS, "pii-anonymize-inbound.py")
OUTBOUND = os.path.join(HOOKS, "pii-deanonymize-outbound.py")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check(cond, msg):
    if not cond:
        sys.stderr.write(f"FAIL: {msg}\n")
        sys.exit(1)


inbound = load(INBOUND, "pii_inbound")

# --- merge_mapping: stable markers across messages ---
existing = {}
first = inbound.merge_mapping(existing, {"SZEMELY_1": "Kovács Eszter", "EMAIL_1": "k@example.com"})
check(first == {"SZEMELY_1": "Kovács Eszter", "EMAIL_1": "k@example.com"}, f"first message: {first}")
second = inbound.merge_mapping(existing, {"SZEMELY_1": "Nagy Péter", "SZEMELY_2": "Kovács Eszter"})
check(second == {"SZEMELY_2": "Nagy Péter", "SZEMELY_1": "Kovács Eszter"}, f"second message: {second}")
check(existing["SZEMELY_1"] == "Kovács Eszter", "earlier marker was overwritten")
check(".." not in inbound.mapping_file("../../etc"), "session id path traversal")

# --- outbound hook as a subprocess ---
with tempfile.TemporaryDirectory() as tmp:
    home, proj = os.path.join(tmp, "home"), os.path.join(tmp, "proj")
    os.makedirs(os.path.join(home, ".pii-mapper", "sess-1"))
    os.makedirs(proj)
    with open(os.path.join(proj, ".env"), "w") as f:
        f.write("PII_ANONYMIZE=true\n")
    mapping = {f"SZEMELY_{i}": f"Név{i}" for i in range(1, 11)}
    mapping["EMAIL_1"] = "k@example.com"
    with open(os.path.join(home, ".pii-mapper", "sess-1", "mapping.json"), "w") as f:
        json.dump(mapping, f, ensure_ascii=False)
    env = dict(os.environ, HOME=home, CLAUDE_PROJECT_DIR=proj)

    def run(payload):
        p = subprocess.run([sys.executable, OUTBOUND], input=json.dumps(payload),
                           capture_output=True, text=True, env=env)
        check(p.returncode == 0, f"outbound exit {p.returncode}: {p.stderr}")
        return p.stdout

    out = run({"session_id": "sess-1", "tool_name": "mcp__plugin_telegram_telegram__reply",
               "tool_input": {"chat_id": "1", "text": "Kedves SZEMELY_1! SZEMELY_10 és SZEMELY_2nek: EMAIL_1"}})
    res = json.loads(out)["hookSpecificOutput"]
    check(res["hookEventName"] == "PreToolUse", f"event name: {res}")
    check(res["updatedInput"] == {"chat_id": "1", "text": "Kedves Név1! Név10 és Név2nek: k@example.com"},
          f"updatedInput: {res['updatedInput']}")

    # No marker in the text -> no output (the call goes through unchanged)
    check(run({"session_id": "sess-1", "tool_input": {"text": "semmi"}}) == "", "unchanged text produced output")
    # Unknown session -> no mapping -> no output
    check(run({"session_id": "other", "tool_input": {"text": "SZEMELY_1"}}) == "", "foreign session leaked a mapping")

print("pii-hooks: all pass")
