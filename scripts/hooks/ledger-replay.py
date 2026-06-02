#!/usr/bin/env python3
"""SessionStart hook: on every session start/resume (incl. a respawn's fresh
session), replay any still-UNANSWERED inbound message by injecting it as hidden
context at the top of the model's context window. This is the deterministic
mechanism -- the fresh session does not need to REMEMBER to look; the unanswered
question is already in front of it.

Outputs the SessionStart additionalContext JSON. Empty ledger -> no-op. Never
breaks session start (always exit 0).
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def main():
    # Drain stdin (the SessionStart payload) so the pipe never breaks; not needed.
    try:
        sys.stdin.read()
    except Exception:
        pass
    try:
        rows = ledger_lib.unanswered()
    except Exception:
        sys.exit(0)  # ledger unavailable -> no-op
    if not rows:
        sys.exit(0)  # nothing pending -> no-op

    lines = []
    for chat_id, message_id, text, ts in rows:
        snippet = (text or "").strip().replace("\n", " ")
        lines.append(f'- chat {chat_id}, message_id {message_id} (ts {ts}): "{snippet}"')
    ctx = (
        "MEGVÁLASZOLATLAN BESZÉLGETÉS-FOLYTONOSSÁG (determinisztikus ledger). "
        "A kapcsolatod újraindult, de az alábbi Telegram-üzenet(ek)re MÉG NEM "
        "válaszoltál. Válaszolj rájuk MOST a telegram reply tool "
        "(mcp__plugin_telegram_telegram__reply) meghívásával a megfelelő chat_id-re, "
        "onnan folytatva ahol a kapcsolat megszakadt:\n" + "\n".join(lines)
    )
    out = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": ctx,
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
