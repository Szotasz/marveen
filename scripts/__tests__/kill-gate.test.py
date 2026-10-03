#!/usr/bin/env python3
"""Regression test for scripts/hooks/kill-gate.py (card 0ad8d161).

The gate refuses (a) a signal sender together with a parent-PID lookup in one command,
(b) a target that is PID 1, -1 or the caller's `systemd --user`, and (c) a signal
sender together with a lookup of the manager by name (pgrep, pidof, ps -C, a grep/awk
filter naming systemd) in one command. Every command
below is given to the gate as TEXT (the hook input); none of them is ever executed,
and the service-manager lookup is replaced by a stub (PID 4242) except in the two
end-to-end runs, which only read /proc.

The positive control is the shape of the 2026-10-03 command that stopped the user
service manager (names and paths neutralised); the negative control is a stop by the
caller's own PID file. Both directions are pinned: a later "fewer false positives"
change must fail here, not in production, and so must a gate that blocks prose.

Run: python3 <this file>   Exit 0 = all green.
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GATE = os.path.join(ROOT, 'scripts', 'hooks', 'kill-gate.py')

spec = importlib.util.spec_from_file_location('kgate', GATE)
kgate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kgate)

MANAGER = 4242
kgate.manager_pids = lambda proc='/proc', uid=None: {MANAGER}
SCAN = kgate._load_scanner()

failed = []


def check(name, ok):
    print('  [%s] %s' % ('PASS' if ok else 'FAIL', name))
    if not ok:
        failed.append(name)


def blocks(cmd):
    return kgate.Gate(SCAN).check(cmd) is not None


# The 2026-10-03 shape, neutralised: a pgrep -f pick, its parent from ps, TERM to both.
INCIDENT = (
    "grep -q 'START agent=agent-x label=agent-x-lab-l2' \"$HOME/.cache/runner.log\" && echo \"L2 RUNNING\" || "
    "{ SP=$(pgrep -f 'label agent-x-lab-l2' | head -1); PP=$(ps -o ppid= -p $SP | tr -d ' '); "
    "echo \"l2 bash=$PP runner=$SP $(tr '\\0' ' ' < /proc/$PP/cmdline | cut -c1-80)\"; "
    "kill -TERM $PP; kill -TERM $SP; sleep 2; ps -p $PP,$SP -o pid= | wc -l; }")
OWN_PIDFILE_STOP = 'kill -TERM "$(cat run.pid)"'

print('scanner API (the gate depends on these helpers of destructive-gate.py)')
check('every helper the gate imports still exists', all(hasattr(SCAN, n) for n in kgate.SCANNER_API))

print('(a) a signal plus a parent-PID lookup in one command')
check('the 2026-10-03 shape is blocked (positive control)', blocks(INCIDENT))
check('kill of a ps ppid inside a quoted command substitution', blocks('kill -TERM "$(ps -o ppid= -p $X)"'))
check('ps -o ppid= piped into xargs kill', blocks('ps -o ppid= -p $X | xargs kill'))
check('ps -eo pid,ppid and a kill', blocks("PP=$(ps -eo pid,ppid | awk -v p=$X '$1==p{print $2}'); kill $PP"))
check('kill $PPID', blocks('kill $PPID'))
check('kill ${PPID}', blocks('kill -9 ${PPID}'))
check('the 4th field of /proc/<pid>/stat by awk', blocks("p=$(awk '{print $4}' /proc/$X/stat); kill -TERM $p"))
check('the 4th field of /proc/<pid>/stat by cut', blocks("p=$(cut -d' ' -f4 /proc/$X/stat); kill $p"))
check('the PPid line of /proc/<pid>/status', blocks('p=$(grep PPid /proc/$X/status | cut -f2); kill $p'))
check('inside bash -c', blocks('bash -c "PP=$(ps -o ppid= -p $X); kill -TERM $PP"'))
check('the lookup outside, the kill inside bash -c', blocks('PP=$(ps -o ppid= -p $X); bash -c "kill -TERM $PP"'))
check('pkill -P with a ps ppid', blocks('pkill -P $(ps -o ppid= -p $X)'))
check('a shell heredoc body is scanned', blocks("bash <<'SH'\nPP=$(ps -o ppid= -p $X)\nkill $PP\nSH"))
check('kill -0 (a probe) with a ppid lookup passes', not blocks('X=$(ps -o ppid= -p 123); kill -0 $X'))
check('kill -l with a ppid lookup passes', not blocks('ps -o pid,ppid,cmd -u $USER; kill -l'))
check('ps --ppid (children of a PID) is not a parent lookup', not blocks('kill $(ps --ppid $LAUNCHER -o pid=)'))

print('(b) a target that is init, -1 or the service manager')
check('kill -TERM <manager>', blocks('kill -TERM %d' % MANAGER))
check('kill -- -<manager> (its process group)', blocks('kill -- -%d' % MANAGER))
check('kill -9 -1 (every process)', blocks('kill -9 -1'))
check('kill 1', blocks('kill 1'))
check('kill -s KILL <manager>', blocks('kill -s KILL %d' % MANAGER))
check('kill --signal=TERM <manager>', blocks('kill --signal=TERM %d' % MANAGER))
check('sudo kill <manager>', blocks('sudo kill %d' % MANAGER))
check('timeout 5 kill <manager>', blocks('timeout 5 kill -TERM %d' % MANAGER))
check('a manager PID among others', blocks('kill -TERM 4243 %d' % MANAGER))
check('pkill -f "systemd --user"', blocks("pkill -f 'systemd --user'"))
check('killall systemd', blocks('killall systemd'))
check('pkill -u <user> without a pattern', blocks('pkill -u someuser'))
check('killall -u <user> without a name', blocks('killall -u someuser'))
check('killall5', blocks('killall5 -9'))
check('pkill -P <manager>', blocks('pkill -P %d' % MANAGER))
check('pkill -g <manager>', blocks('pkill -g %d' % MANAGER))
check('kill <other pid> passes', not blocks('kill 4243'))
check('kill -TERM <two other pids> passes', not blocks('kill -TERM 4243 4244'))
check('kill -0 <manager> (a probe) passes', not blocks('kill -0 %d' % MANAGER))
check('pkill -u <user> <pattern> passes (a pattern narrows it)', not blocks('pkill -u someuser node'))
check('pkill -P $$ (own children) passes', not blocks('pkill -P $$'))
check('pkill -P $LAUNCHER passes', not blocks('pkill -P $LAUNCHER'))
check('kill %1 (a job) passes', not blocks('kill %1'))
# A subshell's closing paren sticks to the last word ("4242)"): still a number.
check('(kill -TERM <manager>) in a subshell', blocks('(kill -TERM %d)' % MANAGER))
check('$(kill -9 <manager>) in a substitution', blocks('echo $(kill -9 %d)' % MANAGER))
check('(kill -TERM <other pid>) in a subshell passes', not blocks('(kill -TERM 4243)'))

print('(c) a signal plus a lookup of the service manager by name in one command')
check('kill -TERM $(pgrep -x systemd)', blocks('kill -TERM $(pgrep -x systemd)'))
check('kill $(pidof systemd)', blocks('kill $(pidof systemd)'))
check('kill -9 $(pgrep -u <user> -x systemd)', blocks('kill -9 $(pgrep -u agent-x -x systemd)'))
check('kill `pidof systemd` (backticks)', blocks('kill `pidof systemd`'))
check('pgrep -f "systemd --user" piped into xargs kill', blocks("pgrep -f 'systemd --user' | xargs kill"))
check('pidof systemd piped into xargs kill -9', blocks('pidof systemd | xargs kill -9'))
check('kill $(ps -C systemd -o pid=)', blocks('kill $(ps -C systemd -o pid=)'))
check('ps | grep systemd | awk | xargs kill', blocks("ps -eo pid,comm | grep systemd | awk '{print $1}' | xargs kill"))
check('grep [s]ystemd (the self-excluding pattern)', blocks("ps aux | grep '[s]ystemd --user' | awk '{print $2}' | xargs kill"))
check('awk filtering on systemd', blocks("ps -eo pid,comm | awk '$2==\"systemd\"{print $1}' | xargs kill"))
check('a for loop over pgrep systemd', blocks('for p in $(pgrep systemd); do kill $p; done'))
check('pkill -P $(pgrep -x systemd)', blocks('pkill -P $(pgrep -x systemd)'))
check('pgrep -d, (a delimiter value) does not hide the name', blocks('kill -TERM $(pgrep -d, -x systemd)'))
check('the manager binary path as the pattern', blocks("kill $(pgrep -f '/usr/lib/systemd/systemd --user')"))
check('sudo kill -HUP $(pidof systemd)', blocks('sudo kill -HUP $(pidof systemd)'))
check('inside bash -c (single quotes)', blocks("bash -c 'kill $(pidof systemd)'"))
check('inside bash -c (double quotes)', blocks('bash -c "kill $(pidof systemd)"'))
check('kill $(pgrep -u <user>) (every process of the user)', blocks('kill $(pgrep -u agent-x)'))
check('kill $(pgrep -P <manager>) (its children)', blocks('kill $(pgrep -P %d)' % MANAGER))
check('kill $(pgrep -P 1)', blocks('kill $(pgrep -P 1)'))
# The guard the stop skill asks for prints nothing a kill could use: it must pass.
check('a grep -q guard on the comm passes', not blocks('ps -o comm= -p $P | grep -qx systemd || kill $P'))
check('a grep --quiet guard passes', not blocks('ps -o comm= -p $P | grep --quiet systemd || kill $P'))
check('the guard inside bash -c passes', not blocks("bash -c 'ps -o comm= -p $P | grep -qx systemd || kill $P'"))
check('pgrep -c (a count) passes', not blocks('pgrep -c systemd; kill "$(cat run.pid)"'))
check('pidof -q (an exit status) passes', not blocks('pidof -q systemd && kill "$(cat run.pid)"'))
check('grep -l (a file list) passes', not blocks('grep -l systemd *.service; kill "$(cat run.pid)"'))
check('kill -0 $(pidof systemd) (a probe) passes', not blocks('kill -0 $(pidof systemd)'))
check('pgrep -x systemd alone (no signal) passes', not blocks('pgrep -x systemd'))
check('a pattern kill without systemd is not this rule', not blocks("pgrep -f 'next dev' | xargs kill"))
check('pgrep -u <user> <pattern> passes', not blocks('kill $(pgrep -u agent-x node)'))
check('kill $(pgrep -P $$) (own children) passes', not blocks('kill $(pgrep -P $$)'))
check('a quoted message naming the lookup passes', not blocks('git commit -m "kill $(pidof systemd) is blocked"'))
check('prose next to a kill passes', not blocks('kill "$(cat run.pid)"; echo "systemd is fine"'))

print('context: text that only NAMES a kill is not a kill')
check('a data heredoc', not blocks("cat > note.md <<'EOF'\n" + INCIDENT + "\nEOF"))
check('a comment line', not blocks('# kill -TERM $(ps -o ppid= -p $X)\necho ok'))
check('a commit message', not blocks('git commit -m "never kill -TERM a PID from ps -o ppid="'))
check('a python heredoc body', not blocks("python3 - <<'PY'\ns = 'kill -TERM $PP; ps -o ppid= -p $SP'\nprint(s)\nPY"))
# Lines that LOOK like shell inside a Python string: the scanner reads the heredoc
# body, but the string's quotes keep them from being command words.
check('a python heredoc whose lines look like shell', not blocks(
    "python3 - <<'PY'\nDOC = '''\nPP=$(ps -o ppid= -p $SP)\nkill -TERM $PP\n'''\nprint(DOC)\nPY"))
check('echo of a kill', not blocks('echo "kill 1"'))
check('a remote command (ssh) is out of scope', not blocks("ssh host 'kill -TERM $(ps -o ppid= -p 1)'"))
check('the own PID file stop passes (negative control)', not blocks(OWN_PIDFILE_STOP))
check('safe-kill passes', not blocks('/opt/app/scripts/safe-kill --pidfile run.pid'))
check('a PID carried over from an earlier call passes (the stated gap)', not blocks('kill -TERM $PP'))

print('the service-manager lookup on a /proc tree')
with tempfile.TemporaryDirectory() as tmp:
    me = os.getuid()
    rows = {100: ('systemd', me, b'/lib/systemd/systemd\0--user\0'),
            101: ('systemd', me, b'/sbin/init\0'),
            102: ('systemd', me + 1, b'/lib/systemd/systemd\0--user\0'),
            103: ('bash', me, b'bash\0--user\0')}
    for pid, (comm, uid, argv) in rows.items():
        d = os.path.join(tmp, str(pid))
        os.makedirs(d)
        open(os.path.join(d, 'comm'), 'w').write(comm + '\n')
        open(os.path.join(d, 'status'), 'w').write('Name:\t%s\nUid:\t%d\t%d\t%d\t%d\n' % (comm, uid, uid, uid, uid))
        open(os.path.join(d, 'cmdline'), 'wb').write(argv)
    os.makedirs(os.path.join(tmp, 'self'))
    spec2 = importlib.util.spec_from_file_location('kgate2', GATE)
    fresh = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(fresh)
    found = fresh.manager_pids(tmp, me)
    check('only the calling uid\'s systemd --user is the manager (%s)' % sorted(found), found == {100})

print('the hook end to end (subprocess, real /proc read, nothing executed)')


def run(payload):
    p = subprocess.run([sys.executable, GATE], input=payload, capture_output=True, text=True, timeout=30)
    return p.returncode, p.stderr


rc, err = run(json.dumps({'tool_name': 'Bash', 'tool_input': {'command': INCIDENT}}))
check('positive control: rc 2 and the reason', rc == 2 and 'KILL-GATE: BLOCKED' in err and 'safe-kill' in err)
rc, err = run(json.dumps({'tool_name': 'Bash', 'tool_input': {'command': OWN_PIDFILE_STOP}}))
check('negative control: rc 0', rc == 0 and err == '')
rc, err = run('not json')
check('unreadable input blocks', rc == 2)
rc, err = run(json.dumps({'tool_name': 'Read', 'tool_input': {'file_path': '/x'}}))
check('another tool passes', rc == 0)
rc, err = run(json.dumps({'tool_name': 'Bash', 'tool_input': {'command': 'tmux kill-session -t =x; docker kill y'}}))
check('kill-session and docker kill are not signal senders', rc == 0)

print('a gate error blocks only a command that names a signal sender')


def main_with(cmd):
    old_in, old_err = sys.stdin, sys.stderr
    sys.stdin = io.StringIO(json.dumps({'tool_name': 'Bash', 'tool_input': {'command': cmd}}))
    sys.stderr = io.StringIO()
    try:
        kgate.main()
    except SystemExit as exc:
        return exc.code
    finally:
        sys.stdin, sys.stderr = old_in, old_err
    return None


orig = kgate.Gate.check
os.environ['HOOK_ERRLOG_PATH'] = os.path.join(tempfile.mkdtemp(), 'hook-errors.log')
kgate.Gate.check = lambda self, cmd: (_ for _ in ()).throw(RuntimeError('boom'))
check('a kill command: rc 2', main_with('kill -TERM 4243') == 2)
check('any other command: rc 0 (the pre-check never calls the gate)', main_with('ls -la') == 0)
kgate.Gate.check = orig

print()
if failed:
    print('FAILED: %d' % len(failed))
    for f in failed:
        print('  - ' + f)
    sys.exit(1)
print('ALL GREEN')
