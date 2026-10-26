#!/usr/bin/env python3
"""Behaviour tests for scripts/ram-emergency-brake.py (the RAM emergency brake).

Run: python3 scripts/__tests__/ram-emergency-brake.test.py

Nothing here kills, unloads or sends anything: the process table is a fake
/proc tree in a temp dir, meminfo/PSI are temp files, and the killer, the
ollama client and the Telegram alert are recording fakes. The REAL
TelegramAlert only ever runs against a fake send helper in a temp dir (to
prove the bot token never reaches the log and the owner chat is resolved),
so nothing is ever sent. The owner-chat resolver runs on temp install trees.
"""
import sys

# Linux only, like the brake itself (/proc, PSI, cgroup v2, pidfd). On any other platform
# the brake exits before its own checks and os.pidfd_open does not exist, so nothing here
# can be measured: report a counted skip (the script-tests-runner contract: exit 77 plus a
# reason line) instead of FAILs. This runs before anything platform-specific is touched.
if not sys.platform.startswith("linux"):
    print("SKIP (control unmet): RAM emergency brake is Linux only (/proc, PSI, cgroup v2, "
          "pidfd); sys.platform is %r" % sys.platform)
    sys.exit(77)

import importlib.util
import json
import os
import shutil
import signal
import subprocess as _sp_mod
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRAKE = os.path.join(ROOT, "scripts", "ram-emergency-brake.py")
spec = importlib.util.spec_from_file_location("ram_emergency_brake", BRAKE)
rvf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rvf)

def _proc_self_uid():
    """The real uid of this process as the kernel reports it in /proc (what a
    real child's /proc entry will show), or None off Linux."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("Uid:"):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return None


# The fake /proc's uid is deliberately NOT the uid this test runs as (nor the
# kernel's view of it): every brake call on the fake /proc passes my_uid=UID
# explicitly, so no check depends on the host's uid. A CI runner is not uid
# 1000; with a fixture uid equal to the host's, a missing my_uid would pass here
# and fail there.
UID = next(u for u in (1000, 2000, 3000) if u not in (os.getuid(), _proc_self_uid(), 999))
APP = "/user.slice/user-%d.slice/user@%d.service/app.slice/" % (UID, UID)
fails = []


def check(name, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + name + ((" -- " + str(extra)) if (extra and not cond) else ""))
    if not cond:
        fails.append(name)


def write_stat(root, pid, name="x", start=None, state="S"):
    """A /proc/<pid>/stat whose field 22 (start time) is `start` (default 1000 + pid)."""
    rest = [state] + ["0"] * 18 + [str(1000 + pid if start is None else start)] + ["0"] * 5
    with open(os.path.join(root, str(pid), "stat"), "w") as f:
        f.write("%d (%s) %s\n" % (pid, name, " ".join(rest)))


def mkproc(root, pid, name, argv, rss_mb, cgroup=APP + "tmux-spawn-x.scope", uid=UID, cwd=None):
    d = os.path.join(root, str(pid))
    os.makedirs(d)
    write_stat(root, pid, name)
    with open(os.path.join(d, "status"), "w") as f:
        f.write("Name:\t%s\nUid:\t%d\t%d\t%d\t%d\nVmRSS:\t%d kB\n" % (name, uid, uid, uid, uid, rss_mb * 1024))
    with open(os.path.join(d, "cmdline"), "wb") as f:
        f.write(b"\0".join(a.encode() for a in argv) + b"\0")
    with open(os.path.join(d, "cgroup"), "w") as f:
        f.write("0::%s\n" % cgroup)
    if cwd:
        os.symlink(cwd, os.path.join(d, "cwd"))


def never_kill_table(root):
    """Processes that must NEVER be chosen, however big. Returns their pids."""
    mkproc(root, 101, "claude", ["/home/user/.local/bin/claude", "--continue"], 3600)
    mkproc(root, 102, "tmux: server", ["/usr/bin/tmux", "new-session", "-d", "-s", "main-channels"], 900)
    mkproc(root, 103, "node", ["/usr/bin/node", os.path.join(rvf.ROOT, "dist", "index.js")], 3000,
           cgroup=APP + "marveen-dashboard.service")
    mkproc(root, 104, "bun", ["/home/user/.bun/bin/bun", "server.ts"], 2500)
    mkproc(root, 105, "systemd", ["/usr/lib/systemd/systemd", "--user"], 2000, cgroup=APP[:-9] + "init.scope")
    mkproc(root, 106, "sshd", ["sshd: user@pts/0"], 2000)
    mkproc(root, 107, "bash", ["/bin/bash", "/opt/app/scripts/channels.sh"], 2000,
           cgroup=APP + "marveen-channels.service")
    # an ffmpeg inside the dashboard cgroup (voice transcoding) is protected by cgroup
    mkproc(root, 108, "ffmpeg", ["ffmpeg", "-i", "voice.ogg", "out.wav"], 2200,
           cgroup=APP + "marveen-dashboard.service")
    mkproc(root, 109, "python3", ["python3", "/opt/app/scripts/ram-emergency-brake.py"], 1900)
    # a claude binary launched with a weird comm is still caught via argv
    mkproc(root, 110, "MainThread", ["/home/user/.local/bin/claude", "-p", "x"], 3500)
    mkproc(root, 111, "ollama", ["/usr/local/bin/ollama", "runner"], 3000)
    return [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]


def not_allowlisted_table(root):
    """Big processes that are neither never-kill nor allowlisted: must be ignored."""
    mkproc(root, 201, "node", ["node", "/home/user/.npm/_npx/x/node_modules/.bin/some-mcp-server"], 2800)
    mkproc(root, 202, "chrome", ["/opt/google/chrome/chrome", "--no-sandbox"], 2700)  # not headless
    mkproc(root, 203, "python3", ["python3", "/opt/app/scripts/analyze.py"], 2600)
    mkproc(root, 204, "ffmpeg", ["ffmpeg", "-i", "x"], 2900, uid=999)  # someone else's
    mkproc(root, 205, "ffmpeg", ["ffmpeg", "-version"], 10)  # too small to matter
    return [201, 202, 203, 204, 205]


class FakeOllama:
    def __init__(self, models):
        self.models = list(models)
        self.unloaded = []

    def loaded(self):
        return list(self.models)

    def unload(self, m):
        self.unloaded.append(m)
        self.models.remove(m)


class FakeAlert:
    def __init__(self, ok=True):
        self.sent = []
        self.ok = ok
        self._pending = False

    def start(self, text):
        self.sent.append(text)
        self._pending = True
        return None

    def poll(self):
        if not self._pending:
            return None
        self._pending = False
        return (self.ok, "" if self.ok else "boom")


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def write_mem(path, avail_mb):
    with open(path, "w") as f:
        f.write("MemTotal:        8130352 kB\nMemAvailable:   %8d kB\nSwapFree:        4000000 kB\n"
                % (avail_mb * 1024))


def write_psi(path, full):
    with open(path, "w") as f:
        f.write("some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n"
                "full avg10=%.2f avg60=0.00 avg300=0.00 total=1\n" % full)


def make_brake(td, proc_root, models=(), dry_run=False, alert=None):
    mem = os.path.join(td, "meminfo")
    psi = os.path.join(td, "psi")
    write_mem(mem, 5000)
    write_psi(psi, 0.0)
    killed = []

    def killer(victim):
        killed.append(list(victim["targets"]))
        return {p: "term" for p in victim["targets"]}

    clock = Clock()
    b = rvf.Brake(dry_run=dry_run, log_path=os.path.join(td, "log.jsonl"), meminfo_path=mem,
                  psi_path=psi, proc_root=proc_root, ollama=FakeOllama(models),
                  alert=alert or FakeAlert(), killer=killer, clock=clock, my_uid=UID,
                  protected_pids=(), echo=False)
    return b, mem, psi, killed, clock


def events(b):
    with open(b.log_path) as f:
        return [json.loads(l) for l in f if l.strip()]


# The python-script allowlist of a sample config: one agent dir with named heavy
# scripts (anywhere under it) and its scripts/ dir open to any script, and a
# second agent dir with one named script.
VIDEO = os.path.join(rvf.ROOT, "agents", "video")
MEDIA = os.path.join(rvf.ROOT, "agents", "media")
SAMPLE_CONFIG = {"python_scripts": [
    {"dir": "agents/video", "scripts": ["render_native.py", "render_v3.py", "cut_reel.py",
                                         "batch.py", "compare.py", "variants.py"]},
    {"dir": "agents/video/scripts", "scripts": "*"},
    {"dir": "agents/media", "scripts": ["transcribe.py"]},
]}


def _write(path, body):
    with open(path, "w") as f:
        f.write(body if isinstance(body, str) else json.dumps(body))
    return path


def sample_allow(td):
    path = os.path.join(td, "ram-emergency-brake.json")
    with open(path, "w") as f:
        json.dump(SAMPLE_CONFIG, f)
    return rvf.load_config(path)


# ---- the single-signal-path invariant: scenarios take the brake MODULE, so the
# same scenario runs against the real code, against mutants, and against older code
SCOPE = APP + "heavy-job-1700000000-77.scope"


def _accepted(fn, **kw):
    """The keyword arguments fn accepts (so older code is judged on behaviour)."""
    import inspect
    params = inspect.signature(fn).parameters
    return {k: v for k, v in kw.items() if k in params}


def sc_send_recheck(m):
    """pidfd path: a pinned target that exec'd into a never-kill process before
    the send is NOT signalled (the send itself re-checks)."""
    if not m.HAS_PIDFD:
        return True, "no pidfd here"
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        c = _sp_mod.Popen([sys.executable, "-c",
                           "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"])
        try:
            time.sleep(0.3)
            mkproc(root, c.pid, "ffmpeg", ["ffmpeg", "-i", "x"], 900)
            t = m.Target(c.pid, str(1000 + c.pid), APP + "tmux-spawn-x.scope", proc_root=root, use_pidfd=True,
                         **_accepted(m.Target, my_uid=UID))
            pinned = t.fd is not None
            with open(os.path.join(root, str(c.pid), "cmdline"), "wb") as f:
                f.write(b"/home/user/.local/bin/claude\0")       # exec into an agent session
            send = getattr(m, "send_checked", None)
            r = send(t, signal.SIGKILL) if send else t.send(signal.SIGKILL)
            time.sleep(0.3)
            alive = c.poll() is None
            t.close()
            return pinned and r == "reused" and alive, (pinned, r, alive)
        finally:
            c.kill()
            c.wait()


def sc_exec_pidfd(m):
    """End to end with use_pidfd=True: a target that exec's into claude during
    the TERM -> KILL grace is never SIGKILLed."""
    if not m.HAS_PIDFD:
        return True, "no pidfd here"
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        c = _sp_mod.Popen([sys.executable, "-c",
                           "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"])
        try:
            time.sleep(0.3)
            mkproc(root, c.pid, "ffmpeg", ["ffmpeg", "-i", "x"], 900)
            victim = {"ident": {c.pid: (str(1000 + c.pid), APP + "tmux-spawn-x.scope")}}
            done = []

            def sleep_exec(_s):
                if not done:
                    with open(os.path.join(root, str(c.pid), "cmdline"), "wb") as f:
                        f.write(b"/home/user/.local/bin/claude\0")
                    done.append(1)
            res = m.kill_victim(victim, proc_root=root, grace=1.0, sleep=sleep_exec, use_pidfd=True, my_uid=UID)
            time.sleep(0.3)
            alive = c.poll() is None
            return alive and res.get(c.pid) != "kill", (res, alive)
        finally:
            c.kill()
            c.wait()


def sc_unreadable(m, kind):
    """A heavy-job scope whose other member is a process the brake cannot
    identify: kind "hidden" = pid 25, /proc/25 exists but nothing in it is
    readable (as under hidepid); kind "nostart" = pid 24, readable but without a
    start time. It is never a target and never signalled, and the scope's
    cgroup is never written. (The scope cgroup files exist, so a cgroup-kill
    path, if there were one, would have what it needs to act.)"""
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 21, "ffmpeg", ["ffmpeg", "-i", "x"], 900, cgroup=SCOPE)
        if kind == "nostart":
            mkproc(root, 24, "ffmpeg", ["ffmpeg", "-i", "y"], 700, cgroup=SCOPE)
            os.remove(os.path.join(root, "24", "stat"))
        else:
            os.makedirs(os.path.join(root, "25"))
        cg = os.path.join(td, "cgfs") + SCOPE
        os.makedirs(cg)
        files = {"cgroup.kill": "", "cgroup.freeze": "0\n", "cgroup.procs": "21\n%d\n" % (24 if kind == "nostart" else 25),
                 "cgroup.stat": "nr_descendants 0\n", "cgroup.events": "populated 1\nfrozen 1\n"}
        for name, body in files.items():
            with open(os.path.join(cg, name), "w") as f:
                f.write(body)
        sent = []
        v = m.select_victim(m.list_processes(root), UID)
        res = m.kill_victim(v, proc_root=root, grace=0.5, sleep=lambda s: None, use_pidfd=False,
                            kill=lambda pid, sig: sent.append((pid, sig)), my_uid=UID,
                            **_accepted(m.kill_victim, cgroup_fs=os.path.join(td, "cgfs"),
                                        ledger=os.path.join(td, "ledger.json")))
        written = {n: open(os.path.join(cg, n)).read() for n in files}
        ok = (v["targets"] == [21] and not any(pid in (24, 25) for pid, _ in sent) and written == files
              and res == {21: "kill"})
        return ok, (v["targets"], sent, res, {k: x for k, x in written.items() if files[k] != x})


def _hold_lock(path):
    import fcntl
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def sc_second_instance(m, path):
    """A second ACTING brake is refused (exit 3, clear message) while another
    holds the instance lock. The refused brake is a real process run with
    --cycles 1: one sample can never act (an incident needs two), so even a
    brake that wrongly starts touches nothing."""
    with tempfile.TemporaryDirectory() as td:
        lock = os.path.join(td, "brake.lock")
        fd = _hold_lock(lock)
        try:
            env = dict(os.environ, RAM_BRAKE_LOCK=lock)
            p = _sp_mod.run([sys.executable, path, "--cycles", "1", "--no-mlock"], capture_output=True,
                            text=True, timeout=60, env=env)
        finally:
            os.close(fd)
        ok = p.returncode == 3 and "another brake instance holds" in p.stderr and '"event": "start"' not in p.stdout
        return ok, (p.returncode, p.stderr[-300:], p.stdout[-200:])


def sc_lock_symlink(m):
    """A symlinked lock file is refused and its target is not written."""
    with tempfile.TemporaryDirectory() as td:
        target = os.path.join(td, "precious")
        with open(target, "w") as f:
            f.write("keep\n")
        link = os.path.join(td, "brake.lock")
        os.symlink(target, link)
        try:
            fd = m.acquire_instance_lock(link)
            os.close(fd)
            refused = False
        except m.InstanceLockError as e:
            refused = not e.held
        body = open(target).read()
        return refused and body == "keep\n", (refused, body)


def sc_lock_foreign(m):
    """A lock file owned by another uid (simulated) is refused, not taken."""
    with tempfile.TemporaryDirectory() as td:
        lock = os.path.join(td, "brake.lock")
        with open(lock, "w") as f:
            f.write("pid=1\n")
        real = os.getuid
        os.getuid = lambda: real() + 4242
        try:
            try:
                fd = m.acquire_instance_lock(lock)
                os.close(fd)
                refused = False
            except m.InstanceLockError as e:
                refused = not e.held and "owned by uid" in str(e)
        finally:
            os.getuid = real
        return refused and open(lock).read() == "pid=1\n", refused


def sc_lock_fresh(m):
    """Positive control: a fresh lock is created 0600, taken, records the pid,
    and a second take in the same process is refused as held."""
    with tempfile.TemporaryDirectory() as td:
        lock = os.path.join(td, "brake.lock")
        fd = m.acquire_instance_lock(lock)
        try:
            mode = os.stat(lock).st_mode & 0o777
            body = open(lock).read()
            try:
                fd2 = m.acquire_instance_lock(lock)
                os.close(fd2)
                second = "taken"
            except m.InstanceLockError as e:
                second = "held" if e.held else "error"
        finally:
            os.close(fd)
        return mode == 0o600 and body == "pid=%d\n" % os.getpid() and second == "held", (oct(mode), body, second)


EXCEPTION = ("TelegramAlert", "abort")   # the ONE documented exception: the alert child's own kill
SIGNAL_FUNCS = ("send_checked",)


def sc_static(path):
    """The brake source:
    - contains no 'cgroup.kill' and no 'cgroup.freeze' at all (code, strings,
      comments): jobs are never stopped or frozen through their cgroup;
    - os.kill / os.killpg / signal.pidfd_send_signal / signal.pthread_kill are
      referenced only inside send_checked();
    - .kill() / .terminate() / .send_signal() are called only inside
      TelegramAlert.abort() (the alert child), the one documented exception,
      and that exception says so in its docstring."""
    import ast
    text = open(path).read()
    bad = ["literal %r" % lit for lit in ("cgroup.kill", "cgroup.freeze") if lit in text]
    tree = ast.parse(text)
    sig_ok, exc_ok, exc_doc = set(), set(), False
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in SIGNAL_FUNCS:
            sig_ok.update(id(n) for n in ast.walk(node))
        if isinstance(node, ast.ClassDef) and node.name == EXCEPTION[0]:
            for f in node.body:
                if isinstance(f, ast.FunctionDef) and f.name == EXCEPTION[1]:
                    exc_ok.update(id(n) for n in ast.walk(f))
                    exc_doc = "ONE EXCEPTION" in (ast.get_docstring(f) or "")
    found = sorted(n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name in SIGNAL_FUNCS)
    for n in ast.walk(tree):
        if (id(n) not in sig_ok and isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name)
                and (n.value.id, n.attr) in (("os", "kill"), ("os", "killpg"), ("signal", "pidfd_send_signal"),
                                             ("signal", "pthread_kill"))):
            bad.append("%s.%s at line %d" % (n.value.id, n.attr, n.lineno))
        if id(n) not in sig_ok and isinstance(n, ast.Name) and n.id in ("pidfd_send_signal", "killpg"):
            bad.append("%s at line %d" % (n.id, n.lineno))
        if (id(n) not in exc_ok and isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                and n.func.attr in ("kill", "terminate", "send_signal")):
            bad.append(".%s() at line %d" % (n.func.attr, n.lineno))
    if not exc_doc:
        bad.append("the exception %s.%s is not documented as THE ONE EXCEPTION" % EXCEPTION)
    return found == list(SIGNAL_FUNCS) and not bad, (found, bad)


def load_variant(src, name, td):
    d = os.path.join(td, name, "scripts")   # ROOT of the variant = td/name: its store/ is a temp dir
    os.makedirs(d)
    path = os.path.join(d, "ram-emergency-brake.py")
    with open(path, "w") as f:
        f.write(src)
    sp = importlib.util.spec_from_file_location("brake_" + name.replace("-", "_").replace(".", "_"), path)
    mod = importlib.util.module_from_spec(sp)
    sp.loader.exec_module(mod)
    return mod, path


MUTANTS = (
    # (name, old, new, scenario)
    ("pidfd-no-recheck", """    c = t.check()
    if c != "same":
        t.state = c
        return c
    try:
        if t.fd is not None:""", """    try:
        if t.fd is not None:""", "send_recheck"),
    ("target-unidentifiable", """    return q.get("start") is not None""", """    return True""", "unreadable_nostart"),
    ("skip-instance-lock", """            lock_fd = acquire_instance_lock(lock)""", """            pass""", "second_instance"),
    ("lock-without-O_NOFOLLOW", """os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError as e:
        raise InstanceLockError""", """os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    except OSError as e:
        raise InstanceLockError""", "lock_symlink"),
    ("lock-without-owner-check", """        if st.st_uid != os.getuid():""", """        if False:""", "lock_foreign"),
    ("stray-proc.kill", """def terminate(targets""", """def _stray(proc):
    proc.kill()


def terminate(targets""", "static"),
    ("stray-os.kill", """def terminate(targets""", """def _stray(pid):
    os.kill(pid, 9)


def terminate(targets""", "static"),
    ("cgroup-kill-back", """def terminate(targets""", """def _scope_kill(cg):
    open(cg + "/cgroup.kill", "w").write("1")


def terminate(targets""", "static"),
)
SCENARIOS = {"send_recheck": sc_send_recheck, "exec_pidfd": sc_exec_pidfd,
             "unreadable_hidden": lambda m: sc_unreadable(m, "hidden"),
             "unreadable_nostart": lambda m: sc_unreadable(m, "nostart"),
             "lock_symlink": sc_lock_symlink, "lock_foreign": sc_lock_foreign, "lock_fresh": sc_lock_fresh}


def run_scenario(name, m, path):
    try:
        if name == "static":
            return sc_static(path)
        if name == "second_instance":
            return sc_second_instance(m, path)
        return SCENARIOS[name](m)
    except Exception as e:  # older code with another API: the property is not there
        return False, "raised %s: %s" % (type(e).__name__, e)


NEW_CHECKS = (
    ("send_recheck", "pidfd path: a pinned target that exec'd into claude is not signalled (send re-checks)"),
    ("exec_pidfd", "use_pidfd=True: a target exec'ing into claude during the grace is never SIGKILLed"),
    ("unreadable_hidden", "a live process with an unreadable /proc entry (hidepid) in the victim's scope is "
                          "never signalled; the scope cgroup is never written"),
    ("unreadable_nostart", "a scope member without a readable start time is never a target, never signalled"),
    ("second_instance", "a second acting brake is refused (exit 3, clear message) while the lock is held"),
    ("lock_symlink", "a symlinked instance lock is refused and its target untouched"),
    ("lock_foreign", "an instance lock owned by another uid is refused"),
    ("lock_fresh", "a fresh instance lock is created 0600 with the pid, a second take is 'held'"),
    ("static", "static: no cgroup.kill / cgroup.freeze anywhere; signals only in send_checked; "
               ".kill()/.terminate()/.send_signal() only in TelegramAlert.abort (the documented exception)"),
)


def single_signal_path_tests():
    for key, title in NEW_CHECKS:
        ok, info = run_scenario(key, rvf, BRAKE)
        check("single path: " + title, ok, info)
    src = open(BRAKE).read()
    with tempfile.TemporaryDirectory() as td:
        for name, old, new, scen in MUTANTS:
            if src.count(old) != 1:
                check("mutant %s: applies to the brake source" % name, False, "pattern count %d" % src.count(old))
                continue
            m, path = load_variant(src.replace(old, new), name, td)
            ok, info = run_scenario(scen, m, path)
            check("mutant %s: caught by %s" % (name, scen), not ok, info)


def main():
    # ---------------- selection -----------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        nk = never_kill_table(root)
        procs = rvf.list_processes(root)
        for p in procs:
            check("never-kill: pid %d (%s)" % (p["pid"], p["name"]),
                  rvf.never_kill_reason(p) is not None, p)
        check("only never-kill processes -> no victim",
              rvf.select_victim(procs, UID) is None)
        nal = not_allowlisted_table(root)
        procs = rvf.list_processes(root)
        v = rvf.select_victim(procs, UID)
        check("never-kill + non-allowlisted (MCP node, desktop chrome, other python, other uid, tiny)"
              " -> no victim", v is None, v)

        # allowlisted jobs appear: largest RSS wins
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "raw.mov", "out.mp4"], 800)
        mkproc(root, 302, "headless_shell",
               ["/home/user/.cache/ms-playwright/chromium_headless_shell-1/headless_shell",
                "--headless", "--type=renderer"], 1200)
        mkproc(root, 303, "python", [".venv/bin/python", "scripts/render_native.py", "spec.json"], 600,
               cwd=VIDEO)
        mkproc(root, 304, "node", ["node", "/home/user/proj/node_modules/.bin/vitest", "run"], 700)
        procs = rvf.list_processes(root)
        allow = sample_allow(td)
        v = rvf.select_victim(procs, UID, python_allow=allow)
        check("largest allowlisted RSS chosen (headless browser 1200 MB)", v and v["pid"] == 302, v)
        check("victim reason is headless-browser", v and v["reason"] == "headless-browser", v)
        check("victim targets only itself outside a scope", v and v["targets"] == [302], v)
        byname = {p["pid"]: rvf.killable_reason(p, allow) for p in procs}
        check("configured render script (relative path + cwd) is allowlisted",
              byname[303] == "python-heavy:render_native.py", byname[303])
        check("no config: the same python script is NOT killable (generic classes only)",
              rvf.killable_reason([p for p in procs if p["pid"] == 303][0]) is None)
        check("vitest node is allowlisted", (byname[304] or "").startswith("node-heavy"), byname[304])
        check("ffmpeg is allowlisted", byname[301] == "heavy:ffmpeg", byname[301])
        check("no never-kill pid ever chosen", v["pid"] not in nk and v["pid"] not in nal)

        # a heavy-job scope is preferred even if smaller, and killed as a whole job
        scope = APP + "heavy-job-1700000000-4242.scope"
        mkproc(root, 401, "bash", ["bash", "-c", "make video"], 5, cgroup=scope)
        mkproc(root, 402, "ffmpeg", ["ffmpeg", "-i", "a.mov", "b.mp4"], 300, cgroup=scope)
        # a (silly) claude inside the scope must still be spared
        mkproc(root, 403, "claude", ["/home/user/.local/bin/claude", "-p", "x"], 400, cgroup=scope)
        procs = rvf.list_processes(root)
        v = rvf.select_victim(procs, UID)
        check("heavy-job scope preferred over a bigger outside job", v and v["pid"] == 402, v)
        check("scope victim reports the scope unit", v and v["scope"] == "heavy-job-1700000000-4242.scope", v)
        check("scope kill targets the job's pids but spares claude inside it",
              v and v["targets"] == [401, 402], v and v["targets"])

    # ---------------- brake flow ------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        never_kill_table(root)
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "raw.mov", "out.mp4"], 1500)
        mkproc(root, 302, "ffmpeg", ["ffmpeg", "-i", "raw2.mov", "out2.mp4"], 700)
        alert = FakeAlert()
        b, mem, psi, killed, clock = make_brake(td, root, models=["nomic-embed-text:latest"], alert=alert)

        b.step()
        check("healthy sample: no incident", not b.incident)
        write_mem(mem, 500)
        clock.t += 3
        b.step()
        check("1 critical sample: still no incident (needs 2)", not b.incident and not killed)
        clock.t += 3
        b.step()
        check("2 critical samples: incident started", b.incident)
        check("first action = ollama unload, nothing killed",
              b.ollama.unloaded == ["nomic-embed-text:latest"] and not killed, (b.ollama.unloaded, killed))
        check("alert sent once, after the first action", len(alert.sent) == 1, alert.sent)
        check("alert text is Hungarian, has the action, no em dash",
              "ollama modell" in alert.sent[0] and "\u2014" not in alert.sent[0], alert.sent)
        clock.t += 3
        b.step()
        check("still critical after unload -> largest allowlisted job killed (pid 301)",
              killed == [[301]], killed)
        clock.t += 3
        b.step()
        check("cooldown: no second kill 3 s later", killed == [[301]], killed)
        clock.t += 9
        b.step()
        check("after cooldown the next job goes (pid 302)", killed == [[301], [302]], killed)
        check("still exactly one alert in the incident", len(alert.sent) == 1, len(alert.sent))
        ev = [e["event"] for e in events(b)]
        check("kill lines logged", ev.count("kill") == 2, ev)

        # recovery ends the incident
        write_mem(mem, 3000)
        for _ in range(rvf.RECOVER_SAMPLES):
            clock.t += 3
            b.step()
        check("incident ends after RECOVER_SAMPLES healthy samples", not b.incident)
        check("incident_end logged", "incident_end" in [e["event"] for e in events(b)])

        # a new incident inside the alert cooldown does not page again
        write_mem(mem, 400)
        clock.t += 3
        b.step()
        clock.t += 3
        b.step()
        clock.t += 3
        b.step()
        check("second incident within 30 min: no second Telegram", len(alert.sent) == 1, len(alert.sent))
        check("suppression is logged", "alert_suppressed_cooldown" in [e["event"] for e in events(b)])

    # ---------------- PSI trigger ------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        b, mem, psi, killed, clock = make_brake(td, root)
        write_mem(mem, 1000)
        write_psi(psi, 55.0)
        b.step(); clock.t += 3; b.step()
        check("PSI full 55% with 1000 MB free -> incident", b.incident)
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        b, mem, psi, killed, clock = make_brake(td, root)
        write_mem(mem, 3000)
        write_psi(psi, 55.0)
        b.step(); clock.t += 3; b.step()
        check("PSI high but 3000 MB free -> no incident", not b.incident)

    # ---------------- no candidate ------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        never_kill_table(root)
        alert = FakeAlert()
        b, mem, psi, killed, clock = make_brake(td, root, alert=alert)
        write_mem(mem, 300)
        for _ in range(5):
            b.step(); clock.t += 9
        check("only protected processes: nothing killed", killed == [], killed)
        ev = [e["event"] for e in events(b)]
        check("no_candidate logged once", ev.count("no_candidate") == 1, ev)
        check("alert still sent (incident with no remedy)", len(alert.sent) == 1 and
              "nem volt" in alert.sent[0], alert.sent)

    # ---------------- dry run -------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "raw.mov"], 1500)
        alert = FakeAlert()
        b, mem, psi, killed, clock = make_brake(td, root, models=["m1"], dry_run=True, alert=alert)
        write_mem(mem, 300)
        for _ in range(4):
            b.step(); clock.t += 9
        ev = [e["event"] for e in events(b)]
        check("dry-run: nothing killed", killed == [])
        check("dry-run: nothing unloaded", b.ollama.unloaded == [])
        check("dry-run: no Telegram started", alert.sent == [])
        check("dry-run: would_unload, would_kill, would_alert logged",
              "would_unload" in ev and "would_kill" in ev and "would_alert" in ev, ev)

    # ---------------- rate limit ------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        for i in range(10):
            mkproc(root, 500 + i, "ffmpeg", ["ffmpeg", "-i", "x%d" % i], 200 + i)
        b, mem, psi, killed, clock = make_brake(td, root)
        write_mem(mem, 300)
        for _ in range(30):
            b.step(); clock.t += 9  # killer is fake, processes stay "alive"
        check("at most KILL_WINDOW_MAX kills per window", len(killed) == rvf.KILL_WINDOW_MAX, len(killed))
        check("rate_limited logged", "rate_limited" in [e["event"] for e in events(b)])

    # ---------------- missing MemAvailable is an error, not 0 MB ---------------------------------
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "raw.mov"], 1500)
        alert = FakeAlert()
        b, mem, psi, killed, clock = make_brake(td, root, models=["m1"], alert=alert)
        with open(mem, "w") as f:
            f.write("MemTotal:        8130352 kB\nMemFree:           10000 kB\n")
        for _ in range(5):
            b.step(); clock.t += 9
        ev = [e["event"] for e in events(b)]
        check("missing MemAvailable: no incident", not b.incident)
        check("missing MemAvailable: nothing killed, nothing unloaded, no alert",
              killed == [] and b.ollama.unloaded == [] and alert.sent == [], (killed, alert.sent))
        check("missing MemAvailable: meminfo_error logged once", ev.count("meminfo_error") == 1, ev)
        try:
            rvf.read_meminfo(mem)
            check("read_meminfo raises on missing MemAvailable", False)
        except ValueError:
            check("read_meminfo raises on missing MemAvailable", True)
        write_mem(mem, 5000)
        b.step()
        check("meminfo_ok logged when the reading comes back",
              "meminfo_ok" in [e["event"] for e in events(b)])

    # ---------------- --simulate-avail-mb requires --dry-run ---------------------------------
    import subprocess as _sp
    p = _sp.run([sys.executable, BRAKE, "--simulate-avail-mb", "100", "--once", "--no-mlock"],
                capture_output=True, text=True, timeout=30)
    check("--simulate-avail-mb without --dry-run is refused (exit 2)", p.returncode == 2,
          (p.returncode, p.stderr))
    check("refusal says why and prints no log line", "requires --dry-run" in p.stderr
          and p.stdout.strip() == "", (p.stdout, p.stderr))

    # ---------------- an exception in step() neither crashes the loop nor loses state -----------
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "a"], 1500)
        mkproc(root, 302, "ffmpeg", ["ffmpeg", "-i", "b"], 700)
        alert = FakeAlert()
        b, mem, psi, killed, clock = make_brake(td, root, alert=alert)
        write_mem(mem, 300)
        b.step(); clock.t += 3; b.step()          # incident + first kill (no ollama models)
        check("setup: incident with one kill", b.incident and killed == [[301]], killed)
        kt, alerts = list(b.kill_times), list(alert.sent)
        real_lp = rvf.list_processes

        def boom(*a, **k):
            raise TypeError("simulated bug in the process scan")
        rvf.list_processes = boom
        try:
            err = {}
            clock.t += 9
            r1 = rvf.safe_step(b, err)
            clock.t += 9
            r2 = rvf.safe_step(b, err)
        finally:
            rvf.list_processes = real_lp
        ev = events(b)
        errs = [e for e in ev if e["event"] == "loop_error"]
        check("step exception is caught (safe_step -> False, no raise)", r1 is False and r2 is False)
        check("loop_error logged once within the rate-limit window", len(errs) == 1, errs)
        check("loop_error names the exception", errs and "TypeError" in errs[0]["error"], errs)
        check("state kept across the error: incident, kill_times, alerts",
              b.incident and b.kill_times == kt and alert.sent == alerts, (b.incident, b.kill_times))
        clock.t += 9
        rvf.safe_step(b, err)
        check("after the error the brake continues (next job killed)", killed == [[301], [302]], killed)
        clock.t += 61
        write_mem(mem, 300)
        rvf.list_processes = boom
        try:
            rvf.safe_step(b, err)
        finally:
            rvf.list_processes = real_lp
        errs = [e for e in events(b) if e["event"] == "loop_error"]
        check("loop_error logged again after the window, with the suppressed count",
              len(errs) == 2 and errs[1]["errors_since_last_log"] == 2, errs)

    class Exploding:
        clock = staticmethod(lambda: 0.0)
        calls = 0

        def step(self):
            Exploding.calls += 1
            raise RuntimeError("always")

        def log(self, rec):
            pass
    n = rvf.run_loop(Exploding(), 4, [], poll_sec=0, sleep=lambda s: None)
    check("run_loop survives a step that always raises (4 cycles run)", n == 4 and Exploding.calls == 4,
          (n, Exploding.calls))

    # ---------------- act() raising on EVERY cycle still drives the alert to a terminal state
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "a"], 1500)
        alert = FakeAlert()
        b, mem, psi, killed, clock = make_brake(td, root, alert=alert)

        def act_boom(now, avail):
            raise TypeError("simulated bug in act")
        b.act = act_boom
        write_mem(mem, 300)
        err = {}
        results = []
        for _ in range(4):
            results.append(rvf.safe_step(b, err))
            clock.t += 3
        ev = [e["event"] for e in events(b)]
        check("act() always raising: every acting step reports the error (safe_step False)",
              results[0] is True and all(r is False for r in results[1:]), results)
        check("act() always raising: the alert is still started and ends 'sent'",
              len(alert.sent) == 1 and b.alert_state == "done" and "alert_sent" in ev,
              (alert.sent, b.alert_state, ev))
        check("act() always raising: the alert text names the failed action",
              alert.sent and "hibára futott (TypeError)" in alert.sent[0], alert.sent)
        check("act() always raising: the failure is recorded once per incident",
              b.incident_actions.count("a beavatkozás hibára futott (TypeError)") == 1, b.incident_actions)
        check("act() always raising: nothing was killed", killed == [], killed)

    # ---------------- alert still sending -> busy, never overwritten ------------------------------
    with tempfile.TemporaryDirectory() as td:
        envf = os.path.join(td, ".env")
        with open(envf, "w") as f:
            f.write("TELEGRAM_BOT_TOKEN=abc:def\n")
        helper = os.path.join(td, "slow-send.sh")
        with open(helper, "w") as f:
            f.write("send_telegram_message() { sleep 5; return 0; }\n")
        ta = rvf.TelegramAlert(helper=helper, env_path=envf, chat_id="42")
        first = ta.start("one")
        proc = ta.proc
        second = ta.start("two")
        check("second start while the first send runs -> 'busy'", first is None and second == "busy",
              (first, second))
        check("the running send is not overwritten", ta.proc is proc)
        proc.kill()
        proc.wait()

        class BusyAlert(FakeAlert):
            def start(self, text):
                return "busy"
        root = os.path.join(td, "proc")
        os.makedirs(root)
        b, mem, psi, killed, clock = make_brake(td, root, alert=BusyAlert())
        write_mem(mem, 300)
        for _ in range(6):
            b.step(); clock.t += 61
        ev = [e["event"] for e in events(b)]
        check("brake: 'busy' counts as an attempt, is retried, ends in a logged gave_up",
              b.alert_state == "gave_up" and ev.count("alert_busy") == rvf.ALERT_MAX_ATTEMPTS
              and ev.count("alert_gave_up") == 1 and "alert_not_sent" not in ev,
              (b.alert_state, b.alert_attempts, ev))

    # ---------------- malformed /api/ps never crashes the brake --------------------------------
    import threading as _th
    from http.server import BaseHTTPRequestHandler, HTTPServer
    payload = [b""]

    class PS(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload[0])))
            self.end_headers()
            self.wfile.write(payload[0])
    srv = HTTPServer(("127.0.0.1", 0), PS)
    _th.Thread(target=srv.serve_forever, daemon=True).start()
    ol = rvf.Ollama("http://127.0.0.1:%d" % srv.server_address[1])
    for name, body, want in [
            ("junk entries", {"models": ["x", 5, None, {"name": 7}, {"model": "good:1"}]}, ["good:1"]),
            ("top-level list", [{"name": "a"}], []),
            ("models is a string", {"models": "nomic"}, []),
            ("models missing", {}, [])]:
        payload[0] = json.dumps(body).encode()
        try:
            got = ol.loaded()
        except Exception as e:
            got = "raised %r" % e
        check("Ollama.loaded %s -> %s" % (name, want), got == want, got)
    srv.shutdown()

    # ---------------- python allowlist: config-driven, path-anchored, option-aware ----------
    K, M = VIDEO, MEDIA
    with tempfile.TemporaryDirectory() as td:
        allow = sample_allow(td)

    def pyproc(argv, cwd="", name="python3"):
        return {"pid": 900, "name": name, "rss_mb": 800, "uid": UID, "argv": argv,
                "cgroup": APP + "tmux-spawn-x.scope", "cwd": cwd}
    cases = [
        ("configured script via -X utf8 -u (relative, agent cwd)",
         pyproc(["python3", "-X", "utf8", "-u", "scripts/render_v3.py", "t.json"], cwd=K), True),
        ("attached -Xutf8 and -W ignore",
         pyproc(["python3", "-Xutf8", "-W", "ignore", K + "/scripts/batch.py"]), True),
        ("flag cluster -uO / -OO", pyproc(["python3", "-OO", "-uB", K + "/work/compare.py"]), True),
        ("-- then script", pyproc(["python3", "--", K + "/scripts/cut_reel.py"]), True),
        ("'*' entry: any script under the scripts/ dir",
         pyproc(["python3", K + "/scripts/anything_else.py"]), True),
        ("relative ../ from the other agent's cwd into the scripts dir",
         pyproc(["python3", "../video/scripts/variants.py"], cwd=M), True),
        ("second entry: its named script under its own dir",
         pyproc([".venv/bin/python", "tools/transcribe.py", "x.mp4"], cwd=M, name="python"), True),
        ("named script outside every configured dir", pyproc(["python3", "/home/user/other/batch.py"]), False),
        ("named script relative in another cwd", pyproc(["python3", "compare.py"], cwd="/tmp/x"), False),
        ("unlisted name in the second dir", pyproc(["python3", M + "/predictors.py"]), False),
        ("named script of the FIRST entry in the second dir", pyproc(["python3", M + "/batch.py"]), False),
        ("unlisted name outside the '*' dir", pyproc(["python3", K + "/work/other.py"]), False),
        ("look-alike path /tmp/agents/video/", pyproc(["python3", "/tmp/agents/video/batch.py"]), False),
        ("../ escaping the configured dir", pyproc(["python3", K + "/../x/batch.py"]), False),
        ("relative script with unknown cwd", pyproc(["python3", "scripts/render_v3.py"], cwd=""), False),
        ("-c command", pyproc(["python3", "-c", "import batch", K + "/scripts/batch.py"]), False),
        ("-m module", pyproc(["python3", "-m", "http.server"], cwd=K), False),
        ("named script of the second entry elsewhere", pyproc(["python3", "/tmp/transcribe.py"]), False),
    ]
    for label, proc, want in cases:
        got = rvf.killable_reason(proc, allow) is not None
        check("allowlist: %s -> %s" % (label, "killable" if want else "NOT killable"), got == want,
              (rvf._python_script(proc), rvf.killable_reason(proc, allow)))
    check("allowlist: without a config no python process is killable",
          not any(rvf.killable_reason(proc) for _, proc, _ in cases))

    # ---------------- the config loader -------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        cfg = os.path.join(td, "cfg.json")
        check("config: a missing file is an empty allowlist", rvf.load_config(cfg) == ())
        allow = rvf.load_config(_write(cfg, SAMPLE_CONFIG), root="/srv/app")
        check("config: relative dirs resolve against the install root, '*' is None",
              allow == (("/srv/app/agents/video", frozenset(SAMPLE_CONFIG["python_scripts"][0]["scripts"])),
                        ("/srv/app/agents/video/scripts", None),
                        ("/srv/app/agents/media", frozenset(["transcribe.py"]))), allow)
        allow = rvf.load_config(_write(cfg, {"python_scripts": [{"dir": "/opt/x/../jobs", "scripts": ["a.py"]}]}))
        check("config: an absolute dir is kept, normalized", allow == (("/opt/jobs", frozenset(["a.py"])),), allow)
        check("config: an empty object is an empty allowlist", rvf.load_config(_write(cfg, {})) == ())
        bad = [
            ("not JSON", "{nope"),
            ("top level is a list", []),
            ("unknown top-level key", {"python_scripts": [], "kill_all": True}),
            ("python_scripts not a list", {"python_scripts": {"dir": "x"}}),
            ("entry without scripts", {"python_scripts": [{"dir": "x"}]}),
            ("entry with an extra key", {"python_scripts": [{"dir": "x", "scripts": "*", "y": 1}]}),
            ("empty dir", {"python_scripts": [{"dir": " ", "scripts": "*"}]}),
            ("dir is the filesystem root", {"python_scripts": [{"dir": "/", "scripts": "*"}]}),
            ("dir resolving to the root", {"python_scripts": [{"dir": "/tmp/..", "scripts": "*"}]}),
            ("a script name with a slash", {"python_scripts": [{"dir": "x", "scripts": ["a/b.py"]}]}),
            ("an empty script list", {"python_scripts": [{"dir": "x", "scripts": []}]}),
            ("scripts is another string", {"python_scripts": [{"dir": "x", "scripts": "all"}]}),
        ]
        for why, body in bad:
            try:
                rvf.load_config(_write(cfg, body))
                check("config: %s -> ConfigError" % why, False, "accepted")
            except rvf.ConfigError:
                check("config: %s -> ConfigError" % why, True)

    # ---------------- alert lifecycle is independent of the incident -----------------
    class ScriptedAlert:
        """start() results and poll() results are scripted per attempt."""
        def __init__(self, polls, start_raises=False):
            self.polls = list(polls)     # per attempt: True / False / "hang"
            self.start_raises = start_raises
            self.starts = []
            self.current = None
            self.aborted = 0

        def start(self, text):
            if self.start_raises:
                self.starts.append(text)
                raise RuntimeError("helper exploded")
            if self.current is not None:
                raise AssertionError("start() while a send is in flight (would overwrite it)")
            self.starts.append(text)
            self.current = self.polls.pop(0) if self.polls else False
            return None

        def poll(self):
            if self.current is None or self.current == "hang":
                return None
            ok, self.current = self.current, None
            return (ok, "" if ok else "Bot API rejected")

        def abort(self):
            self.aborted += 1
            self.current = None

        def release(self, ok=True):
            self.current = ok

    def lifecycle_brake(td, alert):
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "a"], 1500)
        return make_brake(td, root, alert=alert)

    def recover_and_run(b, mem, clock, seconds, step=3):
        write_mem(mem, 3000)
        for _ in range(int(seconds / step)):
            clock.t += step
            b.step()

    # a) first send fails, memory recovers within 30 s -> the alert is still retried to 'sent'
    with tempfile.TemporaryDirectory() as td:
        al = ScriptedAlert([False, True])
        b, mem, psi, killed, clock = lifecycle_brake(td, al)
        write_mem(mem, 300)
        b.step(); clock.t += 3; b.step()          # incident + kill + first send started
        clock.t += 3; b.step()                     # first send fails
        check("lifecycle a: first attempt failed while in incident",
              len(al.starts) == 1 and b.alert_state == "pending", (al.starts, b.alert_state))
        recover_and_run(b, mem, clock, 120)
        ev = [e["event"] for e in events(b)]
        check("lifecycle a: incident ended BEFORE the retry was sent",
              "incident_end" in ev and "alert_sent" in ev
              and ev.index("incident_end") < ev.index("alert_sent") and not b.incident, ev)
        check("lifecycle a: retried after recovery and ended in 'sent'",
              len(al.starts) == 2 and b.alert_state == "done" and ev.count("alert_sent") == 1, (al.starts, ev))
        check("lifecycle a: the retried text still names the incident's action",
              "leállítva: ffmpeg" in al.starts[1], al.starts)

    # a2) every send fails, recovery right away -> bounded retries, logged gave_up, then silence
    with tempfile.TemporaryDirectory() as td:
        al = ScriptedAlert([False, False, False, False, False])
        b, mem, psi, killed, clock = lifecycle_brake(td, al)
        write_mem(mem, 300)
        b.step(); clock.t += 3; b.step()
        recover_and_run(b, mem, clock, 600)
        ev = [e["event"] for e in events(b)]
        check("lifecycle a2: exactly ALERT_MAX_ATTEMPTS sends, then a logged gave_up",
              len(al.starts) == rvf.ALERT_MAX_ATTEMPTS and b.alert_state == "gave_up"
              and ev.count("alert_gave_up") == 1 and ev.count("alert_failed") == rvf.ALERT_MAX_ATTEMPTS,
              (len(al.starts), b.alert_state, ev))

    # b) a new incident while the first alert is still 'sending' -> never overwritten
    with tempfile.TemporaryDirectory() as td:
        al = ScriptedAlert(["hang"])
        b, mem, psi, killed, clock = lifecycle_brake(td, al)
        write_mem(mem, 300)
        b.step(); clock.t += 3; b.step()          # send 1 in flight
        recover_and_run(b, mem, clock, 33)         # incident_end, still sending
        check("lifecycle b: still sending after incident_end", b.alert_state == "sending" and not b.incident)
        write_mem(mem, 300)
        clock.t += 3; b.step(); clock.t += 3; b.step()   # incident 2 starts during 'sending'
        ev = [e["event"] for e in events(b)]
        check("lifecycle b: second incident started", ev.count("incident_start") == 2, ev)
        check("lifecycle b: in-flight send not overwritten, no second start",
              len(al.starts) == 1 and b.alert_state == "sending" and "alert_carried" in ev, (al.starts, ev))
        al.release(True)
        clock.t += 3; b.step()
        ev = [e["event"] for e in events(b)]
        check("lifecycle b: the in-flight send's result is logged ('sent')",
              b.alert_state == "done" and ev.count("alert_sent") == 1, ev)

    # b2) a send that never finishes is aborted at the timeout and counted, not orphaned
    with tempfile.TemporaryDirectory() as td:
        al = ScriptedAlert(["hang", True])
        b, mem, psi, killed, clock = lifecycle_brake(td, al)
        write_mem(mem, 300)
        b.step(); clock.t += 3; b.step()
        recover_and_run(b, mem, clock, 200)
        ev = [e["event"] for e in events(b)]
        check("lifecycle b2: hung send aborted + alert_timeout, then retried to 'sent'",
              al.aborted == 1 and "alert_timeout" in ev and b.alert_state == "done"
              and len(al.starts) == 2, (al.aborted, ev))

    # c) start() raising: every call counted once, bounded, terminal gave_up logged
    with tempfile.TemporaryDirectory() as td:
        al = ScriptedAlert([], start_raises=True)
        b, mem, psi, killed, clock = lifecycle_brake(td, al)
        write_mem(mem, 300)
        b.step(); clock.t += 3; b.step()
        recover_and_run(b, mem, clock, 900)
        ev = [e["event"] for e in events(b)]
        check("lifecycle c: start() raising -> exactly ALERT_MAX_ATTEMPTS calls, no crash",
              len(al.starts) == rvf.ALERT_MAX_ATTEMPTS and b.alert_attempts == rvf.ALERT_MAX_ATTEMPTS,
              (len(al.starts), b.alert_attempts))
        check("lifecycle c: alert_error per call and one terminal alert_gave_up",
              ev.count("alert_error") == rvf.ALERT_MAX_ATTEMPTS and ev.count("alert_gave_up") == 1
              and b.alert_state == "gave_up", ev)

    # d) incident ends before any action -> the alert still goes out (not silently dropped)
    with tempfile.TemporaryDirectory() as td:
        al = ScriptedAlert([True])
        b, mem, psi, killed, clock = lifecycle_brake(td, al)
        b.next_action_at = 1e12                    # no action possible in this incident
        write_mem(mem, 300)
        b.step(); clock.t += 3; b.step()
        check("lifecycle d: no action yet -> no send during the incident", al.starts == [])
        recover_and_run(b, mem, clock, 40)
        check("lifecycle d: after incident_end the alert is sent anyway",
              len(al.starts) == 1 and b.alert_state == "done"
              and "magától visszajött" in al.starts[0], al.starts)

    # e) the real TelegramAlert has abort() and never leaves the process behind
    with tempfile.TemporaryDirectory() as td:
        envf = os.path.join(td, ".env")
        with open(envf, "w") as f:
            f.write("TELEGRAM_BOT_TOKEN=abc:def\n")
        helper = os.path.join(td, "slow.sh")
        with open(helper, "w") as f:
            f.write("send_telegram_message() { sleep 30; }\n")
        ta = rvf.TelegramAlert(helper=helper, env_path=envf, chat_id="42")
        ta.start("x")
        proc = ta.proc
        ta.abort()
        check("TelegramAlert.abort kills and clears the running send",
              ta.proc is None and proc.poll() is not None, proc.poll())

    # ---------------- terminate(): TERM then KILL, only to the selected process --------------
    # fallback path (no pidfd): the identity is re-read from the (fake) /proc right
    # before every signal; a fake kill() records what was sent
    def fallback_world(td):
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 11, "ffmpeg", ["ffmpeg", "-i", "a"], 900)     # obeys SIGTERM
        mkproc(root, 12, "ffmpeg", ["ffmpeg", "-i", "b"], 800)     # ignores SIGTERM
        sent = []

        def fkill(pid, sig):
            sent.append((pid, sig))
            if (pid == 11 and sig == rvf.signal.SIGTERM) or sig == rvf.signal.SIGKILL:
                shutil.rmtree(os.path.join(root, str(pid)), ignore_errors=True)
        victim = rvf.select_victim(rvf.list_processes(root), UID, skip_pids={11})
        v11 = rvf.select_victim(rvf.list_processes(root), UID, skip_pids={12})
        both = dict(victim, targets=[11, 12], ident={**victim["ident"], **v11["ident"]})
        return root, sent, fkill, both

    with tempfile.TemporaryDirectory() as td:
        root, sent, fkill, both = fallback_world(td)
        res = rvf.kill_victim(both, proc_root=root, grace=1.0, sleep=lambda s: None,
                              use_pidfd=False, kill=fkill, my_uid=UID)
        check("terminate: SIGTERM to both", (11, rvf.signal.SIGTERM) in sent and (12, rvf.signal.SIGTERM) in sent, sent)
        check("terminate: SIGKILL only to the one ignoring SIGTERM",
              (12, rvf.signal.SIGKILL) in sent and (11, rvf.signal.SIGKILL) not in sent, sent)
        check("terminate: result map", res == {11: "term", 12: "kill"}, res)

    # pid reuse between the selection and the KILL: the pid now names a NEW process
    for what, mutate in (
            ("start time", lambda root: write_stat(root, 12, "ffmpeg", start=99999)),
            ("cgroup", lambda root: open(os.path.join(root, "12", "cgroup"), "w").write("0::" + APP + "other.scope\n")),
            ("never-kill (exec'd into claude)",
             lambda root: open(os.path.join(root, "12", "cmdline"), "wb").write(b"/home/user/.local/bin/claude\0"))):
        with tempfile.TemporaryDirectory() as td:
            root, sent, fkill, both = fallback_world(td)

            def sleep_and_reuse(_s, root=root, mutate=mutate, done=[]):
                if not done:
                    mutate(root)        # pid 12 is now someone else
                    done.append(1)
            res = rvf.kill_victim(both, proc_root=root, grace=1.0, sleep=sleep_and_reuse,
                                  use_pidfd=False, kill=fkill, my_uid=UID)
            check("pid reuse (%s changed after the TERM): no SIGKILL reaches the new process" % what,
                  (12, rvf.signal.SIGKILL) not in sent and res.get(12) == "term_then_reused", (sent, res))
    with tempfile.TemporaryDirectory() as td:
        root, sent, fkill, both = fallback_world(td)
        write_stat(root, 12, "ffmpeg", start=4242)   # reused BEFORE the first signal
        res = rvf.kill_victim(both, proc_root=root, grace=1.0, sleep=lambda s: None,
                              use_pidfd=False, kill=fkill, my_uid=UID)
        check("pid reuse before the TERM: no signal at all to the new process, result 'reused'",
              not any(pid == 12 for pid, _ in sent) and res.get(12) == "reused", (sent, res))

    def eperm_kill(pid, sig):
        if sig == rvf.signal.SIGKILL:
            raise PermissionError("not ours any more")
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 13, "ffmpeg", ["ffmpeg"], 900)
        v = rvf.select_victim(rvf.list_processes(root), UID)
        try:
            res = rvf.kill_victim(v, proc_root=root, grace=0.5, sleep=lambda s: None, use_pidfd=False,
                                  kill=eperm_kill, my_uid=UID)
            check("terminate: SIGKILL PermissionError is caught -> 'eperm'", res == {13: "eperm"}, res)
        except PermissionError:
            check("terminate: SIGKILL PermissionError is caught -> 'eperm'", False, "raised")

    # pidfd path, with real child processes of this test only
    if rvf.HAS_PIDFD:
        def child(code):
            return _sp.Popen([sys.executable, "-c", code])
        ign = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
        c = child(ign)
        time.sleep(0.3)
        me = rvf.read_proc("/proc", c.pid)
        res = rvf.kill_victim({"ident": {c.pid: (me["start"], me["cgroup"])}}, grace=0.5, use_pidfd=True,
                              my_uid=me["uid"])
        c.wait(timeout=10)
        check("pidfd: a real SIGTERM-ignoring child gets TERM then KILL through its pidfd",
              res == {c.pid: "kill"} and c.returncode == -9, (res, c.returncode))
        # the identity recorded at selection is not the process the pid names now
        # (as after a pid reuse): the pidfd is refused, NOTHING is signalled
        c = child("import time; time.sleep(30)")
        time.sleep(0.3)
        me = rvf.read_proc("/proc", c.pid)
        res = rvf.kill_victim({"ident": {c.pid: (str(int(me["start"]) + 1), me["cgroup"])}}, grace=0.5,
                              use_pidfd=True, my_uid=me["uid"])
        time.sleep(0.2)
        survived = c.poll() is None
        c.kill()
        c.wait()
        check("pidfd: identity mismatch at pin time (pid reuse) -> 'reused', the process is not signalled",
              res == {c.pid: "reused"} and survived, (res, survived))
        # a process that exits between selection and pinning
        c = child("pass")
        me_start = rvf.read_start("/proc", c.pid) or "0"
        c.wait()
        res = rvf.kill_victim({"ident": {c.pid: (me_start, "")}}, grace=0.5, use_pidfd=True,
                              my_uid=_proc_self_uid())
        # ('reused' too: the kernel may have handed the pid on already; either way no signal)
        check("pidfd: a process gone (reaped) before pinning -> 'gone', nothing sent",
              res in ({c.pid: "gone"}, {c.pid: "reused"}), res)
    else:
        print("  SKIP pidfd cases (no os.pidfd_open here)")

    # ---------------- real TelegramAlert: token never logged ---------------------------------------
    with tempfile.TemporaryDirectory() as td:
        token = "123456:SECRET-TOKEN-abc"
        envf = os.path.join(td, ".env")
        with open(envf, "w") as f:
            f.write('TELEGRAM_BOT_TOKEN="%s"\n' % token)
        helper = os.path.join(td, "fake-send.sh")
        with open(helper, "w") as f:
            f.write('send_telegram_message() { echo "rejected for bot$1 chat $2" >&2; return 1; }\n')
        ta = rvf.TelegramAlert(helper=helper, env_path=envf, chat_id="42")
        root = os.path.join(td, "proc")
        os.makedirs(root)
        b, mem, psi, killed, clock = make_brake(td, root, alert=ta)
        write_mem(mem, 300)
        for _ in range(3):
            b.step(); clock.t += 1
        import time as _t
        for _ in range(50):
            if ta.proc is None:
                break
            _t.sleep(0.1)
        b.step()
        raw = open(b.log_path).read()
        check("failed send is logged as alert_failed", "alert_failed" in raw, raw[-400:])
        check("bot token never appears in the log", token not in raw)
        check("redacted marker present instead", "<token>" in raw)
        ta2 = rvf.TelegramAlert(helper=helper, env_path=envf, chat_id="")
        miss = ta2.start("x")
        check("missing chat id -> named, nothing started",
              miss.startswith("missing:owner chat id") and ta2.proc is None, miss)

    # ---------------- owner chat + token file: the owner-chat.sh rules, on temp installs ----------
    with tempfile.TemporaryDirectory() as td:
        inst, home = os.path.join(td, "inst"), os.path.join(td, "home")
        chan = os.path.join(inst, ".claude", "channels", "telegram")
        legacy = os.path.join(home, ".claude", "channels", "telegram")
        os.makedirs(chan)
        os.makedirs(legacy)

        def resolve(**env):
            return rvf.resolve_owner_chat(inst, home, environ=env)

        def access(path, allow_from):
            _write(os.path.join(path, "access.json"), {"dmPolicy": "allowlist", "allowFrom": allow_from})

        check("owner chat: no install .env -> none, the reason names it",
              resolve() == (None, "no owner chat: env file not found: %s" % os.path.join(inst, ".env")),
              resolve())
        check("owner chat: MARVEEN_ALERT_CHAT_ID override wins", resolve(MARVEEN_ALERT_CHAT_ID="777") == ("777", None))
        _write(os.path.join(inst, ".env"), "ALLOWED_CHAT_ID=0\n")
        _write(os.path.join(chan, ".env"), "TELEGRAM_BOT_TOKEN=1:abc\n")
        access(chan, ["111222333"])
        check("owner chat: ALLOWED_CHAT_ID=0 is the placeholder -> the single DM entry of access.json",
              resolve() == ("111222333", None), resolve())
        check("owner chat: MARVEEN_ALERT_CHAT_ID=0 is not a chat either",
              resolve(MARVEEN_ALERT_CHAT_ID="0") == ("111222333", None), resolve(MARVEEN_ALERT_CHAT_ID="0"))
        _write(os.path.join(inst, ".env"), 'ALLOWED_CHAT_ID="555"\n')
        check("owner chat: a real ALLOWED_CHAT_ID (quoted) is used first", resolve() == ("555", None), resolve())
        _write(os.path.join(inst, ".env"), "ALLOWED_CHAT_ID=\n")
        access(chan, ["111", 222, "-100123"])
        r = resolve()
        check("owner chat: two DM entries -> none, refusing to guess (the group id is ignored)",
              r[0] is None and "2 DM entries" in r[1], r)
        access(chan, ["-100123", "0"])
        r = resolve()
        check("owner chat: only a group and the placeholder -> none", r[0] is None and "no DM entry" in r[1], r)
        os.remove(os.path.join(chan, ".env"))
        _write(os.path.join(legacy, ".env"), "TELEGRAM_BOT_TOKEN=2:legacy\n")
        access(legacy, [42])
        check("owner chat: install-scoped dir without .env -> the legacy ~/.claude dir",
              resolve() == ("42", None), resolve())
        check("token file: the legacy .env when the install-scoped one is missing",
              rvf.token_env_path(inst, home, environ={}) == os.path.join(legacy, ".env"))
        check("token file: TELEGRAM_ENV overrides",
              rvf.token_env_path(inst, home, environ={"TELEGRAM_ENV": "/x/.env"}) == "/x/.env")
        check("token file: TELEGRAM_STATE_DIR is NOT honoured (a sub-agent's channel)",
              rvf.token_env_path(inst, home, environ={"TELEGRAM_STATE_DIR": "/sub"}) == os.path.join(legacy, ".env"))

        # the real TelegramAlert resolves the chat and the token at send time; fake helper
        rec = os.path.join(td, "sent")
        helper = os.path.join(td, "record-send.sh")
        _write(helper, 'send_telegram_message() { printf "%%s|%%s" "$2" "$3" > %s; return 0; }\n' % rec)
        ta = rvf.TelegramAlert(helper=helper, root=inst, home=home)
        saved = os.environ.pop("MARVEEN_ALERT_CHAT_ID", None), os.environ.pop("TELEGRAM_ENV", None)
        try:
            started = ta.start("szia")
        finally:
            for k, v in zip(("MARVEEN_ALERT_CHAT_ID", "TELEGRAM_ENV"), saved):
                if v is not None:
                    os.environ[k] = v
        res = None
        for _ in range(100):
            res = ta.poll()
            if res is not None:
                break
            time.sleep(0.05)
        sent = open(rec).read() if os.path.exists(rec) else ""
        check("real TelegramAlert: resolved owner chat and text reach the helper, poll -> ok",
              started is None and res == (True, "") and sent == "42|szia", (started, res, sent))

    # ---------------- the alert copy passes the outgoing-copy gate's audit ----------------------------
    gate_path = os.path.join(ROOT, "scripts", "hooks", "outgoing-copy-gate.py")
    gspec = importlib.util.spec_from_file_location("outgoing_copy_gate", gate_path)
    copy_gate = importlib.util.module_from_spec(gspec)
    gspec.loader.exec_module(copy_gate)
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        b, mem, psi, killed, clock = make_brake(td, root)
        texts = []
        b.alert_min_mb = 412
        for acts in ([], ["ollama modell kiürítve: m1"],
                     ["leállítva: ffmpeg [heavy:ffmpeg] (PID 301, 1500 MB, heavy-job scope)"],
                     ["nem volt leállítható nehéz folyamat"], ["a beavatkozás hibára futott (TypeError)"]):
            b.alert_actions = acts
            texts.append(b.alert_text(412, 7939))
        stripped = texts[2].translate(str.maketrans("áéíóöőúüű", "aeiooouuu")) + " \u2014 x"
        check("alert copy: positive control, the audit flags an accentless text with an em dash",
              len(copy_gate.audit(stripped)) >= 2, copy_gate.audit(stripped))
        problems = [(t, copy_gate.audit(t)) for t in texts]
        check("alert copy: every alert text passes the outgoing-copy gate audit (accents, no em dash)",
              all(not pr for _, pr in problems), [x for x in problems if x[1]])
        check("alert copy: Hungarian with accents, names the new log file",
              all("vészfék" in t and "store/ram-emergency-brake-log.jsonl" in t for t in texts), texts[0])

    # ---------------- Linux only: elsewhere a clean exit, nothing done ---------------------------------
    env = dict(os.environ, RAM_BRAKE_PLATFORM="darwin")
    # --simulate-avail-mb without --dry-run would be refused with 2 BEFORE any side effect,
    # so a missing platform check shows as rc 2, never as a real run
    p = _sp.run([sys.executable, BRAKE, "--simulate-avail-mb", "100", "--once", "--no-mlock"],
                capture_output=True, text=True, timeout=30, env=env)
    check("non-Linux (stubbed platform): exit 0 with a clear message, no log line",
          p.returncode == 0 and "Linux only" in p.stderr and p.stdout.strip() == "",
          (p.returncode, p.stdout, p.stderr))
    p = _sp.run([sys.executable, BRAKE, "--help"], capture_output=True, text=True, timeout=30)
    check("--help says Linux only and documents --config",
          p.returncode == 0 and "Linux only" in p.stdout and "--config" in p.stdout, p.stdout)

    single_signal_path_tests()

    print()
    if fails:
        print("FAIL: %d check(s): %s" % (len(fails), ", ".join(fails)))
        return 1
    print("OK: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
