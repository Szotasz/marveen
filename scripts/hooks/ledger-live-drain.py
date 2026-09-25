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
import channel_scope  # noqa: E402

GRACE_SECONDS = 60

# BUSY GATE (INBOXBUSY924). Measured 2026-09-23..24 on the main agent: all 9
# "[Inbox] ... valasz nelkul maradt" wake-ups fired 1-2 min after the inbound,
# while the session was still MID-TURN on that very message, and the reply went
# out 1-10 min later (e.g. in 3108 12:34:29, nudge 12:36:03, reply 12:45:04).
# The question was never lost: the capture hook only logs what the session
# already received. An open question during a running turn is simply being
# worked on. So: skip while the agent's pane shows a live turn, and let a later
# idle tick surface it if the turn really ended without a reply. Fail OPEN: if
# the pane cannot be read, behave as before (a missed wake-up costs more than a
# spurious one).
BUSY_FOOTER_LINES = 8


def _pane_text(agent_id):
    override = os.environ.get("LEDGER_DRAIN_PANE_FILE")
    if override:
        try:
            with open(override) as f:
                return f.read()
        except Exception:
            return ""
    main = ledger_lib.main_agent_id()
    session = f"{main}-channels" if agent_id == main else f"agent-{agent_id}"
    try:
        import subprocess
        out = subprocess.run(["tmux", "capture-pane", "-p", "-t", session],
                             capture_output=True, text=True, timeout=5)
        return out.stdout if out.returncode == 0 else ""
    except Exception:
        return ""


def _session_busy(agent_id):
    lines = [l for l in _pane_text(agent_id).splitlines() if l.strip()]
    return any("esc to interrupt" in l for l in lines[-BUSY_FOOTER_LINES:])


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

    # A group message the agent was not addressed in owes no reply, so there is
    # nothing to drain: surfacing it would ask for the group post the standing
    # rule forbids. Same test as the Stop guard and the prompt directive.
    if not channel_scope.reply_owed(chat_id, text, agent_id):
        sys.exit(0)

    # GRACE: skip a fresh inbound the agent may be answering right now.
    try:
        if created_at is None or (int(time.time()) - int(created_at)) < GRACE_SECONDS:
            nothing()
    except Exception:
        nothing()

    # BUSY: the agent is mid-turn, most likely on this very message.
    if _session_busy(agent_id):
        nothing()

    # DEDUP: surface a given message_id at most once.
    path = _statefile(agent_id)
    if _last_surfaced(path) == str(message_id):
        nothing()
    if precheck:
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
