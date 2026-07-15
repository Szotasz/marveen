#!/usr/bin/env python3
"""SessionStart hook: on every session start/resume (incl. a respawn's fresh
session), inject the recent conversation CONTEXT for THIS agent -- up to the last
DEFAULT_WINDOW turns (trimmed to DEFAULT_CHAR_BUDGET chars, ~4k tokens) in
chronological order PLUS a highlighted OPEN QUESTION (the most recent
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

# How many chars of transcript context to inject (~4 chars/token, so 16000 chars
# ~= 4000 tokens). If the recent window exceeds this, the OLDEST turns are
# dropped so the injected context stays bounded regardless of how chatty the
# recent conversation was. Env override: LEDGER_CONTEXT_CHAR_BUDGET (raise it
# only if a specific install genuinely needs a deeper replay -- the default is
# deliberately lean so a fresh session does not carry needless context).
DEFAULT_CHAR_BUDGET = 16000

# How many recent turns to consider before the char budget trims. 20 keeps the
# injected context lean; the continuity failure mode is NOT a too-short window
# (a key fact usually sits well within 20 turns) but the fresh session not
# *reading* the loaded block -- addressed by the mandatory directive below.
# Env override: LEDGER_CONTEXT_WINDOW.
DEFAULT_WINDOW = 20


def _env_int(name, default):
    """Positive int from env var `name`, else `default`. Non-positive / non-numeric -> default."""
    v = os.environ.get(name)
    if v:
        try:
            n = int(v)
            if n > 0:
                return n
        except ValueError:
            pass
    return default


def _window_limit():
    return _env_int("LEDGER_CONTEXT_WINDOW", DEFAULT_WINDOW)


def _char_budget():
    return _env_int("LEDGER_CONTEXT_CHAR_BUDGET", DEFAULT_CHAR_BUDGET)


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

    owner = ledger_lib.owner_name()

    transcript = []
    for direction, chat_id, text, ts in rows:
        who = owner if direction == "in" else "Te"
        snippet = (text or "").strip().replace("\n", " ")
        transcript.append(f'  [{ts}] {who}: "{snippet}"')

    # Token guard: drop the OLDEST turns until the transcript fits the budget.
    char_budget = _char_budget()
    total = sum(len(line) + 1 for line in transcript)
    while len(transcript) > 1 and total > char_budget:
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
            f'NYITOTT KÉRDÉS (még NEM válaszoltad meg): {owner} utolsó üzenete '
            f'(chat {chat_id}, message_id {message_id}): "{snippet}". Válaszolj rá '
            f'MOST a telegram reply tool (mcp__plugin_telegram_telegram__reply) '
            f'meghívásával a megfelelő chat_id-re, a fenti kontextusból folytatva.'
        )

    # Nyomatékos záró direktíva. A betöltés önmagában nem elég: egy friss session
    # hajlamos a legfrissebb BEJÖVŐ ingerre (pl. egy most érkezett kép) ugrani és
    # a fenti kontextust háttérként kezelni. Ez a sor kötelezővé teszi a
    # feldolgozást MIELŐTT bármely új üzenetre reagálna, hogy ne kérdezzen vissza
    # olyat, ami fent már eldőlt.
    parts.append(
        "KÖTELEZŐ: MIELŐTT bármely új bejövő üzenetre válaszolsz, dolgozd fel a "
        "fenti beszélgetést. A benne szereplő döntések, megállapodások és "
        "folyamatban lévő szálak ÉRVÉNYESEK és folytatandók. NE kérdezz vissza "
        "olyat, amit fent már megbeszéltetek (pl. \"mihez kell ez?\", ha fent már "
        "eldőlt); a betöltött kontextusból folytass, ne kezdd elölről."
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
