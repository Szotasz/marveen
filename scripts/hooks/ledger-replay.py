#!/usr/bin/env python3
"""SessionStart hook: on every session start/resume (incl. a respawn's fresh
session), inject the recent conversation CONTEXT for THIS agent -- up to the last
DEFAULT_WINDOW turns (trimmed to DEFAULT_CHAR_BUDGET chars, ~4k tokens) PLUS a
highlighted OPEN QUESTION (the most recent inbound with no later reply). This is
the deterministic mechanism: the fresh session does not need to REMEMBER
anything; its context window already carries the conversation and the question
to answer.

The block is ordered so its actionable core survives context-preview truncation
(the harness may spill a large additionalContext to a file and inline only a
small preview taken from the block START): mandatory directive first, then the
open question, then the freshest turns, then older turns as backfill.

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

# Of the (budget-trimmed) turns, how many most-recent ones get their own
# highlighted "LEGFRISSEBB FORDULÓK" section at the TOP of the block; the rest
# are appended below as older backfill. This is purely a display split so the
# freshest, most relevant turns lead the block and survive any context-preview
# truncation -- it does NOT change the window or the char budget.
RECENT_TURNS_HIGHLIGHT = 5


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

    # Split the (budget-trimmed) turns into the most-recent highlight window and
    # the older backfill. The recent turns are the newest, so they are never the
    # ones the budget guard drops.
    if len(transcript) > RECENT_TURNS_HIGHLIGHT:
        recent = transcript[-RECENT_TURNS_HIGHLIGHT:]
        older = transcript[:-RECENT_TURNS_HIGHLIGHT]
    else:
        recent = transcript
        older = []

    # Order the block so the essence survives ANY context-preview truncation: the
    # Claude Code harness may spill a large SessionStart additionalContext to a
    # file and inline only a ~2KB preview taken from the BLOCK START. So the
    # mandatory directive and the open question -- the actionable core -- lead the
    # block, then the freshest turns, then the older backfill last. (Previously
    # the directive and open question sat at the END, so on a large/chatty block
    # they fell off the visible preview edge and the fresh session missed them.)
    parts = [
        "KÖTELEZŐ: MIELŐTT bármely új bejövő üzenetre válaszolsz, dolgozd fel az "
        "alábbi beszélgetés-kontextust. A kapcsolatod újraindult egy friss "
        "sessionben, ami NEM emlékszik az élő beszélgetésre; a folytonosságot ez "
        "a blokk adja. A benne szereplő döntések, megállapodások és folyamatban "
        "lévő szálak ÉRVÉNYESEK és folytatandók. NE kérdezz vissza olyat, amit "
        "lent már megbeszéltetek (pl. \"mihez kell ez?\", ha lent már eldőlt); a "
        "betöltött kontextusból folytass, ne kezdd elölről."
    ]
    if open_q:
        chat_id, message_id, text, ts = open_q
        snippet = (text or "").strip().replace("\n", " ")
        parts.append(
            f'NYITOTT KÉRDÉS (még NEM válaszoltad meg): {owner} utolsó üzenete '
            f'(chat {chat_id}, message_id {message_id}): "{snippet}". Válaszolj rá '
            f'MOST a telegram reply tool (mcp__plugin_telegram_telegram__reply) '
            f'meghívásával a megfelelő chat_id-re, a lenti kontextusból folytatva.'
        )
    if recent:
        parts.append(
            "LEGFRISSEBB FORDULÓK (időrendben, a beszélgetés vége -- innen "
            "folytasd):\n" + "\n".join(recent)
        )
    if older:
        parts.append(
            "KORÁBBI HÁTTÉR (régebbi fordulók, csak kontextusnak, időrendben):\n"
            + "\n".join(older)
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
