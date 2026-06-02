#!/usr/bin/env python3
"""SessionStart hook: on every session start/resume (incl. a respawn's fresh
session), inject the recent conversation CONTEXT for THIS agent -- the last ~20
turns in chronological order PLUS a highlighted OPEN QUESTION (the most recent
inbound with no later reply). This is the deterministic mechanism: the fresh
session does not need to REMEMBER anything; its context window already carries
the conversation and the question to answer.

Generic across the three channel agents -- agent_id is derived from cwd, so a
session only ever replays its OWN chat. Outputs the SessionStart additionalContext
JSON. No history -> no-op. Never breaks session start (always exit 0).
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

# Roughly 4000 tokens of transcript context (~4 chars/token). If the recent
# window exceeds this, the OLDEST turns are dropped so the injected context
# stays bounded regardless of how chatty the recent conversation was.
CONTEXT_CHAR_BUDGET = 16000


def _window_limit():
    """How many recent turns to replay. Env override LEDGER_CONTEXT_WINDOW,
    default ledger_lib.RECENT_LIMIT (20). Non-positive / non-numeric -> default."""
    v = os.environ.get("LEDGER_CONTEXT_WINDOW")
    if v:
        try:
            n = int(v)
            if n > 0:
                return n
        except ValueError:
            pass
    return ledger_lib.RECENT_LIMIT


def main():
    cwd = None
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd")
    except Exception:
        pass
    agent_id = ledger_lib.agent_id_from_cwd(cwd)

    try:
        rows = ledger_lib.recent(agent_id, _window_limit())
        open_q = ledger_lib.open_question(agent_id)
    except Exception:
        sys.exit(0)  # ledger unavailable -> no-op
    if not rows and not open_q:
        sys.exit(0)  # nothing to replay

    transcript = []
    for direction, chat_id, text, ts in rows:
        who = "Gyula" if direction == "in" else "Te"
        snippet = (text or "").strip().replace("\n", " ")
        transcript.append(f'  [{ts}] {who}: "{snippet}"')

    # Token guard: drop the OLDEST turns until the transcript fits the budget.
    total = sum(len(line) + 1 for line in transcript)
    while len(transcript) > 1 and total > CONTEXT_CHAR_BUDGET:
        total -= len(transcript[0]) + 1
        transcript.pop(0)

    parts = [
        "BESZÉLGETÉS-FOLYTONOSSÁG (determinisztikus ledger). A kapcsolatod "
        "újraindult egy friss sessionben, ami NEM emlékszik az élő beszélgetésre. "
        "Az alábbi a legutóbbi beszélgetés-kontextus (időrendben), hogy onnan "
        "folytasd ahol megszakadt:"
    ]
    if transcript:
        parts.append("\n".join(transcript))
    if open_q:
        chat_id, message_id, text, ts = open_q
        snippet = (text or "").strip().replace("\n", " ")
        parts.append(
            f'NYITOTT KÉRDÉS (még NEM válaszoltad meg): Gyula utolsó üzenete '
            f'(chat {chat_id}, message_id {message_id}): "{snippet}". Válaszolj rá '
            f'MOST a telegram reply tool (mcp__plugin_telegram_telegram__reply) '
            f'meghívásával a megfelelő chat_id-re, a fenti kontextusból folytatva.'
        )

    out = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "\n\n".join(parts),
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
