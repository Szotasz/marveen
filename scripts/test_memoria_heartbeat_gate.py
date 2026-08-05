#!/usr/bin/env python3
"""Branch tests for memoria_heartbeat_gate against a throwaway database.

Every outward path is rebound: db, marker, token, messages URL, and the wake
call itself. Nothing here may reach store/claudeclaw.db or the live agent.

The scenario that matters most is `scenario_own_turn_does_not_retrigger`: it is
the whole reason the watermark is written by the agent instead of by the gate.

Run: python3 scripts/test_memoria_heartbeat_gate.py
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "memoria_heartbeat_gate", Path(__file__).resolve().parent / "memoria_heartbeat_gate.py"
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

FAILURES: list[str] = []


def check_eq(name: str, got, want) -> None:
    if got == want:
        print(f"  ok   {name}: {got!r}")
    else:
        print(f"  FAIL {name}: got {got!r}, want {want!r}")
        FAILURES.append(name)


def build_db(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE conversation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "agent_id TEXT NOT NULL, chat_id TEXT NOT NULL, direction TEXT NOT NULL, "
        "created_at INTEGER NOT NULL)"
    )
    con.execute(
        "CREATE TABLE tool_call_log (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "session_id TEXT NOT NULL, tool_name TEXT NOT NULL, success INTEGER, "
        "created_at INTEGER NOT NULL, agent_id TEXT, input_summary TEXT)"
    )
    con.commit()
    return con


def add_conv(con, agent="picard", direction="in") -> None:
    con.execute(
        "INSERT INTO conversation_log (agent_id, chat_id, direction, created_at) "
        "VALUES (?, 'c', ?, 0)",
        (agent, direction),
    )
    con.commit()


def add_tool(con, agent="picard", summary="ls") -> None:
    con.execute(
        "INSERT INTO tool_call_log (session_id, tool_name, success, created_at, agent_id, "
        "input_summary) VALUES ('s', 'Bash', 1, 0, ?, ?)",
        (agent, summary),
    )
    con.commit()


# What the PostToolUse hook actually stores for the agent's own end-of-turn
# bookkeeping call, verbatim from the live tool_call_log (row 4266).
MARK_SEEN_SUMMARY = (
    "python3 /Users/gruzmanarnold/marveen/scripts/memoria_heartbeat_gate.py "
    "--mark-seen --conv-upto 1609"
)


def mark_seen_and_log(con, conv_upto: int) -> int:
    """`--mark-seen` the way it happens in production.

    The hook logs the call AFTER the script has read the maximum, so the row
    always lands in front of the marker this very call just wrote. Any test
    that calls gate.mark_seen() without this row is modelling a world one row
    friendlier than the real one -- which is exactly how the self-wake survived
    fourteen green scenarios.
    """
    rc = gate.mark_seen(conv_upto)
    add_tool(con, summary=MARK_SEEN_SUMMARY)
    return rc


def mark_all() -> int:
    """The agent claiming it reviewed everything that exists right now."""
    return gate.mark_seen(gate.current_maxima()["conversation_log"])


def wire(tmp: Path):
    gate.DB_PATH = tmp / "test.db"
    gate.MARKER_FILE = tmp / "marker.txt"
    gate.TOKEN_FILE = tmp / "token"
    gate.MESSAGES_URL = "http://127.0.0.1:1/never"
    gate.TOKEN_FILE.write_text("test-token")
    con = build_db(gate.DB_PATH)
    woken: list = []
    gate.wake_agent = lambda seen, maxima: woken.append((dict(seen), dict(maxima)))
    return con, woken


def scenario_quiet() -> None:
    print("nothing since the marker -> silent")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)
        add_tool(con)
        mark_all()
        check_eq("exit code", gate.check(), 0)
        check_eq("woken", woken, [])


def scenario_new_conversation() -> None:
    print("new inbound turn -> wake")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)
        mark_all()
        add_conv(con)
        check_eq("exit code", gate.check(), 0)
        check_eq("woken once", len(woken), 1)


def scenario_new_tool_only() -> None:
    print("autonomous work only, no channel traffic -> wake (the old blind spot)")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)
        mark_all()
        for _ in range(5):
            add_tool(con)
        check_eq("exit code", gate.check(), 0)
        check_eq("woken once", len(woken), 1)


def scenario_own_turn_does_not_retrigger() -> None:
    print("agent's own turn (tool calls + outbound reply) -> no self-retrigger")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)
        mark_all()

        add_conv(con)  # Arnold writes
        check_eq("gate wakes", gate.check(), 0)
        check_eq("woken once", len(woken), 1)

        # the turn itself: tool calls, then an outbound reply
        for _ in range(8):
            add_tool(con)
        add_conv(con, direction="out")
        mark_seen_and_log(con, gate.current_maxima()["conversation_log"])

        check_eq("next tick exit", gate.check(), 0)
        check_eq("no second wake", len(woken), 1)


def scenario_mark_seen_call_does_not_rewake() -> None:
    print("the --mark-seen call's own log row -> not activity (self-wake, 2026-08-02)")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)
        add_tool(con)
        mark_all()

        # A silent turn: nothing happened, the agent still has to mark seen.
        check_eq("mark-seen exit", mark_seen_and_log(con, 1), 0)
        check_eq("next tick exit", gate.check(), 0)
        check_eq("stays silent", woken, [])

        # And it stays silent hour after hour, which is where the live gate
        # failed: each wake wrote another mark-seen row for the next one.
        for _ in range(3):
            gate.check()
        check_eq("still silent after three ticks", woken, [])

        # Real work in the same window is still seen.
        add_tool(con, summary="git status")
        check_eq("wakes on real work", gate.check(), 0)
        check_eq("woken once", len(woken), 1)


def scenario_crashed_turn_rewakes() -> None:
    print("turn dies before --mark-seen -> same window wakes again (deliberate)")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)
        mark_all()
        add_conv(con)

        check_eq("first wake", gate.check(), 0)
        # no mark_seen: the turn crashed
        check_eq("second tick", gate.check(), 0)
        check_eq("woken twice", len(woken), 2)
        check_eq(
            "same window both times",
            woken[0][0]["conversation_log"] == woken[1][0]["conversation_log"],
            True,
        )


def scenario_wake_fails_marker_untouched() -> None:
    print("wake fails -> non-zero exit, marker untouched")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, _ = wire(tmp)
        add_conv(con)
        mark_all()
        before = gate.MARKER_FILE.read_text()
        add_conv(con)

        def boom(seen, maxima):
            raise OSError("dashboard down")

        gate.wake_agent = boom
        check_eq("exit code", gate.check(), 1)
        check_eq("marker untouched", gate.MARKER_FILE.read_text(), before)


def scenario_other_agent_ignored() -> None:
    print("another agent's rows -> not our activity, stays silent")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)
        mark_all()
        add_conv(con, agent="geordi")
        add_tool(con, agent="geordi")
        check_eq("exit code", gate.check(), 0)
        check_eq("woken", woken, [])


def scenario_legacy_marker_format() -> None:
    print("pre-679 bare-integer marker -> honoured, not replayed from zero")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        for _ in range(3):
            add_conv(con)
        gate.MARKER_FILE.write_text("3\n")

        seen = gate.read_markers()
        check_eq("conversation watermark kept", seen["conversation_log"], 3)
        check_eq("tool watermark starts at zero", seen["tool_call_log"], 0)
        check_eq("no conversation replay", gate.count_new(3, "conversation_log"), 0)


def scenario_missing_marker() -> None:
    print("no marker file at all -> everything counts as new")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)
        check_eq("exit code", gate.check(), 0)
        check_eq("woken once", len(woken), 1)


def scenario_mark_seen_writes_both() -> None:
    print("--mark-seen writes both watermarks as json")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, _ = wire(tmp)
        add_conv(con)
        add_conv(con)
        add_tool(con)
        check_eq("exit code", mark_all(), 0)
        data = json.loads(gate.MARKER_FILE.read_text())
        check_eq("conversation watermark", data["conversation_log"], 2)
        check_eq("tool watermark", data["tool_call_log"], 1)


def scenario_outbound_only_stays_silent() -> None:
    print("agent's own outbound replies -> not inbound activity, stays silent")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)
        mark_all()
        for _ in range(4):
            add_conv(con, direction="out")
        check_eq("exit code", gate.check(), 0)
        check_eq("woken", woken, [])


def scenario_midturn_message_survives_mark_seen() -> None:
    print("message arrives DURING the turn -> stays in front of the watermark (msg 681)")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, woken = wire(tmp)
        add_conv(con)  # id 1
        mark_all()

        add_conv(con)  # id 2, Arnold writes
        check_eq("gate wakes", gate.check(), 0)
        conv_max_in_prompt = woken[0][1]["conversation_log"]
        check_eq("prompt showed conv_max", conv_max_in_prompt, 2)

        # the turn: tool calls, an outbound reply, and a message landing mid-turn
        for _ in range(3):
            add_tool(con)
        add_conv(con, direction="out")  # id 3
        add_conv(con)  # id 4, arrives while the turn is still running

        check_eq("mark-seen exit", gate.mark_seen(conv_max_in_prompt), 0)
        data = json.loads(gate.MARKER_FILE.read_text())
        check_eq("conv marker stopped at the prompt value", data["conversation_log"], 2)
        check_eq("tool marker swallowed own footprint", data["tool_call_log"], 3)

        # the whole point: the mid-turn message is not lost
        check_eq("next tick exit", gate.check(), 0)
        check_eq("woken again for id 4", len(woken), 2)
        check_eq("new window starts at 2", woken[1][0]["conversation_log"], 2)

        # and once it IS reviewed, silence returns
        gate.mark_seen(4)
        check_eq("settles", gate.check(), 0)
        check_eq("no third wake", len(woken), 2)


def scenario_mark_seen_requires_conv_upto() -> None:
    print("--mark-seen without --conv-upto -> refuses, writes nothing")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, _ = wire(tmp)
        add_conv(con)
        mark_all()
        before = gate.MARKER_FILE.read_text()
        add_conv(con)
        add_tool(con)

        check_eq("exit code", gate.mark_seen(None), 2)
        check_eq("marker untouched", gate.MARKER_FILE.read_text(), before)
        check_eq("cli rejects it too", gate.main(["--mark-seen"]), 2)


def scenario_conv_upto_clamped() -> None:
    print("--conv-upto out of range -> clamped, never swallows unread input")
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        con, _ = wire(tmp)
        for _ in range(2):
            add_conv(con)
        mark_all()  # conv marker = 2
        add_conv(con)  # id 3, unreviewed

        check_eq("above max", gate.mark_seen(9999), 0)
        check_eq(
            "clamped to current max",
            json.loads(gate.MARKER_FILE.read_text())["conversation_log"],
            3,
        )

        check_eq("below previous", gate.mark_seen(1), 0)
        check_eq(
            "does not move backward",
            json.loads(gate.MARKER_FILE.read_text())["conversation_log"],
            3,
        )


if __name__ == "__main__":
    for scenario in (
        scenario_quiet,
        scenario_new_conversation,
        scenario_new_tool_only,
        scenario_own_turn_does_not_retrigger,
        scenario_mark_seen_call_does_not_rewake,
        scenario_crashed_turn_rewakes,
        scenario_wake_fails_marker_untouched,
        scenario_other_agent_ignored,
        scenario_legacy_marker_format,
        scenario_missing_marker,
        scenario_mark_seen_writes_both,
        scenario_outbound_only_stays_silent,
        scenario_midturn_message_survives_mark_seen,
        scenario_mark_seen_requires_conv_upto,
        scenario_conv_upto_clamped,
    ):
        scenario()
        print()

    if FAILURES:
        print(f"FAILED: {', '.join(FAILURES)}")
        sys.exit(1)
    print("all scenarios passed")
