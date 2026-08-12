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


def run_hook(db_path, cwd="/Users/edgar/marveen", extra_env=None):
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
    decision = None
    if out:
        try:
            decision = json.loads(out).get("decision")
        except Exception:
            decision = "PARSE_ERROR:" + out
    return decision, p.returncode


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
    lib.log_inbound("marveen", "8695313113", "1001", "mennyi 2+2?", "2026-08-02T22:00:00.000Z")
    d, _ = run_hook(db)
    check("unanswered question blocks", d, "block")

    # 2. Same question, but answered via reply-tool (outbound logged) -> ALLOW
    lib.log_outbound("marveen", "8695313113", "4")
    d, _ = run_hook(db)
    check("answered question allows", d, None)

    # 3. Pure acknowledgement -> ALLOW (no reply owed)
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound("marveen", "8695313113", "1002", "köszi 👍", "2026-08-02T22:05:00.000Z")
    d, _ = run_hook(db)
    check("ack allows", d, None)

    # 4. Stale (older than STALE_SECONDS) unanswered question -> ALLOW
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound("marveen", "8695313113", "1003", "regi kerdes", "2026-08-01T00:00:00.000Z")
    # backdate created_at directly
    con = lib.connect()
    con.execute("UPDATE conversation_log SET created_at=? WHERE message_id='1003'",
                (int(time.time()) - 4000,))
    con.commit(); con.close()
    d, _ = run_hook(db)
    check("stale question allows", d, None)

    # 5. Max-block backstop: after MAX_BLOCKS blocks on the same id -> ALLOW
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound("marveen", "8695313113", "1004", "makacs kerdes", "2026-08-02T22:10:00.000Z")
    env = {"TG_GUARD_MAX_BLOCKS": "2"}
    d1, _ = run_hook(db, extra_env=env)   # block 1
    d2, _ = run_hook(db, extra_env=env)   # block 2
    d3, _ = run_hook(db, extra_env=env)   # now over the cap -> allow
    check("maxblock #1 blocks", d1, "block")
    check("maxblock #2 blocks", d2, "block")
    check("maxblock #3 allows (backstop)", d3, None)

    # 6. No inbound at all (e.g. a heartbeat-only turn) -> ALLOW
    db = fresh_db()
    load_lib(db)
    d, _ = run_hook(db)
    check("no inbound allows", d, None)

    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {FAILS}", file=sys.stderr)
        sys.exit(1)
    print("\nAll telegram-reply-guard tests passed.")


if __name__ == "__main__":
    main()
