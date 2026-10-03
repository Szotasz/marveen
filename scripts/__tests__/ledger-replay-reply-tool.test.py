#!/usr/bin/env python3
"""REPLAYTOOL924: the SessionStart replay names the reply tool of the channel the
open question came FROM, not always Telegram.

Measured 2026-09-24: a respawned session was told to answer a Discord DM with
mcp__plugin_telegram_telegram__reply. The ledger records the envelope source
(PROVIDERVAK908); the replay now derives the tool from it, and on an unknown
source falls back to provider-agnostic wording instead of inventing a name.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
sys.path.insert(0, HOOKS)
spec = importlib.util.spec_from_file_location("replay", os.path.join(HOOKS, "ledger-replay.py"))
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

OPEN_Q = ("100", "200", "Köszönöm", "2026-09-24T13:39:11Z", None, None)
TRANSCRIPT = ['  [2026-09-24T13:37:09Z] Gazda: "kerdes"']


def directive(reply_tool):
    out = replay._build_output(TRANSCRIPT, OPEN_Q, "Gazda", reply_tool)
    text = json.dumps(out, ensure_ascii=False)
    start = text.find("NYITOTT")
    return text[start:start + 400]


failed = []


def check(name, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        failed.append(name)


d = directive("mcp__plugin_discord_discord__reply")
check("a Discord source names the Discord reply tool", "mcp__plugin_discord_discord__reply" in d)
check("a Discord source does NOT name the Telegram tool", "telegram" not in d.lower())

d = directive("mcp__plugin_telegram_telegram__reply")
check("a Telegram source still names the Telegram tool", "mcp__plugin_telegram_telegram__reply" in d)

d = directive(None)
check("an unknown source names NO tool (no invented name)", "mcp__plugin_" not in d)
check("an unknown source says: the channel it came from", "ahonnan jött" in d)

sig = replay._fit_output.__code__.co_varnames[:replay._fit_output.__code__.co_argcount]
check("_fit_output threads reply_tool through to _build_output", "reply_tool" in sig)


# End-to-end through main(): the helper checks above pass reply_tool by hand, so
# on their own they stay green even if main() never derives it. Write real
# ledger rows (a sourced inbound, no outbound after it = an open question), run
# the hook as the harness does, and read the tool name off its real output.
import subprocess
import tempfile

REPLAY = os.path.join(HOOKS, "ledger-replay.py")


def replay_output(source):
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(os.environ, LEDGER_DB_PATH=os.path.join(tmp, "ledger.db"),
                   MARVEEN_AGENT_ID="replay-e2e", MAIN_AGENT_ID="replay-e2e")
        seed = (
            "import sys; sys.path.insert(0, sys.argv[1]); import ledger_lib;"
            "src = sys.argv[2] or None;"
            "ledger_lib.log_inbound('replay-e2e', '4242', '1', 'nyitott kerdes',"
            " '2026-09-25T10:00:00Z', source=src)"
        )
        subprocess.run([sys.executable, "-c", seed, HOOKS, source or ""],
                       env=env, check=True, cwd=tmp)
        res = subprocess.run([sys.executable, REPLAY], input=json.dumps({"cwd": tmp}),
                             env=env, cwd=tmp, capture_output=True, text=True, timeout=60)
        return res.returncode, res.stdout


rc, out = replay_output("plugin:discord:discord")
check("main(): the hook exits 0 on a sourced open question", rc == 0)
check("main(): a Discord-sourced open question names the Discord reply tool",
      "mcp__plugin_discord_discord__reply" in out)
check("main(): a Discord-sourced open question does NOT name the Telegram tool",
      "mcp__plugin_telegram_telegram__reply" not in out)

rc, out = replay_output("plugin:telegram:telegram")
check("main(): a Telegram-sourced open question names the Telegram reply tool",
      "mcp__plugin_telegram_telegram__reply" in out)

rc, out = replay_output(None)
check("main(): the open question is replayed at all (control for the checks above)",
      "nyitott kerdes" in out)
check("main(): an unsourced open question names NO tool", "mcp__plugin_" not in out)

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All ledger-replay reply-tool tests passed.")
