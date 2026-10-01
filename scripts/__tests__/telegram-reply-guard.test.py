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


import contextlib
import importlib.util


def load_guard():
    """Import the hook as a module, so its helpers can be called directly."""
    spec = importlib.util.spec_from_file_location("guard_mod", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@contextlib.contextmanager
def env_patch(vars, install_dir=None):
    """Set/clear env vars (and optionally the install dir) for one block."""
    import ledger_lib
    regi = {k: os.environ.get(k) for k in vars}
    regi_dir = getattr(ledger_lib, "_install_dir", None)
    for k, v in vars.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    if install_dir is not None:
        ledger_lib._install_dir = lambda *_a, **_k: install_dir
    try:
        yield
    finally:
        for k, v in regi.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if install_dir is not None and regi_dir is not None:
            ledger_lib._install_dir = regi_dir


# The identity the rows are ledgered under AND the identity the hook resolves.
# They used to be two different things: the rows said "marveen", while the hook
# took its id from the install -- MAIN_AGENT_ID in <install>/.env, "marveen" only
# as the fallback. On any install whose main agent has another name the hook
# looked under that name, found no open question, and every case returned
# got=None: the allow cases went green for the wrong reason and the suite could
# not tell a working guard from a dead one. MARVEEN_AGENT_ID is the explicit
# override agent_id_from_payload honours before the cwd, so pinning it here
# makes the result independent of the host.
AGENT = "tgguard-test"


def run_hook(db_path, cwd=None, extra_env=None):
    env = dict(os.environ)
    env["LEDGER_DB_PATH"] = db_path
    env["MARVEEN_AGENT_ID"] = AGENT
    if extra_env:
        env.update(extra_env)
    p = subprocess.run(
        [sys.executable, HOOK],
        input=json.dumps({"cwd": cwd or os.path.dirname(db_path), "stop_hook_active": False}),
        capture_output=True, text=True, env=env, timeout=20,
    )
    out = p.stdout.strip()
    decision = None
    if out:
        try:
            decision = json.loads(out).get("decision")
        except Exception:
            decision = "PARSE_ERROR:" + out
    # An allow is "exit 0, no output". A hook that crashes before deciding
    # looks the same on stdout, so the run must also be clean.
    if p.returncode != 0 or p.stderr.strip():
        decision = f"UNCLEAN(rc={p.returncode}):{p.stderr.strip()[-200:]}"
    return decision, p.returncode


# Kept alive for the whole run; TemporaryDirectory removes each one when the
# interpreter finalises it.
_TMPDIRS = []


def fresh_db():
    # Each DB gets its own directory. The hook keeps its per-agent statefile
    # NEXT TO the DB (_statefile: dirname(db_path())/.tg-reply-guard-<agent>),
    # and AGENT is a constant, so a DB made straight in the shared tmpdir put
    # every concurrent run of this suite on the same statefile -- and the old
    # "clear stale statefiles" sweep here deleted the other runs' state
    # mid-case. A private directory makes the statefile private too, starts
    # every case clean without touching anyone else's files, and needs no
    # sweep at all.
    d = tempfile.TemporaryDirectory(prefix="tgguard-")
    _TMPDIRS.append(d)
    return os.path.join(d.name, "ledger.db")


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
    lib.log_inbound(AGENT, "8695313113", "1001", "mennyi 2+2?", "2026-08-02T22:00:00.000Z")
    d, _ = run_hook(db)
    check("unanswered question blocks", d, "block")

    # 2. Same question, but answered via reply-tool (outbound logged) -> ALLOW
    lib.log_outbound(AGENT, "8695313113", "4")
    d, _ = run_hook(db)
    check("answered question allows", d, None)

    # 3. Pure acknowledgement -> ALLOW (no reply owed)
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(AGENT, "8695313113", "1002", "köszi 👍", "2026-08-02T22:05:00.000Z")
    d, _ = run_hook(db)
    check("ack allows", d, None)
    # Liveness control: the same DB with a real question after the ack must
    # block. Without it "ack allows" is also what a hook that never finds
    # anything would return.
    lib.log_inbound(AGENT, "8695313113", "1012", "és mikor?", "2026-08-02T22:06:00.000Z")
    d, _ = run_hook(db)
    check("ack control: a later question on the same DB blocks", d, "block")

    # 4. Stale (older than STALE_SECONDS) unanswered question -> ALLOW
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(AGENT, "8695313113", "1003", "regi kerdes", "2026-08-01T00:00:00.000Z")
    # backdate created_at directly
    con = lib.connect()
    con.execute("UPDATE conversation_log SET created_at=? WHERE message_id='1003'",
                (int(time.time()) - 4000,))
    con.commit(); con.close()
    d, _ = run_hook(db)
    check("stale question allows", d, None)
    # Control: the same row with a staleness window wider than its age must
    # block, so it is the age that allowed it, not a hook that saw nothing.
    d, _ = run_hook(db, extra_env={"TG_GUARD_STALE_SECONDS": "86400"})
    check("stale control: same row inside the window blocks", d, "block")

    # 5. Max-block backstop: after MAX_BLOCKS blocks on the same id -> ALLOW
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound(AGENT, "8695313113", "1004", "makacs kerdes", "2026-08-02T22:10:00.000Z")
    env = {"TG_GUARD_MAX_BLOCKS": "2"}
    d1, _ = run_hook(db, extra_env=env)   # block 1
    d2, _ = run_hook(db, extra_env=env)   # block 2
    d3, _ = run_hook(db, extra_env=env)   # now over the cap -> allow
    check("maxblock #1 blocks", d1, "block")
    check("maxblock #2 blocks", d2, "block")
    check("maxblock #3 allows (backstop)", d3, None)

    # 6. No inbound at all (e.g. a heartbeat-only turn) -> ALLOW
    db = fresh_db()
    lib = load_lib(db)
    d, _ = run_hook(db)
    check("no inbound allows", d, None)
    lib.log_inbound(AGENT, "8695313113", "1006", "most mar van kerdes?", "2026-08-02T22:20:00.000Z")
    d, _ = run_hook(db)
    check("no-inbound control: once a question arrives it blocks", d, "block")

    # 6b. Rows ledgered under ANOTHER agent must not make this one block. This
    #     is the other half of the identity pin: the hook reads its own rows.
    db = fresh_db()
    lib = load_lib(db)
    lib.log_inbound("some-other-agent", "8695313113", "1007", "kinek szol ez?", "2026-08-02T22:25:00.000Z")
    d, _ = run_hook(db)
    check("another agent's open question does not block this one", d, None)
    d, _ = run_hook(db, extra_env={"MARVEEN_AGENT_ID": "some-other-agent"})
    check("... but blocks the agent it belongs to", d, "block")

    # 7. Provider resolution and the reply-tool name it produces.
    #    A table test, because the two halves of the tool name differ per
    #    provider: mcp__plugin_<plugin directory>_<MCP server>__reply. Slack is
    #    the case that motivated it -- the plugin directory is `slack-channel`
    #    while the MCP server is `slack`, so deriving the name from the provider
    #    alone produced a tool that does not exist in any session.
    guard = load_guard()

    # 7a. CHANNEL_PROVIDER in the environment wins over everything.
    for provider, vart_tool in [
        ("telegram", "mcp__plugin_telegram_telegram__reply"),
        ("discord", "mcp__plugin_discord_discord__reply"),
        ("slack", "mcp__plugin_slack-channel_slack__reply"),
        ("SLACK", "mcp__plugin_slack-channel_slack__reply"),  # case-folded
    ]:
        with env_patch({"CHANNEL_PROVIDER": provider}):
            tool, nev = guard._reply_tool_name()
        check(f"env {provider} -> tool", tool, vart_tool)
        check(f"env {provider} -> name", nev, provider.lower())

    # 7b. A provider we know of but whose real tool name is unverified must NOT
    #     get an invented name. A wrong name is worse than none: the model cannot
    #     comply with a directive naming a tool absent from its session, which is
    #     the exact failure this guard exists to remove.
    #     (An EMPTY CHANNEL_PROVIDER is not this case: it is falsy, so resolution
    #     correctly falls through to .env and the project settings. 7d covers it.)
    for provider in ("teams", "googlechat", "whatsapp"):
        with env_patch({"CHANNEL_PROVIDER": provider}):
            tool, _ = guard._reply_tool_name()
        check(f"unverified {provider} -> generic wording",
              tool, "a csatorna reply tool")

    # 7c. With no environment value, the install .env is consulted, then the
    #     project settings. Both are exercised through a temporary install dir.
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, ".env"), "w") as f:
            f.write("CHANNEL_PROVIDER=discord\n")
        with env_patch({"CHANNEL_PROVIDER": None}, install_dir=d):
            tool, _ = guard._reply_tool_name()
        check(".env discord -> tool", tool, "mcp__plugin_discord_discord__reply")

    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".claude"))
        with open(os.path.join(d, ".claude", "settings.json"), "w") as f:
            json.dump({"enabledPlugins": {"slack-channel@marveen-marketplace": True}}, f)
        with env_patch({"CHANNEL_PROVIDER": None, "CLAUDE_PROJECT_DIR": d}, install_dir=d):
            tool, _ = guard._reply_tool_name()
        check("settings slack-channel -> slack tool", tool,
              "mcp__plugin_slack-channel_slack__reply")

    # 7d. Nothing configured anywhere: no tool is named, and the guard still
    #     fires. The PR text once claimed telegram was the fallback; it is not.
    with tempfile.TemporaryDirectory() as d:
        with env_patch({"CHANNEL_PROVIDER": None, "CLAUDE_PROJECT_DIR": d}, install_dir=d):
            tool, nev = guard._reply_tool_name()
        check("nothing configured -> generic wording", tool, "a csatorna reply tool")
        check("nothing configured -> generic name", nev, "csatorna")

    # 8. Fixture isolation: the hook's statefile sits beside the DB, so every
    #    DB must live in a directory of its own, and making a new one must not
    #    touch the statefile of another DB (a concurrent run of this suite).
    a, b = fresh_db(), fresh_db()
    check("fresh_db: private dir, not the shared tmpdir",
          os.path.dirname(a) != tempfile.gettempdir(), True)
    check("fresh_db: each DB its own dir",
          os.path.dirname(a) != os.path.dirname(b), True)
    other = os.path.join(os.path.dirname(a), f".tg-reply-guard-{AGENT}")
    with open(other, "w") as f:
        f.write("{}")
    fresh_db()
    check("fresh_db: leaves another DB's statefile alone", os.path.exists(other), True)

    # 7. A reply SENT between an inbound's arrival and its (later) ledger write
    #    -> ALLOW. Replays 2026-09-11: "hahó" arrived 08:40:21Z, the reply went
    #    out 08:41:19Z, the inbound row was only written at 08:41:20Z.
    now = int(time.time())
    db = fresh_db()
    lib = load_lib(db)
    lib.log_outbound("marveen", "8695313113", "itt vagyok")
    lib.log_inbound("marveen", "8695313113", "1184", "hahó",
                    time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now - 60)))
    con = lib.connect()
    con.execute("UPDATE conversation_log SET created_at=? WHERE direction='out'", (now - 2,))
    con.commit(); con.close()
    d, _ = run_hook(db)
    check("reply sent before the inbound was logged allows", d, None)

    # 8. A question that ARRIVED after the last reply is still open -> BLOCK.
    db = fresh_db()
    lib = load_lib(db)
    lib.log_outbound("marveen", "8695313113", "korabbi valasz")
    con = lib.connect()
    con.execute("UPDATE conversation_log SET created_at=? WHERE direction='out'", (now - 120,))
    con.commit(); con.close()
    lib.log_inbound("marveen", "8695313113", "1190", "uj kerdes?",
                    time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now - 60)))
    d, _ = run_hook(db)
    check("question arriving after the last reply blocks", d, "block")

    if FAILS:
        print(f"\n{len(FAILS)} FAILED: {FAILS}", file=sys.stderr)
        sys.exit(1)
    print("\nAll telegram-reply-guard tests passed.")


if __name__ == "__main__":
    main()
