#!/usr/bin/env python3
"""Pre-check probe for the memoria-heartbeat round (TOKENEGES917).

Answers one question for the schedule runner, WITHOUT starting the model:
did anything happen since the round last ran that could warrant memory work?

Measured 2026-09-17: one memoria-heartbeat round costs ~1.43M tokens, almost
all of it re-reading the session context. At the old */15 cron that is ~138M
tokens a day, most of it spent concluding that there was nothing to do.

Cursor, not hash. A hash says "something changed" but not what, so the model
would have to start anyway just to find out. A timestamp cursor says where we
are, so this probe can hand the round the actual counts.

READ-ONLY on purpose. The round owns memoria-heartbeat-state.json and stamps
it at the end of every run; a gate that wrote it would consume the round's own
signal (the round would wake, then report nothing new). A gate may only read
what the round writes.

Exit codes:
  0 + "SKIP"      nothing happened, the model must not start
  0 + summary     something happened, text becomes the prompt prefix
  non-zero        cannot tell -> fail open, the model runs anyway

Fail-open has no exceptions. A broken probe's silent SKIP is indistinguishable
from a genuinely quiet system, and that is the failure class this exists to
prevent.
"""
import json
import os
import sqlite3
import sys

# BEEGETETT924: abszolut ut helyett a szkript sajat helyebol szamolt gyoker
# (scripts/hooks/ ket szinttel a gyoker alatt), env-bol felulirhato.
ROOT = os.environ.get(
    "MARVEEN_ROOT",
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
)
DB = os.environ.get("MARVEEN_DB", os.path.join(ROOT, "store", "claudeclaw.db"))
STATE = os.environ.get(
    "MEMORIA_HEARTBEAT_STATE", os.path.join(ROOT, "store", "memoria-heartbeat-state.json")
)

# (label, table, timestamp column)
SOURCES = [
    ("uj emlek", "memories", "created_at"),
    ("kanban mozgas", "kanban_cards", "updated_at"),
    ("kanban komment", "kanban_comments", "created_at"),
    ("naplo bejegyzes", "daily_logs", "created_at"),
    ("csatorna uzenet", "conversation_log", "created_at"),
]


def bail(reason):
    """Fail open: say why on stderr, exit non-zero, let the model run."""
    sys.stderr.write(f"memoria-precheck: cannot determine state ({reason})\n")
    sys.exit(2)


def main():
    if not os.path.exists(DB) or os.path.getsize(DB) == 0:
        bail(f"ledger db missing or empty: {DB}")

    try:
        with open(STATE) as f:
            last = int(json.load(f)["last_run_at"])
    except Exception as err:
        # No stamp yet, or unreadable: we genuinely do not know the window.
        bail(f"state file unreadable: {err}")

    try:
        conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        parts = []
        for label, table, col in SOURCES:
            n = conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {col} > ?", (last,)
            ).fetchone()[0]
            if n:
                parts.append(f"{n} {label}")
    except Exception as err:
        bail(f"query failed: {err}")

    if not parts:
        print("SKIP")
        return

    print(
        f"[Pre-check] Az elozo memoria-heartbeat kor ota ({last}) tortent: "
        + ", ".join(parts)
        + ". Ezeket nezd at, ne kerdezd le ujra a valtozas TENYET."
    )


if __name__ == "__main__":
    main()
