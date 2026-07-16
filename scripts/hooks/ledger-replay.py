#!/usr/bin/env python3
"""SessionStart hook: on every session start/resume (incl. a respawn's fresh
session), inject the recent conversation CONTEXT for THIS agent -- up to the last
DEFAULT_WINDOW turns (trimmed to DEFAULT_CHAR_BUDGET chars, ~4k tokens) PLUS a
highlighted OPEN QUESTION (the most recent inbound with no later reply). This is
the deterministic mechanism: the fresh session does not need to REMEMBER
anything; its context window already carries the conversation and the question
to answer.

Two layers keep the fresh end of the conversation actually reaching the fresh
session:
  1. A BYTE budget (DEFAULT_BYTE_BUDGET) on the FINAL payload: the hook measures
     its own real UTF-8 output size and drops the OLDEST turns until it fits,
     so the harness always injects the block WHOLE (no file-spill, no preview).
  2. Block ORDER as a belt-and-braces fallback: if a payload ever does exceed
     the cap, the harness spills it to a file and inlines only a small preview
     taken from the block START -- so the mandatory directive and the open
     question (the actionable core) lead the block, then the freshest turns,
     then older turns as backfill.

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
# ~= 4000 tokens). This is a CHEAP coarse pre-trim only; the authoritative guard
# is the BYTE budget below (see _fit_output). If the recent window exceeds this,
# the OLDEST turns are dropped so the injected context stays bounded regardless
# of how chatty the recent conversation was. Env override:
# LEDGER_CONTEXT_CHAR_BUDGET.
DEFAULT_CHAR_BUDGET = 16000

# Hard BYTE budget on the FINAL hook payload (the whole json.dumps(...) blob,
# UTF-8 encoded: frame + directive + open-question + transcript). This is the
# real guard. WHY bytes, not chars: the Claude Code harness caps a hook's
# additionalContext by BYTE size -- above the cap it does NOT inject the block,
# it saves it to a file and inlines only a small (~2KB) PREVIEW taken from the
# block START, so a large payload's fresh (most recent) turns are lost and the
# restarted session has no memory of them. Hungarian accents (á é ő ű) are 2
# bytes each in UTF-8, so a char-only measure UNDERCOUNTS and can silently
# overshoot the cap. 8192 is a conservative target well under the empirical
# too-large threshold (an ~11.1KB payload was already rejected by the harness).
# Env override: LEDGER_CONTEXT_BYTE_BUDGET. Lower this if a future harness build
# shrinks its internal limit -- the reliability lives in OUR self-measuring
# trim, not the harness's discretion.
DEFAULT_BYTE_BUDGET = 8192

# Per-message snippet cap (chars). A single very long turn is truncated with an
# ellipsis rather than letting it dominate (or, if it is the freshest turn,
# blow) the whole byte budget. This is the depth optimization: bounding each
# line lets MORE turns fit under the byte budget, and guarantees even a single
# huge freshest turn still fits. Env override: LEDGER_CONTEXT_MAX_SNIPPET.
DEFAULT_MAX_SNIPPET = 1200

# How many recent turns to consider before the budgets trim. 20 keeps the
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


def _byte_budget():
    return _env_int("LEDGER_CONTEXT_BYTE_BUDGET", DEFAULT_BYTE_BUDGET)


def _max_snippet():
    return _env_int("LEDGER_CONTEXT_MAX_SNIPPET", DEFAULT_MAX_SNIPPET)


def _snippet(text, limit):
    """One-line, whitespace-collapsed snippet, truncated to `limit` chars with an
    ellipsis marker so a single runaway message cannot dominate the budget."""
    s = (text or "").strip().replace("\n", " ")
    if limit > 0 and len(s) > limit:
        s = s[:limit].rstrip() + " [...]"
    return s


def _build_output(transcript, open_q, owner):
    """Assemble the final SessionStart hook payload dict from the (already
    snippet-trimmed, oldest-first) transcript lines + optional open question.

    Block order puts the actionable core first (directive, open question), then
    the freshest turns, then older backfill -- so even a preview taken from the
    block START carries the essence. Pure function of its inputs so the byte-fit
    loop can rebuild and re-measure cheaply.
    """
    # Split into the most-recent highlight window and the older backfill. The
    # recent turns are the newest, so the byte/char guards (which drop from the
    # OLDEST end) never touch them until the older backfill is already empty.
    if len(transcript) > RECENT_TURNS_HIGHLIGHT:
        recent = transcript[-RECENT_TURNS_HIGHLIGHT:]
        older = transcript[:-RECENT_TURNS_HIGHLIGHT]
    else:
        recent = transcript
        older = []

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
        snippet = _snippet(text, _max_snippet())
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

    return {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "\n\n".join(parts),
        }
    }


def _payload_bytes(out):
    """Real byte size of the serialized hook payload -- the exact quantity the
    harness measures against its internal cap (ensure_ascii=False keeps accented
    chars as multi-byte UTF-8, matching print(..., ensure_ascii=False) below)."""
    return len(json.dumps(out, ensure_ascii=False).encode("utf-8"))


def _fit_output(transcript, open_q, owner, byte_budget):
    """Build the payload and keep it under `byte_budget` by dropping the OLDEST
    turn and re-measuring, iteratively (build -> measure -> trim -> repeat). The
    freshest END survives, the oldest turns fall off first. At least one turn is
    kept when any exist (its snippet is already bounded by _max_snippet, so a
    lone freshest turn still fits)."""
    transcript = list(transcript)
    out = _build_output(transcript, open_q, owner)
    while len(transcript) > 1 and _payload_bytes(out) > byte_budget:
        transcript.pop(0)
        out = _build_output(transcript, open_q, owner)
    return out


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

    max_snippet = _max_snippet()
    transcript = []
    for direction, chat_id, text, ts in rows:
        who = owner if direction == "in" else "Te"
        snippet = _snippet(text, max_snippet)
        transcript.append(f'  [{ts}] {who}: "{snippet}"')

    # Coarse char pre-trim (cheap): drop the OLDEST turns until the transcript
    # roughly fits the char budget, so the authoritative byte-fit loop below has
    # less to iterate over. The byte budget is the real guard.
    char_budget = _char_budget()
    total = sum(len(line) + 1 for line in transcript)
    while len(transcript) > 1 and total > char_budget:
        total -= len(transcript[0]) + 1
        transcript.pop(0)

    # Authoritative guard: keep the FINAL payload's real UTF-8 byte size under the
    # harness's injection cap, dropping oldest turns and re-measuring until it
    # fits (freshest END survives).
    out = _fit_output(transcript, open_q, owner, _byte_budget())

    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
