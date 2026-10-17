#!/usr/bin/env python3
"""memory-frontmatter-gate.py -- PreToolUse gate for Write/Edit/MultiEdit on memory files.

WHY (MEMFMGATE918, 2026-09-18): nine memory files in the fleet store had a
frontmatter that did not parse (an unquoted `description:` containing ": ",
one broken double-quoted scalar). The harness reads `description` to decide
recall relevance, so those nine memories were RECALL-BLIND: on disk, and
therefore "remembered", yet never retrievable. "I wrote it" is not the same
as "it can be read back". This gate parses the frontmatter of the file AS IT
WOULD BE AFTER THE WRITE, in the same step as the write, and blocks when it
does not parse.

SCOPE: only `<...>/projects/<slug>/memory/<file>.md`, never MEMORY.md (the
index has no frontmatter). Any other path passes untouched.

CONTRACT (hook-exit-code-invariant): exit 2 = block, the stderr text goes
back to the model with the fix; exit 0 = allow. This gate NEVER exits 1:
malformed stdin or an unreadable file is not a verdict, so it allows.

PARSER: PyYAML when importable (that is what the fleet's audit used to find
the nine); otherwise a strict subset check that rejects exactly the two
measured failure shapes (unquoted scalar with ": " inside, unbalanced
double quote). The verdict names which parser decided.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# HOOKDEPLOAD1008: guarded. Unguarded, a broken memory_frontmatter_lib.py failed
# at module load, before main(), with exit 1 -- the one code this gate promises
# never to return. A check that cannot load is no verdict on the write, so the
# gate allows it and says why on stderr, as it does for its internal errors.
try:
    from memory_frontmatter_lib import (  # noqa: E402  (the shared check, KAPUEGYUT918)
        _subset_check, is_memory_file, parse_frontmatter, split_frontmatter, tartalom_hiba,
    )
    _LIB_ERR = None
except Exception as _lib_exc:  # noqa: BLE001 -- SyntaxError, ImportError, anything
    _LIB_ERR = repr(_lib_exc)


def _read_stdin():
    try:
        raw = sys.stdin.read()
    except Exception:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def resulting_content(tool_name, tool_input):
    """The file body as it will stand after the tool runs, or None if unknowable."""
    path = tool_input.get('file_path')
    if tool_name == 'Write':
        content = tool_input.get('content')
        return content if isinstance(content, str) else None
    try:
        with open(path, encoding='utf-8') as fh:
            body = fh.read()
    except Exception:
        return None
    if tool_name == 'Edit':
        edits = [tool_input]
    elif tool_name == 'MultiEdit':
        edits = tool_input.get('edits')
        if not isinstance(edits, list):
            return None
    else:
        return None
    for e in edits:
        if not isinstance(e, dict):
            return None
        old, new = e.get('old_string'), e.get('new_string')
        if not isinstance(old, str) or not isinstance(new, str) or old == '':
            return None
        if old not in body:
            return None  # the Edit tool itself will fail; nothing to judge
        body = body.replace(old, new) if e.get('replace_all') else body.replace(old, new, 1)
    return body


def verdict(tool_name, tool_input):
    """Return None to allow, or the block reason."""
    if not isinstance(tool_input, dict):
        return None
    path = tool_input.get('file_path')
    if not is_memory_file(path):
        return None
    body = resulting_content(tool_name, tool_input)
    if body is None:
        return None
    return tartalom_hiba(body)


def main():
    payload = _read_stdin()
    if not isinstance(payload, dict):
        sys.exit(0)
    tool_name = payload.get('tool_name')
    if tool_name not in ('Write', 'Edit', 'MultiEdit'):
        sys.exit(0)
    if _LIB_ERR:
        sys.stderr.write('memory-frontmatter-gate: a kapu fuggosege (scripts/hooks/memory_frontmatter_lib.py) '
                         f'nem toltheto be ({_LIB_ERR}), a kapu ATENGED\n')
        sys.exit(0)
    try:
        reason = verdict(tool_name, payload.get('tool_input'))
    except Exception as ex:  # a crashing gate must not become a silent exit 1
        sys.stderr.write(f'memory-frontmatter-gate: belso hiba, a kapu ATENGED: {ex}\n')
        sys.exit(0)
    if reason:
        sys.stderr.write(reason + '\n')
        sys.exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
