#!/usr/bin/env python3
"""memory-frontmatter-sweep.py -- the at-rest check of every fleet memory file (KAPUEGYUT918, PR2).

WHY: the two hooks (memory-frontmatter-gate.py on Write/Edit, memory-frontmatter-
bash-gate.py on Bash) only see writes made inside a Claude Code session, and the
Bash one only blames files the command names. A file written by a script run
outside any session, copied from another machine, or broken by a parallel writer
is seen by neither. This sweep reads them all, with the same parser, and REPORTS.
It never repairs: a memory file is someone's record, the fix is theirs.

WHAT IT READS: <home>/.claude/projects/*/memory/*.md and every
<repo>/agents/*/.claude-config/projects/*/memory/*.md (MEMORY.md excluded), each
realpath counted once: .claude-config/projects is a symlink, a naive walk counts
the same file up to 15 times.

WHAT IT SAYS, and when: the state file keeps the last broken set. The message to
Marveen goes out only when the set CHANGES (a new broken file, or one repaired),
with the full list of what is broken now. An unchanged set is one stdout line, not
a daily repeat of the same news (a repeated alarm is read past).

EXIT CODES (the scheduler's command task maps 0/1 to 0; only 2+ is an alert):
  0  nothing broken
  1  broken files exist (the verdict; the message carries it)
  2  the instrument failed. Counted PER SOURCE, because a glob skips an unreadable
     or missing directory silently: the home projects tree yields no memory file,
     or agent config dirs exist but none of them yields one. A sweep that sees
     nothing (or only half) must not look like a clean fleet.
  3  the message to Marveen could not be delivered
"""
import argparse
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, 'hooks'))
from memory_frontmatter_lib import tartalom_hiba  # noqa: E402


def memory_files(home, repo):
    """(sorted realpaths, per-source hit counts, whether agent config dirs exist)."""
    sources = {
        'home': os.path.join(home, '.claude', 'projects', '*', 'memory', '*.md'),
        'agents': os.path.join(repo, 'agents', '*', '.claude-config', 'projects', '*', 'memory', '*.md'),
    }
    seen, counts = {}, {}
    for name, pat in sources.items():
        hits = [p for p in glob.glob(pat) if os.path.basename(p) != 'MEMORY.md']
        counts[name] = len(hits)
        for p in hits:
            seen.setdefault(os.path.realpath(p), p)
    agent_configs = bool(glob.glob(os.path.join(repo, 'agents', '*', '.claude-config', 'projects')))
    return sorted(seen), counts, agent_configs


def sweep(files):
    broken = {}
    for p in files:
        with open(p, encoding='utf-8', errors='replace') as fh:
            reason = tartalom_hiba(fh.read())
        if reason:
            broken[p] = reason.split('. Javitas:')[0][:200]
    return broken


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--home', default=os.path.expanduser('~'))
    ap.add_argument('--repo', default=REPO)
    ap.add_argument('--state', default=os.path.join(REPO, 'store', 'memory-frontmatter-sweep.json'))
    ap.add_argument('--notify', action='store_true', help='message Marveen when the broken set changes')
    ap.add_argument('--agent-msg', default=os.path.join(REPO, 'scripts', 'agent-msg.sh'))
    a = ap.parse_args()

    try:
        files, counts, agent_configs = memory_files(a.home, a.repo)
        if counts['home'] == 0:
            print(f'MUSZER-HIBA: a home projects-fajabol egyetlen memoriafajl sem jott ({counts}), ez vak meres, nem tiszta flotta')
            return 2
        if agent_configs and counts['agents'] == 0:
            print(f'MUSZER-HIBA: vannak agens config-konyvtarak, de egyikbol sem jott memoriafajl ({counts}), a meres felig vak')
            return 2
        broken = sweep(files)
    except Exception as ex:
        print(f'MUSZER-HIBA: {type(ex).__name__}: {ex}')
        return 2

    try:
        with open(a.state, encoding='utf-8') as fh:
            before = set(json.load(fh).get('broken') or [])
    except Exception:
        before = set()
    now = set(broken)
    uj, javult = sorted(now - before), sorted(before - now)
    print(f'memoriafajl: {len(files)} (realpath szerint) | hibas frontmatter: {len(now)} | uj: {len(uj)} | javult: {len(javult)}')

    code = 1 if now else 0
    if a.notify and (uj or javult):
        sorok = [f'[memoria-frontmatter sopres] A recall-vak halmaz VALTOZOTT: {len(files)} fajlbol most {len(now)} hibas (uj {len(uj)}, javult {len(javult)}). Csak jelentes, a sopres nem javit.']
        for p in uj:
            sorok.append(f'UJ: {p} -- {broken[p]}')
        for p in sorted(now - set(uj)):
            sorok.append(f'marad: {p}')
        for p in javult:
            sorok.append(f'javult: {p}')
        r = subprocess.run(['bash', a.agent_msg, 'heartbeat', 'marveen', '-'], input='\n'.join(sorok), text=True, capture_output=True)
        if r.returncode != 0 or not r.stdout.startswith('OK'):
            print(f'ERTESITES SIKERTELEN: {r.stdout.strip()[:200]} {r.stderr.strip()[:200]}')
            return 3  # the state is NOT advanced: the next run tries again
    os.makedirs(os.path.dirname(a.state), exist_ok=True)
    tmp = a.state + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump({'broken': sorted(now), 'files': len(files)}, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, a.state)
    return code


if __name__ == '__main__':
    sys.exit(main())
