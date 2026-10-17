#!/usr/bin/env python3
"""StopFailure hook: leave a trace when a turn that owed a channel reply died on an
API error.

Why: the ledger records that a message ARRIVED (ledger-capture.py) and that a reply
WENT OUT (ledger-outbound.py), but nothing recorded a turn that ENDED IN AN ERROR.
Measured 2026-09-22: a Telegram message arrived, the very next assistant turn
answered "Prompt is too long", and nothing on the channel side showed it -- the
loss was found only by reading the transcript back by hand. Claude Code fires
StopFailure INSTEAD of Stop on such a turn, so the Stop-side reply guard never ran
either.

What it does: if the agent's newest inbound has no later reply (the same "open
question" the reply guard and the live drain use), it appends one JSON line to
<store>/ledger-turn-failures.jsonl: when, agent, chat, message_id, error,
error_details. A failure with no open inbound is not recorded: this ledger is
about messages that were not answered, not about every API error.

Outside the broken session: with LEDGER_TURN_FAILURE_NOTIFY=1 (environment, or a
line in <install>/.env) it also runs scripts/notify.sh ONCE per message, because
the session that failed is the one place a re-surfaced message may fail again.
Off by default.

StopFailure is fire-and-forget: the output is ignored, and this hook always exits 0.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

FAILURES_FILE = "ledger-turn-failures.jsonl"
DETAIL_CHARS = 500


def failures_path():
    # Next to the ledger DB, so a test's LEDGER_DB_PATH isolates this file too.
    return os.path.join(os.path.dirname(ledger_lib.db_path()), FAILURES_FILE)


def notify_enabled():
    env = os.environ.get("LEDGER_TURN_FAILURE_NOTIFY")
    if env is not None:  # the environment, when set, decides alone
        return env.strip() == "1"
    try:
        with open(os.path.join(ledger_lib._install_dir(), ".env")) as f:
            return any(line.strip() == "LEDGER_TURN_FAILURE_NOTIFY=1" for line in f)
    except OSError:
        return False


def already_recorded(path, agent_id, chat_id, message_id):
    try:
        with open(path) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if (r.get("agent_id"), r.get("chat_id"), r.get("message_id")) == (
                        agent_id, chat_id, message_id):
                    return True
    except OSError:
        pass
    return False


def notify(agent_id, message_id, error):
    cmd = os.environ.get("LEDGER_TURN_FAILURE_NOTIFY_CMD") or os.path.join(
        ledger_lib._install_dir(), "scripts", "notify.sh")
    text = (f"{agent_id}: a(z) {message_id} azonositoju uzenet feldolgozasa hibaval "
            f"megszakadt ({error}). Nem kapott valaszt; kuldd el ujra.")
    try:
        subprocess.run(["bash", cmd, text], timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    agent_id = ledger_lib.agent_id_from_payload(payload)
    if not agent_id:
        return
    oq = ledger_lib.open_question_with_age(agent_id)
    if not oq:
        return  # nothing owed a reply, or it was already answered
    chat_id, message_id = oq[:2]
    error = str(payload.get("error") or "unknown")
    path = failures_path()
    first = not already_recorded(path, agent_id, chat_id, message_id)
    row = {
        "at": int(time.time()),
        "agent_id": agent_id,
        "chat_id": chat_id,
        "message_id": message_id,
        "error": error,
        "error_details": str(payload.get("error_details") or "")[:DETAIL_CHARS],
    }
    with open(path, "a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    if first and notify_enabled():
        notify(agent_id, message_id, error)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
