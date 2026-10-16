#!/usr/bin/env python3
"""Token-free gate in front of the memoria-heartbeat task.

memoria-heartbeat runs hourly 07-21 and wakes the main agent to save anything
worth remembering. Every tick costs a model call, including the many hours with
nothing to look at. This gate answers one FACT before spending anything: has
anything happened since the agent last said it had caught up?

The gate deliberately does NOT judge importance -- no rules, no local model.
"Was there activity" is a fact; "is it worth remembering" is a judgement, and a
heuristic gate fails exactly where the interesting cases are. The agent still
decides what to keep; the gate only decides whether there is anything to look
at.

WHO MOVES THE WATERMARK, AND WHY IT IS NOT THIS SCRIPT
------------------------------------------------------
The first version of this gate watched conversation_log and advanced the
watermark itself. That has a loop in it: the agent we wake writes to the very
log we watch (its outbound messages, and every one of its tool calls), so the
next tick reads its own echo as new activity and spends a model call to
discover it. Narrowing the query hides the loop rather than removing it, and it
also blinds the gate to autonomous work -- which is where most of the
memory-worthy material actually is.

So the watermark moves at the END of the agent's turn, not here (Picard's
design, msg 679):

  - this script READS two watermarks (conversation_log.id, tool_call_log.id)
    and wakes the agent when EITHER has moved. It never writes them.
  - the agent runs `--mark-seen` as the last action of its heartbeat turn,
    which sets both to the current max.

Everything the agent produced during its own turn is therefore behind the
watermark by construction. This is a fact about ordering, not a heuristic or a
damping factor.

The failure direction is deliberate too: if the turn dies before `--mark-seen`,
the watermarks do not move and the next tick wakes on the same window. Looking
at the same hour twice is cheap; skipping it silently is not.

THE TWO WATERMARKS ARE NOT MOVED THE SAME WAY (Picard, msg 681)
---------------------------------------------------------------
A message can arrive WHILE the agent's turn is running. Advancing both marks to
the current max would swallow it: it would sit behind the watermark without
anyone having read it. So:

  - tool_call_log -> current max. This is the agent's OWN footprint. It has to
    be swallowed, otherwise the loop above comes straight back.
  - conversation_log -> only as far as `--conv-upto`, the conv_max the wake
    prompt showed. Anything that landed after that stays in FRONT of the mark
    and the next tick wakes on it.

One sentence for why they differ: the tool log is my own trace, the
conversation log is somebody else's. What arrives during my turn is by
definition not my trace. `--conv-upto` is therefore REQUIRED with `--mark-seen`
-- the caller states what it actually reviewed rather than the script assuming
"everything up to now". The price of the conservative side is at most one extra
wake on a message the agent already handled mid-turn. That is the cheap
direction.

HOW MUCH THAT ACTUALLY PROTECTS TODAY -- LESS THAN IT SOUNDS
------------------------------------------------------------
Measured 2026-07-28, do not soften this without re-measuring. A message
delivered INTO an already-running turn never reaches conversation_log at all,
so there is nothing for the conservative watermark to keep in front of:

  - the inbound writer is scripts/hooks/ledger-capture.py, bound to
    UserPromptSubmit (marveen/.claude/settings.json). No prompt is submitted
    mid-turn, so the hook never fires for that message.
  - the outbound writer (ledger-outbound.py) is bound to PostToolUse, which
    DOES fire mid-turn. Hence the asymmetry in the evidence.
  - concrete case: Telegram message_id 2438 (14:05:03Z) reached the model's
    context -- the <channel> block is in the session transcript -- and picard's
    reply to it is row 1585 (out). There is no inbound row for it. The inbound
    max both before and after is 1583.

So the paragraph above describes the intended behaviour, not today's reachable
behaviour: the guard is correct but the case it was built for cannot currently
reach it. The fix belongs ABOVE this gate (a mid-turn inbound must get a
conversation_log row; the transcript is available to hooks and log_inbound is
already idempotent on message_id). Until that lands, do not claim this gate
protects against lost mid-turn messages -- it protects against swallowing them
once they are recorded.

THE ONE ROW THE END-OF-TURN WATERMARK CANNOT SWALLOW (measured 2026-08-02)
--------------------------------------------------------------------------
"Everything the agent produced during its own turn is behind the watermark by
construction" was wrong by exactly one row, and that row is this script's own
`--mark-seen` call. The ordering is not arguable:

  1. the agent runs `--mark-seen` as its last action;
  2. THIS function reads MAX(tool_call_log.id) and writes it;
  3. the PostToolUse hook (scripts/hooks/tool-log-capture.py) logs that Bash
     call -- afterwards, because the row records a finished call.

So the marker lands one short of its own footprint, every single time. The next
tick then finds "1 new row" and spends a model call to rediscover it, whose
own `--mark-seen` leaves the next row, forever. Measured on the live marker
file: mark-seen rows 4256/4261/4266 against markers 4255/4260/4265, and the
07:00-18:00 wakes on 2026-08-02 show `tool_call_log.id > N (most N+1, 1 uj sor)`
with zero new conversation rows. A self-sustaining wake, ~15 model calls a day,
none of which had anything to look at.

The fix is a predicate, not a bigger marker: rows whose input_summary is this
script's own `--mark-seen` invocation are excluded from BOTH the maxima and the
counts. This is not the "narrow the query until the loop hides" mistake the
docstring above warns about -- that one blinded the gate to real autonomous
work. This excludes one call whose entire purpose is bookkeeping about the
gate, and which can never itself be worth remembering. Everything else the
agent does, including reading or editing this very file, still counts as
activity.

If the match ever fails (a differently shaped command line), the behaviour
degrades to exactly what it was before: one spurious wake per turn. Nothing is
lost, which is the right direction for a filter that decides what NOT to look
at.

WHERE THE direction='in' FILTER IS, AND WHERE IT DELIBERATELY IS NOT
--------------------------------------------------------------------
conversation_log is read with `direction = 'in'`; tool_call_log has NO such
filter (there is no direction there, and every row is the agent's own work by
construction). The 'in' filter is NOT what damps the loop -- the end-of-turn
watermark does that. It is there so the conservative conv watermark does not
park behind the agent's OWN outbound replies and re-wake on them every single
turn. Removing it would not reintroduce the loop, it would just make every
outbound message look like unreviewed inbound input. If you are reading this in
two weeks wondering whether the filter is load-bearing: it is, for the
conservative marker, not for the loop.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path

MARVEEN_DIR = Path(__file__).resolve().parents[1]
DB_PATH = MARVEEN_DIR / "store" / "claudeclaw.db"
TOKEN_FILE = MARVEEN_DIR / "store" / ".dashboard-token"
MARKER_FILE = MARVEEN_DIR / "store" / "memoria-heartbeat-gate-last.txt"
MESSAGES_URL = "http://localhost:3420/api/messages"

AGENT = "picard"

# The agent's own `--mark-seen` call is logged by the PostToolUse hook AFTER
# this script has read the maximum, so the marker can never cover it and the
# next tick reads it as new activity. Excluded from the maxima and the counts
# alike -- see "THE ONE ROW THE END-OF-TURN WATERMARK CANNOT SWALLOW" above for
# why this particular narrowing does not blind the gate.
OWN_MARK_SEEN_CALL = (
    "COALESCE(input_summary, '') NOT LIKE '%memoria_heartbeat_gate.py --mark-seen%'"
)

# (marker key, table, extra predicate). Both are keyed on the agent so that
# another agent's work never wakes this one. Today only picard writes
# tool_call_log, but the column exists and the filter is what keeps that true if
# that changes. The direction predicate on conversation_log is deliberate and
# the shape of the tool_call_log one is too -- see the module docstring.
SOURCES = (
    ("conversation_log", "conversation_log", "direction = 'in'"),
    ("tool_call_log", "tool_call_log", OWN_MARK_SEEN_CALL),
)

EXTRA_PREDICATE = {key: extra for key, _, extra in SOURCES}


def _and(extra: str | None) -> str:
    return f" AND {extra}" if extra else ""

WAKE_MESSAGE = (
    "[memoria-heartbeat-gate] Tortent valami a legutobbi lezart fordulo ota, "
    "fusd le a memoria-heartbeat skillt.\n\n"
    "AZ ABLAK, amit at kell nezned (a kapu ezekig latta lezartnak):\n"
    "  conversation_log.id > {conv_seen}   (most {conv_max}, {conv_new} uj sor)\n"
    "  tool_call_log.id    > {tool_seen}   (most {tool_max}, {tool_new} uj sor)\n\n"
    "NE oraban merd az ablakot -- a jelolo szabja meg, nem az eltelt ido. Ha a "
    "legutobbi fordulo elszallt vagy kimaradt, ez az ablak tobb orat is atfoghat.\n\n"
    "AZ UTOLSO LEPESED, a fordulo vegen, KOTELEZOEN, PONTOSAN igy:\n"
    f"  python3 {MARVEEN_DIR}/scripts/memoria_heartbeat_gate.py "
    "--mark-seen --conv-upto {conv_max}\n"
    "A {conv_max} a FENTI ablak vege, ne ird at a pillanatnyi max-ra. A ket jelolo "
    "szandekosan NEM egyformán lep: a tool_call_log a pillanatnyi max-ra megy (az a te "
    "sajat labnyomod, azt el kell nyelni, kulonben ujra felebresztene magad), a "
    "conversation_log viszont csak eddig az id-ig (az masok bemenete, azt atnezetlenul "
    "soha). Ha kozben, a fordulod alatt erkezik uzenet, az igy a jelolo elott marad es a "
    "kovetkezo tick felebreszt ra -- ha mar foglalkoztal vele, az ara egyetlen felesleges "
    "ebresztes, es ez a jo irany.\n"
    "Tenyleg az utolso legyen. Ha a fordulo elszall elotte, a jelolo nem mozdul es a "
    "kovetkezo tick ugyanerre az ablakra ebreszt -- ez szandekos.\n\n"
    "Ha az ablakban nincs semmi ertekes, maradj csendben: a kapu csak azt allapitotta meg, "
    "hogy VAN mit atnezni, azt nem, hogy fontos-e. A --mark-seen --conv-upto {conv_max} "
    "ilyenkor is kell."
)


def read_markers() -> dict[str, int]:
    """Watermarks per source, tolerating the older single-integer format."""
    try:
        raw = MARKER_FILE.read_text().strip()
    except FileNotFoundError:
        return {key: 0 for key in EXTRA_PREDICATE}

    try:
        data = json.loads(raw)
    except ValueError:
        data = None

    # `json.loads("1583")` succeeds and yields an int, so "did it parse" is NOT
    # the test for the current format -- the shape is. Getting this wrong threw
    # AttributeError past the ValueError handler on the very file that was on
    # disk when this was written.
    if isinstance(data, dict):
        return {key: int(data.get(key, 0)) for key in EXTRA_PREDICATE}

    # Pre-679 format: a bare conversation_log id. Keep it rather than resetting
    # to zero, which would replay the whole history once.
    try:
        conv = int(raw)
    except ValueError:
        conv = 0
    return {"conversation_log": conv, "tool_call_log": 0}


def current_maxima() -> dict[str, int]:
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        out = {}
        for key, table, extra in SOURCES:
            row = con.execute(
                f"SELECT COALESCE(MAX(id), 0) FROM {table} "
                f"WHERE agent_id = ?{_and(extra)}",
                (AGENT,),
            ).fetchone()
            out[key] = int(row[0])
        return out
    finally:
        con.close()


def write_markers(values: dict[str, int]) -> None:
    MARKER_FILE.parent.mkdir(parents=True, exist_ok=True)
    MARKER_FILE.write_text(json.dumps(values, indent=2) + "\n")


def count_new(since: int, key: str) -> int:
    """Rows in front of the watermark, under the same predicate the max used."""
    extra = EXTRA_PREDICATE[key]
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        row = con.execute(
            f"SELECT COUNT(*) FROM {key} WHERE agent_id = ? AND id > ?{_and(extra)}",
            (AGENT, since),
        ).fetchone()
        return int(row[0])
    finally:
        con.close()


def wake_agent(seen: dict[str, int], maxima: dict[str, int]) -> None:
    """Wake the main agent. Raises on failure; nothing here writes a marker."""
    token = TOKEN_FILE.read_text().strip()
    content = WAKE_MESSAGE.format(
        conv_seen=seen["conversation_log"],
        conv_max=maxima["conversation_log"],
        conv_new=count_new(seen["conversation_log"], "conversation_log"),
        tool_seen=seen["tool_call_log"],
        tool_max=maxima["tool_call_log"],
        tool_new=count_new(seen["tool_call_log"], "tool_call_log"),
    )
    payload = json.dumps({"from": "geordi", "to": AGENT, "content": content}).encode()
    req = urllib.request.Request(
        MESSAGES_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    # 15s is plenty: the endpoint only inserts a row and returns, ~3ms measured.
    #
    # An earlier reading of this raised it to 60s on the theory that the server
    # was slow. It was not. The scheduler ran command tasks with spawnSync,
    # which froze the whole dashboard event loop until the child exited -- so
    # THIS request could not be answered until this very script gave up and
    # died. Raising our own timeout would only have lengthened the freeze it was
    # causing: the child holds the server hostage for exactly as long as it
    # waits. Fixed on the other side (src/web/command-task.ts, async spawn).
    with urllib.request.urlopen(req, timeout=15) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"messages API returned HTTP {resp.status}")


def mark_seen(conv_upto: int | None) -> int:
    """End of the agent's turn. Asymmetric on purpose -- see the module docstring.

    tool_call_log goes to the current max (own footprint, must be swallowed);
    conversation_log goes only as far as the caller says it actually reviewed,
    so a message that landed mid-turn stays in front of the watermark.
    """
    if conv_upto is None:
        print(
            "--mark-seen requires --conv-upto <id>: pass the conv_max the wake "
            "prompt showed you. Without it the script would have to assume you "
            "reviewed everything up to this instant, which would swallow any "
            "message that arrived during your turn. Nothing was written.",
            file=sys.stderr,
        )
        return 2

    seen = read_markers()
    try:
        maxima = current_maxima()
    except sqlite3.Error as exc:
        print(f"cannot read current maxima: {exc}", file=sys.stderr)
        return 1

    # Never past what exists (a bogus high value would swallow unread input),
    # never back below where we already were (that would replay the window).
    conv = max(seen["conversation_log"], min(conv_upto, maxima["conversation_log"]))
    if conv != conv_upto:
        print(
            f"--conv-upto {conv_upto} clamped to {conv} (previous marker "
            f"{seen['conversation_log']}, current inbound max "
            f"{maxima['conversation_log']})",
            file=sys.stderr,
        )

    values = {"conversation_log": conv, "tool_call_log": maxima["tool_call_log"]}
    write_markers(values)
    print(json.dumps(values))
    return 0


def check() -> int:
    seen = read_markers()

    try:
        maxima = current_maxima()
    except sqlite3.Error as exc:
        print(f"watermark query failed: {exc}", file=sys.stderr)
        return 1

    if all(maxima[key] <= seen[key] for key in EXTRA_PREDICATE):
        return 0

    try:
        wake_agent(seen, maxima)
    except (urllib.error.URLError, OSError, RuntimeError, ValueError) as exc:
        print(f"activity found but waking {AGENT} failed ({exc})", file=sys.stderr)
        return 1

    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--mark-seen",
        action="store_true",
        help="end-of-turn watermark write (requires --conv-upto)",
    )
    parser.add_argument(
        "--conv-upto",
        type=int,
        metavar="ID",
        help="the conversation_log id the wake prompt showed as conv_max; "
        "anything newer stays in front of the watermark",
    )
    args = parser.parse_args(argv)

    if args.conv_upto is not None and not args.mark_seen:
        parser.error("--conv-upto only means anything together with --mark-seen")

    return mark_seen(args.conv_upto) if args.mark_seen else check()


if __name__ == "__main__":
    sys.exit(main())
