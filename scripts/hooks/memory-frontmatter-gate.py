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


def _read_stdin():
    try:
        raw = sys.stdin.read()
    except Exception:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def is_memory_file(path):
    if not isinstance(path, str) or not path.endswith('.md'):
        return False
    p = path.replace('\\', '/')
    if os.path.basename(p) == 'MEMORY.md':
        return False
    return '/projects/' in p and '/memory/' in p


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


def split_frontmatter(body):
    """Return the raw frontmatter text, or None when the file has none."""
    if not body.startswith('---\n'):
        return None
    end = body.find('\n---\n', 4)
    if end < 0:
        end = body.find('\n---', 4)
        if end < 0 or body[end:].strip() != '---':
            return None
    return body[4:end]


def _subset_check(fm):
    """Strict subset validator used when PyYAML is absent.

    Accepts `key: value` lines and one nested block (`metadata:`) with
    2-space indented `key: value` lines. Rejects the two measured shapes.
    """
    desc = None
    for ln in fm.split('\n'):
        if not ln.strip() or ln.lstrip().startswith('#'):
            continue
        stripped = ln.lstrip()
        if ':' not in stripped:
            return None, f'sor kettospont nelkul: {ln[:60]!r}'
        key, _, val = stripped.partition(':')
        key = key.strip()
        val = val.strip()
        if val == '':
            continue  # nested block header (metadata:) or empty scalar
        if val.startswith('"'):
            try:
                decoded = json.loads(val)
            except Exception:
                return None, f'{key}: torott dupla-idezojeles skalar'
            if not isinstance(decoded, str):
                return None, f'{key}: az idezojeles ertek nem szoveg'
            if key == 'description' and not ln.startswith(' '):
                desc = decoded
        elif val.startswith("'"):
            if not (val.endswith("'") and len(val) >= 2):
                return None, f'{key}: torott szimpla-idezojeles skalar'
            if key == 'description' and not ln.startswith(' '):
                desc = val[1:-1]
        else:
            if ': ' in val or val.endswith(':'):
                return None, f'{key}: idezojel nelkuli ertek ": "-tal (YAML mapping-hiba)'
            if val[0] in '[{&*!|>%@`':
                return None, f'{key}: idezojel nelkuli ertek YAML-vezerlo karakterrel indul ({val[0]!r})'
            if key == 'description' and not ln.startswith(' '):
                desc = val
    return {'description': desc}, None


def parse_frontmatter(fm):
    """Return (parser_name, data_dict_or_None, error_text_or_None)."""
    try:
        import yaml  # type: ignore
    except Exception:
        data, err = _subset_check(fm)
        return 'subset', data, err
    try:
        data = yaml.safe_load(fm)
    except Exception as ex:
        return 'pyyaml', None, str(ex).split('\n')[0][:160]
    if not isinstance(data, dict):
        return 'pyyaml', None, 'a frontmatter nem kulcs-ertek terkep'
    return 'pyyaml', data, None


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
    fm = split_frontmatter(body)
    if fm is None:
        return ('MEMORIA-FRONTMATTER KAPU: a fajlnak nincs `---` frontmattere, a recall igy nem latja. '
                'Kezdd igy: ---\\nname: <slug>\\ndescription: "<egy mondat>"\\nmetadata:\\n  type: <user|feedback|project|reference>\\n---')
    parser, data, err = parse_frontmatter(fm)
    if err is not None:
        return (f'MEMORIA-FRONTMATTER KAPU ({parser}): a frontmatter NEM parszol -> a memoria RECALL-VAK lenne. '
                f'Hiba: {err}. Javitas: a description erteket JSON-stilusu dupla idezojelbe tedd '
                f'(belso idezojel \\" alakban), es ird ujra a fajlt.')
    desc = data.get('description') if isinstance(data, dict) else None
    if not isinstance(desc, str) or not desc.strip():
        return (f'MEMORIA-FRONTMATTER KAPU ({parser}): nincs nem-ures `description` mezo, a recall ebbol dont. '
                f'Adj egy egy-mondatos description-t (idezojelben), es ird ujra a fajlt.')
    return None


def main():
    payload = _read_stdin()
    if not isinstance(payload, dict):
        sys.exit(0)
    tool_name = payload.get('tool_name')
    if tool_name not in ('Write', 'Edit', 'MultiEdit'):
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
