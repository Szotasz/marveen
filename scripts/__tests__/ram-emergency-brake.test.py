#!/usr/bin/env python3
"""Behaviour tests for scripts/ram-emergency-brake.py (the RAM emergency brake).

Run: python3 scripts/__tests__/ram-emergency-brake.test.py

Nothing here kills, unloads or sends anything: the process table is a fake
/proc tree in a temp dir, meminfo/PSI are temp files, and the killer, the
ollama client and the owner alert are recording fakes. The REAL NotifyAlert
only ever runs a fake notify.sh, or the REAL scripts/notify.sh copied into a
temp install whose PATH puts a recording stand-in `node` (the Slack helper)
and `curl` (the Telegram Bot API) first, so nothing is ever sent.
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
import re
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
    # the heavy-job gate (scripts/heavy-job-gate.py): the gate process itself, and its
    # memory-cap probe child, which runs INSIDE a heavy-job-probe-*.scope
    mkproc(root, 112, "python3", ["python3", "/opt/app/scripts/heavy-job-gate.py", "--label", "x",
                                  "--", "npx", "vitest", "run"], 1800)
    mkproc(root, 113, "python3", ["/usr/bin/python3", "/opt/app/scripts/heavy-job-gate.py",
                                  "--probe-memory-max"], 1700,
           cgroup=APP + "heavy-job-probe-4242-1700000000000000000.scope")
    return [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113]


def gate_scope_prefix():
    """SCOPE_PREFIX as scripts/heavy-job-gate.py defines it (read from the source, the
    gate is not imported), or None when the file or the line is missing."""
    try:
        with open(os.path.join(ROOT, "scripts", "heavy-job-gate.py")) as f:
            src = f.read()
    except OSError:
        return None
    m = re.search(r'^SCOPE_PREFIX = "([^"]+)"', src, re.M)
    return m.group(1) if m else None


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
        self.loaded_calls = 0

    def loaded(self):
        self.loaded_calls += 1
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


def make_brake(td, proc_root, models=(), dry_run=False, alert=None, mod=None, **brake_kw):
    """A Brake of `mod` (default: the brake under test) on temp files; brake_kw go to
    Brake() as given (no ollama_* key = the Brake's own default)."""
    mem = os.path.join(td, "meminfo")
    psi = os.path.join(td, "psi")
    write_mem(mem, 5000)
    write_psi(psi, 0.0)
    killed = []

    def killer(victim):
        killed.append(list(victim["targets"]))
        return {p: "term" for p in victim["targets"]}

    clock = Clock()
    b = (mod or rvf).Brake(dry_run=dry_run, log_path=os.path.join(td, "log.jsonl"), meminfo_path=mem,
                           psi_path=psi, proc_root=proc_root, ollama=FakeOllama(models),
                           alert=alert or FakeAlert(), killer=killer, clock=clock, my_uid=UID,
                           protected_pids=(), echo=False, **brake_kw)
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


EXCEPTION = ("NotifyAlert", "abort")   # the ONE documented exception: the alert child's own kill
SIGNAL_FUNCS = ("send_checked",)


def sc_static(path):
    """The brake source:
    - contains no 'cgroup.kill' and no 'cgroup.freeze' at all (code, strings,
      comments): jobs are never stopped or frozen through their cgroup;
    - os.kill / os.killpg / signal.pidfd_send_signal / signal.pthread_kill are
      referenced only inside send_checked();
    - .kill() / .terminate() / .send_signal() are called only inside
      NotifyAlert.abort() (the alert child), the one documented exception,
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


# ---- ollama unload (opt-in) and the provider-neutral alert: scenarios on the MODULE too ----
OLLAMA_MODELS = ["qwen2.5:7b", "llama3.1:8b"]


def _ollama_run(m, td, models=OLLAMA_MODELS, **kw):
    root = os.path.join(td, "proc")
    os.makedirs(root)
    mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "raw.mov", "out.mp4"], 1500)
    b, mem, psi, killed, clock = make_brake(td, root, models=models, mod=m, **kw)
    write_mem(mem, 300)
    b.step(); clock.t += 3; b.step()
    return b, killed


def sc_unload_default_off(m):
    """No ollama argument, and the config defaults (no file, {}): nothing is unloaded,
    ollama is not asked, the first action is the kill."""
    seen = []
    with tempfile.TemporaryDirectory() as td:
        sub = os.path.join(td, "brake-default")
        os.makedirs(sub)
        b, killed = _ollama_run(m, sub)
        seen.append(("brake default", b.ollama.unloaded, b.ollama.loaded_calls, killed))
        for label, body in (("no config file", None), ("empty config", {})):
            cfg_path = os.path.join(td, label.replace(" ", "-") + ".json")
            if body is not None:
                _write(cfg_path, body)
            cfg = m.load_full_config(cfg_path)
            sub = os.path.join(td, label.replace(" ", "-"))
            os.makedirs(sub)
            b, killed = _ollama_run(m, sub, ollama_unload=cfg["ollama_unload"],
                                    ollama_models=cfg["ollama_models"])
            seen.append((label, b.ollama.unloaded, b.ollama.loaded_calls, killed))
    ok = all(u == [] and calls == 0 and k == [[301]] for _, u, calls, k in seen)
    return ok, seen


def sc_unload_allowlist(m):
    """Opt-in from the config: without a list every loaded model goes; with a list
    only the listed one, the other stays loaded."""
    with tempfile.TemporaryDirectory() as td:
        res = {}
        for label, body in (("all", {"ollama_unload": True}),
                            ("listed", {"ollama_unload": True, "ollama_models": ["llama3.1:8b"]})):
            cfg = m.load_full_config(_write(os.path.join(td, label + ".json"), body))
            sub = os.path.join(td, label)
            os.makedirs(sub)
            b, killed = _ollama_run(m, sub, ollama_unload=cfg["ollama_unload"],
                                    ollama_models=cfg["ollama_models"])
            res[label] = (sorted(b.ollama.unloaded), list(b.ollama.models), killed)
    ok = (res["all"] == (sorted(OLLAMA_MODELS), [], [])
          and res["listed"] == (["llama3.1:8b"], ["qwen2.5:7b"], []))
    return ok, res


NOTIFY_SRC = (("scripts", "notify.sh"), ("scripts", "lib", "owner-chat.sh"),
              ("scripts", "lib", "send-telegram.sh"))
TG_TOKEN = "987654321:AAF" + "q" * 32
NODE_REPLY = {
    "ok": ('{"ok":true,"target":"C0TEST","sender":"main","telegram":"send"}', 0),
    "fail": ('{"ok":false,"error":"channel_not_found","target":"C0TEST","sender":"main","telegram":"send"}', 1),
    "none": ('{"ok":false,"skipped":true,"reason":"no Slack target configured","telegram":"send"}', 2),
}


def notify_install(td, env_text, slack):
    """A temp install with the REAL scripts/notify.sh and its two libs, the stand-in
    dist/slack-notify.js notify.sh checks for, and recording stand-ins first on PATH:
    `node` plays scripts/slack-notify.mjs (slack: ok / fail / none = no target), `curl`
    plays the Telegram Bot API and answers ok. Returns (install, environ, record dir)."""
    inst, bindir, rec = os.path.join(td, "inst"), os.path.join(td, "bin"), os.path.join(td, "rec")
    for d in (bindir, rec, os.path.join(inst, "dist"), os.path.join(inst, "scripts", "lib")):
        os.makedirs(d, exist_ok=True)
    for parts in NOTIFY_SRC:
        shutil.copy(os.path.join(ROOT, *parts), os.path.join(inst, *parts))
    _write(os.path.join(inst, ".env"), env_text)
    _write(os.path.join(inst, "dist", "slack-notify.js"), "// stand-in, never loaded\n")
    reply, rc = NODE_REPLY[slack]
    _write(os.path.join(bindir, "node"),
           "#!/bin/sh\nprintf '%%s\\n' \"$@\" > '%s/node-args'\necho '%s'\nexit %d\n" % (rec, reply, rc))
    _write(os.path.join(bindir, "curl"),
           "#!/bin/sh\ncat > '%s/curl-stdin'\nprintf '%%s\\n' \"$@\" > '%s/curl-args'\n"
           "echo '{\"ok\":true,\"result\":{}}'\nexit 0\n" % (rec, rec))
    for n in ("node", "curl"):
        os.chmod(os.path.join(bindir, n), 0o755)
    env = {"PATH": bindir + ":/usr/bin:/bin", "HOME": td, "LANG": "C.UTF-8"}
    return inst, env, rec


def _rec(rec, name):
    try:
        with open(os.path.join(rec, name)) as f:
            return f.read()
    except OSError:
        return None


def _notify_alert(m, inst, env):
    """The module's NotifyAlert, pointed at the same relative helper path in the temp
    install that NOTIFY_HELPER names in the module's own install."""
    return m.NotifyAlert(helper=os.path.join(inst, os.path.relpath(m.NOTIFY_HELPER, m.ROOT)), environ=env)


def _send(alert, text, wait=20.0):
    started = alert.start(text)
    if started is not None:
        return started
    t_end = time.time() + wait
    while time.time() < t_end:
        r = alert.poll()
        if r is not None:
            return r
        time.sleep(0.05)
    alert.abort()
    return "timeout"


def _drive_brake(m, td, alert, rounds):
    """A brake of module m with the real alert, in a critical incident with nothing
    to kill (the first send starts with the incident's first action). Each round
    waits (real time) for the alert child to exit, jumps the clock past
    ALERT_RETRY_SEC and steps once: that step polls the result and, after a
    failure, starts the next attempt."""
    root = os.path.join(td, "proc")
    os.makedirs(root)
    b, mem, psi, killed, clock = make_brake(td, root, alert=alert, mod=m)
    write_mem(mem, 300)
    b.step(); clock.t += 3; b.step()
    for _ in range(rounds):
        t_end = time.time() + 20
        while alert.proc is not None and alert.proc.poll() is None and time.time() < t_end:
            time.sleep(0.05)
        clock.t += 61
        b.step()
    return b


ALERT_SAMPLE = "Marveen RAM-vészfék: leállítva: <x> & y"


def sc_notify_slack_only(m):
    """No Telegram on the install (no TELEGRAM_BOT_TOKEN), a Slack target present:
    the brake's alert reaches Slack, poll -> ok, and the Bot API is never called."""
    with tempfile.TemporaryDirectory() as td:
        inst, env, rec = notify_install(td, "MAIN_AGENT_ID=marveen\n", "ok")
        res = _send(_notify_alert(m, inst, env), ALERT_SAMPLE)
        node_args, curl = _rec(rec, "node-args"), _rec(rec, "curl-args")
        default_is_notify = isinstance(m.Brake(echo=False, log_path=os.devnull).alert, m.NotifyAlert)
        sub = os.path.join(td, "brake")
        os.makedirs(sub)
        b = _drive_brake(m, sub, _notify_alert(m, inst, env), 1)
        ev = events(b)
        sent = [e for e in ev if e["event"] == "alert_sent"]
    ok = (isinstance(res, tuple) and res[0] is True and node_args is not None
          and ALERT_SAMPLE in node_args.splitlines() and "--kind" in node_args.splitlines()
          and curl is None and default_is_notify
          and len(sent) == 1 and "Slack" in sent[0].get("detail", ""))
    return ok, (res, node_args, curl, default_is_notify, [e["event"] for e in ev], sent)


def sc_notify_no_channel(m):
    """Neither channel delivers (Slack fails, no Telegram token): poll -> NOT ok, and
    the brake retries ALERT_MAX_ATTEMPTS times, then logs a terminal alert_gave_up."""
    with tempfile.TemporaryDirectory() as td:
        inst, env, rec = notify_install(td, "MAIN_AGENT_ID=marveen\n", "fail")
        res = _send(_notify_alert(m, inst, env), ALERT_SAMPLE)
        sub = os.path.join(td, "brake")
        os.makedirs(sub)
        b = _drive_brake(m, sub, _notify_alert(m, inst, env), m.ALERT_MAX_ATTEMPTS + 2)
        ev = [e["event"] for e in events(b)]
    ok = (isinstance(res, tuple) and res[0] is False and "Hiba" in res[1]
          and ev.count("alert_failed") == m.ALERT_MAX_ATTEMPTS and ev.count("alert_gave_up") == 1
          and "alert_sent" not in ev and b.alert_state == "gave_up")
    return ok, (res, ev)


def sc_notify_telegram_only(m):
    """A Telegram-only install (no Slack target): the alert goes over the Bot API to
    ALLOWED_CHAT_ID, the token travels on curl's stdin, never in its argv, and never
    in the brake's log."""
    with tempfile.TemporaryDirectory() as td:
        inst, env, rec = notify_install(
            td, "TELEGRAM_BOT_TOKEN=%s\nALLOWED_CHAT_ID=4242\n" % TG_TOKEN, "none")
        res = _send(_notify_alert(m, inst, env), ALERT_SAMPLE)
        args, stdin = _rec(rec, "curl-args") or "", _rec(rec, "curl-stdin") or ""
        sub = os.path.join(td, "brake")
        os.makedirs(sub)
        b = _drive_brake(m, sub, _notify_alert(m, inst, env), 1)
        raw = open(b.log_path).read()
    ok = (isinstance(res, tuple) and res[0] is True and "chat_id=4242" in args
          and ("text=" + ALERT_SAMPLE) in args and TG_TOKEN not in args and TG_TOKEN in stdin
          and '"alert_sent"' in raw and TG_TOKEN not in raw)
    return ok, (res, args, raw[-300:])


def sc_alert_escape(m):
    """notify.sh sends Telegram with parse_mode=HTML: & < > in the alert are escaped."""
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        b = make_brake(td, root, mod=m)[0]
        b.alert_actions = ["leállítva: <x>&y [heavy:ffmpeg]"]
        t = b.alert_text(400, 8000)
    return "leállítva: &lt;x&gt;&amp;y [heavy:ffmpeg]" in t and "<x>" not in t, t


def sc_redact(m):
    t = m.redact("rejected for https://api.telegram.org/bot%s/sendMessage, slack xoxb-1-2-abc" % TG_TOKEN)
    return TG_TOKEN not in t and "xoxb-" not in t and t.count("<token>") == 2, t


NOTIFY_CHECKS = (
    ("notify_slack_only", "no Telegram, Slack present: the alert reaches Slack (exit 0, logged alert_sent "
                          "naming Slack), the Bot API is never called, Brake's default alert is NotifyAlert"),
    ("notify_no_channel", "Slack fails and no Telegram: not ok, ALERT_MAX_ATTEMPTS attempts, one alert_gave_up"),
    ("notify_telegram_only", "Telegram only: sent to ALLOWED_CHAT_ID, token on curl stdin only, never logged"),
    ("alert_escape", "the alert text escapes & < > (parse_mode=HTML on Telegram, Slack's own escapes)"),
    ("redact", "redact() removes a Telegram bot token inside a URL and a Slack token"),
    ("unload_default_off", "ollama unload is off by default (Brake default, no config, empty config)"),
    ("unload_allowlist", "ollama opt-in: all models without a list, only the listed ones with it"),
)


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
    # ollama unload: opt-in, default off, allowlist honoured
    ("unload-default-on (Brake)", """echo=True, python_allow=(), ollama_unload=False, ollama_models=None):""",
     """echo=True, python_allow=(), ollama_unload=True, ollama_models=None):""", "unload_default_off"),
    ("unload-default-on (config)", """return {"python_allow": (), "ollama_unload": False, "ollama_models": None}""",
     """return {"python_allow": (), "ollama_unload": True, "ollama_models": None}""", "unload_default_off"),
    ("unload-gate-removed", """if self.ollama_unload and now - self.last_ollama_try""",
     """if now - self.last_ollama_try""", "unload_default_off"),
    ("unload-allowlist-ignored", """models = [m for m in loaded if ollama_model_listed(m, self.ollama_models)]""",
     """models = list(loaded)""", "unload_allowlist"),
    # the alert: through notify.sh, honest exit, escaped, redacted
    ("notify-bypassed", """NOTIFY_HELPER = os.path.join(ROOT, "scripts", "notify.sh")""",
     """NOTIFY_HELPER = os.path.join(ROOT, "scripts", "lib", "send-telegram.sh")""", "notify_slack_only"),
    ("alert-exit-ignored", """ok = self.proc.returncode == 0""", """ok = True""", "notify_no_channel"),
    ("alert-unescaped", """acts = acts.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")""",
     """acts = acts""", "alert_escape"),
    ("redact-off", """text = r.sub("<token>", text)""", """pass""", "redact"),
)
SCENARIOS = {"send_recheck": sc_send_recheck, "exec_pidfd": sc_exec_pidfd,
             "unreadable_hidden": lambda m: sc_unreadable(m, "hidden"),
             "unreadable_nostart": lambda m: sc_unreadable(m, "nostart"),
             "lock_symlink": sc_lock_symlink, "lock_foreign": sc_lock_foreign, "lock_fresh": sc_lock_fresh,
             "unload_default_off": sc_unload_default_off, "unload_allowlist": sc_unload_allowlist,
             "notify_slack_only": sc_notify_slack_only, "notify_no_channel": sc_notify_no_channel,
             "notify_telegram_only": sc_notify_telegram_only, "alert_escape": sc_alert_escape,
             "redact": sc_redact}


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
               ".kill()/.terminate()/.send_signal() only in NotifyAlert.abort (the documented exception)"),
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
        check("the brake's scope mark is heavy-job-gate.py's SCOPE_PREFIX",
              gate_scope_prefix() == rvf.SCOPE_MARK, (gate_scope_prefix(), rvf.SCOPE_MARK))
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
        b, mem, psi, killed, clock = make_brake(td, root, models=["nomic-embed-text:latest"], alert=alert,
                                                ollama_unload=True)

        b.step()
        check("healthy sample: no incident", not b.incident)
        write_mem(mem, 500)
        clock.t += 3
        b.step()
        check("1 critical sample: still no incident (needs 2)", not b.incident and not killed)
        clock.t += 3
        b.step()
        check("2 critical samples: incident started", b.incident)
        check("opt-in: first action = ollama unload, nothing killed",
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

    # ---------------- ollama unload: opt-in, default off, optional model allowlist -------------
    # An agent on the ollama provider, or memory embeddings on the same server, lose
    # their model on an unload, so by default the brake never even asks ollama.
    def ollama_world(td, models, **kw):
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "raw.mov", "out.mp4"], 1500)
        b, mem, psi, killed, clock = make_brake(td, root, models=models, **kw)
        write_mem(mem, 300)
        b.step(); clock.t += 3; b.step()          # incident + first action
        return b, killed, clock

    with tempfile.TemporaryDirectory() as td:
        b, killed, clock = ollama_world(td, ["qwen2.5:7b", "nomic-embed-text:latest"])
        check("ollama default off: nothing unloaded, ollama not even asked (no /api/ps)",
              b.ollama.unloaded == [] and b.ollama.loaded_calls == 0, (b.ollama.unloaded, b.ollama.loaded_calls))
        check("ollama default off: the first action is the kill", killed == [[301]], killed)
        clock.t += 61; b.step()
        check("ollama default off: still nothing unloaded after OLLAMA_RETRY_SEC",
              b.ollama.unloaded == [] and b.ollama.loaded_calls == 0, b.ollama.unloaded)
        check("ollama default off: no ollama event in the log",
              not [e for e in events(b) if "ollama" in e["event"] or "unload" in e["event"]], events(b))
    with tempfile.TemporaryDirectory() as td:
        b, killed, clock = ollama_world(td, ["qwen2.5:7b", "nomic-embed-text:latest"], ollama_unload=True)
        check("ollama opt-in, no list: every loaded model unloaded, nothing killed yet",
              b.ollama.unloaded == ["qwen2.5:7b", "nomic-embed-text:latest"] and killed == [],
              (b.ollama.unloaded, killed))
    with tempfile.TemporaryDirectory() as td:
        b, killed, clock = ollama_world(td, ["qwen2.5:7b", "nomic-embed-text:latest", "llama3.1:8b"],
                                        ollama_unload=True, ollama_models=["llama3.1:8b", "nomic-embed-text"])
        check("ollama allowlist: only the listed models unloaded (tag-less name matches :latest)",
              sorted(b.ollama.unloaded) == ["llama3.1:8b", "nomic-embed-text:latest"] and killed == [],
              (b.ollama.unloaded, killed))
        kept = [e for e in events(b) if e["event"] == "ollama_kept_unlisted"]
        check("ollama allowlist: the unlisted model stays loaded and is logged as kept",
              b.ollama.models == ["qwen2.5:7b"] and kept and kept[0]["models"] == ["qwen2.5:7b"], (b.ollama.models, kept))
    with tempfile.TemporaryDirectory() as td:
        b, killed, clock = ollama_world(td, ["qwen2.5:7b"], ollama_unload=True, ollama_models=["llama3.1:8b"])
        check("ollama allowlist: only unlisted models loaded -> none unloaded, the kill goes ahead",
              b.ollama.unloaded == [] and killed == [[301]], (b.ollama.unloaded, killed))
    check("ollama_model_listed: exact name, tag-less -> :latest only, other tags not",
          rvf.ollama_model_listed("qwen2.5:7b", frozenset(["qwen2.5:7b"]))
          and rvf.ollama_model_listed("qwen2.5:latest", frozenset(["qwen2.5"]))
          and not rvf.ollama_model_listed("qwen2.5:7b", frozenset(["qwen2.5"]))
          and not rvf.ollama_model_listed("qwen2.5", frozenset(["qwen2.5:7b"]))
          and rvf.ollama_model_listed("anything:1", None))

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

    # ---------------- a non-UTF-8 /proc record never stops the brake ------------------------
    # The kernel cuts a process name at 15 bytes and passes high bytes through, so an
    # accented name cut mid-character (or one set through prctl, by any user) is not
    # valid UTF-8 in status / stat. One such process must not abort the table walk.
    bad_name = b"vesz-f\xc3\xa9k-ren\xc5"
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "raw.mov", "out.mp4"], 1500)
        mkproc(root, 501, "x", ["/usr/bin/python3", "x.py"], 900)
        d = os.path.join(root, "501")
        with open(os.path.join(d, "status"), "wb") as f:
            f.write(b"Name:\t" + bad_name + b"\nUid:\t%d\t%d\t%d\t%d\nVmRSS:\t%d kB\n"
                    % (UID, UID, UID, UID, 900 * 1024))
        with open(os.path.join(d, "stat"), "wb") as f:
            f.write(b"501 (" + bad_name + b") S " + b" ".join([b"0"] * 18 + [b"1501"] + [b"0"] * 5)
                    + b"\n")
        with open(os.path.join(d, "cgroup"), "wb") as f:
            f.write(b"0::" + APP.encode() + b"tmux-spawn-\xff.scope\n")
        try:
            rec, err = rvf.read_proc(root, 501), None
        except Exception as e:  # noqa: BLE001 - the point is that nothing escapes
            rec, err = None, e
        check("non-UTF-8 status/stat/cgroup: read_proc returns a record (no exception)",
              err is None and rec is not None and "\ufffd" in rec["name"]
              and rec["start"] == "1501", (err, rec))
        alert = FakeAlert()
        b, mem, psi, killed, clock = make_brake(td, root, alert=alert)
        write_mem(mem, 300)
        b.step(); clock.t += 3; b.step()
        ev = [e["event"] for e in events(b)]
        check("non-UTF-8 record on the host: the brake still stops the job (pid 301)",
              killed == [[301]], killed)
        check("... with no loop/act error logged", "loop_error" not in ev and "act_error" not in ev, ev)

    # a record that still cannot be parsed is skipped, logged and named in the alert
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        never_kill_table(root)
        mkproc(root, 502, "ffmpeg", ["ffmpeg", "-i", "a"], 1500)
        real_rp = rvf.read_proc

        def flaky(proc_root, pid):
            if pid == 502:
                raise ValueError("simulated unparsable record")
            return real_rp(proc_root, pid)
        rvf.read_proc = flaky
        try:
            skipped = []
            procs = rvf.list_processes(root, skipped)
            check("unparsable record: list_processes skips it and names it, the walk goes on",
                  skipped == [502] and 101 in [p["pid"] for p in procs], (skipped, len(procs)))
            alert = FakeAlert()
            b, mem, psi, killed, clock = make_brake(td, root, alert=alert)
            write_mem(mem, 300)
            b.step(); clock.t += 3; b.step()
            ev = events(b)
            sk = [e for e in ev if e["event"] == "proc_record_skipped"]
            nc = [e for e in ev if e["event"] == "no_candidate"]
            check("skipped record logged (proc_record_skipped, pid named)",
                  sk and sk[0]["pids"] == [502] and sk[0]["count"] == 1, sk)
            check("no_candidate carries the skipped count", nc and nc[0].get("skipped_records") == 1, nc)
            check("the alert says a record was skipped (not just 'nothing to stop')",
                  len(alert.sent) == 1 and "olvashatatlan" in alert.sent[0], alert.sent)
            check("nothing killed, no loop error", killed == [] and
                  "loop_error" not in [e["event"] for e in ev], killed)
            # the pre-signal re-check: an unparsable record is never signalled
            sent = []
            t = rvf.Target(502, "1502", APP + "tmux-spawn-x.scope", proc_root=root, use_pidfd=False,
                           kill=lambda pid, sig: sent.append((pid, sig)), my_uid=UID)
            r = rvf.send_checked(t, signal.SIGTERM)
            check("Target.check on an unparsable record -> 'reused', nothing sent",
                  r == "reused" and sent == [], (r, sent))
        finally:
            rvf.read_proc = real_rp

    # the same on the REAL /proc: a child whose name is cut mid-character
    if hasattr(os, "pidfd_open"):
        code = ("import ctypes,time; ctypes.CDLL(None).prctl(15, ctypes.c_char_p(%r), 0, 0, 0); "
                "time.sleep(30)" % bad_name)
        c = _sp_mod.Popen([sys.executable, "-c", code])
        try:
            time.sleep(0.3)
            with open("/proc/%d/status" % c.pid, "rb") as f:
                raw_ok = bad_name in f.read()
            try:
                rec, err = rvf.read_proc("/proc", c.pid), None
            except Exception as e:  # noqa: BLE001
                rec, err = None, e
            procs_err = None
            try:
                rvf.list_processes("/proc")
            except Exception as e:  # noqa: BLE001
                procs_err = e
            if raw_ok:
                check("real /proc: a non-UTF-8 process name reads as a record",
                      err is None and rec is not None and "\ufffd" in rec["name"], (err, rec))
                check("real /proc: the table walk survives it", procs_err is None, procs_err)
            else:
                print("  SKIP real /proc non-UTF-8 name (prctl name not visible here)")
        finally:
            c.kill()
            c.wait()

    # ---------------- dry run -------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "proc")
        os.makedirs(root)
        mkproc(root, 301, "ffmpeg", ["ffmpeg", "-i", "raw.mov"], 1500)
        alert = FakeAlert()
        b, mem, psi, killed, clock = make_brake(td, root, models=["m1"], dry_run=True, alert=alert,
                                                ollama_unload=True)
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
        helper = _write(os.path.join(td, "slow-notify.sh"), "sleep 5\nexit 0\n")
        ta = rvf.NotifyAlert(helper=helper)
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
        full = rvf.load_full_config(os.path.join(td, "missing.json"))
        check("config: no file -> ollama unload off, no model list",
              full["ollama_unload"] is False and full["ollama_models"] is None and full["python_allow"] == (), full)
        full = rvf.load_full_config(_write(cfg, SAMPLE_CONFIG))
        check("config: python_scripts alone -> ollama unload still off", full["ollama_unload"] is False, full)
        full = rvf.load_full_config(_write(cfg, {"ollama_unload": True}))
        check("config: ollama_unload true without a list -> every model (None)",
              full["ollama_unload"] is True and full["ollama_models"] is None, full)
        full = rvf.load_full_config(_write(cfg, {"ollama_unload": True, "ollama_models": ["a:1", "b"]}))
        check("config: ollama_models -> a frozenset of the names",
              full["ollama_models"] == frozenset(["a:1", "b"]), full)
        full = rvf.load_full_config(_write(cfg, {"ollama_unload": False}))
        check("config: ollama_unload false is accepted (explicit off)", full["ollama_unload"] is False, full)
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
            ("ollama_unload not a bool", {"ollama_unload": "yes"}),
            ("ollama_unload as 1", {"ollama_unload": 1}),
            ("ollama_models without the opt-in", {"ollama_models": ["a"]}),
            ("ollama_models with the opt-in off", {"ollama_unload": False, "ollama_models": ["a"]}),
            ("ollama_models empty", {"ollama_unload": True, "ollama_models": []}),
            ("ollama_models a string", {"ollama_unload": True, "ollama_models": "a"}),
            ("ollama_models with a non-string", {"ollama_unload": True, "ollama_models": ["a", 3]}),
            ("ollama_models with a blank name", {"ollama_unload": True, "ollama_models": ["a b"]}),
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

    # e) the real NotifyAlert has abort() and never leaves the process behind
    with tempfile.TemporaryDirectory() as td:
        helper = _write(os.path.join(td, "slow.sh"), "sleep 30\n")
        ta = rvf.NotifyAlert(helper=helper)
        ta.start("x")
        proc = ta.proc
        ta.abort()
        check("NotifyAlert.abort kills and clears the running send",
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

    # ---------------- real NotifyAlert: secrets in the child's output never reach the log ----------
    with tempfile.TemporaryDirectory() as td:
        token = "123456789:AAH" + "x" * 32
        slack = "xoxb-1111-2222-SECRETsecret"
        helper = _write(os.path.join(td, "fake-notify.sh"),
                        'echo "rejected for bot%s, slack %s, text: $1" >&2\nexit 1\n' % (token, slack))
        ta = rvf.NotifyAlert(helper=helper)
        root = os.path.join(td, "proc")
        os.makedirs(root)
        b, mem, psi, killed, clock = make_brake(td, root, alert=ta)
        write_mem(mem, 300)
        for _ in range(3):
            b.step(); clock.t += 1
        for _ in range(50):
            if ta.proc is None or ta.proc.poll() is not None:
                break
            time.sleep(0.1)
        b.step()
        raw = open(b.log_path).read()
        check("NotifyAlert: notify.sh exit 1 is logged as alert_failed", "alert_failed" in raw, raw[-400:])
        check("NotifyAlert: no Telegram or Slack token in the log, redacted marker instead",
              token not in raw and slack not in raw and "<token>" in raw, raw[-400:])
        miss = rvf.NotifyAlert(helper=os.path.join(td, "no-such-notify.sh")).start("x")
        check("NotifyAlert: a missing notify.sh is named, nothing started",
              miss == "missing:" + os.path.join(td, "no-such-notify.sh"), miss)
    check("NotifyAlert: the brake's default helper is scripts/notify.sh of the install",
          rvf.NOTIFY_HELPER == os.path.join(rvf.ROOT, "scripts", "notify.sh")
          and isinstance(rvf.Brake(echo=False, log_path=os.devnull).alert, rvf.NotifyAlert)
          and rvf.NotifyAlert().helper == rvf.NOTIFY_HELPER, rvf.NOTIFY_HELPER)

    # ---------------- the REAL scripts/notify.sh (Slack-only, nothing, Telegram-only), escaping,
    # redaction, and the ollama opt-in: the same scenarios the mutants below must turn red
    for key, title in NOTIFY_CHECKS:
        ok, info = run_scenario(key, rvf, BRAKE)
        check("alert/ollama: " + title, ok, info)

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
