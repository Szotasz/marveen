#!/usr/bin/env python3
"""Out-of-process watcher: do the PreToolUse security hooks still LOAD? (card 723bbb70, point (3))

THE HOLE IT COVERS. Claude Code reads a PreToolUse hook's exit code 2 as "block"; ANY other non-zero
exit is a non-blocking error and the tool call goes through. Measured 2026-10-08 (af12a1d3, on a throwaway
copy): when a gate FILE, or a module it imports at load time, is broken (a syntax error), every security
hook exits 1 -- the gate stands open. The command wrapper of 723bbb70 (1)-(2)
turns that exit into 2, so the gate closes instead -- and then a broken bash-egress-parser blocks every
Bash call of every sub-agent, which can then not even send a message to say so. Either way the failure
is silent where it happens. It has to be measured from outside, on the main agent's side, by a timer.

WHAT IT MEASURES. The hook list is derived at run time from the settings, never from a list file
shared with the wrapper: the PreToolUse union of <root>/.claude/settings.json and
<root>/agents/*/.claude/settings.json. A script that any of them calls in the "...; exit 0" helper
form is deliberately non-blocking and is left out (on this install: channel-image-resize and the two
memory-frontmatter gates). Each distinct command is run the way Claude Code runs it (/bin/sh -c,
CLAUDE_PROJECT_DIR set, cwd at the root, the hook's own timeout), but with a minimal environment instead of the
watcher's own (PATH, HOME, TZ, the locale, TMPDIR, PYTHONPATH, NODE_PATH, CLAUDE_PROJECT_DIR, PYTHONDONTWRITEBYTECODE),
and with a HARMLESS call on stdin: a Bash `true` when one of its matchers takes Bash -- so a gate that loads a dependency only on its Bash
branch is reached too -- otherwise a tool name no hook acts on. A loadable gate lets that call through
(exit 0, no deny). Anything else is a finding:
  OPEN    exit code other than 0 and 2 (a load error, a missing module, a signal): the call passes,
          the gate does not guard;
  CLOSED  exit 2, or a deny/block decision on stdout, for a harmless call: the gate blocks everything
          it is wired to (a load error behind the wrapper, a missing interpreter, a missing file);
  TIMEOUT the hook did not finish within its own timeout.
READ-ONLY. PYTHONDONTWRITEBYTECODE is set, and on this install the probe calls of all twelve commands
wrote nothing (strace, 2026-10-08). A hook's OWN designed logging still runs when its state calls for
it -- outgoing-copy-gate logs a missing or broken name-rules file on every call -- as on any real call.
LOCAL DEPENDENCIES (card 06c9aa79). A gate can load a module only on its own narrow path -- a signal gate loads
destructive-gate.py only for a command that sends a signal -- and the harmless call never reaches it: with that
module broken, the wrapped gate blocks every such command and nobody is told. So the gates' local dependencies
(files under <root>/scripts) are derived from their source at run time, transitively: python imports (resolved
in the importing file's directory, then scripts/lib, then a unique file of that name under scripts/) and quoted
.py/.mjs/.cjs/.js file names that exist (node's relative imports, destructive-gate.py, outgoing-copy-gate.py), read
from the source WITHOUT its comments (string literals kept; python imports without docstrings either): loading
executes, so a file a comment merely mentions is not loaded. Each one is loaded on its own WITHOUT running a main --
python -B under a module name other than __main__, node's import() from -e (a gate starts its main only as the entry
script) -- with stdin closed, the minimal environment above, a timeout and the process-group kill. A load still runs
the module's top level, so only a module whose top level is safe to run is loaded: one with a main guard (python's
if __name__ == "__main__", node's isInvokedDirectly() / process.argv[1] against import.meta.url, require.main ===
module), or a definitions-only library with nothing to guard (imports, defs, classes, assignments, a docstring, a
sys.path change; node: import, export, const, let, var, function, class). Any other dependency is NOT loaded but
reported as UNGUARDED (NINCS MAIN-ŐR): its top level is its main -- a sender script would send -- and only its syntax
is checked (compile, node --check; a broken one is an IMPORT finding). A module that does not load is an IMPORT
finding, named with the gates that reach it, in the same alert. A dependency the source NAMES whose file is not there is a MISSING finding ("HIÁNYZIK: <path>"),
in the same alert, because the gate fails on it the same way (card 06c9aa79 (2)): a python import that is neither
stdlib, nor a local file (resolved as above), nor an installed module (searched outside the install root), shown
at the importing file's directory and scripts/lib; and a file name in a load form -- os.path.join(..., "<name>")
in python, a relative import/require specifier in node -- shown at the path it resolves to. The missing rule reads the
source without its comments and (python) docstrings: a commented-out load or import is no finding (card 06c9aa79 (3)).
WHAT IT DOES NOT SEE. A dependency whose path is put together at run time (a computed or formatted path, a name
read from config or the environment) rather than written as a literal; a node specifier without its extension; a
python name that two files under scripts/ share (ambiguous: neither loaded nor reported). A quoted file name in
any other form (pathlib's / or with_name, a bare string to spec_from_file_location, a message) is loaded when the
file exists, but its absence is not reported; a python source that does not tokenize gets no missing finding from its text
(its own load fails, which the probes report); a node side-effect import (import "./x.mjs") is not in the missing rule (a
static one breaks its gate, which the command probe reports). In a node source, a regex literal right after a division
operator (n / /re/.source.length) is read as a second division, not as a doubtful case: a comment opener inside it (two
slashes, or a slash and an asterisk) is taken for one, and a load in the stretch it blanks (the rest of the line, or up to
the next comment end or the end of the file) is neither loaded nor a missing finding. A deliberately optional import (try/except
ImportError) of a module that is not installed IS reported. The definitions-only test takes a call inside an
assignment (X = f()) or an if/try condition for a definition, and its node half is a line heuristic, not a parser (a
statement split so that a line starts with a plain word is taken for code, the side that loads nothing). A guarded
module's top level outside the guard still runs when it is loaded.

THE ALERT goes to the main agent through the dashboard API (/api/messages), sent as `hook-load-watch`
when SYSTEM_SENDER_IDS lists it, otherwise as MAIN_AGENT_ID -- the sender rule of the scripts/channels.sh
guards: an id the API does not know is refused with 403 "unknown agent". Delivery is honest: only an
HTTP 2xx answer carrying a message id counts as sent; a failed POST is logged and the alert state is
not advanced, so the next tick tries again. One alert per changed set of findings, repeated every
HOOK_LOAD_WATCH_COOLDOWN seconds while it lasts, and one notice when every hook loads again.
Every tick stamps <state>/.hook-load-watch, so a watcher that stopped running is told apart from a
healthy install by the stamp's age.

Usage:
  scripts/hook-load-watch.py          # one tick (timer): measure, alert on a change, stamp
  scripts/hook-load-watch.py --check  # measure and print; no alert, no stamp, no state written
Exit codes: 0 measured (tick: findings, if any, were alerted or are within the repeat window);
1 --check: at least one finding / tick: findings whose alert could NOT be delivered;
3 nothing to measure (no settings readable, or no hook derived).
Env:
  HOOK_LOAD_WATCH_ROOT          install root (default: this script's parent's parent)
  HOOK_LOAD_WATCH_STATE_DIR     stamp and alert state (default <root>/store)
  HOOK_LOAD_WATCH_TO            alert recipient (default .env MAIN_AGENT_ID, then marveen)
  HOOK_LOAD_WATCH_FROM          alert sender (default: the rule above)
  HOOK_LOAD_WATCH_API           dashboard base URL (default http://localhost:<.env WEB_PORT or 3420>)
  HOOK_LOAD_WATCH_ALERT_DRYRUN  1: print "ALERT_DRYRUN: <message>" instead of the POST (tests)
  HOOK_LOAD_WATCH_COOLDOWN      seconds between repeats of an unchanged alert (default 3600)
  HOOK_LOAD_WATCH_IMPORT_TIMEOUT  seconds for one dependency's load (default 20)
"""
import ast
import glob
import importlib.machinery
import io
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time
import tokenize
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.environ.get("HOOK_LOAD_WATCH_ROOT")
                       or os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE_DIR = os.environ.get("HOOK_LOAD_WATCH_STATE_DIR") or os.path.join(ROOT, "store")
STAMP = os.path.join(STATE_DIR, ".hook-load-watch")
STATE = os.path.join(STATE_DIR, ".hook-load-watch.json")
SENDER_ID = "hook-load-watch"
DEFAULT_TIMEOUT = 60          # seconds, Claude Code's default for a hook without its own timeout
PROBE_TOOL = "HookLoadProbe"  # a tool name no hook acts on
SCRIPT_EXT = r"(?:py|mjs|cjs|js|sh)"


def cooldown():
    raw = os.environ.get("HOOK_LOAD_WATCH_COOLDOWN", "")
    # a malformed or zero override must not turn the repeat into an every-tick alert storm
    return int(raw) if raw.isdigit() and int(raw) > 0 else 3600


def log(msg):
    print("%s [hook-load-watch] %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg), flush=True)


def read_env_keys(keys):
    """The named keys of <root>/.env, read WITHOUT sourcing the file (it carries tokens)."""
    out = {}
    try:
        with open(os.path.join(ROOT, ".env"), encoding="utf-8") as fh:
            for line in fh:
                k, sep, v = line.rstrip("\n").partition("=")
                if sep and k in keys and k not in out:
                    out[k] = v.strip()
    except OSError:
        pass
    return out


# --- derivation -----------------------------------------------------------------------------------

def settings_files():
    files = [os.path.join(ROOT, ".claude", "settings.json")]
    files += sorted(glob.glob(os.path.join(ROOT, "agents", "*", ".claude", "settings.json")))
    return files


def script_paths(command):
    """The script files a hook command runs, as absolute paths: $CLAUDE_PROJECT_DIR resolved to the root,
    then every absolute path with a script extension (the interpreter paths have none)."""
    text = command.replace("${CLAUDE_PROJECT_DIR}", ROOT).replace("$CLAUDE_PROJECT_DIR", ROOT)
    return sorted({os.path.normpath(m) for m in re.findall(r"(/[A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*\." + SCRIPT_EXT + r")(?![A-Za-z0-9_])", text)})


def is_helper_form(command):
    """The deliberately non-blocking helper form: the command ends in `exit 0` (possibly inside bash -c '...')."""
    return re.search(r";\s*exit\s+0\s*'?\s*$", command.strip()) is not None


def derive():
    """Returns (commands, helpers, unreadable): commands maps a command string to its scripts, matchers,
    timeout and the settings owners that call it."""
    entries, unreadable = [], []
    main_path = os.path.join(ROOT, ".claude", "settings.json")
    for path in settings_files():
        owner = "MAIN" if path == main_path else path.split(os.sep)[-3]
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            if owner == "MAIN":
                unreadable.append((path, owner, "the file is missing"))
            continue
        except (OSError, ValueError) as exc:
            unreadable.append((path, owner, "%s: %s" % (type(exc).__name__, first_line(str(exc)))))
            continue
        for entry in (data.get("hooks") or {}).get("PreToolUse") or []:
            for hook in entry.get("hooks") or []:
                cmd = hook.get("command")
                if hook.get("type", "command") != "command" or not isinstance(cmd, str):
                    continue
                entries.append((owner, entry.get("matcher") or "", cmd, hook.get("timeout")))
    helpers = set()
    for _, _, cmd, _ in entries:
        if is_helper_form(cmd):
            helpers.update(script_paths(cmd))
    commands, skipped = {}, set()
    for owner, matcher, cmd, timeout in entries:
        scripts = script_paths(cmd)
        if not scripts:
            skipped.add(cmd)
            continue
        if set(scripts) & helpers:
            continue
        rec = commands.setdefault(cmd, {"scripts": scripts, "matchers": set(), "owners": set(), "timeout": None})
        rec["matchers"].add(matcher)
        rec["owners"].add(owner)
        if isinstance(timeout, (int, float)) and timeout > 0:
            rec["timeout"] = max(rec["timeout"] or 0, timeout)
    return commands, helpers, unreadable, skipped


# --- local dependencies (06c9aa79) ------------------------------------------------------------------

PY_IMPORT = re.compile(r"^[ \t]*(?:from[ \t]+([A-Za-z_]\w*)[\w.]*[ \t]+import\b"
                       r"|import[ \t]+([A-Za-z_][\w.]*(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*(?:[ \t]+as[ \t]+\w+)?)*))", re.M)
FILE_LIT = re.compile(r"""["']([A-Za-z0-9_./@+-]*[A-Za-z0-9_@+-]\.(?:py|mjs|cjs|js))["']""")
# 06c9aa79 (2): the forms in which a quoted file name is LOADED, so its absence is a finding. Measured on this install
# 2026-10-08: the other unresolved quoted names are no dependencies ('/index.js' in an extension list, '__init__.py'
# in the egress parser's resolver, 'send.py' in a comment), and they stay silent.
PY_JOIN = re.compile(r"\bos\.path\.join\(")
JS_LOAD = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])(\.\.?/[A-Za-z0-9_./@+-]*[A-Za-z0-9_@+-]\.(?:mjs|cjs|js))\1""")

STDLIB = frozenset(getattr(sys, "stdlib_module_names", ()))
PY_IMPORT_PROBE = ("import importlib.util, os, sys\n"
                   "p = sys.argv[1]\n"
                   "sys.path.insert(0, os.path.dirname(p))\n"
                   "s = importlib.util.spec_from_file_location('_hook_load_watch_dependency', p)\n"
                   "m = importlib.util.module_from_spec(s)\n"
                   "s.loader.exec_module(m)\n")


def import_timeout():
    raw = os.environ.get("HOOK_LOAD_WATCH_IMPORT_TIMEOUT", "")
    return int(raw) if raw.isdigit() and int(raw) > 0 else 20


def python_index():
    """Every .py under <root>/scripts by module name (node_modules, __pycache__ and test dirs left out)."""
    index = {}
    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, "scripts")):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", "__pycache__", "__tests__")]
        for name in filenames:
            if name.endswith(".py") and name[:-3].isidentifier():
                index.setdefault(name[:-3], []).append(os.path.join(dirpath, name))
    return index


def call_args(text, start):
    """The argument text of a call, from just after its "(" to the matching ")"; quoted strings are skipped."""
    depth, i, quote = 1, start, None
    while i < len(text) and depth:
        c = text[i]
        if quote:
            if c == "\\":
                i += 1
            elif c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        i += 1
    return text[start:i - 1] if not depth else ""


def load_literals(path, text):
    """(file name, offset) for every quoted .py/.mjs/.cjs/.js name the source LOADS: an argument of os.path.join(...) at
    any depth in python, a relative import/export-from/import()/require() specifier in node."""
    if path.endswith(".py"):
        for m in PY_JOIN.finditer(text):
            for lit in FILE_LIT.finditer(call_args(text, m.end())):
                yield lit.group(1), m.end() + lit.start()
    elif path.endswith((".mjs", ".cjs", ".js")):
        for m in JS_LOAD.finditer(text):
            yield m.group(2), m.start(2)



def blank_spans(text, spans):
    """text with every character of the (start, end) offset spans turned into a space, line breaks kept."""
    chars = list(text)
    for a, b in spans:
        for x in range(a, b):
            if chars[x] not in "\r\n":
                chars[x] = " "
    return "".join(chars)


def py_code_only(text):
    """The python source with its comments and string statements (docstrings) blanked, offsets and lines kept; None when it
    does not tokenize (such a file fails its own load, which the probes report)."""
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, SyntaxError):
        return None
    starts = [0]
    for line in text.splitlines(keepends=True):
        starts.append(starts[-1] + len(line))
    off = lambda rc: starts[rc[0] - 1] + rc[1]
    spans = [(off(t.start), off(t.end)) for t in toks if t.type == tokenize.COMMENT]
    sig = [t for t in toks if t.type not in (tokenize.NL, tokenize.COMMENT)]
    i = 0
    while i < len(sig):
        if sig[i].type != tokenize.STRING:
            i += 1
            continue
        j = i
        while j + 1 < len(sig) and sig[j + 1].type == tokenize.STRING:
            j += 1
        before = sig[i - 1].type if i else tokenize.NEWLINE
        after = sig[j + 1].type if j + 1 < len(sig) else tokenize.ENDMARKER
        if before in (tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT) and after in (tokenize.NEWLINE, tokenize.ENDMARKER):
            spans += [(off(t.start), off(t.end)) for t in sig[i:j + 1]]
        i = j + 1
    return blank_spans(text, spans)


def py_comments_only(text):
    """The python source with ONLY its comments blanked: string literals, docstrings included, stay. The load set reads this
    (review of #1830): a file a comment merely mentions is not loaded, and so not executed. None when it does not tokenize."""
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, SyntaxError):
        return None
    starts = [0]
    for line in text.splitlines(keepends=True):
        starts.append(starts[-1] + len(line))
    off = lambda rc: starts[rc[0] - 1] + rc[1]
    return blank_spans(text, [(off(t.start), off(t.end)) for t in toks if t.type == tokenize.COMMENT])


JS_REGEX_BEFORE = set("(,=:[!&|?{};+-*%<>~^")
JS_REGEX_WORDS = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"}
JS_CONDITION_WORDS = {"if", "while", "for", "with"}


def js_code_only(text):
    return blank_spans(text, js_scan(text)[0])


def js_scan(text):
    """(comment spans, literal spans) of a node source. The comment spans make js_code_only: the node source with its comments blanked, offsets and lines kept. Strings, template literals and regex literals are
    stepped over, so a // or /* inside them is not taken for a comment (a regex literal is told from a division by the code
    before it, as minifiers do). A template literal is followed into its ${...} expressions: the code there is read as code
    (a string, a nested template or a comment in it is what it is there), and the template goes on after the closing brace.
    A / right after the closing paren of an if/while/for/with condition starts a regex literal, as in the language. Where the
    scanner still cannot tell, it leans to code: a stretch stepped over as a string or regex is not blanked. The literal spans
    (strings, whole outermost template literals, regex literals) let js_top_level read the statements alone."""
    spans, lits, i, n, prev, word, tpl_start = [], [], 0, len(text), "", "", 0
    if text.startswith("#!"):  # a hashbang line is a comment to node
        i = text.find("\n") if "\n" in text else n
        spans.append((0, i))
    stack = []   # "tpl" for a template literal, [depth] for a ${...} expression inside one
    parens = []  # one flag per open paren: does it close an if/while/for/with condition
    while i < n:
        c = text[i]
        if stack and stack[-1] == "tpl":
            if c == "\\":
                i += 2
            elif c == "`":
                stack.pop()
                if not stack:
                    lits.append((tpl_start, i + 1))
                i, prev, word = i + 1, "`", ""
            elif text.startswith("${", i):
                stack.append([0])
                i, prev, word = i + 2, "{", ""
            else:
                i += 1
            continue
        if c == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            spans.append((i, j))
            i = j
            continue
        if c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            spans.append((i, j))
            i = j
            continue
        if c == "`":
            if not stack:
                tpl_start = i
            stack.append("tpl")
            i += 1
            continue
        if c in "'\"":
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            lits.append((i, min(j + 1, n)))
            i, prev, word = j + 1, c, ""
            continue
        if c == "/" and (prev == "" or prev in JS_REGEX_BEFORE or prev == "cond)" or word in JS_REGEX_WORDS):
            j, in_class = i + 1, False
            while j < n and text[j] != "\n":
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == "[":
                    in_class = True
                elif text[j] == "]":
                    in_class = False
                elif text[j] == "/" and not in_class:
                    break
                j += 1
            j += 1
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            lits.append((i, min(j, n)))
            i, prev, word = j, "/", ""
            continue
        if c.isalnum() or c in "_$":
            j = i
            while j < n and (text[j].isalnum() or text[j] in "_$"):
                j += 1
            word, prev, i = text[i:j], text[j - 1], j
            continue
        if c == "(":
            parens.append(word in JS_CONDITION_WORDS)
        elif c == ")":
            if parens and parens.pop():
                i, prev, word = i + 1, "cond)", ""
                continue
        elif c == "{" and stack:
            stack[-1][0] += 1
        elif c == "}" and stack:
            if stack[-1][0] == 0:
                stack.pop()
                i, prev, word = i + 1, "", ""
                continue
            stack[-1][0] -= 1
        if not c.isspace():
            prev, word = c, ""
        i += 1
    if stack:  # a template literal left open runs to the end of the file
        lits.append((tpl_start, n))
    return spans, lits


def installed(name):
    """A python module importable from OUTSIDE the install root (stdlib paths, site-packages, PYTHONPATH)."""
    root = os.path.abspath(ROOT) + os.sep
    path = [p for p in sys.path if p and not (os.path.abspath(p) + os.sep).startswith(root)]
    try:
        return importlib.machinery.PathFinder.find_spec(name, path) is not None
    except (ImportError, ValueError):
        return False


def local_deps(path, index):
    """The local files one script loads (its python imports and the quoted file names that exist), and the ones its
    source names whose file is not there: (found, {shown paths tuple: why})."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return set(), {}
    here, scripts, found, missing = os.path.dirname(path), os.path.join(ROOT, "scripts"), set(), {}

    def miss(cands, why):
        shown = [p for p in dict.fromkeys(os.path.normpath(c) for c in cands)
                 if p != path and os.path.commonpath([scripts, p]) == scripts]
        if shown:
            missing.setdefault(tuple(os.path.relpath(p, ROOT) for p in shown), why)

    def line_of(offset):
        return "%s:%d" % (os.path.relpath(path, ROOT), text.count("\n", 0, offset) + 1)

    # 06c9aa79 (3): the missing rule reads the source without its comments and (python) docstrings, so a commented-out load
    # or import is not reported. Review of #1830: what a file loads is read without comments as well -- loading executes,
    # so a file a comment merely mentions must not be loaded -- but with its string literals, where the file names are
    # (python imports from the code without docstrings too). From a python source that does not tokenize only its import
    # statements are followed.
    is_py, is_js = path.endswith(".py"), path.endswith((".mjs", ".cjs", ".js"))
    code = py_code_only(text) if is_py else js_code_only(text) if is_js else text
    loads = py_comments_only(text) if is_py else code
    code_imports = {m.start() for m in PY_IMPORT.finditer(code)} if code is not None and is_py else set()

    def add(cand):
        cand = os.path.normpath(cand)
        if cand != path and os.path.isfile(cand) and os.path.commonpath([scripts, cand]) == scripts:
            found.add(cand)
            return True
        return False

    if is_py:
        # a source that does not tokenize still names its imports (its own load fails, the ones it reaches are followed)
        for m in PY_IMPORT.finditer(code if code is not None else text):
            names = [m.group(1)] if m.group(1) else [part.split()[0] for part in m.group(2).split(",") if part.strip()]
            for name in (n.split(".")[0] for n in names):
                if name in STDLIB:
                    continue
                for cand in (os.path.join(here, name + ".py"), os.path.join(here, name, "__init__.py"),
                             os.path.join(scripts, "lib", name + ".py")):
                    if add(cand):
                        break
                else:
                    hits = index.get(name, [])
                    if len(hits) == 1:
                        add(hits[0])
                    elif not hits and m.start() in code_imports and not installed(name):
                        miss([os.path.join(here, name + ".py"), os.path.join(scripts, "lib", name + ".py")],
                             'python import "%s" (%s): nincs helyi fájlként, és telepített modulként sincs' % (name, line_of(m.start())))
    for m in (FILE_LIT.finditer(loads) if loads is not None else ()):
        for cand in (os.path.join(here, m.group(1)), os.path.join(ROOT, m.group(1))):
            if add(cand):
                break
    for lit, offset in (load_literals(path, code) if code is not None else ()):
        if any(os.path.isfile(os.path.normpath(c)) for c in (os.path.join(here, lit), os.path.join(ROOT, lit))):
            continue
        miss([os.path.join(ROOT, lit) if lit.startswith("scripts/") else os.path.join(here, lit)],
             'a forrásban betöltött "%s" (%s)' % (lit, line_of(offset)))
    return found, missing


def dependency_map(commands):
    """Each local dependency of the derived gate scripts -> the gates (relative) that reach it, transitively,
    and the owners of their commands."""
    index, deps = python_index(), {}
    for rec in commands.values():
        for gate in rec["scripts"]:
            if not gate.endswith((".py", ".mjs", ".cjs", ".js")):
                continue
            seen, todo = {gate}, [gate]
            while todo:
                found, missing = local_deps(todo.pop(), index)
                for dep in sorted(found):
                    if dep not in seen:
                        seen.add(dep)
                        todo.append(dep)
                        d = deps.setdefault(dep, {"gates": set(), "owners": set()})
                        d["gates"].add(os.path.relpath(gate, ROOT))
                        d["owners"].update(rec["owners"])
                # 06c9aa79 (2): named but not there -- nothing to load or to follow; a string key ("MISSING:..."), so
                # the map still sorts
                for shown, why in sorted(missing.items()):
                    d = deps.setdefault("MISSING:" + ",".join(shown), {"gates": set(), "owners": set(),
                                                                       "shown": list(shown), "why": why})
                    d["gates"].add(os.path.relpath(gate, ROOT))
                    d["owners"].update(rec["owners"])
    return deps


# Review of #1830: loading a dependency executes its top level, so only a file whose top level is safe to run is loaded --
# one with a main guard (the main is then not run), or a definitions-only library that has nothing to guard. Anything else
# is reported as UNGUARDED and only syntax-checked (compile / node --check run nothing).
PY_DEF_STMTS = (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Assign, ast.AnnAssign,
                ast.AugAssign, ast.Pass, ast.Raise, ast.Global)
JS_DECL_WORDS = {"import", "export", "const", "let", "var", "function", "async", "class"}
JS_CONTINUES = set("=,([{+-*/%?:&|<>!.~^")


def py_main_guard(node):
    """An `if __name__ == "__main__":` at the top level (either operand order)."""
    t = node.test if isinstance(node, ast.If) else None
    if not (isinstance(t, ast.Compare) and len(t.ops) == 1 and isinstance(t.ops[0], ast.Eq)):
        return False
    pair = [t.left, t.comparators[0]]
    return (any(isinstance(x, ast.Name) and x.id == "__name__" for x in pair)
            and any(isinstance(x, ast.Constant) and x.value == "__main__" for x in pair))


def py_top_level_code(body):
    """The first top-level statement that RUNS something (not a definition, an import, an assignment, a docstring or a
    sys.path change), looking into try and if blocks; None for a definitions-only module."""
    for node in body:
        if isinstance(node, PY_DEF_STMTS) or py_main_guard(node):
            continue
        if isinstance(node, ast.Expr):
            v = node.value
            if isinstance(v, ast.Constant):
                continue
            if (isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr in ("insert", "append")
                    and ast.unparse(v.func.value) == "sys.path"):
                continue
            return node
        if isinstance(node, ast.If):
            hit = py_top_level_code(node.body) or py_top_level_code(node.orelse)
        elif isinstance(node, getattr(ast, "TryStar", ast.Try)) or isinstance(node, ast.Try):
            hit = (py_top_level_code(node.body) or py_top_level_code(node.orelse) or py_top_level_code(node.finalbody)
                   or next((h for x in node.handlers for h in [py_top_level_code(x.body)] if h), None))
        else:
            return node
        if hit:
            return hit
    return None


def js_top_level_code(text):
    """(line, text) of the first top-level statement of a node source that is no declaration (import, export, const, let,
    var, function, class), read with comments and literals blanked and continuation lines followed; None when there is none.
    A heuristic, not a parser: a statement split so that a line starts with a plain word is taken for code (the safe side)."""
    comments, lits = js_scan(text)
    masked = blank_spans(text, comments + lits)
    depth, last = 0, ""
    for no, line in enumerate(masked.split("\n"), 1):
        stripped = line.strip()
        if stripped and depth == 0 and last not in JS_CONTINUES and stripped[0] not in ".?:+-*/%&|=,)]}>;":
            word = re.match(r"[A-Za-z_$][\w$]*", stripped)
            if not (word and word.group(0) in JS_DECL_WORDS):
                return no, first_line(text.split("\n")[no - 1])
        for c in line:
            if c in "([{":
                depth += 1
            elif c in ")]}":
                depth = max(0, depth - 1)
        if stripped:
            last = stripped[-1]
    return None


def js_main_guard(text):
    """The repo's node main guards: isInvokedDirectly() / process.argv[1] against import.meta.url, or require.main === module."""
    code = js_code_only(text)
    return (("import.meta.url" in code and "process.argv[1]" in code)
            or re.search(r"\brequire\.main\s*===?\s*module\b", code) is not None)


def guard_check(path):
    """(True, "") when loading the file runs nothing but its definitions (a main guard, or a definitions-only top level), or
    when it does not parse (then nothing runs either: the load fails at compile); (False, why) otherwise."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return True, ""
    if path.endswith(".py"):
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError):
            return True, ""
        if any(py_main_guard(n) for n in tree.body):
            return True, ""
        hit = py_top_level_code(tree.body)
        if hit is None:
            return True, ""
        return False, 'no if __name__ == "__main__" guard, top-level code at line %d: %s' % (
            hit.lineno, first_line(ast.unparse(hit))[:80])
    if js_main_guard(text):
        return True, ""
    hit = js_top_level_code(text)
    if hit is None:
        return True, ""
    return False, "no isInvokedDirectly() / import.meta.url main guard, top-level code at line %d: %s" % (hit[0], hit[1][:80])


# Review of #1830: the probes get the environment a hook needs to start, not the watcher's own (which may carry tokens).
PROBE_ENV_KEEP = ("PATH", "HOME", "TZ", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "PYTHONPATH", "NODE_PATH")


def probe_env():
    env = {k: os.environ[k] for k in PROBE_ENV_KEEP if k in os.environ}
    env.update(CLAUDE_PROJECT_DIR=ROOT, PYTHONDONTWRITEBYTECODE="1")
    return env


def run_bounded(argv, timeout):
    """(rc, stdout, stderr) or None on a timeout (the process group is killed); OSError propagates."""
    proc = subprocess.Popen(argv, cwd=ROOT, env=probe_env(), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        return None
    return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def syntax_probe(path, why):
    """An unguarded dependency is not loaded: a syntax check (it runs nothing) still tells a broken file apart."""
    if path.endswith(".py"):
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                compile(fh.read(), path, "exec", dont_inherit=True)
        except (SyntaxError, ValueError) as exc:
            return {"class": "IMPORT", "rc": 1, "detail": "%s: %s | SyntaxError: %s" % (
                os.path.basename(path), getattr(exc, "lineno", "?"), first_line(getattr(exc, "msg", "") or str(exc)))}
    else:
        try:
            res = run_bounded(["node", "--check", path], import_timeout())
        except OSError as exc:
            return {"class": "IMPORT", "rc": None, "detail": "%s: node" % type(exc).__name__}
        if res is None:
            return {"class": "TIMEOUT", "rc": None, "detail": "not syntax-checked within %ss" % import_timeout()}
        if res[0] != 0:
            return {"class": "IMPORT", "rc": res[0], "detail": error_detail(res[2]) or first_line(res[1])}
    return {"class": "UNGUARDED", "rc": None, "detail": why}


def import_probe(path):
    """Load ONE dependency on its own, without running a main: OK, IMPORT (it does not load) or TIMEOUT; UNGUARDED (not
    loaded) when its top level would run more than definitions."""
    safe, why = guard_check(path)
    if not safe:
        return syntax_probe(path, why)
    if path.endswith(".py"):
        argv = ["python3", "-B", "-c", PY_IMPORT_PROBE, path]
    else:
        argv = ["node", "--input-type=module", "-e", "await import(%s)" % json.dumps(pathlib.Path(path).as_uri())]
    timeout = import_timeout()
    try:
        res = run_bounded(argv, timeout)
    except OSError as exc:
        return {"class": "IMPORT", "rc": None, "detail": "%s: %s" % (type(exc).__name__, argv[0])}
    if res is None:
        return {"class": "TIMEOUT", "rc": None, "detail": "not loaded within %ss" % timeout}
    rc, out, err = res
    detail = "" if rc == 0 else (error_detail(err) or first_line(out))
    return {"class": "OK" if rc == 0 else "IMPORT", "rc": rc, "detail": detail}


def takes_bash(matchers):
    for m in matchers:
        if m in ("", "*") or m == "Bash":
            return True
        try:
            if re.fullmatch(m, "Bash"):
                return True
        except re.error:
            continue
    return False


# --- probe ----------------------------------------------------------------------------------------

def probe_payload(bash):
    payload = {"session_id": "hook-load-watch", "transcript_path": "", "cwd": ROOT,
               "hook_event_name": "PreToolUse", "tool_name": PROBE_TOOL, "tool_input": {}}
    if bash:
        payload["tool_name"] = "Bash"
        payload["tool_input"] = {"command": "true", "description": "hook load probe"}
    return payload


def denies(stdout):
    try:
        out = json.loads(stdout)
    except ValueError:
        return False
    if not isinstance(out, dict):
        return False
    hso = out.get("hookSpecificOutput") if isinstance(out.get("hookSpecificOutput"), dict) else {}
    return out.get("decision") == "block" or hso.get("permissionDecision") == "deny" or out.get("continue") is False


def first_line(text):
    for line in (text or "").splitlines():
        line = re.sub(r"[\x00-\x1f\x7f]", " ", line).strip()
        if line:
            return line[:200]
    return ""


def error_detail(text):
    """The place and the cause. Node prints the file:line first; a Python traceback starts with "Traceback ...",
    its last 'File "...", line N' line is the place (for a broken import: the broken module, not the gate) and
    its last "...Error: ..." line is the cause."""
    # an absolute path or file:// URL shrinks to its file name: the cause, not the directory, has to fit the line
    text = re.sub(r"(?:file://)?/[^\s:'\"]*/([^/\s:'\"]+)", r"\1", text or "")
    head = first_line(text)
    if head.startswith("Traceback"):
        places = [l for l in text.splitlines() if re.match(r'\s*File "[^"<]+", line \d+', l)]
        if places:
            head = first_line(places[-1])
    errs = [l.strip() for l in text.splitlines() if re.match(r"\s*[A-Za-z_.]*(Error|Exception)\b", l)]
    tail = re.sub(r"[\x00-\x1f\x7f]", " ", errs[-1])[:160] if errs else ""
    return head if not tail or tail == head else "%s | %s" % (head[:100], tail)


def probe(command, rec):
    bash = takes_bash(rec["matchers"])
    env = probe_env()
    timeout = rec["timeout"] or DEFAULT_TIMEOUT
    started = time.monotonic()
    proc = subprocess.Popen(["/bin/sh", "-c", command], cwd=ROOT, env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        out, err = proc.communicate(json.dumps(probe_payload(bash)).encode(), timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        out, err = proc.communicate()
        return {"class": "TIMEOUT", "rc": None, "detail": "no answer within %ss" % timeout, "tool": "Bash" if bash else PROBE_TOOL}
    rc = proc.returncode
    out_s, err_s = out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
    if rc == 0 and not denies(out_s):
        klass = "OK"
    elif rc == 0 or rc == 2:
        klass = "CLOSED"
    else:
        klass = "OPEN"
    return {"class": klass, "rc": rc, "detail": error_detail(err_s) or first_line(out_s),
            "tool": "Bash" if bash else PROBE_TOOL, "ms": int((time.monotonic() - started) * 1000)}


def measure():
    commands, helpers, unreadable, skipped = derive()
    results = []
    for path, owner, why in unreadable:
        # a settings file Claude Code cannot read loads none of its hooks: that is a finding too
        results.append({"class": "SETTINGS", "rc": None, "detail": why, "tool": "-", "command": "",
                        "scripts": [os.path.relpath(path, ROOT)], "owners": [owner]})
    for cmd, rec in commands.items():
        res = probe(cmd, rec)
        res.update(command=cmd, scripts=[os.path.relpath(s, ROOT) for s in rec["scripts"]],
                   owners=sorted(rec["owners"]))
        results.append(res)
    for cmd in sorted(skipped):
        log("left out, no script file in the command: %s" % first_line(cmd)[:120])
    # 06c9aa79: the gates' local dependencies, each loaded on its own; their results come after the commands'
    for dep, d in sorted(dependency_map(commands).items()):
        if "why" in d:
            res = {"class": "MISSING", "rc": None, "why": d["why"],
                   "detail": "HIÁNYZIK: %s; %s" % (", ".join(d["shown"]), d["why"]), "scripts": list(d["shown"])}
        else:
            res = import_probe(dep)
            res["scripts"] = [os.path.relpath(dep, ROOT)]
        res.update(kind="import", command="", owners=sorted(d["owners"]), tool="import (<- %s)" % ", ".join(sorted(d["gates"])))
        results.append(res)
    return results, sorted(os.path.relpath(h, ROOT) for h in helpers)


# --- report and alert -----------------------------------------------------------------------------

def owners_text(owners):
    agents = [o for o in owners if o != "MAIN"]
    parts = (["a fő ügynök"] if "MAIN" in owners else []) + (["%d ügynök" % len(agents)] if agents else [])
    return " és ".join(parts)


MEANING = {"SETTINGS": "OLVASHATATLAN BEÁLLÍTÁS (a hookjai nem mérhetők, és a Claude Code sem tölti be őket)",
           "OPEN": "NYITVA (nem tiltó hibakód: a hívás átmegy, a kapu nem véd)",
           "CLOSED": "ZÁRVA (egy ártalmatlan hívást is tilt: minden ilyen eszközhívás áll)",
           "TIMEOUT": "IDŐTÚLLÉPÉS (a saját határidején belül nem válaszolt)",
           "IMPORT": "NEM TÖLTHETŐ BE (egy kapu helyi függősége: ahol a kapu betölti, ott hibázik, a burkolóval tilt)",
           "UNGUARDED": "NINCS MAIN-ŐR (a betöltése a teljes felső szintjét futtatná, ezért nem töltöttem be, csak a szintaxisát "
                        "néztem; ahol a kapu betölti, ott ez a kód lefut)",
           "MISSING": "a kapu forrásában megnevezett helyi függőség, a fájl nincs meg (ahol a kapu betölti, ott hibázik, a burkolóval tilt)"}


def findings_of(results):
    return [r for r in results if r["class"] != "OK"]


def fingerprint(findings):
    return sorted("%s|%s|%s" % (",".join(f["scripts"]), f["class"], f["rc"]) for f in findings)


def alert_text(findings, results):
    when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    imp_total = sum(1 for r in results if r.get("kind") == "import")
    miss_found = sum(1 for f in findings if f["class"] == "MISSING")
    ung_found = sum(1 for f in findings if f["class"] == "UNGUARDED")
    imp_found = sum(1 for f in findings if f.get("kind") == "import") - miss_found - ung_found
    cmd_total, cmd_found = len(results) - imp_total, len(findings) - imp_found - miss_found - ung_found
    parts = (["%d/%d PreToolUse biztonsági hook-parancs nem tölt be rendesen" % (cmd_found, cmd_total)]
             if cmd_found or not (imp_found or miss_found or ung_found) else [])
    if imp_found:
        parts.append("%d/%d helyi kapu-függőség nem tölthető be" % (imp_found, imp_total))
    if ung_found:
        parts.append("%d/%d helyi kapu-függőség main-őr nélkül, nem töltöttem be" % (ung_found, imp_total))
    if miss_found:
        parts.append("%d/%d helyi kapu-függőség hiányzik" % (miss_found, imp_total))
    lines = ["[HOOK-FIGYELŐ] %s (mérve %s, %s):" % (", ".join(parts), when, ROOT)]
    for f in findings[:12]:
        if f["class"] == "MISSING":
            lines.append("- HIÁNYZIK: %s (%s): %s, próba: %s: %s" % (
                ", ".join(f["scripts"]), owners_text(f["owners"]), MEANING["MISSING"], f["tool"], f["why"][:160]))
            continue
        lines.append("- %s (%s): %s, rc %s, próba: %s%s" % (
            ", ".join(f["scripts"]), owners_text(f["owners"]), MEANING[f["class"]], f["rc"], f["tool"],
            (": " + f["detail"][:160]) if f["detail"] else ""))
    if len(findings) > 12:
        lines.append("- ... és még %d (a teljes lista: python3 scripts/hook-load-watch.py --check)" % (len(findings) - 12))
    lines.append("Teendő: a hook-fájl és a betöltött moduljai (git diff, a legutóbbi módosítás); újramérés: "
                 "python3 scripts/hook-load-watch.py --check")
    lines.append("Ugyanerről legközelebb a változáskor vagy %d perc múlva szólok." % (cooldown() // 60))
    return "\n".join(lines)


def az(n):
    """The Hungarian article before a number, by how it is read out: az 1 (egy), az 5 (öt), az 50-59 (ötven),
    az 500-599 (ötszáz), az 1000-1999 (ezer); a for the rest."""
    s = str(n)
    return "az" if s == "1" or s[0] == "5" or (len(s) == 4 and s[0] == "1") else "a"


def recovered_text(previous, results):
    when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    imp_total = sum(1 for r in results if r.get("kind") == "import")
    total = len(results) - imp_total
    deps = (", és mind %s %d helyi kapu-függőség is" % (az(imp_total), imp_total)) if imp_total else ""
    return ("[HOOK-FIGYELŐ] HELYREÁLLT: mind %s %d PreToolUse biztonsági hook-parancs betölt%s (mérve %s). "
            "A %s óta jelzett hiba lezárható." % (az(total), total, deps, when, previous.get("first_seen", "?")))


def send(content):
    """Honest delivery: True only for an HTTP 2xx answer that carries a message id."""
    if os.environ.get("HOOK_LOAD_WATCH_ALERT_DRYRUN") == "1":
        print("ALERT_DRYRUN: " + content, flush=True)
        return True
    env = read_env_keys(("MAIN_AGENT_ID", "SYSTEM_SENDER_IDS", "WEB_PORT"))
    main_id = env.get("MAIN_AGENT_ID") or "marveen"
    listed = {re.sub(r"[^A-Za-z0-9_-]", "", e) for e in env.get("SYSTEM_SENDER_IDS", "").split(",")}
    sender = os.environ.get("HOOK_LOAD_WATCH_FROM") or (SENDER_ID if SENDER_ID in listed else main_id)
    to = os.environ.get("HOOK_LOAD_WATCH_TO") or main_id
    port = env.get("WEB_PORT", "") if env.get("WEB_PORT", "").isdigit() else "3420"
    base = (os.environ.get("HOOK_LOAD_WATCH_API") or "http://localhost:%s" % port).rstrip("/")
    try:
        with open(os.path.join(ROOT, "store", ".dashboard-token"), encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError as exc:
        log("ALERT NOT SENT: no dashboard token (%s)" % type(exc).__name__)
        return False
    req = urllib.request.Request(base + "/api/messages", method="POST",
                                 data=json.dumps({"from": sender, "to": to, "content": content}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            code, body = resp.status, resp.read(2000)
    except urllib.error.HTTPError as exc:
        log("ALERT NOT SENT: HTTP %s (from=%s to=%s)" % (exc.code, sender, to))
        return False
    except (urllib.error.URLError, OSError) as exc:
        log("ALERT NOT SENT: %s (from=%s to=%s)" % (type(exc).__name__, sender, to))
        return False
    try:
        msg_id = json.loads(body).get("id")
    except (ValueError, AttributeError):
        msg_id = None
    if 200 <= code < 300 and msg_id is not None:
        log("alert sent: id=%s from=%s to=%s" % (msg_id, sender, to))
        return True
    log("ALERT NOT SENT: HTTP %s without a message id (from=%s to=%s)" % (code, sender, to))
    return False


def load_state():
    try:
        with open(STATE, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_file(path, text):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except OSError as exc:
        log("cannot write %s (%s)" % (path, type(exc).__name__))


def tick(results):
    findings = findings_of(results)
    now = int(time.time())
    state = load_state()
    rc = 0
    if findings:
        fp = fingerprint(findings)
        due = state.get("fingerprint") != fp or now - int(state.get("last_alert") or 0) >= cooldown()
        if due:
            if send(alert_text(findings, results)):
                state = {"fingerprint": fp, "last_alert": now,
                         "first_seen": state.get("first_seen") if state.get("fingerprint") else
                         time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))}
                write_file(STATE, json.dumps(state))
            else:
                rc = 1
    elif state.get("fingerprint"):
        if send(recovered_text(state, results)):
            write_file(STATE, json.dumps({}))
        else:
            rc = 1
    write_file(STAMP, "%s %d/%d ok\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                                         len(results) - len(findings), len(results)))
    return rc


def main(argv):
    check = "--check" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--check"]
    if unknown:
        print("usage: hook-load-watch.py [--check]", file=sys.stderr)
        return 3
    results, helpers = measure()
    if not results:
        log("NOTHING TO MEASURE: no PreToolUse hook command derived from the settings under %s" % ROOT)
        return 3
    for r in results:
        log("%-7s rc=%-4s %s (%s) probe=%s%s" % (r["class"], r["rc"], ", ".join(r["scripts"]), owners_text(r["owners"]),
                                                   r["tool"], (" | " + r["detail"]) if r["class"] != "OK" and r["detail"] else ""))
    probed = [r for r in results if r["class"] != "SETTINGS" and r.get("kind") != "import"]
    log("derived %d commands, %d scripts; helpers left out: %s; findings: %d"
        % (len(probed), len({s for r in probed for s in r["scripts"]}), ", ".join(helpers) or "-",
           len(findings_of(results))))
    imports = [r for r in results if r.get("kind") == "import" and r["class"] not in ("MISSING", "UNGUARDED")]
    log("local dependencies: %d loaded on their own, without a main; failing: %d" % (len(imports), len(findings_of(imports))))
    log("local dependencies not loaded, no main guard: %d" % sum(1 for r in results if r["class"] == "UNGUARDED"))
    log("local dependencies named in a gate's source but missing: %d"
        % sum(1 for r in results if r["class"] == "MISSING"))
    if check:
        return 1 if findings_of(results) else 0
    return tick(results)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
