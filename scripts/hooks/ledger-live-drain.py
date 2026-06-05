#!/usr/bin/env python3
"""Live-session open-question drain (heartbeat-driven, NOT a Claude Code hook).

The SessionStart replay (ledger-replay.py) only re-surfaces the open question on
a *respawn*. But a message can be lost in an ALREADY-RUNNING session (a
mid-session channel-deafness gap): ledger-capture.py still records it in
conversation_log, yet the running session never sees it until the next respawn.

This drain runs every ~2 min in the live session (scheduled task
ledger-live-drain) and re-surfaces the still-unanswered inbound so the running
agent answers it WITHOUT waiting for a respawn.

Deterministic + safe:
- GRACE: only surface an open question older than NOW-60s, so we never fight an
  in-flight reply the agent is composing right this moment.
- DEDUP: a statefile next to the ledger DB holds the last surfaced message_id;
  re-surfacing the same id is suppressed (backstop for the surface->reply window,
  so a single missed question is surfaced ONCE, not every tick).
- Never blocks: ANY error -> exit 0, silent (a drain failure must never wedge the
  session or emit noise).

agent_id is derived from the process cwd (generic across channel agents), so the
drain only ever surfaces THIS agent's own open question. When it surfaces one it
writes exactly this block to stdout:

    OPEN_QUESTION chat_id=<id> message_id=<id>
    <text>
"""
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

GRACE_SECONDS = 60


def _statefile(agent_id):
    """Last-surfaced-id marker, kept beside the ledger DB so it is isolated in
    tests (LEDGER_DB_PATH override) and lands in store/ in production."""
    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in str(agent_id))
    return os.path.join(os.path.dirname(ledger_lib.db_path()), f".ledger-drain-{safe}")


def _last_surfaced(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return ""


def _record_surfaced(path, message_id):
    try:
        with open(path, "w") as f:
            f.write(str(message_id))
    except Exception:
        pass


def main():
    agent_id = ledger_lib.agent_id_from_cwd(os.getcwd())

    try:
        oq = ledger_lib.open_question_with_age(agent_id)
    except Exception:
        sys.exit(0)  # ledger unavailable -> silent no-op
    if not oq:
        sys.exit(0)  # nothing open (none, or already answered)
    chat_id, message_id, text, ts, created_at = oq

    # GRACE: skip a fresh inbound the agent may be answering right now.
    try:
        if created_at is None or (int(time.time()) - int(created_at)) < GRACE_SECONDS:
            sys.exit(0)
    except Exception:
        sys.exit(0)

    # DEDUP: surface a given message_id at most once.
    path = _statefile(agent_id)
    if _last_surfaced(path) == str(message_id):
        sys.exit(0)

    snippet = (text or "").strip()
    sys.stdout.write(f"OPEN_QUESTION chat_id={chat_id} message_id={message_id}\n{snippet}\n")
    _record_surfaced(path, message_id)
    sys.exit(0)


if __name__ == "__main__":
    main()
