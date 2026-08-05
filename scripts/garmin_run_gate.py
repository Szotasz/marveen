#!/usr/bin/env python3
"""Token-free gate in front of the garmin-run-watcher heartbeat.

The watcher used to be a `type: heartbeat` task: every tick woke Seven with a
prompt whose first step was to run running_analysis.py and fall silent when it
printed "Mar elemezve". Measured over 7 days that was 100% of the ticks -- a
model call per tick to learn that nothing happened. This script makes the
no-op path cost nothing and only wakes Seven when there is something to judge.

Exit-code contract of running_analysis.py (read from the source, not guessed --
running_analysis.py:157-196):

    main() -> 0  ... no runs at all, or latest run already analysed
    main() -> 1  ... NEW run; analysis written to pending_run_analysis.txt AND
                     last_analyzed_run.json advanced
    sys.exit(0 if result == 0 else 2)

so the process exits 0 for "nothing to do" and 2 for "new run". An uncaught
exception (Garmin login failure, network) exits 1. The codes already
discriminate, so we do NOT string-match the Hungarian output: those strings are
accented and inconsistent ("Mar elemezve" vs "Uj futas talalva") and a locale
or wording change would silently turn every tick into "nothing new".

WHY A CRASH IS NOT exit 0. The task spec asked for "already analysed OR error
-> exit 0". Folding the error branch into the silent branch would disarm the
failure alert this task is supposed to have: a broken Garmin login would look
exactly like "no new run" forever, and the 7-day/0-hit statistic could not tell
the two apart retrospectively. Crashes exit non-zero so failThreshold reports
them.

WHY WE ROLL THE STATE BACK. running_analysis.py advances
last_analyzed_run.json *before* anyone has been told about the run. If the
notify POST then fails (dashboard down, token rotated), the next tick reports
"already analysed" and that run is never assessed -- the marker would record
the attempt instead of the success, the same failure shape we just fixed in the
intel rhythm markers. So we snapshot the state file first and restore it when
the notify fails, which makes the whole gate idempotent: the next tick simply
finds the run again.
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

GARMIN_DIR = Path("/Users/gruzmanarnold/garmin-data")
ANALYSIS_SCRIPT = GARMIN_DIR / "running_analysis.py"
STATE_FILE = GARMIN_DIR / "last_analyzed_run.json"
PENDING_FILE = GARMIN_DIR / "pending_run_analysis.txt"

MARVEEN_DIR = Path("/Users/gruzmanarnold/marveen")
TOKEN_FILE = MARVEEN_DIR / "store" / ".dashboard-token"
MESSAGES_URL = "http://localhost:3420/api/messages"
# Proof-of-life artefact: its mtime answers "did the silent path actually run
# today", which "is the task enabled" does not.
HEARTBEAT_FILE = MARVEEN_DIR / "store" / "garmin-run-gate-last.txt"

RC_NOTHING_NEW = 0
RC_NEW_RUN = 2
SCRIPT_TIMEOUT_S = 120

# Seven must NOT re-run the analysis script. The gate has already run it and
# advanced the state, so a second run would print "Mar elemezve" and Seven
# would fall silent on the very run we woke her for.
NOTIFY_TEMPLATE = (
    "[garmin-run-gate] Uj futas erkezett (activity {activity_id}). "
    "A nyers metrikak keszen allnak: {pending}\n\n"
    "FONTOS: NE futtasd ujra a running_analysis.py-t -- a kapu mar lefuttatta es "
    "a last_analyzed_run.json mar elore lepett, egy ujabb futas 'Mar elemezve'-t "
    "irna es elnemitana ezt az elemzest. Csak olvasd be a fenti fajlt.\n\n"
    "Feladat: add hozza a sajat szakertoi egeszsegoR-ertekelesed (edzesterheles, "
    "HR-zona, hogyan illik a Kosice-maraton felkeszulesbe -- celverseny 2026-10-04, "
    "baseline RHR 51 / VO2max 45), jelezd ha valami elter a szokasostol, es kuldd el "
    "Arnoldnak a sajat Telegram csatornadon. Tomoren, folyo szovegben."
)


def read_state_snapshot() -> bytes | None:
    """The state file's bytes, or None when it does not exist yet."""
    try:
        return STATE_FILE.read_bytes()
    except FileNotFoundError:
        return None


def restore_state(snapshot: bytes | None) -> None:
    """Put the state file back the way it was before the analysis ran."""
    if snapshot is None:
        STATE_FILE.unlink(missing_ok=True)
    else:
        STATE_FILE.write_bytes(snapshot)


def current_activity_id() -> str:
    try:
        return str(json.loads(STATE_FILE.read_text()).get("last_activity_id", "?"))
    except (OSError, ValueError):
        return "?"


def notify_seven(activity_id: str) -> None:
    """Wake Seven. Raises on any failure so the caller can roll the state back."""
    token = TOKEN_FILE.read_text().strip()
    payload = json.dumps(
        {
            "from": "geordi",
            "to": "seven",
            "content": NOTIFY_TEMPLATE.format(
                activity_id=activity_id, pending=PENDING_FILE
            ),
        }
    ).encode()
    req = urllib.request.Request(
        MESSAGES_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    # 15s -- see the note in memoria_heartbeat_gate.wake_agent. The dashboard is
    # not slow (~3ms); it used to be frozen by the very spawnSync that started
    # this script, so no timeout on this side could have helped. This path would
    # have suffered most: a failed notify rolls the Garmin state back and the
    # retry is the next cron tick, 9 hours away (0 10,19).
    with urllib.request.urlopen(req, timeout=15) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"messages API returned HTTP {resp.status}")


def touch_heartbeat(note: str) -> None:
    HEARTBEAT_FILE.parent.mkdir(parents=True, exist_ok=True)
    HEARTBEAT_FILE.write_text(note + "\n")


def main() -> int:
    snapshot = read_state_snapshot()

    try:
        proc = subprocess.run(
            [sys.executable, str(ANALYSIS_SCRIPT)],
            cwd=str(GARMIN_DIR),
            capture_output=True,
            text=True,
            timeout=SCRIPT_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        print(f"running_analysis.py timed out after {SCRIPT_TIMEOUT_S}s", file=sys.stderr)
        return 1

    rc = proc.returncode

    if rc == RC_NOTHING_NEW:
        touch_heartbeat("nothing-new")
        return 0

    if rc != RC_NEW_RUN:
        # Crash or unknown code. Surface it -- do not let it read as "no run".
        print(f"running_analysis.py exited {rc}", file=sys.stderr)
        print(proc.stdout[-2000:], file=sys.stderr)
        print(proc.stderr[-2000:], file=sys.stderr)
        return 1

    activity_id = current_activity_id()
    try:
        notify_seven(activity_id)
    except (urllib.error.URLError, OSError, RuntimeError, ValueError) as exc:
        restore_state(snapshot)
        print(
            f"new run {activity_id} found but notifying seven failed ({exc}); "
            "state rolled back, the next tick will find it again",
            file=sys.stderr,
        )
        return 1

    touch_heartbeat(f"new-run {activity_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
