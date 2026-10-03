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

With --precheck (the task's scheduler preCheck, via ledger-live-drain-precheck.sh)
it prints "SKIP" when the drain would surface nothing and nothing at all when it
would, and never writes the statefile. An idle install then spends no model turn
on the ~720 empty ticks a day.
"""
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

GRACE_SECONDS = 60
MAX_FAST_ATTEMPTS = 5      # 2-min-cadence fires allowed before backing off
BACKOFF_SECONDS = 1800     # after that, at most one fire per 30 min


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


def _attemptfile(agent_id):
    """Consecutive-fire budget for ONE open message_id, beside the dedup marker."""
    return _statefile(agent_id) + "-attempts"


def _read_attempts(path):
    """-> (message_id, count, last_ts); ("", 0, 0) when absent or unreadable."""
    try:
        with open(path) as f:
            mid, count, last = f.read().strip().split(None, 2)
        return mid, int(count), int(last)
    except Exception:
        return "", 0, 0


def _write_attempts(path, message_id, count, last_ts):
    try:
        with open(path, "w") as f:
            f.write(f"{message_id} {count} {last_ts}")
    except Exception:
        pass


def main():
    # --precheck: the scheduler asks "is there anything to surface?" BEFORE it
    # spends a model turn (runPreCheck contract: "SKIP" = no turn). It answers
    # with exactly the same rules as a real drain but never records anything,
    # because the scheduler's busy gate runs after it and may still drop the
    # tick; a question marked surfaced here would then be deduplicated away.
    precheck = "--precheck" in sys.argv[1:]

    def nothing():
        if precheck:
            sys.stdout.write("SKIP\n")
        sys.exit(0)

    agent_id = ledger_lib.agent_id_from_cwd(os.getcwd())

    try:
        oq = ledger_lib.open_question_with_age(agent_id)
    except Exception:
        nothing()  # ledger unavailable -> silent no-op
    if not oq:
        nothing()  # nothing open (none, or already answered)
    # Prefix-slice on purpose (HOOKARITAS821): this unpack sits outside the
    # try above, so a widened open_question_with_age() tuple would kill the
    # hook with a ValueError -- and a dead drain hook fails OPEN: the unanswered
    # question is simply never surfaced. The reply guard died exactly this way
    # for ten days (#1028).
    chat_id, message_id, text, ts, created_at, att_kind, att_file_id = oq[:7]

    # GRACE: skip a fresh inbound the agent may be answering right now.
    try:
        if created_at is None or (int(time.time()) - int(created_at)) < GRACE_SECONDS:
            nothing()
    except Exception:
        nothing()

    # DEDUP: surface a given message_id at most once.
    path = _statefile(agent_id)
    if _last_surfaced(path) == str(message_id):
        nothing()
    if precheck:
        # THROTTLE (2026-09-20, measured): DEDUP above is recorded by the MODEL
        # TURN, so a turn that never completes -- an API usage limit, a crashed
        # session -- leaves the question open and this preCheck fires again two
        # minutes later, forever. Measured on this install: 502 fires over the
        # 18 hours the account was usage-limited, for two unanswered questions,
        # each one an API call that could not possibly succeed.
        # Fire at full cadence a few times (a transient blip deserves that), then
        # back off, so an outage costs ~2 fires an hour instead of 30. Nothing is
        # lost by capping: a question throttled here is still re-surfaced by
        # ledger-replay.py on the next respawn.
        apath = _attemptfile(agent_id)
        seen, count, last = _read_attempts(apath)
        now = int(time.time())
        if seen != str(message_id):
            count, last = 0, 0  # a different question -> fresh budget
        if count >= MAX_FAST_ATTEMPTS and (now - last) < BACKOFF_SECONDS:
            _write_attempts(apath, message_id, count, last)
            nothing()
        _write_attempts(apath, message_id, count + 1, now)
        sys.exit(0)  # something to surface: empty stdout lets the turn run

    snippet = (text or "").strip()
    if att_file_id:
        snippet += (
            f'\n[Ez egy {att_kind or "voice"} csatolmány átirat nélkül: töltsd le '
            f'és írasd át (voice-message-transcribe skill, '
            f'attachment_file_id="{att_file_id}") mielőtt válaszolsz.]'
        )
    sys.stdout.write(f"OPEN_QUESTION chat_id={chat_id} message_id={message_id}\n{snippet}\n")
    _record_surfaced(path, message_id)
    sys.exit(0)


if __name__ == "__main__":
    main()
