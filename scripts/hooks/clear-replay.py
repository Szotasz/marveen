#!/usr/bin/env python3
"""SessionStart hook: hand the cleared thread to the fresh session.

The RESTORE half of the /clear path, reading what clear-capture.py wrote at
SessionEnd(reason=clear). Fires on source=clear only -- the compact / resume /
startup sources have their own replay (taskstate-replay.py) and must not get a
second, older block on top of it.

Ordering (deliberate, mirrors taskstate-replay): read -> inject(print) -> drop.
Dying before the print leaves the record on disk, so the next start still
catches it.

Never breaks session start (always exit 0).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clearstate_lib  # noqa: E402
import ledger_lib  # noqa: E402


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if not isinstance(payload, dict):
        sys.exit(0)

    if (payload.get("source") or "") != "clear":
        sys.exit(0)

    agent = clearstate_lib.agent_id_from_cwd(payload.get("cwd"))
    if not agent:
        sys.exit(0)

    record = clearstate_lib.read_record(agent)
    if not clearstate_lib.is_replayable(record):
        sys.exit(0)

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": clearstate_lib.build_injection(
                record, ledger_lib.owner_name()),
        }
    }, ensure_ascii=False))
    sys.stdout.flush()

    # Single-replay guard: only AFTER a successful print.
    clearstate_lib.drop_record(agent)
    sys.exit(0)


if __name__ == "__main__":
    main()
