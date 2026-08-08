#!/usr/bin/env python3
"""SessionStart hook: inject a deterministic 72-hour state POINTER digest
from daily_logs so a fresh/restarted session can locate recent decisions
without live memory lookups.

Design intent (Janos, 2026-08-08): the digest is a POINTER, not a summary.
Each entry becomes one navigable line -- enough to know "this happened and
here is where to find the full text" -- not a prose recap. The full entries
are always in the DB; this block surfaces WHICH entry to open.

Format:
  - Last 24h entries: "## HH:MM -- Topic [ts:<created_at>]"
    The [ts:N] anchor lets the caller retrieve the full entry:
      SELECT content FROM daily_logs WHERE agent_id='...' AND created_at=N
  - 24-72h entries: "## HH:MM -- Topic" (headline only, no anchor)
  - Secondary (if budget allows): pending approvals, recent task failures.

Drop order when over budget:
  1. Secondary items.
  2. 24-72h headlines from the oldest end.
  (The digest is ~1-2 KB; hitting the 8192 byte ceiling is highly unlikely.)

Byte-safe: all measurements use len(text.encode('utf-8')).
Fail-open: any exception -> exit 0, session is never blocked.
Settings.json wiring is a separate deployment step (not done here).
"""
import sys
import os
import json
import time
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# Hard byte limit on the final serialized hook payload (same rationale as
# ledger-replay.py: harness silently spills blocks > ~11.1 KB).
# Env override: DIGEST_BYTE_BUDGET.
DEFAULT_BYTE_BUDGET = 8192

WINDOW_HOURS = 72
RECENT_HOURS = 24

# Max rows fetched from DB -- guards against table growth on large installs.
DB_FETCH_LIMIT = 100


def _env_int(name, default):
    v = os.environ.get(name)
    if v:
        try:
            n = int(v)
            if n > 0:
                return n
        except ValueError:
            pass
    return default


def _byte_budget():
    return _env_int("DIGEST_BYTE_BUDGET", DEFAULT_BYTE_BUDGET)


def _payload_bytes(out):
    """Real UTF-8 byte size of the serialized payload -- what the harness
    measures. ensure_ascii=False keeps accented chars as multi-byte UTF-8."""
    return len(json.dumps(out, ensure_ascii=False).encode("utf-8"))


def _first_line(content):
    """First non-empty line of a daily_log entry (the ## HH:MM -- Topic headline)."""
    for line in (content or "").splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def _fetch_log_entries(agent_id):
    """Fetch daily_log entries within the 72h window, newest-first.
    Uses the (agent_id, date) index for efficient filtering.
    Returns list of (content, created_at).
    """
    cutoff_date = (
        datetime.datetime.now() - datetime.timedelta(hours=WINDOW_HOURS)
    ).strftime("%Y-%m-%d")
    con = ledger_lib.connect()
    try:
        return con.execute(
            "SELECT content, created_at FROM daily_logs"
            " WHERE agent_id=? AND date >= ?"
            " ORDER BY created_at DESC LIMIT ?",
            (str(agent_id), cutoff_date, DB_FETCH_LIMIT),
        ).fetchall()
    finally:
        con.close()


def _fetch_pending_approvals(agent_id):
    """Pending approvals for this agent. Returns list of one-line strings."""
    con = ledger_lib.connect()
    try:
        rows = con.execute(
            "SELECT category, action_description FROM approvals"
            " WHERE agent_id=? AND status='pending'"
            " ORDER BY requested_at DESC LIMIT 5",
            (str(agent_id),),
        ).fetchall()
        return [
            f"[JOVAHAGYAS VARHATO] {r[0]}: {str(r[1])[:120]}"
            for r in rows
        ]
    except Exception:
        return []
    finally:
        con.close()


def _fetch_task_failures(agent_id):
    """Failed task_runs for this agent in the last 72h."""
    cutoff = int(time.time()) - WINDOW_HOURS * 3600
    con = ledger_lib.connect()
    try:
        rows = con.execute(
            "SELECT name, ts FROM task_runs"
            " WHERE agent=? AND status='failed' AND ts >= ?"
            " ORDER BY ts DESC LIMIT 5",
            (str(agent_id), cutoff),
        ).fetchall()
        result = []
        for name, ts in rows:
            dt = datetime.datetime.utcfromtimestamp(ts).strftime("%m-%d %H:%M")
            result.append(f"[TASK HIBA] {name} ({dt} UTC)")
        return result
    except Exception:
        return []
    finally:
        con.close()


def _build_output(recent_pointers, older_headlines, secondary_lines):
    """Assemble the SessionStart hook payload.
    Frame leads so a harness preview still carries the intent.
    recent_pointers and older_headlines are newest-first lists.
    """
    parts = [
        "ALLAPOT-MUTATOK (utolso 72 ora napi naplo):\n"
        "Minden sor egy-egy tema-jelzo. Ha kell a teljes szoveg, kerj le a DB-bol:\n"
        "  SELECT content FROM daily_logs WHERE agent_id='<id>' AND created_at=<ts>"
    ]
    if recent_pointers:
        parts.append(
            "UTOLSO 24 ORA (fejlec + timestamp-horgony, legujabb elol):\n"
            + "\n".join(recent_pointers)
        )
    if older_headlines:
        parts.append(
            "24-72 ORA (csak fejlecek, legujabb elol):\n"
            + "\n".join(older_headlines)
        )
    if secondary_lines:
        parts.append(
            "MASODLAGOS ALLAPOT:\n"
            + "\n".join(secondary_lines)
        )
    return {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "\n\n".join(parts),
        }
    }


def _log_inject_marker(agent_id, byte_size, item_count):
    """Write a DIGEST_INJECT measurement marker to daily_logs.
    Failure is silently ignored -- must never block startup."""
    try:
        now = int(time.time())
        hhmm = datetime.datetime.fromtimestamp(now).strftime("%H:%M")
        today = datetime.datetime.fromtimestamp(now).strftime("%Y-%m-%d")
        content = f"## {hhmm} -- [DIGEST_INJECT] {byte_size} byte, {item_count} bejegyzes"
        con = ledger_lib.connect()
        try:
            con.execute(
                "INSERT INTO daily_logs (agent_id, date, content, created_at)"
                " VALUES (?, ?, ?, ?)",
                (str(agent_id), today, content, now),
            )
            con.commit()
        finally:
            con.close()
    except Exception:
        pass


def main():
    cwd = None
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd")
    except Exception:
        sys.exit(0)

    agent_id = ledger_lib.agent_id_from_cwd(cwd)

    try:
        rows = _fetch_log_entries(agent_id)
    except Exception:
        sys.exit(0)

    if not rows:
        sys.exit(0)

    now_ts = int(time.time())
    recent_cutoff = now_ts - RECENT_HOURS * 3600

    # Build pointer lines (newest-first).
    recent_pointers = []
    older_headlines = []
    for content, created_at in rows:
        headline = _first_line(content)
        if not headline:
            continue
        if created_at >= recent_cutoff:
            recent_pointers.append(f"{headline} [ts:{created_at}]")
        else:
            older_headlines.append(headline)

    if not recent_pointers and not older_headlines:
        sys.exit(0)

    secondary = _fetch_pending_approvals(agent_id) + _fetch_task_failures(agent_id)

    budget = _byte_budget()
    out = _build_output(recent_pointers, older_headlines, secondary)

    # Drop secondary first (pop from tail = oldest entry).
    while secondary and _payload_bytes(out) > budget:
        secondary.pop()
        out = _build_output(recent_pointers, older_headlines, secondary)

    # Drop oldest 24-72h headlines.
    while older_headlines and _payload_bytes(out) > budget:
        older_headlines.pop()
        out = _build_output(recent_pointers, older_headlines, secondary)

    # Recent pointers are ~60-80 bytes each; breaching budget here requires
    # an extreme number of same-day entries, but handle it gracefully.
    while len(recent_pointers) > 1 and _payload_bytes(out) > budget:
        recent_pointers.pop()
        out = _build_output(recent_pointers, older_headlines, secondary)

    final_bytes = _payload_bytes(out)
    item_count = len(recent_pointers) + len(older_headlines)

    _log_inject_marker(agent_id, final_bytes, item_count)

    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
