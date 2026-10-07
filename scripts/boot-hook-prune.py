#!/usr/bin/env python3
"""Boot-time hook sanity check: prune stale hook commands from settings files.

Scans ~/.claude/settings.json and agents/*/.claude/settings.json.
Any hook command that references a path under a volatile tmpfs directory
(/tmp, /var/tmp, /private/tmp, /dev/shm) OR a path that no longer exists on
disk is removed from the hooks block. A path behind $HOME / ~ (and, in an
agent's own settings file, $CLAUDE_PROJECT_DIR) is resolved first; a path that
only resolves when the hook runs (relative, or behind any other variable) is
kept. The original file is backed up as <file>.bak before any modification.

Exit codes:
  0 -- scan completed (with or without pruning)
  non-zero -- unexpected error reading/writing a settings file (printed to stderr)

Environment variables:
  HOME        -- locates ~/.claude/settings.json and resolves $HOME / ${HOME} / ~
                 in hook commands (default: os.path.expanduser)
  INSTALL_DIR -- project root; agents are searched under $INSTALL_DIR/agents/
"""

import json
import os
import re
import shutil
import sys
import glob

# Volatile tmpfs prefixes: any hook command referencing these is transient.
_TMP_PREFIXES = ('/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/')


def _is_stale_command(command, project_dir=None):
    """Return True when the command references a volatile or non-existent path."""
    # Check for /tmp-like prefixes in the command string.
    if any(prefix in command for prefix in _TMP_PREFIXES):
        return True
    # Extract the first file path that looks like a script (.py / .mjs / .js / .sh).
    m = re.search(r'/[^\s\'"`;&|()<>=]+\.(?:py|mjs|js|sh)\b', command)
    if m:
        script_path = m.group(0)
        # The match is only an absolute path when nothing is glued in front of
        # it in the same shell word. `python3 "$HOME/x/hook.py"` used to be
        # checked as `/x/hook.py`, which never exists, so a live hook was
        # pruned on every boot.
        word = re.split(r'[\s;&|<>=(]', command[:m.start()])[-1]
        prefix = re.sub(r'[\'"]', '', word)
        if prefix in ('$HOME', '${HOME}', '~'):
            script_path = os.environ.get('HOME', os.path.expanduser('~')) + script_path
        elif prefix:
            # An agent's own settings file runs its hooks with the agent dir as
            # $CLAUDE_PROJECT_DIR, so such a path can be checked there.
            # ~/.claude/settings.json serves every project. Relative paths stay
            # unjudged: an earlier `cd` or a --cwd style option can move them.
            if project_dir is not None and prefix in ('$CLAUDE_PROJECT_DIR', '${CLAUDE_PROJECT_DIR}'):
                return not os.path.exists(project_dir + script_path)
            # Anything else in front ($PWD, $(git rev-parse ...), ~user, a
            # relative dir) resolves only when the hook runs, and the boot
            # environment says nothing about that, so the hook is kept.
            return False
        if not os.path.exists(script_path):
            return True
    return False


def _prune_hook_entries(entries, project_dir=None):
    """Remove stale command entries from a hook-event array; return (new_list, n_pruned)."""
    pruned = 0
    new_entries = []
    for entry in entries:
        if not isinstance(entry, dict):
            new_entries.append(entry)
            continue
        inner = entry.get('hooks', None)
        if inner is None:
            new_entries.append(entry)
            continue
        new_inner = []
        for h in inner:
            if isinstance(h, dict) and h.get('type') == 'command':
                cmd = h.get('command', '')
                if _is_stale_command(cmd, project_dir):
                    print(f'  prune: {cmd}', file=sys.stderr)
                    pruned += 1
                    continue
            new_inner.append(h)
        new_entry = dict(entry)
        new_entry['hooks'] = new_inner
        new_entries.append(new_entry)
    return new_entries, pruned


def prune_settings(path, project_dir=None):
    """Read path, remove stale hook commands, write back (with .bak). Returns n_pruned."""
    if not os.path.exists(path):
        return 0
    try:
        with open(path, encoding='utf-8') as f:
            settings = json.load(f)
    except Exception as exc:
        print(f'boot-hook-prune: skip {path}: {exc}', file=sys.stderr)
        return 0

    hooks = settings.get('hooks')
    if not isinstance(hooks, dict):
        return 0

    total_pruned = 0
    for event, entries in list(hooks.items()):
        if not isinstance(entries, list):
            continue
        new_entries, n = _prune_hook_entries(entries, project_dir)
        if n:
            hooks[event] = new_entries
            total_pruned += n

    if total_pruned:
        bak = path + '.bak'
        shutil.copy2(path, bak)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(settings, f, indent=2)
            f.write('\n')
        print(
            f'boot-hook-prune: pruned {total_pruned} stale hook(s) from {path} (backup: {bak})',
            file=sys.stderr,
        )
    return total_pruned


def main():
    home = os.environ.get('HOME', os.path.expanduser('~'))
    install_dir = os.environ.get('INSTALL_DIR', os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    targets = [(os.path.join(home, '.claude', 'settings.json'), None)]
    targets += [
        (path, os.path.dirname(os.path.dirname(path)))
        for path in glob.glob(os.path.join(install_dir, 'agents', '*', '.claude', 'settings.json'))
    ]

    total = 0
    for path, project_dir in targets:
        total += prune_settings(path, project_dir)

    if total:
        print(f'boot-hook-prune: {total} stale hook(s) removed across {len(targets)} file(s)', file=sys.stderr)


if __name__ == '__main__':
    main()
