#!/usr/bin/env python3
"""schedule-dated-post-gate.py -- a one-shot wake-up goes through egyszeri.py, not a raw POST (card 44ac3366).

WHY: a dated cron ("15 7 9 10 *": the day and the month are fixed) is how this install writes a one-shot wake-up, and
the scheduling skill writes one with a script (utemezett-feladat-eletciklus, rule 0: scripts/egyszeri.py). The script
does in one step what a raw POST /api/schedules leaves out: the schedule registry entry, forceSend and telegramChatId,
the cleanup line, and the read-back. The rule stood in the skill and in memory, and the main agent still wrote raw
POSTs three times (2026-10-01, 2026-10-03, 2026-10-08). Knowing the rule is not a brake.

WHAT: PreToolUse(Bash) for the MAIN agent (.claude/settings.json; the sub-agents are stopped earlier, on every
/api/schedules call, by scripts/self-pace-gate.mjs). It denies (exit 2) a command that
  (a) CREATES a schedule: a POST to the collection path /api/schedules (not /api/schedules/<name>, /toggle, /run, and
      not a PUT), by curl or by a call in an inline script, and
  (b) carries a DATED cron, one whose day and month field are numbers (see below for where it may stand).
egyszeri.py itself passes: its HTTP call runs inside the script, the command only names the script.

HOW A CREATE IS RECOGNIZED (the forms the main agent's own transcripts use; measured 2026-10-08 on 944 commands that
name /api/schedules: 174 denied, and each of the 157 inside the dashboard log's window is followed within 5 minutes by
a "Scheduled task created" line with that cron):
  - curl: the curl command that names the collection URL, with -X POST, or with a data option and no -X (and no -G);
  - an HTTP-looking call (call, req, api, *post*, urlopen, Request, ...; print() is not one) whose argument is the
    collection path ("call('POST', '/api/schedules', body)", "api('/api/schedules', 'POST', body)",
    "urllib.request.Request('http://.../api/schedules', data=...)", "requests.post(...)"): a 'POST' argument or method
    POST means a create, any other method argument means none; without one, a function named *post* creates and one
    named *get* does not; urllib's Request creates when it is given data; any other helper creates when it is given a
    body (a second positional argument).
A dated cron counts as a schedule value or as a quoted cron string of its own (a shell argument, a variable's value,
an f-string whose day and month are literal numbers).
NOT SEEN, by design (a command is text): a cron whose day or month comes from a variable ("$CRON",
f"{m} {h} {d} {mo} *"), and a request body read from a file an earlier command wrote.

ONLY WHERE THE SCRIPT EXISTS: egyszeri.py ships in scripts/ (the seed skill utemezett-feladat-eletciklus documents
it). A tree without it (an older checkout, a partial copy) keeps the raw POST as its only path: the gate allows, and
logs one line. SCHEDULE_GATE_ONESHOT_SCRIPT points the gate at another copy.

FAIL-OPEN: any error of the gate itself (stdin, parsing) never stops a Bash call: exit 0 and one line to
store/hook-errors.log (hook_errlog). This hook never exits 1.
"""
import json
import os
import re
import shlex
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

HOOK = "schedule-dated-post-gate"
MESSAGE = "egyszeri ébresztő csak az egyszeri.py-jal (utemezett-feladat-eletciklus 0.)"
ONESHOT_SCRIPT = os.environ.get("SCHEDULE_GATE_ONESHOT_SCRIPT") or os.path.join(
    os.path.realpath(os.path.join(HERE, "..", "..")), "scripts", "egyszeri.py",
)

# The collection path: /api/schedules itself (a query string allowed), never /api/schedules/<name>/...
COLLECTION = re.compile(r"/api/schedules(?![\w/-])")
# A cron field as the scheduler takes it (digits, '*', '/', ',' and '-'), or a placeholder an f-string or a %-format
# fills in ("{t.minute}", "%d"). Prose ("kéri 9 10 órára") is not a cron. A day or a month counts as dated only when
# it is a literal number.
CRON_FIELD = r"""(?:[\d*/,\-]{1,20}|\{[^{}\s"'\\]{1,40}\}|%[sd])"""
# A schedule value: "schedule": "...", 'schedule': '...', \"schedule\":\"...\", schedule='...', also as an f-string.
# A comparison ("t['schedule'] == '15 7 9 10 *'") is not a value: after '=' the quote has to follow.
SCHEDULE_VALUE = re.compile(
    r"""(?<![\w-])schedule["'\\]{0,3}\s*[:=]\s*[fF]?\\?["']\s*"""
    + r"\s+".join(["(" + CRON_FIELD + ")"] * 5) + r"""\s*\\?["']"""
)
# A cron written as a string of its own and passed on ("schedule": cron, mk name "55 5 19 9 *" ..., sys.argv[4], an
# f-string): the transcripts build about a fifth of their raw one-shot POSTs this way (measured 2026-10-08).
CRON_STRING = re.compile(
    r"""(?<![\w\\])[fF]?(["'])\s*""" + r"\s+".join(["(" + CRON_FIELD + ")"] * 5) + r"""\s*\1"""
)
CURL = re.compile(r"(?<![\w.-])curl(?![\w.-])")
HTTP_METHODS = {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"}
DATA_OPTIONS = ("-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F",
                "--form", "--form-string")
SEPARATORS = "\n;&|)"
# The helper names the transcripts use for an HTTP call (call, req, api, _post, urlopen, ...); anything else is not one.
HTTP_HELPER = re.compile(r"api|req|call|http|send|urlopen")


def _log(message, exc=None):
    try:
        import hook_errlog
        hook_errlog.report(HOOK, message, exc)
    except Exception:
        pass


def dated_schedule(text):
    """The first dated cron in text (a schedule value, or a quoted cron string of its own): the day and the month field
    are numbers. None when there is none."""
    for m in SCHEDULE_VALUE.finditer(text):
        if m.group(3).isdigit() and m.group(4).isdigit():
            return " ".join(m.groups())
    for m in CRON_STRING.finditer(text):
        if m.group(4).isdigit() and m.group(5).isdigit():
            return " ".join(m.groups()[1:])
    return None


def _command_end(text, i):
    """Where the shell command that starts at i ends: the first unquoted ;, &, |, ) or newline that is not a
    backslash continuation."""
    quote = None
    n = len(text)
    while i < n:
        c = text[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"":
            quote = c
        elif c == "\\":
            i += 2
            continue
        elif c in SEPARATORS:
            return i
        i += 1
    return n


def _curl_creates(text):
    """Every curl command in text that POSTs to the collection path."""
    for m in CURL.finditer(text):
        span = text[m.start():_command_end(text, m.end())]
        if not COLLECTION.search(span):
            continue
        try:
            words = shlex.split(span, comments=False, posix=True)
        except ValueError:
            words = span.split()
        method = None
        data = get = False
        for k, w in enumerate(words):
            if w in ("-X", "--request") and k + 1 < len(words):
                method = words[k + 1].upper()
            elif w.startswith("--request="):
                method = w.split("=", 1)[1].upper()
            elif w.startswith("-X") and len(w) > 2:
                method = w[2:].upper()
            elif w in ("-G", "--get"):
                get = True
            elif w in DATA_OPTIONS or any(w.startswith(o + "=") for o in DATA_OPTIONS if o.startswith("--")) \
                    or (w[:2] in ("-d", "-F") and len(w) > 2):
                data = True
        if method == "POST" or (method is None and data and not get):
            yield span


def _skip_string(text, i, step):
    """From the quote at i, the index just past the other end of that string literal (step 1 = forward, -1 = back),
    on the same line; None when the line ends first."""
    q = text[i]
    j = i + step
    n = len(text)
    while 0 <= j < n and text[j] != "\n":
        if text[j] == q and not (step == 1 and text[j - 1] == "\\" and text[j - 2:j] != "\\\\"):
            if step == -1 and j > 0 and text[j - 1] == "\\":
                j += step
                continue
            return j + step
        j += step
    return None


def _call_around(text, s, e):
    """The call whose argument list holds the string literal text[s:e]: (name, [argument texts]) or None."""
    # backward to the unmatched '(' on the same line, stepping over strings and balanced brackets
    depth = 0
    i = s - 1
    open_at = None
    while i >= 0 and text[i] != "\n" and s - i < 2000:
        c = text[i]
        if c in "'\"":
            j = _skip_string(text, i, -1)
            if j is None:
                return None
            i = j
            continue
        if c in ")]}":
            depth += 1
        elif c in "([{":
            if depth == 0:
                if c == "(":
                    open_at = i
                break
            depth -= 1
        i -= 1
    if open_at is None:
        return None
    m = re.search(r"([A-Za-z_][\w.]*)\s*$", text[max(0, open_at - 80):open_at])
    if not m:
        return None
    name = m.group(1)
    # forward from '(' to the matching ')', splitting the top-level arguments
    args, cur, depth, i, n = [], [], 0, open_at + 1, len(text)
    while i < n and i - open_at < 200000:
        c = text[i]
        if c in "'\"":
            j = _skip_string(text, i, 1)
            if j is None:
                return None
            cur.append(text[i:j])
            i = j
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                args.append("".join(cur).strip())
                return name, [a for a in args if a]
            depth -= 1
        elif c == "," and depth == 0:
            args.append("".join(cur).strip())
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    return None


def _call_creates(name, args):
    short = name.rsplit(".", 1)[-1].lower()
    # Only an HTTP-looking call is a request: print('POST', '/api/schedules'), a logger or a formatter given the path
    # is not one, whatever its arguments say.
    if not (HTTP_HELPER.search(short) or "post" in short or short == "fetch"):
        return False
    literal = re.compile(r"""^(["'])(\w+)\1$""")
    keyword = re.compile(r"^(\w+)\s*=(?!=)\s*(.*)$", re.S)
    positional = [a for a in args if not keyword.match(a)]
    methods = [literal.match(a).group(2).upper() for a in positional
               if literal.match(a) and literal.match(a).group(2).upper() in HTTP_METHODS]
    joined = ",".join(args)
    kw = re.search(r"""\bmethod\s*[:=]\s*(["'])(\w+)\1""", joined)
    if kw:
        methods.append(kw.group(2).upper())
    if methods:
        return "POST" in methods
    if "post" in short:
        return True
    if "get" in short or short == "fetch":
        return False
    if short == "request":
        return len(positional) >= 2 or any(re.match(r"^data\s*=(?!=)", a) for a in args)
    return len(positional) >= 2


def _script_creates(text):
    """Every call in text whose argument is the collection path and that POSTs to it."""
    for m in COLLECTION.finditer(text):
        line_start = text.rfind("\n", 0, m.start()) + 1
        s = None
        i = m.start() - 1
        while i >= line_start:
            if text[i] in "'\"":
                s = i
                break
            i -= 1
        if s is None:
            continue
        e = _skip_string(text, s, 1)
        if e is None or e < m.end():
            continue
        call = _call_around(text, s, e)
        if call and _call_creates(*call):
            yield call[0]


def decide(command):
    """None to allow, or the dated cron that makes this command a raw one-shot create."""
    if "/api/schedules" not in command:
        return None
    cron = dated_schedule(command)
    if cron is None:
        return None
    if next(_curl_creates(command), None) is None and next(_script_creates(command), None) is None:
        return None
    return cron


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict) or payload.get("tool_name") != "Bash":
            sys.exit(0)
        tool_input = payload.get("tool_input")
        command = tool_input.get("command") if isinstance(tool_input, dict) else None
        if not isinstance(command, str):
            sys.exit(0)
        cron = decide(command)
        if cron is None:
            sys.exit(0)
        if not os.path.isfile(ONESHOT_SCRIPT):
            _log(f"allowed a raw POST /api/schedules with the dated cron {cron!r}: {ONESHOT_SCRIPT} is missing")
            sys.exit(0)
        sys.stderr.write(MESSAGE + "\n")
        sys.exit(2)
    except SystemExit:
        raise
    except Exception as exc:
        _log("the gate failed, the call was allowed (fail-open)", exc)
        sys.exit(0)


if __name__ == "__main__":
    main()
