#!/usr/bin/env python3
"""Test the Telegram-reply Stop hook (scripts/hooks/telegram-reply-guard.py).

Drives the hook as a subprocess against an isolated ledger DB (LEDGER_DB_PATH),
asserting the block/allow decision for each scenario. Run:  python3 <thisfile>
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import os
import sys
import json
import time
import tempfile
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
HOOK = os.path.join(HOOKS, "telegram-reply-guard.py")
sys.path.insert(0, HOOKS)


# LEDGERAGENTFIX905: the fixture used to hardcode both this cwd and the agent id
# "marveen". Since LEDGERCWD828 the hook resolves the id through
# ledger_lib.agent_id_from_payload(), and on any host whose main agent is NOT
# named marveen that resolver returns the LOCAL id -- so the rows were written
# under one name and read under another, and all three BLOCK cases reported
# got=None. That reads as "the guard never blocks" (a real, scary regression);
# measured 2026-09-05 the guard blocks correctly when the ids match. The pad was
# wrong, not the gate. Derive the id from the same resolver the hook uses.
HOOK_CWD = "/Users/edgar/marveen"


def hook_agent_id():
    import ledger_lib
    return ledger_lib.agent_id_from_payload({"cwd": HOOK_CWD})


def run_hook(db_path, cwd=HOOK_CWD, extra_env=None):
    env = dict(os.environ)
    env["LEDGER_DB_PATH"] = db_path
    if extra_env:
        env.update(extra_env)
    p = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps({"cwd": cwd, "stop_hook_active": False}),
        capture_output=True, text=True, env=env, timeout=20,
    )
    out = p.stdout.strip()
    decision, reason = None, ""
    if out:
        try:
            parsed = json.loads(out)
            decision = parsed.get("decision")
            reason = parsed.get("reason") or ""
        except Exception:
            decision = "PARSE_ERROR:" + out
    return decision, reason, p.returncode


def fresh_db():
    fd, path = tempfile.mkstemp(suffix=".db", prefix="tgguard-")
    os.close(fd)
    # remove any stale statefile from a previous run in the same tmpdir
    for f in os.listdir(os.path.dirname(path)):
        if f.startswith(".tg-reply-guard-"):
            try:
                os.remove(os.path.join(os.path.dirname(path), f))
            except Exception:
                pass
    return path


def load_lib(db_path):
    os.environ["LEDGER_DB_PATH"] = db_path
    import importlib
    import ledger_lib
    importlib.reload(ledger_lib)
    return ledger_lib


FAILS = []


def check(name, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")
    if not ok:
        FAILS.append(name)


def main():
    # 1. Unanswered real question -> BLOCK
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(hook_agent_id(), "8695313113", "1001", "mennyi 2+2?", "2026-08-02T22:00:00.000Z")
    d, _r, _ = run_hook(db)
    check("unanswered question blocks", d, "block")

    # 2. Same question, but answered via reply-tool (outbound logged) -> ALLOW
    lib.log_outbound(hook_agent_id(), "8695313113", "4")
    d, _r, _ = run_hook(db)
    check("answered question allows", d, None)

    # 3. Pure acknowledgement -> ALLOW (no reply owed)
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(hook_agent_id(), "8695313113", "1002", "köszi 👍", "2026-08-02T22:05:00.000Z")
    d, _r, _ = run_hook(db)
    check("ack allows", d, None)

    # 4. Stale (older than STALE_SECONDS) unanswered question -> ALLOW
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(hook_agent_id(), "8695313113", "1003", "regi kerdes", "2026-08-01T00:00:00.000Z")
    # backdate created_at directly
    con = lib.connect()
    con.execute("UPDATE conversation_log SET created_at=? WHERE message_id='1003'",
                (int(time.time()) - 4000,))
    con.commit(); con.close()
    d, _r, _ = run_hook(db)
    check("stale question allows", d, None)

    # 5. Max-block backstop: after MAX_BLOCKS blocks on the same id -> ALLOW
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(hook_agent_id(), "8695313113", "1004", "makacs kerdes", "2026-08-02T22:10:00.000Z")
    env = {"TG_GUARD_MAX_BLOCKS": "2"}
    d1, _r, _ = run_hook(db, extra_env=env)   # block 1
    d2, _r, _ = run_hook(db, extra_env=env)   # block 2
    d3, _r, _ = run_hook(db, extra_env=env)   # now over the cap -> allow
    check("maxblock #1 blocks", d1, "block")
    check("maxblock #2 blocks", d2, "block")
    check("maxblock #3 allows (backstop)", d3, None)

    # 6. No inbound at all (e.g. a heartbeat-only turn) -> ALLOW
    db = fresh_db()
    load_lib(db)
    d, _r, _ = run_hook(db)
    check("no inbound allows", d, None)

    # ---- PROVIDERVAK908: the directive must name the RIGHT channel's reply tool.
    # Measured 2026-09-07: a DISCORD inbound (the owner's DM) was answered with a demand for a TELEGRAM reply. The
    # decision was right, the instruction was undeliverable -- so asserting only
    # decision=="block" (as this file did) passes straight through the bug.
    TG_TOOL = "mcp__plugin_telegram_telegram__reply"
    DC_TOOL = "mcp__plugin_discord_discord__reply"

    # 7. Discord inbound -> names the Discord tool, and NOT the Telegram one.
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(hook_agent_id(), "900000000000000001", "2001", "ez mi is?",
                    "2026-09-07T07:02:03.110Z", source="plugin:discord:discord")
    d, r, _ = run_hook(db)
    check("discord inbound blocks", d, "block")
    check("discord names discord tool", DC_TOOL in r, True)
    check("discord does NOT name telegram tool", TG_TOOL in r, False)

    # 8. Telegram inbound -> unchanged behaviour, names the Telegram tool.
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(hook_agent_id(), "8695313113", "2002", "mi ujsag?",
                    "2026-09-07T07:02:03.110Z", source="plugin:telegram:telegram")
    d, r, _ = run_hook(db)
    check("telegram inbound blocks", d, "block")
    check("telegram names telegram tool", TG_TOOL in r, True)
    check("telegram does NOT name discord tool", DC_TOOL in r, False)

    # 9. Legacy row (source NULL, written before the column existed) -> still
    # blocks, but names NO tool at all. An invented tool name is worse than none.
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(hook_agent_id(), "8695313113", "2003", "regi sor, nincs source",
                    "2026-09-07T07:02:03.110Z")
    d, r, _ = run_hook(db)
    check("legacy row blocks", d, "block")
    check("legacy row names no tool", (TG_TOOL in r or DC_TOOL in r), False)
    check("legacy row still carries chat_id", "8695313113" in r, True)

    # 10. END-TO-END: the capture hook must actually RECORD the source. Without
    # this the three cases above test a column nothing ever populates.
    db = fresh_db()
    lib = load_lib(db)
    capture = os.path.join(HOOKS, "ledger-capture.py")
    envelope = (
        '<channel source="plugin:discord:discord" chat_id="900000000000000001" '
        'message_id="3001" user="stylnet" ts="2026-09-07T07:02:03.110Z">'
        "ez mi is?</channel>"
    )
    env = dict(os.environ)
    env["LEDGER_DB_PATH"] = db
    subprocess.run([sys.executable, capture],
                   input=json.dumps({"cwd": HOOK_CWD, "prompt": envelope}),
                   capture_output=True, text=True, env=env, timeout=20)
    con = lib.connect()
    row = con.execute("SELECT source, text FROM conversation_log"
                      " WHERE message_id='3001'").fetchone()
    con.close()
    check("capture records source", row[0] if row else None, "plugin:discord:discord")
    check("capture still records text", row[1] if row else None, "ez mi is?")
    check("capture -> guard names discord tool",
          DC_TOOL in run_hook(db)[1], True)

    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {FAILS}", file=sys.stderr)
        sys.exit(1)
    print("\nAll telegram-reply-guard tests passed.")


if __name__ == "__main__":
    main()
