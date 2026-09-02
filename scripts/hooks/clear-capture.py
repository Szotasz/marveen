#!/usr/bin/env python3
"""SessionEnd hook: save the thread a /clear is about to erase.

The SAVE half of the /clear path. A /clear does NOT fire PreCompact, so the
PreCompact agent-hook that writes the structured task-state never runs -- the
cleared session left no trace at all, not even on the context-restart gate's
own path, which sends /clear deliberately and then tells the fresh session to
read blocks that were never written.

Fires on reason=clear only. The other SessionEnd reasons (logout,
prompt_input_exit, resume, other) end a session that nothing is about to
restart in place, so there is no fresh session to hand anything to.

Deterministic: the record is extracted from the session transcript by plain
parsing -- no model turn (a SessionEnd hook has no time for one), no dashboard
dependency. Never breaks session teardown (always exit 0).

Its counterpart is clear-replay.py on SessionStart(source=clear).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clearstate_lib  # noqa: E402


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if not isinstance(payload, dict):
        sys.exit(0)

    if (payload.get("reason") or "") != "clear":
        sys.exit(0)

    agent = clearstate_lib.agent_id_from_cwd(payload.get("cwd"))
    if not agent:
        sys.exit(0)  # not one of our agents (the main hooks are user-global)

    transcript = payload.get("transcript_path") or ""
    turns = clearstate_lib.extract_turns(transcript)
    if not turns["prompts"] and not turns["lastReply"]:
        sys.exit(0)  # nothing worth carrying across

    try:
        clearstate_lib.write_record(agent, transcript, turns)
    except Exception:
        pass  # best effort: a failed save must not hold up the teardown

    sys.exit(0)


if __name__ == "__main__":
    main()
