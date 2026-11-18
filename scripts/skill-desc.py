#!/usr/bin/env python3
"""Print a skill's frontmatter description for the Level 0 index (skill-index.sh).

Usage: skill-desc.py <SKILL.md>   -> one line on stdout, empty when there is none

IDXBLOCK1118: skill-index.sh read the description with `grep -m1 "^description:"`,
so a YAML block scalar (`description: >`, `>-`, `|`, ... with the text on the
indented lines below) went into the index as a lone ">" or "|", and the skill
could not be found by keyword (10+ project skills on the live install). This
reads the frontmatter, joins a block scalar (or a plain scalar continued on
indented lines) into one line, and keeps what the one-liner did before:
every quote character dropped, cut at 120 CHARACTERS (not bytes, IDXCUT909),
no ellipsis.
"""
from __future__ import annotations

import re
import sys

LIMIT = 120
BLOCK_INDICATOR = re.compile(r'^[>|][-+0-9]*\s*(#.*)?$')


def frontmatter_lines(text: str) -> list[str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != '---':
        # No frontmatter: fall back to the whole file, as the grep did.
        return lines
    for i in range(1, len(lines)):
        if lines[i].strip() == '---':
            return lines[1:i]
    return lines[1:]


def description(lines: list[str]) -> str:
    for i, line in enumerate(lines):
        if not line.startswith('description:'):
            continue
        value = line[len('description:'):].strip()
        if value and not BLOCK_INDICATOR.match(value):
            return value
        # Block scalar, or an empty value continued on indented lines: take the
        # indented (and blank) lines that follow, up to the next top-level key.
        parts = []
        for nxt in lines[i + 1:]:
            if nxt.strip() and not nxt[:1].isspace():
                break
            if nxt.strip():
                parts.append(nxt.strip())
        # One table cell: line breaks of a `|` literal become spaces too.
        return ' '.join(parts)
    return ''


def main() -> int:
    try:
        with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
            text = f.read()
    except (IndexError, OSError):
        return 0
    desc = description(frontmatter_lines(text)).replace('"', '').replace("'", '')
    sys.stdout.write(desc[:LIMIT])
    return 0


if __name__ == '__main__':
    sys.exit(main())
