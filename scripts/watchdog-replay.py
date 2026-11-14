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
import re
import subprocess
import sys
import time

# ENVATLEAK1114: the SAME rule as src/web/pane-text.ts `neutralizeAtMentions`
# (and scripts/hooks/provenance-gate.py `pane_shape`): a backslash before every
# at-sign at the start of the text or after whitespace. Claude Code expands such
# an at-sign token into a file attachment with no tool call, and this script
# types message content straight into a pane. JS_SPACE is JavaScript's
# whitespace class spelled out, because Python's own class is a different set;
# src/__tests__/fixtures/pane-at-neutralize-vectors.json holds the shared cases.
JS_SPACE = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
AT_AFTER_SPACE_RX = re.compile("(^|[" + JS_SPACE + "])@")


def neutralize_at_mentions(text):
    return AT_AFTER_SPACE_RX.sub(lambda m: m.group(1) + "\\@", text or "")


# Test seam: `watchdog-replay.py --neutralize-vectors <file.json>` applies the
# function to every case's "in" and prints the results as JSON. Nothing is typed.
if len(sys.argv) == 3 and sys.argv[1] == "--neutralize-vectors":
    with open(sys.argv[2], encoding="utf-8") as vf:
        json.dump([neutralize_at_mentions(c["in"]) for c in json.load(vf)], sys.stdout)
    sys.exit(0)

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
    full_msg = neutralize_at_mentions(f"[Újraküldés - feladat elveszett restart előtt]: {content}")
    chunk_size = 990
    for i in range(0, len(full_msg), chunk_size):
        chunk = full_msg[i:i + chunk_size]
        subprocess.run(['tmux', 'send-keys', '-t', session_name, '-l', chunk],
                       timeout=5, capture_output=True)
    subprocess.run(['tmux', 'send-keys', '-t', session_name, 'Enter'],
                   timeout=5, capture_output=True)
    mark(m.get('id'), 'replayed-after-restart')
    time.sleep(2)
