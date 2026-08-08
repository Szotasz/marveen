#!/usr/bin/env python3
"""PreToolUse hook (matcher: the Telegram reply tool): stop a second morning briefing.

The briefing reached Viktor twice on 2026-08-02, 08-07 and 08-08. The sender-side
claim (telegram_fallback_send.py --once-per-day) closes the fallback path, but the
third incident went out through the reply TOOL from a stale session that never ran
the prompt-side guard. This hook covers that path.

Recognising the briefing without guessing
-----------------------------------------
The morning message carries an INVISIBLE SEPARATOR (U+2063) as its last character.
Viktor never sees it and cannot type it, which is what makes this different from
the two alternatives that were considered and rejected:

  - blocking every reply in the 07:25-07:40 window would also block Viktor's own
    07:35 message, and a guard that silences an answer to the user is worse than
    the duplicate it prevents;
  - a length threshold would be a heuristic, and a long ordinary reply would
    eventually trip it.

So the rule is narrow and mechanical: inside the window, a message that carries
the sentinel AND a day-marker that already exists means the briefing has been
sent -> deny. No sentinel means it is not the briefing -> allow, always.

Fail-open on purpose
--------------------
Any error here allows the call. This hook can block a message to the user, and a
crash in a guard must not be able to silence the agent; the failure it prevents
(a duplicate briefing) is the milder one. That is the opposite choice from the
sender-side claim, and deliberately so: there, refusing costs nothing but a retry.
"""
import json
import os
import sys
from datetime import datetime, time

# U+2063 INVISIBLE SEPARATOR. Placed by the morning task as the message's last
# character; invisible in every Telegram client and absent from ordinary typing.
SENTINEL = "⁣"

WINDOW_START = time(7, 25)
WINDOW_END = time(7, 40)

MARKER_PREFIX = "morning-sent"


def marker_dir():
    env = os.environ.get("MORNING_MARKER_DIR")
    if env:
        return env
    return os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "store",
    )


def in_window(now):
    return WINDOW_START <= now.time() <= WINDOW_END


def marker_exists(now, mdir=None):
    path = os.path.join(mdir or marker_dir(), f"{MARKER_PREFIX}-{now.date().isoformat()}")
    return os.path.exists(path), path


def decide(payload, now, mdir=None):
    """
    Returns (allow: bool, reason: str).

    Pure, so every branch is testable without a hook harness or a clock.
    """
    tool = payload.get("tool_name") or ""
    if "telegram" not in tool or "reply" not in tool:
        return True, "not the telegram reply tool"

    text = (payload.get("tool_input") or {}).get("text")
    if not isinstance(text, str) or SENTINEL not in text:
        # Viktor's own conversation, or any other reply. Never blocked.
        return True, "no morning sentinel in the message"

    if not in_window(now):
        # The sentinel outside the window is not a duplicate briefing; it is
        # something else carrying the mark, and guessing would be overreach.
        return True, "outside the morning window"

    exists, path = marker_exists(now, mdir)
    if exists:
        return False, (
            "A mai napindito mar kiment (marker: " + path + "). Ez egy MASODIK "
            "napindito lenne ugyanarra a napra -- a hook blokkolta. Ha a mai "
            "uzenet tenyleg nem ment ki, torold a markert es probald ujra."
        )
    return True, "first briefing of the day"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        # Unreadable payload: allow. See the fail-open note above.
        sys.exit(0)

    try:
        allow, reason = decide(payload, datetime.now())
    except Exception:
        sys.exit(0)

    if allow:
        sys.exit(0)

    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
