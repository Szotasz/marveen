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

print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All ledger-replay reply-tool tests passed.")
