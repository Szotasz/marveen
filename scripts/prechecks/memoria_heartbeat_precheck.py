#!/usr/bin/env python3
"""PRECHECKSZURO1004 -- preCheck for the memoria-heartbeat scheduled task.

The round reviews "what happened since the previous round" in the MAIN
agent's session. Measured on one install over 72 h (232 rounds): every round
that wrote a memory or a skill had either main-session tool calls or an
inbound message in its window; 131 rounds had neither and all 131 ended
"quiet". So: nothing happened since the last closing stamp -> nothing to
review. Only an EMPTY window counts: some productive rounds followed just 1-3
tool calls, so "little work" is not a safe signal.

Install-agnostic: the install root is this file's grandparent (scripts/
prechecks/ -> root); the main agent's transcripts are looked up under every
config root the dashboard itself considers (~/.claude, <root>/.channels-config,
MAIN_AGENT_CONFIG_DIR from the environment or <root>/.env), in the folder
Claude Code names after the root (every character other than a letter, a
digit or "-" becomes "-"). Activity in ANY candidate counts, so a wrong guess
can only make the round run, never skip it.

Contract (schedule-runner.ts runPreCheck): stdout "SKIP" skips the LLM round,
anything else (or a non-zero exit, a crash, a timeout) runs it. This script
FAILS OPEN: every error path prints nothing and exits 0, so the round runs.

Modes (file MODE_PATH, one word; absent or unknown = DEFAULT_MODE):
  shadow  never prints SKIP; only logs what it would have done.
  live    prints SKIP when the window is empty.
Every decision is logged as one JSON line to LOG_PATH, in both modes.

Safety net: if the last stamp is older than MAX_SILENCE_S, the round runs
regardless (a stamp that stopped being written must not silence the task).

Paths are overridable by environment variables for the tests only.
"""
import glob
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

ROOT = os.environ.get('MHP_ROOT') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE_PATH = os.environ.get('MHP_STATE_PATH', f'{ROOT}/store/memoria-heartbeat-state.json')
LOG_PATH = os.environ.get('MHP_LOG_PATH', f'{ROOT}/store/precheck/memoria-heartbeat.jsonl')
MODE_PATH = os.environ.get('MHP_MODE_PATH', f'{ROOT}/store/precheck/memoria-heartbeat.mode')
MAX_SILENCE_S = 4 * 3600
# The mode when MODE_PATH is absent or holds anything else. A release decision:
# 'shadow' logs only and never skips; 'live' skips an empty window.
DEFAULT_MODE = 'shadow'
STAMP_FILE_NAME = 'memoria-heartbeat-state.json'


def project_dir_name(root):
    """Claude Code's projects-folder name for a cwd: every character that is not
    a letter, a digit or '-' becomes '-', with no collapsing."""
    return re.sub(r'[^A-Za-z0-9-]', '-', root)


def env_file_value(key):
    try:
        with open(os.path.join(ROOT, '.env'), encoding='utf-8') as fh:
            for line in fh:
                if line.startswith(f'{key}='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ''


def transcript_dirs():
    """Every folder that may hold the main agent's transcripts (see the docstring)."""
    override = os.environ.get('MHP_TRANSCRIPT_DIR')
    if override:
        return [override]
    roots = [os.path.expanduser('~/.claude'), os.path.join(ROOT, '.channels-config')]
    extra = os.environ.get('MAIN_AGENT_CONFIG_DIR') or env_file_value('MAIN_AGENT_CONFIG_DIR')
    if extra:
        roots.append(os.path.expanduser(extra))
    name = project_dir_name(ROOT)
    dirs, seen = [], set()
    for r in roots:
        d = os.path.join(r, 'projects', name)
        # A config root's projects/ is often a symlink to ~/.claude/projects:
        # the same folder must be read once, or every row counts twice.
        real = os.path.realpath(d)
        if os.path.isdir(d) and real not in seen:
            seen.add(real)
            dirs.append(d)
    return dirs


def parse_ts(value):
    return datetime.strptime(value[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp()


def read_mode():
    try:
        with open(MODE_PATH, encoding='utf-8') as fh:
            mode = fh.read().strip()
    except FileNotFoundError:
        return DEFAULT_MODE
    return mode if mode in ('shadow', 'live') else DEFAULT_MODE


def user_text(content):
    if isinstance(content, str):
        return content
    return ' '.join(x.get('text', '') for x in (content or []) if isinstance(x, dict) and x.get('type') == 'text')


def count_activity(since):
    """Main-session work after `since`: tool calls (the stamp itself excluded),
    [Inbox] nudges, and direct (non-scheduled, non-meta) user prompts."""
    counts = {'tool_uses': 0, 'inbox': 0, 'prompts': 0, 'files': 0}
    paths = [p for d in transcript_dirs() for p in glob.glob(os.path.join(d, '*.jsonl'))]
    if not paths:
        raise FileNotFoundError('no main-agent transcript folder found')
    for path in paths:
        if os.path.getmtime(path) < since:
            continue
        counts['files'] += 1
        with open(path, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                # Cheap pre-filter: only rows newer than the stamp matter.
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                ts = row.get('timestamp')
                if not ts or parse_ts(ts) <= since:
                    continue
                kind = row.get('type')
                content = (row.get('message') or {}).get('content')
                if kind == 'assistant':
                    for block in content or []:
                        if isinstance(block, dict) and block.get('type') == 'tool_use':
                            if STAMP_FILE_NAME in json.dumps(block.get('input')):
                                continue
                            counts['tool_uses'] += 1
                elif kind == 'user' and not row.get('isMeta'):
                    if isinstance(content, list) and any(
                            isinstance(x, dict) and x.get('type') == 'tool_result' for x in content):
                        continue
                    text = user_text(content).lstrip()
                    if text.startswith('[Inbox]') or text.startswith('<channel'):
                        counts['inbox'] += 1
                    elif text and not text.startswith('SCHEDULED TASK NOTICE') and not text.startswith('<'):
                        counts['prompts'] += 1
    return counts


def log(entry):
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, 'a', encoding='utf-8') as fh:
        fh.write(json.dumps(entry) + '\n')


def decide(now):
    """Returns (would_skip, entry) -- entry is the log line."""
    entry = {'ts': datetime.fromtimestamp(now, timezone.utc).isoformat(timespec='seconds')}
    with open(STATE_PATH, encoding='utf-8') as fh:
        last = int(json.load(fh)['last_run_at'])
    entry['last_run_at'] = last
    entry['silence_s'] = int(now - last)
    if now - last > MAX_SILENCE_S:
        entry['reason'] = 'max-silence'
        return False, entry
    counts = count_activity(last)
    entry.update(counts)
    empty = counts['tool_uses'] == 0 and counts['inbox'] == 0 and counts['prompts'] == 0
    entry['reason'] = 'empty-window' if empty else 'activity'
    return empty, entry


def main():
    now = time.time()
    mode = read_mode()
    try:
        would_skip, entry = decide(now)
    except Exception as err:  # fail open: the round runs
        try:
            log({'ts': datetime.fromtimestamp(now, timezone.utc).isoformat(timespec='seconds'),
                 'mode': mode, 'would_skip': False, 'skipped': False, 'error': f'{type(err).__name__}: {err}'})
        except Exception:
            pass
        return 0
    skipped = would_skip and mode == 'live'
    entry.update({'mode': mode, 'would_skip': would_skip, 'skipped': skipped})
    try:
        log(entry)
    except Exception:
        pass
    if skipped:
        print('SKIP')
    return 0


if __name__ == '__main__':
    sys.exit(main())
