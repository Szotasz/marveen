#!/usr/bin/env python3
"""
Reference heartbeat gate (see README - "The heartbeat gate pattern").

The shell invocation of THIS script is the mandatory local-only keep-alive tool
call: the heartbeat LLM-turn is not skipped, it just becomes cheap. The script
does the deterministic checks outside the model and prints a compact JSON with
`has_signal`.

Heartbeat contract (in the task prompt):
  has_signal == false -> write one short line and STOP (no external message).
  has_signal == true  -> the model judges and notifies.

Checks: urgent unread mail (last ~70 min), kanban cards due today, calendar
events starting within the next 60 min (macOS Calendar.app). Adapt to taste.
"""
import json
import os
import subprocess
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fleet          # noqa: E402
import mail_triage    # noqa: E402

# Same file the transport's keep-alive directive appends to; the Bash call that
# runs this script is itself the keep-alive, this line just makes it auditable.
KEEPALIVE_LOG = os.environ.get("KEEPALIVE_LOG", "/tmp/agent-keepalive.log")


def keepalive_touch():
    ts = datetime.now().isoformat(timespec="seconds")
    try:
        with open(KEEPALIVE_LOG, "a") as f:
            f.write(f"{ts} keepalive gate\n")
    except OSError:
        pass
    return ts


def calendar_soon(minutes=60):
    us, rs = chr(31), chr(30)
    script = f'''
    set US to (ASCII character 31)
    set RS to (ASCII character 30)
    set d0 to (current date)
    set d1 to d0 + ({minutes} * minutes)
    set outp to ""
    tell application "Calendar"
        repeat with c in calendars
            try
                set evs to (every event of c whose start date is greater than or equal to d0 and start date is less than d1)
                repeat with e in evs
                    set sd to start date of e
                    set hh to (hours of sd) as string
                    set mm to text -2 thru -1 of ("0" & ((minutes of sd) as string))
                    set outp to outp & (summary of e) & US & hh & ":" & mm & US & (name of c) & RS
                end repeat
            end try
        end repeat
    end tell
    return outp
    '''
    try:
        p = subprocess.run(["osascript", "-e", script], capture_output=True,
                           text=True, timeout=45)
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return {"events": [], "error": f"osascript: {e}"}
    if p.returncode != 0:
        return {"events": [], "error": (p.stderr or "failed").strip()[:200]}
    events, seen = [], set()
    for rec in p.stdout.split(rs):
        parts = rec.strip().split(us)
        if len(parts) < 3:
            continue
        key = (parts[0].strip(), parts[1].strip())
        if key in seen:
            continue
        seen.add(key)
        events.append({"summary": parts[0].strip(), "start": parts[1].strip(),
                       "calendar": parts[2].strip()})
    events.sort(key=lambda e: e["start"])
    return {"events": events, "error": None}


def main():
    keepalive_ts = keepalive_touch()
    mail = mail_triage.triage(70)
    try:
        kanban_due = fleet.kanban_due_today()
        kanban_err = None
    except Exception as e:
        kanban_due, kanban_err = [], str(e)
    cal = calendar_soon(60)
    has_signal = bool(mail["important"] or kanban_due or cal["events"])
    print(json.dumps({
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "keepalive_ran": True,
        "keepalive_ts": keepalive_ts,
        "checks": {
            "mail_important": mail["important"],
            "mail_review_count": len(mail["review"]),
            "kanban_due": kanban_due,
            "kanban_error": kanban_err,
            "calendar_next_60min": cal["events"],
            "calendar_error": cal["error"],
        },
        "has_signal": has_signal,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
