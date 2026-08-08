#!/usr/bin/env python3
"""PostToolUse hook (matcher: the Telegram reply tool): record that today's briefing went out.

The other half of the duplicate guard. morning-duplicate-guard.py refuses a
second briefing when the day's marker exists -- but on 2026-08-08 the FIRST
briefing went out through the reply tool from a session that never wrote a
marker, so the guard had nothing to read and a second message would still have
passed.

This closes that: the marker is written by the mechanism that saw the send
succeed, not by the prompt that was supposed to remember. The two paths then
share one fact -- telegram_fallback_send.py --once-per-day writes the same file
before sending, this writes it after -- so whichever path delivers, the day is
marked.

Why after success and not before
--------------------------------
Claiming the day before the send would take the day's briefing away whenever
the reply tool failed afterwards -- and a mid-turn MCP drop is exactly the
failure the fallback sender exists for. Marking only a delivered message means
the worst case here is a duplicate that the OTHER guard still catches, rather
than a morning with no briefing at all.

No window check, deliberately: only the morning task adds the sentinel, so a
sentinel-bearing message IS the briefing whenever it goes out. The window
matters on the blocking side, where a wrong decision would silence the user.
"""
import json
import os
import sys
from datetime import date

# U+2063 INVISIBLE SEPARATOR -- the same mark morning-duplicate-guard.py reads.
SENTINEL = "⁣"

MARKER_PREFIX = "morning-sent"


def marker_dir():
    env = os.environ.get("MORNING_MARKER_DIR")
    if env:
        return env
    return os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "store",
    )


def marker_path(day=None, mdir=None):
    """Same name the sender and the task use -- one fact, one file."""
    day = day or date.today().isoformat()
    return os.path.join(mdir or marker_dir(), f"{MARKER_PREFIX}-{day}")


def succeeded(payload):
    """
    Did the reply actually go out?

    An errored tool call must not mark the day: that is the case where the
    agent still has to reach the user, and a marker would stop it.
    """
    response = payload.get("tool_response")
    if isinstance(response, dict) and response.get("is_error"):
        return False
    return True


def should_mark(payload):
    tool = payload.get("tool_name") or ""
    if "telegram" not in tool or "reply" not in tool:
        return False
    text = (payload.get("tool_input") or {}).get("text")
    if not isinstance(text, str) or SENTINEL not in text:
        return False
    return succeeded(payload)


def mark(path, note=""):
    """
    Write the marker if it is not already there.

    Never overwrites: the file may have been written by the sender-side claim,
    and that record (which message id went out) is the more useful one.
    Returns True when this call created it.
    """
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return False
    except OSError:
        return False
    with os.fdopen(fd, "w") as fh:
        fh.write(f"sent via reply tool{(' ' + note) if note else ''}\n")
    return True


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    try:
        if should_mark(payload):
            chat = (payload.get("tool_input") or {}).get("chat_id")
            mark(marker_path(), note=f"chat={chat}")
    except Exception:
        # A PostToolUse hook runs after the message is already delivered; the
        # only thing an exception here could achieve is noise in the transcript.
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
