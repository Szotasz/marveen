#!/usr/bin/env python3
"""kill-gate.py -- PreToolUse(Bash) gate: no signal to the user's service manager, and
no signal to a PID that the same command took from a parent-PID lookup or from a
lookup of the manager by name.

WHY IT EXISTS (card 0ad8d161, 2026-10-03): an agent stopped a detached launcher with

    SP=$(pgrep -f '<label>' | head -1); PP=$(ps -o ppid= -p $SP | tr -d ' '); kill -TERM $PP

The pgrep pattern matched the `bash -c` launcher itself, and a detached (setsid)
process is adopted by the per-user service manager. So $PP was `systemd --user`, the
TERM went to it, and the manager took every process of the user with it: the whole
agent fleet, the main agent and the chat bridge were down for 22 minutes, and every
background run was lost. On a host where orphans are re-parented to the user manager,
a PID taken from a parent lookup is the manager more often than not.

WHAT IS BLOCKED (exit 2, the reason and the safe form on stderr):
  (a) a signal sender (kill, pkill, killall) AND a parent-PID lookup in the SAME
      command: `ps` asked for the ppid field, `$PPID`, the ppid field of
      /proc/<pid>/stat (the 4th) or the PPid line of /proc/<pid>/status. The gate
      cannot know which PID the lookup will return, so the combination is refused;
  (b) a target that IS the user's service manager or init: `kill <n>` and
      `kill -- -<pgid>` where n is PID 1 or a running `systemd --user` of the calling
      uid (looked up at hook time), `kill ... -1` (every process the caller may
      signal), `killall5`, `pkill`/`killall` whose pattern names systemd or that has
      only a user/group selector and no pattern (every process of that user), and
      `pkill -P <n>` / `pkill -g <n>` with such an n.
  (c) a signal sender AND a lookup of the service manager BY NAME in the same command:
      `pgrep`, `pidof`, `ps -C`, or a grep/awk/sed filter whose arguments name systemd
      (`[s]ystemd` included), a `pgrep` with only a user/group selector (every process
      of that user), and `pgrep -P`/`-g` with PID 1 or the manager. Whatever such a
      lookup returns, systemd is among it. A lookup that prints nothing a kill could
      use is a guard, not a lookup, and passes: `grep -q`/`-c`/`-l`, `pgrep -c`,
      `pidof -q` (`ps -o comm= -p $P | grep -qx systemd || kill $P` is the check the
      stop skill asks for).
  A signal-0 probe (`kill -0`) and the list forms (`kill -l`, `killall -l`) send
  nothing and pass.

WHAT PASSES: a numeric PID that is none of the above, a PID read from a PID file the
caller wrote at launch (`kill "$(cat run.pid)"`), and the recommended path,
scripts/safe-kill, which checks the target at run time.

HOW IT READS THE COMMAND: with the destructive-gate's context-aware scanner, imported
from destructive-gate.py next to this file: comment lines, the body of a data heredoc
(`cat > f <<EOF`) and quoted prose are not commands, a quoted string is never a
command word, and `bash -c '<script>'` is read as the script it is. The scanner's
private helpers are an API this gate depends on; scripts/__tests__/kill-gate.test.py
pins them, so a refactor there fails loudly.

WHAT IT CANNOT SEE (stated, not hidden): a PID carried over from an EARLIER call (PP
set in one Bash call and signalled in the next); a parent lookup in another language
(os.getppid, psutil) or a column cut out of `ps -ef`; a signal sent from an
interpreter payload (os.kill); `eval "<string>"`; `systemctl --user exit`, which stops
the manager without a signal, and the other forms that stop the user's processes with
no signal word (`loginctl kill-user`/`terminate-user`, `systemctl --user kill`/`stop`);
a PID taken from `systemctl --user show -p MainPID`; a `ps -u <user>` selection or a
/proc/*/comm loop fed to a kill; a remote host (ssh). The dynamic case has its own
answer, scripts/safe-kill, not this gate. One false positive is accepted: a filter
that names systemd for another purpose in the same command as a kill (an awk or sed
guard, a grep through a file) is read as a lookup. Write a guard with `grep -q`, put
the other filter in its own call, or stop through safe-kill.

FAILURE MODE: unreadable input blocks, like every governance gate in this repo. An
error INSIDE the gate blocks only a command that names a signal sender (the cheap
pre-check below); every other command passes, and the error is logged through
hook_errlog, so a gate bug cannot stop the whole fleet's Bash.
"""
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(HERE))
SAFE_KILL = os.path.join(PROJECT_ROOT, 'scripts', 'safe-kill')

# Cheap pre-check on the raw text: without one of these words there is nothing to
# judge, and 99% of Bash calls stop here. `safe-kill`, `tmux kill-session` and
# `docker kill` do not match (a dash or a word character on either side).
SIGNAL_WORD_RE = re.compile(r'(?<![\w-])(kill|pkill|killall|killall5)(?![\w-])')

SIGNAL_CMDS = ('kill', 'pkill', 'killall', 'killall5')
# The scanner's helpers this gate uses. A rename in destructive-gate.py must fail the
# test, not production; the test asserts this tuple against the module.
SCANNER_API = ('segments', '_bare_tokens', 'command_index', '_blank_ranges',
               '_comment_ranges', '_heredoc_body_ranges', '_prose_quote_ranges',
               '_script_arg_ranges', '_sub_scripts')
_MAX_NEST = 8

_scanner = None


def _load_scanner():
    global _scanner
    if _scanner is None:
        path = os.path.join(HERE, 'destructive-gate.py')
        spec = importlib.util.spec_from_file_location('_kill_gate_scanner', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        for name in SCANNER_API:
            getattr(mod, name)
        _scanner = mod
    return _scanner


# --- The calling uid's service manager ------------------------------------------------

def manager_pids(proc='/proc', uid=None):
    """PIDs of the running `systemd --user` instances of `uid` (default: the caller).

    Read from /proc at hook time, because the manager's PID changes whenever it is
    restarted (it did on the day this gate was written). Unreadable entries are
    skipped: processes come and go while the directory is listed.
    """
    uid = os.getuid() if uid is None else uid
    out = set()
    try:
        names = os.listdir(proc)
    except OSError:
        return out
    for d in names:
        if not d.isdigit():
            continue
        base = os.path.join(proc, d)
        try:
            with open(os.path.join(base, 'comm'), encoding='utf-8', errors='replace') as fh:
                if fh.read().strip() != 'systemd':
                    continue
            with open(os.path.join(base, 'status'), encoding='utf-8', errors='replace') as fh:
                real_uid = next((int(line.split()[1]) for line in fh if line.startswith('Uid:')), None)
            if real_uid != uid:
                continue
            with open(os.path.join(base, 'cmdline'), 'rb') as fh:
                argv = fh.read().split(b'\0')
            if b'--user' in argv:
                out.add(int(d))
        except (OSError, ValueError, IndexError, StopIteration):
            continue
    return out


# --- What part of the command runs as shell -------------------------------------------

def views(cmd, scan):
    """(code, lite): `lite` is the command without comment lines and data-heredoc
    bodies (the scanner's split: `cat > f <<EOF` is data, `bash <<SH` and
    `python3 - <<PY` are programs and stay); `code` is `lite` with quoted prose blanked
    as well (the destructive gate's rule: a quoted span with whitespace is text, unless
    it carries a command substitution or is a -c script). Offsets are preserved."""
    data, program = scan._heredoc_body_ranges(cmd)
    lite = scan._blank_ranges(cmd, data)
    lite = scan._blank_ranges(lite, scan._comment_ranges(lite))
    keep = scan._script_arg_ranges(lite)
    code = scan._blank_ranges(lite, scan._prose_quote_ranges(lite, keep, program))
    return code, lite


# --- The signal senders ---------------------------------------------------------------

def _command(toks, scan):
    """(index, basename) of the segment's real command; `sudo`/`doas`/`builtin` are
    looked through, the rest of the wrappers by the scanner itself."""
    idx = scan.command_index(toks)
    for _ in range(4):
        if idx is None or toks[idx][1]:
            return None, ''
        base = os.path.basename(toks[idx][0])
        if base not in ('sudo', 'doas', 'builtin'):
            return idx, base
        j = idx + 1
        while j < len(toks) and toks[j][0].startswith('-'):
            j += 2 if toks[j][0] in ('-u', '-g', '-C', '-h', '-p') else 1
        if j >= len(toks):
            return None, ''
        rest = scan.command_index(toks[j:])
        idx = None if rest is None else j + rest
    return None, ''


_SIG_ZERO = ('0', 'SIG0')


def _parse_kill(args):
    """kill's signal and targets. After the first signal spec, every word is a target,
    a negative number included (`kill -9 -1` signals every process)."""
    sig, targets, i = None, [], 0
    while i < len(args):
        a = args[i]
        if a == '--':
            targets.extend(args[i + 1:])
            break
        if sig is None and a in ('-l', '-L', '--list', '--table'):
            return 'LIST', []
        if sig is None and a in ('-s', '-n', '--signal'):
            sig = args[i + 1] if i + 1 < len(args) else ''
            i += 2
            continue
        if sig is None and a.startswith('--signal='):
            sig = a.split('=', 1)[1]
            i += 1
            continue
        if sig is None and a.startswith('-') and len(a) > 1:
            sig = a[1:]
            i += 1
            continue
        targets.append(a)
        i += 1
    return (sig or 'TERM'), targets


_PKILL_VALUE = ('-s', '--session', '-t', '--terminal', '-u', '--euid', '-U', '--uid',
                '-g', '--pgroup', '-G', '--group', '-P', '--parent', '-F', '--pidfile',
                '--ns', '--nslist', '--signal', '-q', '--queue', '--cgroup', '--env')
_PKILL_SELECT_USER = ('-u', '--euid', '-U', '--uid', '-G', '--group')


def _parse_pkill(args, value_opts=_PKILL_VALUE):
    """(signal, pattern, {option: [values]}) of a pkill call (or of a pgrep call, with
    pgrep's value options)."""
    sig, pattern, opts, i = 'TERM', None, {}, 0
    while i < len(args):
        a = args[i]
        if a.startswith('--') and '=' in a:
            k, v = a.split('=', 1)
            opts.setdefault(k, []).append(v)
            if k == '--signal':
                sig = v
            i += 1
            continue
        if a in value_opts:
            v = args[i + 1] if i + 1 < len(args) else ''
            opts.setdefault(a, []).append(v)
            if a == '--signal':
                sig = v
            i += 2
            continue
        if a.startswith('-') and len(a) > 1:
            body = a[1:]
            if re.match(r'^(SIG)?[A-Z]+[0-9+-]*$|^[0-9]+$', body):
                sig = body
            i += 1
            continue
        if pattern is None:
            pattern = a
        i += 1
    return sig, pattern, opts


_KILLALL_VALUE = ('-u', '--user', '-s', '--signal', '-y', '--younger-than', '-o',
                  '--older-than', '-n', '--ns', '-Z', '--context')


def _parse_killall(args):
    """(signal, names, {option: [values]}, list_mode) of a killall call."""
    sig, names, opts, i = 'TERM', [], {}, 0
    while i < len(args):
        a = args[i]
        if a in ('-l', '--list'):
            return 'LIST', [], {}, True
        if a in _KILLALL_VALUE:
            v = args[i + 1] if i + 1 < len(args) else ''
            opts.setdefault(a, []).append(v)
            if a in ('-s', '--signal'):
                sig = v
            i += 2
            continue
        if a.startswith('-') and len(a) > 1:
            body = a[1:]
            if re.match(r'^(SIG)?[A-Z]+[0-9+-]*$|^[0-9]+$', body):
                sig = body
            i += 1
            continue
        names.append(a)
        i += 1
    return sig, names, opts, False


def _number(word):
    # A subshell's or a substitution's closing paren sticks to the last word:
    # `(kill -TERM 4242)` and `$(pgrep -P 1)` hand over "4242)" and "1)".
    word = (word or '').rstrip(')')
    return int(word) if re.fullmatch(r'-?[0-9]+', word) else None


def _scripts(seg, toks, idx, scan):
    """The `bash -c` scripts of a segment, with their `(` restored. _bare_tokens turns
    every `(` into a space for the command-name search, which breaks a `$(...)` inside
    the script (`kill $(pidof systemd)` would read as one kill segment). The replacement
    is one character for one, so the original text is the same span of the segment."""
    flat = seg.replace('(', ' ')
    out = []
    for sub in scan._sub_scripts(toks, idx):
        p = flat.find(sub) if sub else -1
        out.append(seg[p:p + len(sub)] if p >= 0 else sub)
    return out


# (c) The lookups by name: the tools whose output can carry the PIDs of the processes
# their arguments name. pgrep's own value options add -d (the delimiter).
_NAME_TOOLS = ('pgrep', 'pidof', 'ps', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'gawk', 'mawk',
               'nawk', 'sed')
_PGREP_VALUE = _PKILL_VALUE + ('-d', '--delimiter')
# The modes that print nothing a kill could use (an exit status, a count, a file list):
# a guard, not a lookup. Per tool, because the same letter differs (pgrep -l lists PIDs).
_SILENT_LONG = ('--quiet', '--silent', '--count', '--files-with-matches', '--files-without-match')
_SILENT_SHORT = {'pgrep': 'c', 'pidof': 'q', 'grep': 'qclL', 'egrep': 'qclL', 'fgrep': 'qclL',
                 'rg': 'qclL'}


def _names_manager(word):
    """A pattern or a name that names the service manager. `[s]ystemd` and `s\\ystemd`
    count: a grep pattern is written so to keep from matching its own command line."""
    return 'systemd' in re.sub(r'[\[\]\\]', '', word).lower()


def _silent(base, args):
    short = _SILENT_SHORT.get(base, '')
    for a in args:
        if a == '--':
            break
        if a in _SILENT_LONG:
            return True
        if short and re.fullmatch(r'-[A-Za-z]+', a) and any(ch in short for ch in a[1:]):
            return True
    return False


class Gate:
    """One evaluation. `pids` provides the manager PIDs (the forbidden set adds PID 1)."""

    def __init__(self, scan, pids=None):
        self.scan = scan
        self._pids_fn = pids or manager_pids
        self._pids = None

    def forbidden(self):
        if self._pids is None:
            self._pids = {1} | set(self._pids_fn())
        return self._pids

    def _target_reason(self, n, how):
        if n == -1:
            return '%s: -1 signals every process the caller may signal, the service manager included' % how
        if abs(n) in self.forbidden():
            what = 'init (PID 1)' if abs(n) == 1 else 'the user service manager (systemd --user, PID %d)' % abs(n)
            return '%s targets %s' % (how, what)
        return None

    def check(self, cmd):
        """The reason to block, or None."""
        reason, senders, lookups, names = self._eval(cmd, 0)
        if reason:
            return reason
        if senders and lookups:
            return ('a signal is sent in the same command that looks up a parent PID (%s). '
                    'For a detached process that PID is the user service manager '
                    '(systemd --user)' % lookups[0])
        if senders and names:
            return ('a signal is sent in the same command that looks up the service manager '
                    'by name (%s). Whatever such a lookup returns, systemd is among it: init '
                    '(PID 1) or the user service manager (systemd --user)' % names[0])
        return None

    def _name_lookup(self, base, args, seg):
        """Why this segment is a lookup of the service manager by name (rule c), or None."""
        if base not in _NAME_TOOLS or _silent(base, args):
            return None
        if any(_names_manager(a) for a in args):
            return '`%s` names systemd: %s' % (base, seg.strip().rstrip(')')[:80])
        if base != 'pgrep':
            return None
        _sig, pattern, opts = _parse_pkill(args, _PGREP_VALUE)
        for o in ('-P', '--parent', '-g', '--pgroup'):
            for v in opts.get(o, []):
                n = _number(v)
                if n is not None and self._target_reason(n, ''):
                    return ('`pgrep %s %s` lists the children or the group of init or the manager'
                            % (o, v.rstrip(')')))
        narrowed = any(o in opts for o in ('-P', '--parent', '-g', '--pgroup', '-s', '--session',
                                           '-t', '--terminal', '-F', '--pidfile'))
        if pattern is None and not narrowed and any(o in opts for o in _PKILL_SELECT_USER):
            return '`pgrep` with only a user/group selector lists every process of that user'
        return None

    def _eval(self, cmd, depth):
        """(reason, senders, lookups, names) of one command text and its `bash -c` scripts.

        The structure is read from the lite view: segments() and the tokenizer are
        quote-aware, and a quoted string with whitespace is never taken for a command
        word, so a commit message that names `kill` stays a message. The arguments
        keep their quoted text there (a pkill pattern like 'systemd --user' survives).
        The text-level lookups use the code view, where quoted prose is blanked."""
        scan = self.scan
        code, lite = views(cmd, scan)
        senders, lookups, names = [], [], []
        for seg in scan.segments(lite):
            toks = scan._bare_tokens(seg)
            idx, base = _command(toks, scan)
            if idx is None:
                continue
            args = [t for t, _sp in toks[idx + 1:]]
            reason = None
            if base == 'killall5':
                reason = 'killall5 signals every process on the host'
            elif base == 'kill':
                sig, targets = _parse_kill(args)
                if sig != 'LIST' and sig.upper() not in _SIG_ZERO:
                    senders.append(seg)
                    for t in targets:
                        n = _number(t)
                        if n is not None:
                            reason = reason or self._target_reason(n, '`kill %s`' % t)
            elif base == 'pkill':
                sig, pattern, opts = _parse_pkill(args)
                if sig.upper() not in _SIG_ZERO:
                    senders.append(seg)
                    narrowed = any(o in opts for o in ('-P', '--parent', '-g', '--pgroup', '-s', '--session',
                                                       '-t', '--terminal', '-F', '--pidfile'))
                    if pattern and 'systemd' in pattern.lower():
                        reason = '`pkill` pattern "%s" names the service manager' % pattern
                    elif pattern is None and not narrowed and any(o in opts for o in _PKILL_SELECT_USER):
                        reason = '`pkill` with only a user/group selector signals every process of that user'
                    for o in ('-P', '--parent', '-g', '--pgroup'):
                        for v in opts.get(o, []):
                            n = _number(v)
                            if n is not None:
                                reason = reason or self._target_reason(n, '`pkill %s %s`' % (o, v))
            elif base == 'killall':
                sig, names, opts, listing = _parse_killall(args)
                if not listing and sig.upper() not in _SIG_ZERO:
                    senders.append(seg)
                    hit = next((n for n in names if 'systemd' in n.lower()), None)
                    if hit:
                        reason = '`killall %s` names the service manager' % hit
                    elif not names and ('-u' in opts or '--user' in opts):
                        reason = '`killall -u` without a name signals every process of that user'
            elif base == 'ps':
                skip_next = False
                for t in args:
                    if skip_next:
                        skip_next = False
                        continue
                    if t == '--ppid':
                        skip_next = True
                        continue
                    if 'ppid' in t.lower():
                        lookups.append('`ps` asked for the ppid field: %s' % seg.strip()[:80])
                        break
            if reason:
                return reason, senders, lookups, names
            found = self._name_lookup(base, args, seg)
            if found:
                names.append(found)
            for sub in _scripts(seg, toks, idx, scan):
                if not sub or sub == cmd:
                    continue
                if depth >= _MAX_NEST:
                    return 'the command nests too deep (%d levels) to follow' % depth, senders, lookups, names
                r2, s2, l2, n2 = self._eval(sub, depth + 1)
                if r2:
                    return r2, senders, lookups, names
                senders.extend(s2)
                lookups.extend(l2)
                names.extend(n2)
        lookups.extend(_text_lookups(code, lite))
        return None, senders, lookups, names


def _text_lookups(code, lite):
    """Parent lookups that are not a `ps` segment of their own: `$PPID`, a `ps` inside a
    quoted command substitution, the 4th field of /proc/<pid>/stat and the PPid line of
    /proc/<pid>/status. The path must be in the code view; the field extraction may sit
    in an awk or cut program, which the code view blanks as prose, so that half is read
    from the lite view."""
    out = []
    if re.search(r'\$\{?PPID\b', code):
        out.append('`$PPID`')
    # `ps --ppid <n>` lists the CHILDREN of n, it does not return a parent: skipped.
    if re.search(r'(?<![\w-])ps\s[^\n;&|]*?(?<!--)ppid', code, re.I):
        out.append('`ps ... ppid`')
    if re.search(r'/proc/[^\s/]+/stat(?![a-z])', code) and (
            re.search(r'(?<![\w$])\$4(?!\d)', lite) or re.search(r'-f\s*4(?![\d-])', lite)
            or re.search(r'ppid', lite, re.I)):
        out.append('the ppid field of /proc/<pid>/stat')
    if re.search(r'/proc/[^\s/]+/status\b', code) and 'PPid' in lite:
        out.append('the PPid line of /proc/<pid>/status')
    return out


def block(reason):
    sys.stderr.write(
        'KILL-GATE: BLOCKED. %s.\n\n'
        'Signal only a PID you recorded when you started the process, never one taken '
        'from a parent lookup or a pattern: on this host a detached process is adopted by '
        'the user service manager, and signalling the manager stops every process of the '
        'user (2026-10-03: the whole fleet for 22 minutes).\n'
        'The safe form:\n'
        '  start:  <command> & echo $! > run.pid     (or: %s --record run.pid $!)\n'
        '  stop:   %s --pidfile run.pid\n'
        'safe-kill refuses init, systemd, tmux and sshd, a PID file that is not yours, and '
        'a PID that was reused since the file was written.\n' % (reason, SAFE_KILL, SAFE_KILL))
    sys.exit(2)


def _report(message, exc=None):
    try:
        sys.path.insert(0, HERE)
        import hook_errlog
        hook_errlog.report('kill-gate', message, exc)
    except Exception:
        pass


def main():
    raw = sys.stdin.read()
    try:
        ev = json.loads(raw)
    except Exception:
        sys.stderr.write('KILL-GATE: the hook input is not readable, so the call is BLOCKED.\n')
        sys.exit(2)
    if (ev.get('tool_name') or '') != 'Bash':
        sys.exit(0)
    cmd = str((ev.get('tool_input') or {}).get('command') or '')
    if not SIGNAL_WORD_RE.search(cmd):
        sys.exit(0)
    try:
        reason = Gate(_load_scanner()).check(cmd)
    except Exception as exc:
        _report('gate error on a command that names a signal sender', exc)
        sys.stderr.write('KILL-GATE: the gate itself failed (%s: %s). The command names a '
                         'signal sender, so it is BLOCKED; this is a gate bug, not yours. '
                         'Use %s for the stop meanwhile.\n' % (type(exc).__name__, exc, SAFE_KILL))
        sys.exit(2)
    if reason:
        block(reason)
    sys.exit(0)


if __name__ == '__main__':
    main()
