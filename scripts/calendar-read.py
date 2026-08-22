#!/usr/bin/env python3
"""Read the calendar snapshot written by the LaunchAgent, for the briefing.

  python3 scripts/calendar-read.py            -- one human-readable block
  python3 scripts/calendar-read.py --json     -- the interpreted result

The snapshot itself is produced by scripts/bin/calendar-events (Swift/EventKit)
under com.marveen.calendar, because the agent's own process cannot hold the
macOS calendar permission -- see the header of calendar-events.swift.

This module exists for ONE distinction: "no events today" and "I could not read
the calendar" must never look alike. A snapshot that is merely OLD counts as
unmeasured too, however healthy its status field looks -- otherwise a
LaunchAgent that quietly stopped would serve yesterday's day as today's.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_PATH = Path(os.environ.get("MARVEEN_CALENDAR_SNAPSHOT", ROOT / "store" / "calendar-today.json"))

# The LaunchAgent refreshes hourly; two hours of slack absorbs a missed run
# without letting a dead agent pass as live.
DEFAULT_MAX_AGE_MINUTES = 150

# Reasons, phrased for a reader. None of them may imply absence of events.
_REASONS = {
    "denied": "a naptár-hozzáférés meg van tagadva (Rendszerbeállítások > Adatvédelem > Naptárak)",
    "not_determined": "a naptár-engedélyt még senki nem hagyta jóvá",
    "restricted": "a naptár-hozzáférést házirend korlátozza",
    "write_only": "csak írási jog van, olvasni nem lehet",
    "error": "a naptár-olvasás hibára futott",
    "missing": "nincs naptár-pillanatkép (a com.marveen.calendar még nem futott le)",
    "stale": "a naptár-pillanatkép elavult (a com.marveen.calendar nem frissítette)",
    "malformed": "a naptár-pillanatkép olvashatatlan",
}


def _parse_iso(raw):
    try:
        return datetime.fromisoformat(str(raw))
    except (TypeError, ValueError):
        return None


def _unmeasured(state: str, extra: str = "") -> dict:
    reason = _REASONS.get(state, state)

    return {
        "state": state,
        "measured": False,
        "message": f"A naptár nem mérhető: {reason}{extra}.",
        "events": [],
    }


def interpret(payload, now: datetime, max_age_minutes: int = DEFAULT_MAX_AGE_MINUTES) -> dict:
    """Turn a raw snapshot into a verdict the briefing can print verbatim."""
    if payload is None:
        return _unmeasured("missing")

    if not isinstance(payload, dict):
        return _unmeasured("malformed")

    generated = _parse_iso(payload.get("generatedAt"))

    if generated is None:
        return _unmeasured("stale", " (hiányzó vagy olvashatatlan időbélyeg)")

    if generated.tzinfo is None:
        generated = generated.replace(tzinfo=now.tzinfo or timezone.utc)

    age_minutes = (now - generated).total_seconds() / 60

    # A future timestamp means a skewed clock or a hand-edited file. Trusting it
    # would be worse than admitting we do not know.
    if age_minutes < -1 or age_minutes > max_age_minutes:
        return _unmeasured("stale")

    status = str(payload.get("status", "")).strip().lower()

    if status != "ok":
        detail = payload.get("detail")

        return _unmeasured(status if status in _REASONS else "error", f" -- {detail}" if detail else "")

    events = payload.get("events") or []

    if not events:
        return {
            "state": "empty",
            "measured": True,
            "message": "Ma nincs naptári esemény.",
            "events": [],
        }

    return {
        "state": "ok",
        "measured": True,
        "message": f"{len(events)} esemény ma.",
        "events": events,
    }


def format_event(ev: dict) -> str:
    """One line per event: time range, title, and location when there is one."""
    title = (ev.get("title") or "(nincs cím)").strip()
    parts = []

    if ev.get("allDay"):
        parts.append("egész nap")
    else:
        start, end = _parse_iso(ev.get("start")), _parse_iso(ev.get("end"))
        parts.append(f"{start:%H:%M}-{end:%H:%M}" if start and end else "  ?  ")

    line = f"{parts[0]}  {title}"
    location = (ev.get("location") or "").strip()

    return f"{line} ({location})" if location else line


def load_snapshot():
    if not SNAPSHOT_PATH.exists():
        return None

    try:
        return json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return "malformed"  # distinct from "absent": the file is there but unusable


def main() -> int:
    ap = argparse.ArgumentParser(description="Read today's calendar snapshot")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--max-age-minutes", type=int, default=DEFAULT_MAX_AGE_MINUTES)
    args = ap.parse_args()

    raw = load_snapshot()
    result = interpret({} if raw == "malformed" else raw, datetime.now().astimezone(), args.max_age_minutes)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["measured"] else 3

    print(result["message"])

    for ev in result["events"]:
        print("  " + format_event(ev))

    return 0 if result["measured"] else 3


if __name__ == "__main__":
    sys.exit(main())
