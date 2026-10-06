#!/usr/bin/env python3
"""
Unwire one channel provider's progress hooks from a Claude Code settings.json.
The settings half of scripts/retire-progress-watchdog.sh -- run by that script,
not by hand.

Usage:
  python3 retire_progress_hooks.py <settings.json> <telegram|slack> <dry_run: 0|1>

Stdout contract (the shell side parses exactly this):
  REMOVED <event>: <command>     one line per hook entry taken out
  COUNT <n>                      always the last line, n = number of REMOVED

Why a separate file: this used to be a here-document inside a "$( ... )" in the
shell script. bash 3.2 -- the /bin/bash every macOS ships -- does not skip a
here-document body while it scans a command substitution for the closing
paren, so an apostrophe in a comment below ("provider's") read as an unclosed
quote and the WHOLE script died at parse time ("unexpected EOF while looking
for matching `''"), before retiring anything. bash 4+ parses it fine, which is
why Linux never showed it. Python that lives in its own file cannot break the
shell parser whatever it contains.
"""
import json
import sys


def main():
    if len(sys.argv) != 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    settings_path, provider, dry_run = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
    with open(settings_path, encoding='utf-8') as f:
        cfg = json.load(f)
    hooks = cfg.get('hooks') or {}

    # Match this provider's progress hooks by the script filename they invoke:
    # <provider>_progress.py, _clear.py, _reply_clear.py, _watchdog.py. Matching on
    # the filename (not the whole command) keeps this robust to the interpreter
    # path and to any bash -c wrapper the installer may have used.
    needle = f"{provider}_progress"
    removed = []

    for event, groups in list(hooks.items()):
        if not isinstance(groups, list):
            continue
        for group in list(groups):
            entries = group.get('hooks')
            if not isinstance(entries, list):
                continue
            keep = []
            for entry in entries:
                command = entry.get('command') or ''
                if needle in command:
                    removed.append(f"{event}: {command}")
                else:
                    keep.append(entry)
            if len(keep) != len(entries):
                group['hooks'] = keep
            # Prune a group left empty -- an empty matcher group is dead weight
            # that later installs would otherwise keep appending next to.
            if not group.get('hooks'):
                groups.remove(group)
        if not groups:
            del hooks[event]

    if removed and not dry_run:
        cfg['hooks'] = hooks
        with open(settings_path, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)

    for line in removed:
        print(f"REMOVED {line}")
    print(f"COUNT {len(removed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
