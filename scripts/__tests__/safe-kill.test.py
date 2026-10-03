#!/usr/bin/env python3
"""Regression test for scripts/safe-kill (card 0ad8d161).

safe-kill signals only a process the caller started and recorded. Every case runs on
a FAKE /proc tree in a temp directory and with a recording kill function: no real
signal is sent to anything, and the refusals are the point of most cases.

Run: python3 <this file>   Exit 0 = all green.
"""
import importlib.machinery
import importlib.util
import io
import os
import signal
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TOOL = os.path.join(ROOT, 'scripts', 'safe-kill')

loader = importlib.machinery.SourceFileLoader('safekill', TOOL)
spec = importlib.util.spec_from_loader('safekill', loader)
sk = importlib.util.module_from_spec(spec)
loader.exec_module(sk)

failed = []
ME = os.getuid()
TICK = float(os.sysconf('SC_CLK_TCK'))


def check(name, ok):
    print('  [%s] %s' % ('PASS' if ok else 'FAIL', name))
    if not ok:
        failed.append(name)


def make_proc(root, procs, btime):
    """procs: {pid: (comm, uid, state, start_ticks, argv bytes)}"""
    os.makedirs(root, exist_ok=True)
    open(os.path.join(root, 'stat'), 'w').write('cpu 1 2 3\nbtime %d\n' % btime)
    for pid, (comm, uid, state, start, argv) in procs.items():
        d = os.path.join(root, str(pid))
        os.makedirs(d)
        rest = [state] + ['0'] * 18 + [str(start)] + ['0'] * 30
        open(os.path.join(d, 'stat'), 'w').write('%d (%s) %s\n' % (pid, comm, ' '.join(rest)))
        open(os.path.join(d, 'comm'), 'w').write(comm + '\n')
        open(os.path.join(d, 'status'), 'w').write('Name:\t%s\nUid:\t%d\t%d\t%d\t%d\n' % (comm, uid, uid, uid, uid))
        open(os.path.join(d, 'cmdline'), 'wb').write(argv)


class Kills:
    def __init__(self):
        self.calls = []

    def __call__(self, pid, sig):
        self.calls.append((pid, sig))


def pidfile(dirpath, content, mode=0o600, mtime=None):
    path = os.path.join(dirpath, 'run-%d.pid' % len(os.listdir(dirpath)))
    with open(path, 'w') as fh:
        fh.write(content)
    os.chmod(path, mode)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def refused(fn, *a, **kw):
    try:
        fn(*a, **kw)
    except sk.Refused as exc:
        return str(exc)
    return None


with tempfile.TemporaryDirectory() as tmp:
    now = int(time.time())
    btime = now - 100000                       # booted ~28 h ago
    started_at = now - 600                     # the process started 10 min ago
    start_ticks = int((started_at - btime) * TICK)
    proc = os.path.join(tmp, 'proc')
    make_proc(proc, {
        # PID 1 with a plain comm, as in a container whose init is a shell: refused for
        # being PID 1, not for its name.
        1: ('sh', ME, 'S', start_ticks, b'sh\x00'),
        5001: ('sleep', ME, 'S', start_ticks, b'sleep\x00600\x00'),
        5002: ('tmux: server', ME, 'S', start_ticks, b'tmux\x00'),
        5003: ('systemd', ME, 'S', start_ticks, b'/lib/systemd/systemd\x00--user\x00'),
        5004: ('sleep', ME + 1, 'S', start_ticks, b'sleep\x00'),
        5005: ('sleep', ME, 'Z', start_ticks, b''),
        5006: ('sshd', ME, 'S', start_ticks, b'sshd\x00'),
    }, btime)
    files = os.path.join(tmp, 'files')
    os.makedirs(files)
    kw = dict(proc=proc, managers=set())

    print('the normal stop')
    k = Kills()
    f = pidfile(files, '5001 %d\n' % start_ticks)
    msg = sk.stop(f, kill_fn=k, **kw)
    check('a recorded PID is signalled once with TERM', k.calls == [(5001, signal.SIGTERM)] and 'sent' in msg)
    k = Kills()
    msg = sk.stop(f, sig=signal.SIGKILL, dry_run=True, kill_fn=k, **kw)
    check('--dry-run sends nothing', k.calls == [] and 'would send SIGKILL' in msg)
    k = Kills()
    f = pidfile(files, '5001\n', mtime=started_at + 2)
    sk.stop(f, kill_fn=k, **kw)
    check('a bare PID file written after the start is accepted', k.calls == [(5001, signal.SIGTERM)])
    k = Kills()
    sk.stop(f, 5001, kill_fn=k, **kw)
    check('the PID argument may repeat the file', k.calls == [(5001, signal.SIGTERM)])

    print('a PID that is not (or no longer) the caller\'s process')
    f = pidfile(files, '5001\n', mtime=started_at - 3600)
    check('a bare PID file older than the process: reused PID', 'reused PID' in (refused(sk.stop, f, kill_fn=Kills(), **kw) or ''))
    f = pidfile(files, '5001 %d\n' % (start_ticks + 50))
    check('a recorded start time that differs: reused', 'reused' in (refused(sk.stop, f, kill_fn=Kills(), **kw) or ''))
    f = pidfile(files, '5099\n')
    check('a PID that is not running', 'not running' in (refused(sk.stop, f, kill_fn=Kills(), **kw) or ''))
    f = pidfile(files, '5005\n')
    check('a zombie', 'zombie' in (refused(sk.stop, f, kill_fn=Kills(), **kw) or ''))
    f = pidfile(files, '5004\n')
    check('another uid\'s process', 'not to you' in (refused(sk.stop, f, kill_fn=Kills(), **kw) or ''))
    f = pidfile(files, '5001 %d\n' % start_ticks)
    check('a PID argument that is not the file\'s', 'is not the one in' in (refused(sk.stop, f, 5002, kill_fn=Kills(), **kw) or ''))

    print('a target whose death takes others with it')
    for pid, name in ((1, 'PID 1 (comm "sh")'), (5002, 'tmux server'), (5003, 'systemd'), (5006, 'sshd')):
        f = pidfile(files, '%d\n' % pid)
        check('%s is refused' % name, refused(sk.stop, f, kill_fn=Kills(), **kw) is not None)
    make_proc(os.path.join(tmp, 'proc2'), {6001: ('worker', ME, 'S', start_ticks, b'worker\x00')}, btime)
    f = pidfile(files, '6001 %d\n' % start_ticks)
    check('a PID the manager lookup names is refused',
          'service manager' in (refused(sk.stop, f, kill_fn=Kills(), proc=os.path.join(tmp, 'proc2'), managers={6001}) or ''))
    check('the shared manager lookup (the kill gate\'s) finds the fake systemd --user',
          sk._gate().manager_pids(proc, ME) == {5003})
    check('without a managers argument the lookup runs and a plain process passes',
          sk.check_target(5001, ME, proc)['comm'] == 'sleep')

    print('a PID file that is not the caller\'s own')
    good = pidfile(files, '5001 %d\n' % start_ticks)
    link = os.path.join(files, 'link.pid')
    os.symlink(good, link)
    check('a symlink', 'symlink' in (refused(sk.stop, link, kill_fn=Kills(), **kw) or ''))
    f = pidfile(files, '5001 %d\n' % start_ticks, mode=0o620)
    check('group-writable', 'writable by group or others' in (refused(sk.stop, f, kill_fn=Kills(), **kw) or ''))
    # The process (5004) IS the other uid's, so only the file-owner check can refuse here.
    f = pidfile(files, '5004 %d\n' % start_ticks)
    why = refused(sk.stop, f, uid=ME + 1, kill_fn=Kills(), **kw) or ''
    check('a PID file owned by another uid', 'the PID file' in why and 'not to you' in why)
    f = pidfile(files, 'hello\n')
    check('not a PID', 'does not hold' in (refused(sk.stop, f, kill_fn=Kills(), **kw) or ''))
    check('a missing file', refused(sk.stop, os.path.join(files, 'none.pid'), kill_fn=Kills(), **kw) is not None)

    print('--record')
    rec = os.path.join(files, 'recorded.pid')
    sk.record(rec, 5001, **kw)
    st = os.stat(rec)
    check('writes "PID STARTTIME" with mode 0600',
          open(rec).read() == '5001 %d\n' % start_ticks and (st.st_mode & 0o777) == 0o600)
    k = Kills()
    sk.stop(rec, kill_fn=k, **kw)
    check('a recorded file stops the process', k.calls == [(5001, signal.SIGTERM)])
    check('records only a process that may be stopped', refused(sk.record, os.path.join(files, 'x.pid'), 5002, **kw) is not None)

    print('signals and the command line')
    check('TERM, SIGKILL and 9 parse', (sk.parse_signal('TERM'), sk.parse_signal('SIGKILL'), sk.parse_signal('9'))
          == (signal.SIGTERM, signal.SIGKILL, signal.SIGKILL))
    old_err = sys.stderr
    sys.stderr = io.StringIO()
    try:
        check('no arguments: usage (64)', sk.main([]) == 64)
        check('an unknown signal: usage (64)', sk.main(['--pidfile', good, '-s', 'NOPE']) == 64)
        check('a refusal: 2', sk.main(['--pidfile', os.path.join(files, 'none.pid'), '--dry-run']) == 2)
    finally:
        sys.stderr = old_err

print()
if failed:
    print('FAILED: %d' % len(failed))
    for f in failed:
        print('  - ' + f)
    sys.exit(1)
print('ALL GREEN')
