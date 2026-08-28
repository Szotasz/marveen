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

# ---------------------------------------------------------------------------
# agent_id_from_payload (LEDGERCWD828): the cwd is MUTABLE within a session --
# the main agent cd-ing into agents/iris/... re-attributed its OWN replies to
# iris, the reply guard found no outbound under the real id and triple-sent an
# answered link. The transcript_path (derived from the session's config dir)
# is immutable per session, so it must win over the cwd.
# ---------------------------------------------------------------------------
MAIN_TRANSCRIPT = os.path.join(INSTALL, ".channels-config", "projects", "x", "sess.jsonl")
SUB_TRANSCRIPT = os.path.join(INSTALL, "agents", "iris", ".claude-config", "projects", "x", "s.jsonl")
HOME_TRANSCRIPT = os.path.join(os.path.expanduser("~"), ".claude", "projects", "x", "s.jsonl")

PAYLOAD_CASES = [
    # (a) THE INCIDENT, as a known positive: main-agent session whose cwd
    # wandered into a sub-agent's tree must STAY the main agent.
    ("main session cd-ed into agents/<x> stays MAIN (the incident)",
     {"transcript_path": MAIN_TRANSCRIPT, "cwd": os.path.join(INSTALL, "agents", "iris", "workspace", "v3")}, MAIN),
    # (b) NEGATIVE CONTROL: a real sub-agent's own reply keeps its own name.
    ("real sub-agent keeps its own id",
     {"transcript_path": SUB_TRANSCRIPT, "cwd": os.path.join(INSTALL, "agents", "iris")}, "iris"),
    ("sub-agent that cd-ed elsewhere STILL keeps its own id",
     {"transcript_path": SUB_TRANSCRIPT, "cwd": os.path.join(INSTALL, "store")}, "iris"),
    ("home-config transcript is the main agent",
     {"transcript_path": HOME_TRANSCRIPT, "cwd": os.path.join(INSTALL, "agents", "boni")}, MAIN),
    ("no transcript falls back to the old cwd semantics (sub-agent)",
     {"cwd": os.path.join(INSTALL, "agents", "boni", "x")}, "boni"),
    ("no transcript, install-subdir cwd falls back to MAIN",
     {"cwd": os.path.join(INSTALL, "store")}, MAIN),
    ("empty payload resolves to MAIN, never invents",
     {}, MAIN),
    ("None payload resolves to MAIN, never invents",
     None, MAIN),
    ("out-of-tree transcript says nothing -> cwd chain decides",
     {"transcript_path": "/tmp/elsewhere/t.jsonl", "cwd": os.path.join(INSTALL, "agents", "dia")}, "dia"),
    # The MIRROR family (review finding on #1100): every fleet agent's tmux
    # session runs on the DEFAULT ~/.claude config root, whose project dir is
    # keyed by the flattened starting cwd -- the agent id is IN the segment.
    # Measured live 2026-08-28: the running samu session's transcript sits
    # exactly here. Mapping this family to MAIN would mirror the original bug.
    ("~/.claude fleet-session transcript keeps the agent id (the mirror case)",
     {"transcript_path": os.path.join(os.path.expanduser("~"), ".claude", "projects",
                                      INSTALL.replace(os.sep, "-") + "-agents-iris", "s.jsonl"),
      "cwd": os.path.join(INSTALL, "store")}, "iris"),
    ("~/.claude session started DEEP in an agent tree still maps to the agent",
     {"transcript_path": os.path.join(os.path.expanduser("~"), ".claude", "projects",
                                      INSTALL.replace(os.sep, "-") + "-agents-geri-workspace-hideghivas", "s.jsonl"),
      "cwd": "/tmp"}, "geri"),
    ("~/.claude session started at the install root is the MAIN agent",
     {"transcript_path": os.path.join(os.path.expanduser("~"), ".claude", "projects",
                                      INSTALL.replace(os.sep, "-"), "s.jsonl"),
      "cwd": os.path.join(INSTALL, "agents", "iris")}, MAIN),
]

for name, payload, want in PAYLOAD_CASES:
    got = ledger_lib.agent_id_from_payload(payload)
    ok = got == want
    if not ok:
        failed.append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")

# Env override sits BETWEEN transcript and cwd: it wins when the transcript is
# silent, and loses when the transcript speaks.
os.environ["MARVEEN_AGENT_ID"] = "explicit-agent"
got = ledger_lib.agent_id_from_payload({"transcript_path": "/tmp/none/t.jsonl", "cwd": "/tmp/none"})
if got != "explicit-agent":
    failed.append("env override when transcript silent")
print(f"  [{'PASS' if got == 'explicit-agent' else 'FAIL'}] env override when transcript silent: got={got!r}")
got = ledger_lib.agent_id_from_payload({"transcript_path": SUB_TRANSCRIPT})
if got != "iris":
    failed.append("transcript beats env override")
print(f"  [{'PASS' if got == 'iris' else 'FAIL'}] transcript beats env override: got={got!r}")
os.environ.pop("MARVEEN_AGENT_ID", None)

# ---------------------------------------------------------------------------
# End-to-end through the REAL outbound hook: same incident shape, but the row
# that lands in the (temp) ledger DB is what gets asserted -- not the resolver
# in isolation. LEDGER_DB_PATH keeps this off the live store.
# ---------------------------------------------------------------------------
import json
import sqlite3
import subprocess
import tempfile

HOOK = os.path.join(HOOKS, "ledger-outbound.py")
with tempfile.TemporaryDirectory() as tmp:
    db = os.path.join(tmp, "ledger.db")
    env = dict(os.environ, LEDGER_DB_PATH=db, MAIN_AGENT_ID="mainagent")
    env.pop("MARVEEN_AGENT_ID", None)

    def run_hook(transcript, cwd):
        payload = {
            "tool_name": "mcp__plugin_telegram_telegram__reply",
            "cwd": cwd,
            "transcript_path": transcript,
            "tool_input": {"chat_id": "111", "text": "e2e probe"},
        }
        subprocess.run(["python3", HOOK], input=json.dumps(payload).encode(),
                       env=env, timeout=30, check=False)

    HOME_FLEET_TRANSCRIPT = os.path.join(os.path.expanduser("~"), ".claude", "projects",
                                         INSTALL.replace(os.sep, "-") + "-agents-iris", "s.jsonl")
    run_hook(MAIN_TRANSCRIPT, os.path.join(INSTALL, "agents", "iris", "workspace"))
    run_hook(SUB_TRANSCRIPT, os.path.join(INSTALL, "agents", "iris"))
    run_hook(HOME_FLEET_TRANSCRIPT, os.path.join(INSTALL, "store"))
    rows = sqlite3.connect(db).execute(
        "SELECT agent_id FROM conversation_log WHERE direction='out' ORDER BY id").fetchall()
    got_ids = [r[0] for r in rows]
    want_ids = [MAIN, "iris", "iris"]
    ok = got_ids == want_ids
    if not ok:
        failed.append("end-to-end outbound rows")
    print(f"  [{'PASS' if ok else 'FAIL'}] end-to-end outbound rows: got={got_ids!r} want={want_ids!r}")

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All ledger agent-id tests passed.")
