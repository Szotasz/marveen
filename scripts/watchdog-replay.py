#!/usr/bin/env python3
"""Replay delivered-but-unfinished inter-agent messages into a freshly
restarted agent session (extracted from watchdog.sh so it is testable).

MSGSZIVARGAS826: this is a RECORD-LESS injection path -- raw tmux send-keys
with no delivery row anywhere, which made a leaked message impossible to
attribute. Every replayed message now writes a dated marker line into the
dashboard log (argv[5]) so transcript-side detectors have an anchor. The
marker carries a FULL DATE deliberately: dashboard.log lines are time-only,
and hour-based filtering across days has already produced a false backlog
reading once.

argv: session_name agent_id cutoff_epoch data_file log_target
"""
import json
import subprocess
import sys
import time

session_name, agent_id, cutoff_str, data_file, log_target = sys.argv[1:6]
cutoff = int(cutoff_str)

with open(data_file) as f:
    msgs = json.load(f)

pending = [
    m for m in msgs
    if m.get('to_agent') == agent_id
       and m.get('status') == 'delivered'
       and m.get('completed_at') is None
       and m.get('created_at', 0) >= cutoff
]

if not pending:
    sys.exit(0)

print(f"[watchdog] {agent_id}: replaying {len(pending)} unfinished message(s)", flush=True)
time.sleep(15)  # let claude boot up and reach the prompt


def mark(msg_id: object, note: str) -> None:
    # Marker for transcript-side delivery detectors (MSGSZIVARGAS826): the
    # ONLY durable record this injection path produces, so it must never be
    # skipped on the injected branch. Best-effort: a marker failure must not
    # stop the replay itself.
    line = json.dumps({
        'time': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'msg': 'watchdog-replay injected',
        'id': msg_id,
        'agent': agent_id,
        'session': session_name,
        'note': note,
    }, ensure_ascii=False)
    try:
        with open(log_target, 'a') as lf:
            lf.write(line + '\n')
    except Exception as exc:  # noqa: BLE001
        print(f"[watchdog] marker write failed for msg {msg_id}: {exc}", file=sys.stderr, flush=True)


for m in pending:
    content = m.get('content', '')
    full_msg = f"[Újraküldés - feladat elveszett restart előtt]: {content}"
    chunk_size = 990
    for i in range(0, len(full_msg), chunk_size):
        chunk = full_msg[i:i + chunk_size]
        subprocess.run(['tmux', 'send-keys', '-t', session_name, '-l', chunk],
                       timeout=5, capture_output=True)
    subprocess.run(['tmux', 'send-keys', '-t', session_name, 'Enter'],
                   timeout=5, capture_output=True)
    mark(m.get('id'), 'replayed-after-restart')
    time.sleep(2)
