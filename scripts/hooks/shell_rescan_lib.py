#!/usr/bin/env python3
r"""Detector for the class "data enters the command text and the shell re-scans it".

WHY. Prose pasted into a command text is scanned by the shell before the
interpreter ever sees it. A backtick in a message body ran `git reset --hard
origin/main` in a shared checkout and destroyed uncommitted work; a written rule
against it did not hold. A rule is not a control until a tool enforces it.

THE MECHANISM. It is not `python3 -c` that is dangerous. It is that PROSE gets
pasted into the text of a command, and the shell scans that text before the
interpreter sees it. The same family: eval, an unquoted heredoc, ${v@P}, and a
backtick inside a double-quoted string. A quoted substitution ("$v") is NOT
re-scanned and is therefore safe -- the fix is never "quote harder", it is "keep
the data out of the command text": argument, stdin, or a QUOTED heredoc.

HOW IT PARSES, and why it is recursive. Shell syntax REOPENS inside $( ): quotes
nest, and a heredoc can be opened there. Earlier versions were wrong in ways found
only by measurement on real commands:
  - scanning heredoc bodies as syntax fired on 7.57% of about 106 000 real
    commands, almost all of them heredocs -- the gate firing on its own remedy;
  - a flat scan of $( ) fired on 4.12%, dominated by "... $(echo "$x") ..." where
    the inner quote was read as the closing one.
Both were instrument errors, not unsafe commands.

DETAILS THAT MATTER (each one reproduced before it was handled):
  - shell COMMENTS are recognised: otherwise an apostrophe in a comment
    ("# Don't panic") opens a single-quoted region that swallows the rest of the
    command -- a general blinding, and a trivial bypass;
  - the heredoc terminator is matched the way bash matches it: exactly at column
    zero for <<, leading TABS stripped for <<-;
  - the rest of a heredoc header line is still the same command
    (`cat <<EOF && eval "..."`), and it may open more heredocs: their bodies
    follow the first one in order, the way bash reads them;
  - `<<<` is a here-string, not a heredoc;
  - `\eval` is still eval: a backslash before a word character quotes only the
    backslash, it does not hide the word;
  - `eval` fires only in COMMAND position, so `grep eval file` is left alone;
  - the interpreter payload is tracked by parsing words: `/usr/bin/python3`,
    `python3.11`, `python3 -u -c`, `env python3 -c` and `bash -c` are all
    recognised, and padding the command with spaces does not hide it.

SCOPE, deliberately narrow:
  - $( ) is flagged only inside an inline interpreter payload, never on its own:
    "$(cat token-file)" is an everyday idiom, and a gate blocking it would be
    switched off within a day.
  - A backtick in UNQUOTED position is left alone: that is deliberate old-style
    substitution by the author, not prose that drifted into a command.
  - Quoted heredoc bodies are inert text and are never scanned as syntax.

KNOWN LIMITS, stated so a green run is never read as coverage:
  - An arithmetic COMMAND `(( ... ))` is not parsed: a `<<` inside it is read
    as a heredoc header, which refuses a harmless command and hides an eval
    written after it.
  - Recursion is depth-limited; past the limit it stops descending, so a
    pathologically nested command is under-scanned rather than crashing.
  - It sees only what reaches the Bash tool. Anything executed another way
    (a script already on disk, an MCP server, an agent's own subprocess) is
    uncovered -- a FALSE GREEN, not proof the command was safe.
  - It cannot tell a deliberate backtick from an accidental one. It raises the
    floor; it does not read intent.
  - Command position is tracked LEXICALLY. A computed command name -- the shape
    $(printf eval) "..." -- is not resolved, so the eval rule reads "eval written
    as a word", not "eval however it is produced".
"""
import re

HEREDOC_HDR = re.compile(
    r"<<(-?)[ \t]*((?:\$'[^']*'|'[^']*'|\"(?:\\.|[^\"\\])*\"|\\.|[A-Za-z0-9_.:+@%,=-])+)")
PROMPT_EXPAND = re.compile(
    r"\$\{!?(?:[A-Za-z_][A-Za-z0-9_]*(?:\[[^]]*\])?|[0-9]+|[*@#?$!-])@P\}")
INTERP_WORD = re.compile(r"^(?:python|node|nodejs|perl|ruby|php|bash|sh|zsh)[0-9.]*$")
# -c, -e, -E, --eval, node's -p/--print, php's -r, and the clustered short
# forms a shell takes (bash -lc).
# ⚠️Recognising the FLAG is not the same as inspecting the payload: if that
# payload is SINGLE-quoted the rule deliberately does not look inside it, so
# `bash -lc 'echo "$(x)"'` passes. That is the measured 0.159% exemption, and it
# applies to the clustered forms exactly as it does to a plain -c.
INLINE_FLAG = re.compile(r"^(?:--eval=?|--print=?|-[A-Za-z]*[ceE]=?|-[pr])$")
# The same flag at the START of a double-quoted word that also holds its payload:
# node "--eval=console.log('$(id)')".
INLINE_PREFIX = re.compile(r"^(?:--eval=|--print=|-[A-Za-z]*[ceE])")

# Wrappers that pass the real command through, plus the shapes that can legally
# precede it: options, durations and environment assignments. This list is used
# for ONE thing -- deciding whether an `eval` is still in command position --
# so a mistake here cannot blind the interpreter rule the way it used to.
PREFIX_CMDS = ("env", "nohup", "setsid", "time", "nice", "stdbuf", "timeout",
               "command", "exec", "builtin", "sudo", "xargs")
# Shell KEYWORDS do not occupy the command position -- `then eval "$x"` is still
# an eval in command position, and treating `then` as the command silenced it.
KEYWORDS = ("if", "then", "else", "elif", "fi", "while", "until", "do", "done",
            "for", "in", "case", "esac", "select", "function", "coproc", "!")
OPTIONISH = re.compile(r"^(?:-.*|[0-9.]+[a-z]?)$")
OPERAND_OPTS = ("-u", "-C", "-s", "-o", "-n", "-p", "-k", "-g", "-r", "-w",
                "--signal", "--chdir", "--user", "--group", "--unset")
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\[[^]]*\])?\+?=$")

SEPARATORS = ";&|\n(){}"
DQ_ESCAPABLE = "$`\"\\\n"
MAX_DEPTH = 25


def _unescape(w):
    """A shell word with its backslashes removed. A backslash-newline is a line
    continuation and disappears entirely -- keeping it turned e\\<newline>val into
    "e\\nval", which then failed to match eval."""
    out, i, n = [], 0, len(w)
    while i < n:
        if w[i] == "\\" and i + 1 < n:
            if w[i + 1] != "\n":
                out.append(w[i + 1])
            i += 2
            continue
        out.append(w[i])
        i += 1
    return "".join(out)


def _delim(raw):
    """Split a heredoc delimiter word into its quoted and unquoted pieces. ANY
    quoted piece makes the whole body inert -- <<E"OF" and <<EOF\\! are as inert as
    <<'EOF', and reading their bodies as live syntax was a measured false positive."""
    out, quoted, i, n = [], False, 0, len(raw or "")
    while i < n:
        c = raw[i]
        if c == "$" and i + 1 < n and raw[i + 1] == "'":
            i += 1                     # $'...' quotes the delimiter as well
            c = "'"
        if c in "'\"":
            j, buf = i + 1, []
            while j < n:
                if raw[j] == "\\" and j + 1 < n and c == '"':
                    buf.append(raw[j + 1]); j += 2; continue
                if raw[j] == c:
                    break
                buf.append(raw[j]); j += 1
            out.append("".join(buf)); quoted = True; i = j + 1
            continue
        if c == "\\" and i + 1 < n:
            out.append(raw[i + 1]); quoted = True; i += 2
            continue
        out.append(c); i += 1
    return "".join(out), quoted


def _is_subst(s, i):
    """$( ... ) is a command substitution; $(( ... )) is ARITHMETIC and runs no
    command. Treating the second as the first fired on `"$((1 + 2))"`."""
    return s.startswith("$(", i) and not s.startswith("$((", i)


def _arith(s, i):
    """For a $(( ... )) at i, return (index_after, body).

    The old version started its depth count one character early, so the second
    `)` of the arithmetic looked like the start of `))` even when the third paren
    belonged to an ENCLOSING $( ). It then ate the caller's terminator and the
    rest of the command went unscanned. Measured on `x=$(echo $((1 + 2)))`."""
    j, dep, n = i + 3, 0, len(s)
    while j < n:
        c = s[j]
        if c == "(":
            dep += 1
        elif c == ")":
            if dep == 0:
                if s.startswith("))", j):
                    return j + 2, s[i + 3:j]
                return j + 1, s[i + 3:j]
            dep -= 1
        j += 1
    return n, s[i + 3:]


def _interp(word):
    return bool(INTERP_WORD.match(word.rsplit("/", 1)[-1]))


def _strip_heredoc_escapes(body):
    """In an UNQUOTED heredoc a backslash still escapes $ and ` -- \\`code\\` is
    literal text, not a substitution, and flagging it is a false positive."""
    out, i, n = [], 0, len(body)
    while i < n:
        if body[i] == "\\" and i + 1 < n and body[i + 1] in "$`\\\n":
            i += 2
            continue
        out.append(body[i])
        i += 1
    return "".join(out)


def _heredoc_body_end(s, pos, dash, delim):
    """pos is the start of the document's first line. Returns (body, index_after).
    bash ends the document on a line that is EXACTLY the delimiter; with <<- the
    leading TABS (only tabs) are stripped first. Measured against bash, not assumed."""
    lines, n = [], len(s)
    while pos <= n:
        eol = s.find("\n", pos)
        line = s[pos:] if eol < 0 else s[pos:eol]
        probe = line.lstrip("\t") if dash else line
        if probe == delim:
            return "\n".join(lines), (n if eol < 0 else eol + 1)
        lines.append(line)
        if eol < 0:
            return "\n".join(lines), n
        pos = eol + 1
    return "\n".join(lines), n


def _check_body(body, delim, out):
    """An UNQUOTED heredoc body is expanded: a backtick, $( ) or ${v@P} in it runs."""
    clean = _strip_heredoc_escapes(body)
    if "`" in clean:
        out.append(("B_UNQUOTED_HEREDOC", delim + ":`"))
    k = clean.find("$(")
    while k >= 0:
        if not clean.startswith("$((", k):
            out.append(("B_UNQUOTED_HEREDOC", delim + ":$("))
            break
        nxt2, abody = _arith(clean, k)
        if "$(" in abody or "`" in abody:
            out.append(("B_UNQUOTED_HEREDOC", delim + ":$(("))
            break
        k = clean.find("$(", nxt2)
    mp = PROMPT_EXPAND.search(clean)
    if mp:
        out.append(("D_PROMPT_EXPAND", mp.group(0)))


def _scan_dq(s, i, out, reg, payload, depth, notes=None, armed=False):
    """Scan a double-quoted body. i points just past the opening quote.
    Returns the index just past the closing quote. `armed` means the enclosing
    command already named an interpreter, so a flag written INSIDE the quotes --
    the "-c$( )" whole-word form -- still counts."""
    n = len(s)
    start = i if armed else None
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n and s[i + 1] in DQ_ESCAPABLE:
            i += 2
            continue
        if c == '"':
            return i + 1
        if s.startswith("$((", i):
            # Arithmetic does NOT run a command by itself, but it DOES expand a
            # substitution written inside it -- $(( $(id) )) executes. Skipping
            # the whole construct was therefore a blind spot, not a narrowing.
            j, body = _arith(s, i)
            if body and depth < MAX_DEPTH:   # nested $(( )) recurses through here
                _scan_dq(body + '"', 0, out, reg, payload, depth + 1, notes=notes)
            i = j
            continue
        if _is_subst(s, i):
            if payload or (start is not None
                           and INLINE_PREFIX.match(_unescape(s[start:i]))):
                out.append(("A_INLINE_INTERP_DQ", "$("))
            i = _scan(s, i + 2, out, reg, depth + 1, stop=")", notes=notes)
            continue
        if c == "$" and s.startswith("${", i):
            m = PROMPT_EXPAND.match(s, i)
            if m:
                out.append(("D_PROMPT_EXPAND", m.group(0)))
                i = m.end()
                continue
        if c == "`":
            # The same rule label is also what an arithmetic body reaches, since
            # $(( )) is scanned through here. The label says "double-quoted"; the
            # POLICY is the same either way -- the shell runs it -- but the name
            # is imprecise there, and the gate's message says so.
            out.append(("E_BACKTICK_IN_DQ", s[max(0, i - 30):i + 30]))
            i += 1
            continue
        i += 1
    return n


def _scan(s, i, out, reg, depth=0, stop=None, notes=None, inherit=None):
    """Scan an unquoted shell context. Returns the index just past `stop`.

    WHAT THIS DELIBERATELY DOES NOT DO, and why. An earlier design tracked WHICH
    word was the command and WHICH word was the interpreter payload. That
    machinery existed for exactly one rule, fired 18 times in about 106 000 real
    commands, and produced most of the defects found in review: wrappers whose own arguments became the command
    (`timeout 10s`, `env -u VAR`), a flag glued to its payload (`-c"..."`), a line
    continuation between them, a heredoc in the middle of a command. So the
    command is no longer a position -- it is a SET OF WORDS between separators,
    and the rule asks whether that set contains both an interpreter and an inline
    flag. Fewer moving parts, and the entire class of ordering bugs is gone."""
    if depth > MAX_DEPTH:
        if stop:
            j = s.find(stop, i)
            return len(s) if j < 0 else j + 1
        return len(s)
    n = len(s)
    st = dict(inherit) if inherit else {"interp": False, "await": False,
                                        "lead": True, "skip": False,
                                        "optarg": False, "glued": False}
    st.setdefault("optarg", False)
    st.setdefault("glued", False)
    wbuf = []
    present = [False]                     # a QUOTED empty string is still a word
    pending = []                          # heredocs opened on the current line

    def close_word():
        w = "".join(wbuf)
        del wbuf[:]
        seen, present[0] = present[0] or bool(w), False
        if not seen:
            return                        # nothing at all consumes nothing, not even
        if st["skip"]:                    # a pending redirection target -- and it
            st["skip"] = False            # does NOT consume the payload slot either
            return
        awaiting, st["await"] = st["await"], False   # a quoted EMPTY word IS the payload slot
        if not w:
            return
        u = _unescape(w)
        if awaiting and u == "--":
            st["await"] = True         # `bash -c -- "$( )"`: the payload is the NEXT word
            return
        lead = st["lead"]
        base = u.rsplit("/", 1)[-1]
        optarg, st["optarg"] = st["optarg"], False
        # An option's OPERAND (`sudo -u root`, `env -u VAR`, `timeout -s KILL`)
        # is not the command either; without this the word after any wrapper
        # option closed the command position and silenced the eval that followed.
        keeps = (base in PREFIX_CMDS or base in KEYWORDS or OPTIONISH.match(u)
                 or ("=" in u.split("/")[0] and not u.startswith("=")) or optarg)
        if u in OPERAND_OPTS and lead:
            st["optarg"] = True        # `sudo -i grep eval file` has no operand:
                                       # treating every flag as taking one kept the
                                       # command position open and fired on an
                                       # `eval` that was just an argument
        if not keeps:
            st["lead"] = False
        if u in ("-v", "-V") and lead:
            st["lead"] = False         # `command -v eval` is a query, not an eval
        if u == "eval":
            # Only in COMMAND position: `grep eval file` is not an eval, and a gate
            # that refused it would be switched off within a day. Everything that
            # may legally stand in front of a command -- a wrapper, an option, a
            # duration, an assignment -- keeps the position open.
            if lead:
                out.append(("C_EVAL", "eval"))
            return
        # The interpreter stays armed to the end of its command. Finding where its
        # options end takes a table of every option with an operand (python3 -W
        # ignore -c, bash -o pipefail -c, perl -I lib -e), and such a table is
        # never complete: each missing entry disarmed the -c after it. So an inline
        # flag after the script arms too (python3 tool.py -c "$(x)"): a rare false
        # refusal, traded for a whole class of misses.
        if u == "--":
            st["interp"] = False
        if _interp(u):
            # ONLY in command position. `find . -name python3 -exec grep -E "$( )"`
            # armed the rule from an ARGUMENT and then fired on an unrelated grep --
            # a measured false positive on ordinary work.
            if lead:
                st["interp"] = True
            return
        glued, st["glued"] = st["glued"], False
        if glued:
            return                     # -c"payload": the payload was THIS word
        head = u.split('"', 1)[0].split("'", 1)[0]      # -c"..." is a flag too
        if st["interp"] and (INLINE_FLAG.match(u) or (head and INLINE_FLAG.match(head))):
            st["await"] = True

    while i < n:
        c = s[i]
        if c == "\\":
            if i + 1 < n and s[i + 1] == "\n":
                i += 2                     # line continuation: SPLICES the word --
                continue                   # e\<newline>val is the single word eval
            if i + 1 < n:
                wbuf.append(c); wbuf.append(s[i + 1]); i += 2
            else:
                i += 1
            continue
        if stop and c == stop:
            close_word()
            return i + 1
        if c == "#" and not wbuf and (i == 0 or s[i - 1] in " \t\n;&|("):
            nl = s.find("\n", i)
            end = n if nl < 0 else nl
            if notes is not None and depth == 0:
                notes.append(s[i:end])   # a comment nested inside $( ) must not
                                         # grant the escape for the whole command
            i = end
            continue
        if c == "<" and s.startswith("<<<", i):
            keep = st["await"]
            close_word()
            st["await"] = keep
            i += 3
            st["skip"] = True              # the here-string operand is not a command
            continue
        if c == "<" and s.startswith("<<", i) and HEREDOC_HDR.match(s, i):
            m = HEREDOC_HDR.match(s, i)
            close_word()
            # The body starts on the NEXT line. The rest of this line is still the
            # same command and may open more heredocs; their bodies follow in order.
            pending.append((m.group(1) == "-",) + _delim(m.group(2)))
            i = m.end()
            continue
        if c in "<>":
            keep = st["await"]         # `python3 -c 2>/dev/null "$( )"`: the
            close_word()               # descriptor is not the payload
            st["await"] = keep
            i += 1
            while i < n and s[i] in "<>&":
                i += 1
            st["skip"] = True              # the target is not a command word
            continue
        if c == "(" and wbuf and "".join(wbuf).endswith("=") and ASSIGN.match(
                _unescape("".join(wbuf))):
            j, dep = i + 1, 0          # array assignment: the ELEMENTS are data,
            while j < n:               # but they are still expanded, so scan them
                ch = s[j]
                if ch == "\\":
                    j += 2
                    continue
                if ch == "'":
                    k = s.find("'", j + 1)
                    j = n if k < 0 else k + 1
                    continue
                if ch == '"':
                    k = j + 1
                    while k < n:
                        if s[k] == "\\":
                            k += 2
                            continue
                        if s[k] == '"':
                            break
                        k += 1
                    j = k + 1
                    continue
                if ch == "(":
                    dep += 1
                elif ch == ")":
                    if dep == 0:
                        break
                    dep -= 1
                j += 1
            inner = s[i + 1:min(j, n)]
            if inner:
                sub = dict(st); sub["lead"] = False   # no command position inside
                _scan(inner, 0, out, reg, depth + 1, notes=notes, inherit=sub)
            del wbuf[:]
            present[0] = True
            i = min(j + 1, n)
            continue
        if c in SEPARATORS:
            close_word()
            st.update({"interp": False, "await": False, "lead": True, "skip": False})
            i += 1
            if c == "\n" and pending:
                for dash, delim, quoted in pending:
                    body, i = _heredoc_body_end(s, i, dash, delim)
                    if not quoted:
                        _check_body(body, delim, out)
                del pending[:]         # what follows the last document is a NEW
            continue                   # command (an eval right after a heredoc)
        if c in " \t":
            close_word()
            i += 1
            continue
        if c == "'":
            present[0] = True
            if wbuf and wbuf[-1] == "$":
                # $'...' (ANSI-C quoting): a backslash escapes the next character,
                # so \' does not close it. Treated as a plain '...', `$'it\'s'`
                # opened an unterminated quote that hid the rest of the command.
                j = i + 1
                while j < n and s[j] != "'":
                    j += 2 if s[j] == "\\" else 1
                if j >= n:
                    j = -1
            else:
                j = s.find("'", i + 1)
            if j < 0:
                wbuf.append(s[i + 1:]); i = n
            else:
                wbuf.append(s[i + 1:j]); i = j + 1
            continue
        if c == '"':
            present[0] = True
            head = _unescape("".join(wbuf))
            glued_flag = st["interp"] and bool(INLINE_FLAG.match(head))
            take = st["await"] or glued_flag
            if glued_flag:
                st["glued"] = True
            j = _scan_dq(s, i + 1, out, reg, take, depth, notes=notes,
                         armed=st["interp"] and not wbuf)
            wbuf.append(s[i + 1:max(i + 1, j - 1)])
            i = j
            continue
        if s.startswith("$((", i):
            j, body = _arith(s, i)
            if body:
                _scan_dq(body + '"', 0, out, reg, st["await"], depth + 1, notes=notes)
            wbuf.append("\x00")
            i = j
            continue
        if _is_subst(s, i):
            glued_here = st["interp"] and bool(
                INLINE_FLAG.match(_unescape("".join(wbuf))))
            if st["await"] or glued_here:
                out.append(("A_INLINE_INTERP_DQ", "$( )"))
            wbuf.append("\x00")           # a substitution IS a word: without this
                                          # `> $(x) eval` left the skip pending and
                                          # swallowed the command after it
            i = _scan(s, i + 2, out, reg, depth + 1, stop=")", notes=notes)
            continue
        if c == "$" and s.startswith("${", i):
            m = PROMPT_EXPAND.match(s, i)
            if m:
                out.append(("D_PROMPT_EXPAND", m.group(0)))
                wbuf.append(m.group(0))
                i = m.end()
                continue
            j, dep = i + 2, 0          # ${var} is one word element, not a brace
            while j < n:               # group: letting { and } fall through to
                if s[j] == "{":        # SEPARATORS reopened the command position
                    dep += 1           # and fired eval on a plain argument
                elif s[j] == "}":
                    if dep == 0:
                        break
                    dep -= 1
                j += 1
            wbuf.append(s[i:min(j + 1, n)])
            i = min(j + 1, n)
            continue
        wbuf.append(c)
        i += 1
    close_word()
    return n


def findings(cmd):
    """Return [(rule, detail)] for constructs where data placed in the command
    text will be re-scanned by the shell. An empty list is not proof of safety."""
    if not cmd:
        return []
    out = []
    try:
        _scan(cmd, 0, out, {})
    except RecursionError:
        return []                    # fail-open: never wedge on a pathological input
    return out


def comments(cmd):
    """Text of the shell COMMENTS in the command. The gate needs this so that its
    escape marker only counts when it is written as a comment -- a command whose
    quoted data happened to contain the marker would otherwise disarm the gate."""
    if not cmd:
        return []
    notes = []
    try:
        _scan(cmd, 0, [], {}, notes=notes)
    except RecursionError:
        return []
    return notes
