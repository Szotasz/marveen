"""memory_frontmatter_lib.py -- the memory-file frontmatter check, shared by two hooks.

memory-frontmatter-gate.py (PreToolUse Write/Edit/MultiEdit) judges the body a
write WOULD produce; memory-frontmatter-bash-gate.py (Bash, KAPUEGYUT918)
judges the body a Bash call DID produce. One parser, one set of messages, so
the two paths cannot drift apart (MEMFMGATE918, KAPUEGYUT918).
"""
import json
import os


def is_memory_file(path):
    if not isinstance(path, str) or not path.endswith('.md'):
        return False
    p = path.replace('\\', '/')
    if os.path.basename(p) == 'MEMORY.md':
        return False
    return '/projects/' in p and '/memory/' in p


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


def tartalom_hiba(body):
    """The block reason for a memory file body, or None when its frontmatter is fine.

    Shared by the Write/Edit gate (the body as it WOULD stand after the write)
    and the Bash after-gate (the body as it DOES stand after the call).
    """
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
