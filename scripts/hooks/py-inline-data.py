#!/usr/bin/env python3
"""INSTRFILES1104 A (Samu 69992/69997/70023, Dani 70000): is the python code of a Bash command DATA?

db-write-gate.mjs reads a quoted glob, or a glob in a heredoc body, as the literal name it is when no program in the
command runs that text as shell code (reShellsText). A python interpreter in the command makes that reading depend on
the python code: code that only reads and prints is data; code that can start a process, reflect, or expand a pattern
itself is not. This file decides that with a CLOSED allowlist (a deny list of handles was bypassed round after round):
the code is data only when every python invocation in the command shows its code (-c CODE, or a heredoc on
`python3 -` / bare `python3`) and every such code passes check_code() below. Anything else is "strict": a script
file, -m, code from a pipe, an expanding word, a command substitution, code the ast cannot parse.

The gate runs it as `/usr/bin/python3 -I -S <this file>` with the command on stdin and reads one line:
"data", or "strict <reason>". Any other outcome (no interpreter, a timeout, a crash) is strict on the gate side.
`--selftest` checks the allowlist against the interpreter running it (a test runs it under each python it finds).

Nothing here runs, imports or evaluates the code it reads: ast.parse only.
"""
import ast
import builtins
import json
import re
import sys
import types

# The closed lists, measured over 7 days of sub-agent calls (work/instrfiles-a-pyscan2.txt in the PR's measurement):
# a module is here only if data code used it, and only with the attributes data code used. An attribute is never a
# module (--selftest), so no dotted access reaches sys, builtins or os through an allowed module (re.enum.sys, ...).
MODULE_ATTRS = {
    'ast': ['parse'],
    'base64': ['b64encode', 'b64decode'],
    'collections': ['Counter', 'OrderedDict', 'defaultdict'],
    'csv': ['reader', 'writer', 'DictWriter'],
    'datetime': ['datetime', 'date', 'timedelta', 'UTC'],
    'difflib': ['unified_diff', 'SequenceMatcher'],
    'hashlib': ['sha256', 'md5'],
    'html': ['unescape', 'escape'],
    'io': ['open'],
    'itertools': ['product'],
    'json': ['load', 'dump', 'dumps', 'JSONDecoder', 'loads'],
    'math': ['pi', 'sin', 'ceil', 'sqrt', 'log', 'radians', 'cos'],
    'random': ['seed', 'shuffle', 'random', 'uniform'],
    're': ['sub', 'search', 'findall', 'S', 'M', 'match', 'finditer', 'I', 'compile', 'fullmatch', 'escape', 'subn',
           'split'],
    'statistics': ['median', 'mean', 'stdev'],
    'struct': ['pack', 'unpack', 'unpack_from'],
    'sys': ['stdin', 'argv', 'exit', 'stderr'],
    'time': ['time', 'strftime', 'localtime', 'sleep'],
    'unicodedata': ['category', 'normalize', 'combining'],
    'xml.etree.ElementTree': ['parse'],
    'zlib': ['compress', 'crc32'],
}
MODULES = set(MODULE_ATTRS)
# Builtins data code may name (open: measured need, and no pattern-expanding API can be in data code, rule (5)).
BUILTINS_OK = {'print', 'len', 'sorted', 'range', 'enumerate', 'zip', 'min', 'max', 'sum', 'str', 'int', 'float', 'list',
               'dict', 'set', 'tuple', 'isinstance', 'any', 'all', 'map', 'filter', 'reversed', 'abs', 'round', 'repr',
               'bool', 'open', 'next', 'iter', 'ord', 'chr', 'hex', 'oct', 'bin', 'divmod', 'slice', 'bytes',
               'bytearray'}
# Never, as a name or an attribute, whatever else holds.
NEVER = {'getattr', 'setattr', 'delattr', 'vars', 'globals', 'locals', 'eval', 'exec', 'compile', '__import__',
         'breakpoint', 'help', 'input'}
OK_DUNDER = {'__name__', '__main__', '__file__', '__tests__'}
# The builtin exception classes may be named (except ValueError:, raise SystemExit(1)).
EXC_NAME = re.compile(r'[A-Z]\w*(?:Error|Exception|Warning|Exit|Interrupt|Iteration)')
DUNDER = re.compile(r'__\w+__')
# rule (5), Dani 70000 / Samu 69997: a pattern-expanding or directory-walking API anywhere in the text
GLOB_API = re.compile(r'\b(?:glob|iglob|fnmatch|fnmatchcase|scandir|listdir|iterdir|rglob|walk|pathlib|Path)\b')
# R7: frame, code and traceback object attributes (gi_frame.f_builtins holds eval); as an attribute, and (Samu 70023 (4))
# as a word anywhere in the text
FRAME_ATTR = re.compile(r'(?:gi|cr|ag|f|tb|co)_')
FRAME_WORD = re.compile(r'(?<![A-Za-z0-9])(?:gi|cr|ag|f|tb|co)_[A-Za-z]')
PY_NAME = re.compile(r'(?:python|pypy)(?:\d+(?:\.\d+)*)?')
# wrappers that run the next word as a program: an expanding word after one is a program name we cannot see
WRAPPERS = {'env', 'exec', 'command', 'nohup', 'timeout', 'nice', 'time', 'sudo', 'stdbuf', 'caffeinate', 'builtin',
            'chrt', 'ionice', 'taskset', 'setsid', 'arch', 'uv', 'poetry', 'pipenv', 'conda', 'pyenv', 'npx'}
# python options that take no argument (combined, -IS), and those that take one
FLAGS = set('IsSEBdOquvbRxPh')
FLAGS_ARG = {'-W', '-X'}


class Strict(Exception):
    pass


def scan(cmd):
    """Split a Bash command into simple commands: [{'words': [(text, expands)], 'heredocs': [(body, quoted)],
    'stdin': bool}]. Raises Strict on what it does not model (a command substitution, an unterminated quote)."""
    cmds, cur = [], {'words': [], 'heredocs': [], 'stdin': False}
    pending = []          # heredocs declared on the current line: (command, delimiter, quoted, strip_tabs)
    i, n = 0, len(cmd)
    word, expands, in_word = [], False, False
    redirect = None       # 'skip' (the next word is a redirection target) or 'heredoc'

    def end_word():
        nonlocal word, expands, in_word, redirect
        if in_word:
            text = ''.join(word)
            if redirect == 'heredoc':
                if expands and '$' in text:
                    raise Strict('heredoc-delimiter')
                pending.append((cur, text.replace('\x00', ''), '\x00' in text, redirect_strip))
            elif redirect != 'skip':
                cur['words'].append((text.replace('\x00', ''), expands))
            redirect = None
        word, expands, in_word = [], False, False

    def end_cmd():
        nonlocal cur
        end_word()
        if redirect is not None:
            raise Strict('redirect')
        if cur['words'] or cur['heredocs'] or cur['stdin']:
            cmds.append(cur)
        cur = {'words': [], 'heredocs': [], 'stdin': False}

    redirect_strip = False
    while i < n:
        c = cmd[i]
        if c == '\\':
            if i + 1 < n and cmd[i + 1] == '\n':
                i += 2
                continue
            word.append(cmd[i + 1] if i + 1 < n else '')
            in_word = True
            i += 2
            continue
        if c == "'":
            j = cmd.find("'", i + 1)
            if j < 0:
                raise Strict('quote')
            word.append(cmd[i + 1:j] + '\x00')
            in_word = True
            i = j + 1
            continue
        if c == '"':
            j = i + 1
            buf = []
            while j < n and cmd[j] != '"':
                if cmd[j] == '\\' and j + 1 < n:
                    buf.append(cmd[j:j + 2] if cmd[j + 1] not in '$`"\\\n' else cmd[j + 1])
                    j += 2
                    continue
                if cmd[j] == '`' or cmd.startswith('$(', j):
                    raise Strict('substitution')
                if cmd[j] == '$':
                    expands = True
                buf.append(cmd[j])
                j += 1
            if j >= n:
                raise Strict('quote')
            word.append(''.join(buf) + '\x00')
            in_word = True
            i = j + 1
            continue
        if c == '`' or cmd.startswith('$(', i) or cmd.startswith('<(', i) or cmd.startswith('>(', i):
            raise Strict('substitution')
        if c == '$':
            expands = True
            word.append(c)
            in_word = True
            i += 1
            continue
        if c == '#' and not in_word:
            j = cmd.find('\n', i)
            i = n if j < 0 else j
            continue
        if c == '\n':
            end_cmd()
            for owner, delim, quoted, strip in pending:
                lines = []
                j = i + 1
                while True:
                    k = cmd.find('\n', j)
                    line = cmd[j:] if k < 0 else cmd[j:k]
                    if (line.lstrip('\t') if strip else line) == delim:
                        i = (n - 1) if k < 0 else k
                        break
                    if k < 0:
                        raise Strict('heredoc-unterminated')
                    lines.append(line.lstrip('\t') if strip else line)
                    j = k + 1
                owner['heredocs'].append(('\n'.join(lines), quoted))
            pending.clear()
            i += 1
            continue
        if c in ' \t':
            end_word()
            i += 1
            continue
        if c in ';&|()':
            end_cmd()
            i += 1
            continue
        if c in '<>':
            if in_word and re.fullmatch(r'\d+', ''.join(word)):
                word, in_word = [], False
            end_word()
            if cmd.startswith('<<<', i):
                cur['stdin'] = True
                redirect = 'skip'
                i += 3
            elif cmd.startswith('<<', i):
                redirect_strip = cmd.startswith('<<-', i)
                redirect = 'heredoc'
                i += 3 if redirect_strip else 2
            elif c == '<':
                cur['stdin'] = True
                redirect = 'skip'
                i += 2 if cmd.startswith('<>', i) else 1
            else:
                redirect = 'skip'
                i += 1
                while i < n and cmd[i] in '>|&':
                    i += 1
            continue
        word.append(c)
        in_word = True
        i += 1
    if pending:
        raise Strict('heredoc-unterminated')
    end_cmd()
    return cmds


def invocations(cmds):
    """The python code of every python invocation, or Strict when one does not show its code."""
    codes = []
    for cmd in cmds:
        words = cmd['words']
        k = 0
        while k < len(words) and re.fullmatch(r'[A-Za-z_]\w*=.*', words[k][0], re.S) and not words[k][1]:
            k += 1
        if k < len(words) and words[k][1]:
            raise Strict('program-expands')
        if k < len(words) and words[k][0].rsplit('/', 1)[-1] in WRAPPERS and any(e for _, e in words[k + 1:]):
            raise Strict('wrapper-expands')
        for idx, (w, _) in enumerate(words):
            if not PY_NAME.fullmatch(w.rsplit('/', 1)[-1].lower()):
                continue
            j = idx + 1
            code = None
            while j < len(words):
                opt, e = words[j]
                if e:
                    raise Strict('option-expands')
                if opt == '-c':
                    if j + 1 >= len(words) or words[j + 1][1]:
                        raise Strict('code-expands')
                    code = words[j + 1][0]
                    break
                if opt == '-m':
                    raise Strict('script-or-module')
                if opt in FLAGS_ARG:
                    j += 2
                    continue
                if opt.startswith('-') and len(opt) > 1 and set(opt[1:]) <= FLAGS:
                    j += 1
                    continue
                break
            if code is None:
                first = words[j][0] if j < len(words) else None
                if first is not None and not first.startswith('-'):
                    raise Strict('script-or-module')
                if first is not None and first != '-':
                    raise Strict('option')
                if cmd['stdin'] or len(cmd['heredocs']) != 1:
                    raise Strict('stdin')
                body, quoted = cmd['heredocs'][0]
                if not quoted and re.search(r'[$`\\]', body):
                    raise Strict('heredoc-expands')
                code = body
            codes.append(code)
    return codes


def free_name_ok(name):
    return name in BUILTINS_OK or name in OK_DUNDER or bool(EXC_NAME.fullmatch(name))


def check_code(code):
    """None when the code is data, else the first reason it is not."""
    for d in DUNDER.findall(code):
        if d not in OK_DUNDER:
            return 'dunder'
    if 'format_map' in code:
        return 'format_map'
    if GLOB_API.search(code):
        return 'globapi'
    try:
        tree = ast.parse(code)
    except Exception:
        return 'unparsed'
    alias, modpaths, local = {}, set(), set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.name not in MODULES:
                    return 'import'
                modpaths.add(a.name)
                bound = a.asname or a.name.split('.')[0]
                alias[bound] = a.name if a.asname else bound
        elif isinstance(n, ast.ImportFrom):
            if n.level or not n.module:
                return 'import'
            for a in n.names:
                full = n.module + '.' + a.name
                if a.name == '*':
                    return 'import-star'
                if full in MODULES:
                    modpaths.add(full)
                    alias[a.asname or a.name] = full
                elif a.name in MODULE_ATTRS.get(n.module, ()):
                    local.add(a.asname or a.name)
                else:
                    return 'import'
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            local.add(n.name)
        elif isinstance(n, ast.arg):
            local.add(n.arg)
        elif isinstance(n, ast.Name) and not isinstance(n.ctx, ast.Load):
            local.add(n.id)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            local.add(n.name)
        elif type(n).__name__ in ('MatchAs', 'MatchStar') and getattr(n, 'name', None):
            local.add(n.name)
        elif type(n).__name__ == 'MatchMapping' and getattr(n, 'rest', None):
            local.add(n.rest)
    if set(alias) & local:
        return 'module-rebound'
    prefixes = {'.'.join(p.split('.')[:k]) for p in modpaths for k in range(1, p.count('.') + 2)}
    parent = {}
    for p in ast.walk(tree):
        for c in ast.iter_child_nodes(p):
            parent[c] = p
    for n in ast.walk(tree):
        if isinstance(n, ast.Attribute):
            a = n.attr
            if a in NEVER and a != 'compile':      # re.compile: a module pair below; running code needs exec/eval
                return 'never'
            if a.startswith('_') and not DUNDER.fullmatch(a):
                return 'private'
            if FRAME_ATTR.match(a):
                return 'frame'
            up = parent.get(n)
            if a == 'format' and isinstance(up, ast.Call) and up.func is n and not (
                    isinstance(n.value, ast.Constant) and isinstance(n.value.value, str)):
                return 'format'
            if isinstance(up, ast.Attribute):
                continue
            parts, base = [], n
            while isinstance(base, ast.Attribute):
                parts.append(base.attr)
                base = base.value
            if not (isinstance(base, ast.Name) and base.id in alias):
                continue
            path, rest = alias[base.id], parts[::-1]
            while rest and path + '.' + rest[0] in prefixes:
                path = path + '.' + rest.pop(0)
            if not rest or path not in MODULES or rest[0] not in MODULE_ATTRS[path]:
                return 'module-attr'
        elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
            if n.id in NEVER:
                return 'never'
            if n.id in alias:
                if not isinstance(parent.get(n), ast.Attribute):
                    return 'bare-module'
            elif n.id not in local and not free_name_ok(n.id):
                return 'builtin'
    if FRAME_WORD.search(code):
        return 'frame-word'
    return None


def verdict(cmd):
    try:
        codes = invocations(scan(cmd))
    except Strict as e:
        return 'strict ' + str(e)
    for code in codes:
        why = check_code(code)
        if why:
            return 'strict ' + why
    return 'data'


def selftest():
    """Samu 70023 (3): no allowed attribute is a module, a frame, a code object or a function's way to one; and the
    same holds one level down (datetime.datetime.<attr>). A python update that breaks it fails this, not the gate."""
    import importlib
    bad = []
    kinds = (types.ModuleType, types.FrameType, types.CodeType, types.TracebackType, types.GeneratorType)
    for mod, attrs in MODULE_ATTRS.items():
        try:
            m = importlib.import_module(mod)
        except Exception as e:
            bad.append(f'{mod}: import {type(e).__name__}')
            continue
        for a in attrs:
            if not hasattr(m, a):
                continue            # not in this python (datetime.UTC < 3.11): the code fails, it reaches nothing
            v = getattr(m, a)
            if isinstance(v, kinds):
                bad.append(f'{mod}.{a}: {type(v).__name__}')
                continue
            for b in dir(v):
                if b.startswith('_'):
                    continue
                try:
                    w = getattr(v, b)
                except Exception:
                    continue
                if isinstance(w, kinds):
                    bad.append(f'{mod}.{a}.{b}: {type(w).__name__}')
    for name in BUILTINS_OK:
        if not hasattr(builtins, name):
            bad.append(f'builtin {name}: missing')
    return bad


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        print(json.dumps({'python': sys.version.split()[0], 'bad': selftest()}))
    else:
        print(verdict(sys.stdin.read()))
