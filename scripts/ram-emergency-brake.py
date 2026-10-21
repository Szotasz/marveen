#!/usr/bin/env python3
"""RAM emergency brake for a fleet host (user-level, long-running). Linux only.

Polls /proc/meminfo every POLL_SEC. When MemAvailable stays under CRIT_MB for
CONFIRM_SAMPLES consecutive samples (or memory PSI "full avg10" is high while
MemAvailable is already low) an INCIDENT starts, and the brake acts in order:

  1. unload every model loaded in the local ollama server (HTTP API,
     keep_alive=0), because ollama usually runs as a system service a user
     process cannot kill;
  2. if still critical: SIGTERM, then SIGKILL after TERM_GRACE_SEC, the
     largest-RSS process from a STRICT allowlist of heavy, restartable jobs.
     Anything inside a heavy-job-*.scope (a job admitted by
     scripts/heavy-job.sh) is preferred, and every process of that job the
     brake can identify is a target; each one is signalled on its own (the
     job is never stopped through its cgroup). A process the brake cannot
     identify (unreadable /proc entry) is never a target.
     Each target is pinned at selection time (pidfd, confirmed against its
     start time and cgroup), so a pid reused in the TERM -> KILL window is
     never signalled; on both paths the identity, own-uid, cgroup and
     never-kill check is re-run right before every signal (send_checked, the
     only signal path).

The allowlist has built-in generic classes: ffmpeg and media tools (KILL_COMM),
headless browsers, and node test runners / builds / renders (vitest, jest, tsc,
playwright test, vite build, webpack, remotion, render.mjs). Python processes are
never matched by basename alone (batch.py, render.py ... are common names):
they are killable only when the resolved script path is listed in the optional
config file store/ram-emergency-brake.json (see load_config). No config file =
only the generic classes.

It NEVER kills agent sessions (claude), tmux, the dashboard, the channels
service, bun (channel plugins), systemd, sshd, dbus, ollama or itself: the
never-kill check wins over the allowlist and is applied per process.

Every action is appended to store/ram-emergency-brake-log.jsonl (JSON lines,
keys "ts", "event", ...). ONE owner alert is sent per incident (global cooldown
ALERT_COOLDOWN_SEC) through the honest send helper scripts/lib/send-telegram.sh;
the alert is driven to a logged terminal state (alert_sent / alert_gave_up /
alert_suppressed_cooldown) even after the incident ends. The bot token is read
from the main install's Telegram channel .env (TELEGRAM_ENV overrides); the
owner chat is MARVEEN_ALERT_CHAT_ID when set, else resolved like
scripts/lib/owner-chat.sh does (see resolve_owner_chat). The brake never prints
or logs the token and never puts it in ITS OWN argv.

Linux only: /proc/meminfo, /proc/<pid>/ and PSI are its whole input. On any
other platform it prints a message and exits 0 without doing anything.

One acting brake per install: a non-dry brake takes an exclusive flock on
store/.ram-emergency-brake.lock (RAM_BRAKE_LOCK overrides; opened O_NOFOLLOW,
created 0600, must be a regular file owned by this user). Another instance
holding it: exit 3; an unsafe or unusable lock file: exit 4. Dry runs skip it.

Flags:
  --dry-run              log what would be done, change nothing, send nothing
  --cycles N             run N samples then exit (default: forever)
  --once                 same as --cycles 1
  --simulate-avail-mb N  pretend MemAvailable is N MB (testing the selection
                         against the real process table; use with --dry-run)
  --log-samples          log every sample (verbose, for --cycles runs)
  --no-mlock             do not mlockall() the process
  --config PATH          python-script allowlist (default store/ram-emergency-brake.json)
"""
import argparse
import ctypes
import fcntl
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, "store")
LOG_PATH = os.path.join(STORE, "ram-emergency-brake-log.jsonl")
CONFIG_PATH = os.path.join(STORE, "ram-emergency-brake.json")
SEND_HELPER = os.path.join(ROOT, "scripts", "lib", "send-telegram.sh")
OLLAMA_URL = os.environ.get("OLLAMA_URL") or "http://localhost:11434"

POLL_SEC = 3.0
CRIT_MB = 600            # act below this MemAvailable
CONFIRM_SAMPLES = 2      # consecutive critical samples before the first action
PSI_FULL_CRIT = 40.0     # memory PSI full avg10 (%) that counts as critical ...
PSI_AVAIL_MB = 1200      # ... but only while MemAvailable is already under this
WARN_MB = 1200           # low-memory enter/exit transitions are logged (no action)
RECOVER_MB = 1000        # incident ends after RECOVER_SAMPLES samples above this
RECOVER_SAMPLES = 10
MIN_RSS_MB = 50          # a victim smaller than this would not help
TERM_GRACE_SEC = 5.0
ACTION_COOLDOWN_SEC = 8.0   # between two actions, let the kernel reclaim
OLLAMA_RETRY_SEC = 60.0
KILL_WINDOW_SEC = 600.0
KILL_WINDOW_MAX = 6         # at most this many kills per KILL_WINDOW_SEC
ALERT_COOLDOWN_SEC = 1800.0
ALERT_RETRY_SEC = 60.0
ALERT_MAX_ATTEMPTS = 3
ALERT_SEND_TIMEOUT_SEC = 60.0  # a send still running after this counts as a failed attempt
HEARTBEAT_SEC = 3600.0

SCOPE_MARK = "heavy-job-"

# ---- never-kill (wins over everything) --------------------------------------
NEVER_COMM = {
    "claude", "tmux", "tmux: server", "tmux: client", "systemd", "(sd-pam)",
    "sshd", "sshd-session", "sshd-auth", "bun", "dbus-daemon", "dbus-broker",
    "ollama", "journalctl", "systemctl", "systemd-run", "agetty", "login",
}
NEVER_ARGV_SUBSTR = (
    os.path.join(ROOT, "dist", "index.js"),   # dashboard of this install
    "/.local/bin/claude",              # agent sessions
    "@anthropic-ai/claude-code",
    "claude-plugins-official",         # channel plugins (bun)
    "scripts/channels.sh",
    "marveen-channels",
    "marveen-dashboard",
    "ram-emergency-brake.py",          # this brake
    "heavy-job.py",                    # the gate process (its job is killable)
    "/usr/lib/systemd/",
)
NEVER_CGROUP_SUBSTR = (
    "/marveen-dashboard.service",
    "/marveen-channels.service",
    "/marveen-ram-emergency-brake.service",
    "/init.scope",
    "/dbus.service",
)

# ---- allowlist of killable heavy jobs ----------------------------------------
KILL_COMM = {
    "ffmpeg", "ffprobe", "ffplay", "melt", "x264", "x265", "magick", "convert",
    "gs", "remotion", "vips",
}
BROWSER_COMM = {"chrome", "chromium", "chromium-browse", "chromium-browser",
                "headless_shell", "chrome-headless"}
NODE_HEAVY_RE = re.compile(
    r"(vitest|/jest|\bjest\b|/tsc\b|\btsc\b|remotion|render\.mjs|playwright test|"
    r"@playwright/test|vite build|\bwebpack\b)")
_SCRIPT_NAME_RE = re.compile(r"^[^/\0]+$")


class ConfigError(ValueError):
    pass


def load_config(path, root=ROOT):
    """The python-script allowlist from the optional JSON config. Shape:

      {"python_scripts": [
         {"dir": "agents/video", "scripts": ["render.py", "batch.py"]},
         {"dir": "agents/video/scripts", "scripts": "*"}
      ]}

    "dir" is relative to the install root (or absolute); "scripts" lists the
    basenames killable anywhere under that directory, or "*" for any python
    script under it. Returns a tuple of (normalized dir, frozenset of names or
    None for "*"). A missing file is an empty allowlist. A file that exists but
    is unreadable or malformed raises ConfigError: the caller then runs with
    the generic classes only (fewer kills, never more)."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return ()
    except (OSError, ValueError) as e:
        raise ConfigError("cannot read %s: %s" % (path, e))
    if not isinstance(raw, dict):
        raise ConfigError("top level must be an object")
    unknown = sorted(set(raw) - {"python_scripts"})
    if unknown:
        raise ConfigError("unknown key(s): %s" % ", ".join(unknown))
    entries = raw.get("python_scripts", [])
    if not isinstance(entries, list):
        raise ConfigError("python_scripts must be a list")
    out = []
    for i, e in enumerate(entries):
        if not isinstance(e, dict) or set(e) != {"dir", "scripts"}:
            raise ConfigError("python_scripts[%d] must be {\"dir\": ..., \"scripts\": ...}" % i)
        d, names = e["dir"], e["scripts"]
        if not isinstance(d, str) or not d.strip():
            raise ConfigError("python_scripts[%d].dir must be a non-empty string" % i)
        d = os.path.normpath(os.path.join(root, d))
        if d == os.sep:
            raise ConfigError("python_scripts[%d].dir must not be the filesystem root" % i)
        if names == "*":
            out.append((d, None))
            continue
        if (not isinstance(names, list) or not names
                or not all(isinstance(n, str) and _SCRIPT_NAME_RE.match(n) for n in names)):
            raise ConfigError("python_scripts[%d].scripts must be \"*\" or a non-empty list of "
                              "file names (no '/')" % i)
        out.append((d, frozenset(names)))
    return tuple(out)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


# ---- readers ------------------------------------------------------------------
def read_meminfo(path="/proc/meminfo"):
    d = {}
    with open(path) as f:
        for line in f:
            k, _, v = line.partition(":")
            try:
                d[k] = int(v.strip().split()[0])
            except (ValueError, IndexError):
                pass
    # A missing MemAvailable must NOT read as 0 MB: that would look like an
    # emergency and trigger kills. It is a read error; the caller takes no action.
    if "MemAvailable" not in d:
        raise ValueError("MemAvailable missing from %s" % path)
    return {"avail_mb": d["MemAvailable"] // 1024,
            "total_mb": d.get("MemTotal", 0) // 1024,
            "swap_free_mb": d.get("SwapFree", 0) // 1024}


def read_psi_full(path="/proc/pressure/memory"):
    try:
        with open(path) as f:
            for line in f:
                if line.startswith("full"):
                    for part in line.split():
                        if part.startswith("avg10="):
                            return float(part[6:])
    except (OSError, ValueError):
        return None
    return None


def _read(path, binary=False):
    try:
        with open(path, "rb" if binary else "r") as f:
            return f.read()
    except OSError:
        return None


def read_proc(proc_root, pid):
    """One process record, or None if it vanished / is a kernel thread."""
    base = os.path.join(proc_root, str(pid))
    status = _read(os.path.join(base, "status"))
    if status is None:
        return None
    name, rss_kb, uid = None, 0, None
    for line in status.splitlines():
        if line.startswith("Name:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("VmRSS:"):
            try:
                rss_kb = int(line.split()[1])
            except (ValueError, IndexError):
                rss_kb = 0
        elif line.startswith("Uid:"):
            try:
                uid = int(line.split()[1])
            except (ValueError, IndexError):
                uid = None
    raw = _read(os.path.join(base, "cmdline"), binary=True) or b""
    argv = [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]
    if not argv:  # kernel thread or zombie
        return None
    cg = ""
    cgtext = _read(os.path.join(base, "cgroup")) or ""
    for line in cgtext.splitlines():
        if line.startswith("0::"):
            cg = line[3:].strip()
    try:
        cwd = os.readlink(os.path.join(base, "cwd"))
    except OSError:
        cwd = ""
    return {"pid": pid, "name": name or "", "rss_mb": rss_kb // 1024, "uid": uid,
            "argv": argv, "cgroup": cg, "cwd": cwd, "start": read_start(proc_root, pid)}


def read_start(proc_root, pid):
    """The process start time (/proc/<pid>/stat field 22), or None if the
    process is gone, a zombie, or the file cannot be parsed. pid + start time
    is the process identity: a reused pid has another start time."""
    st = _read(os.path.join(proc_root, str(pid), "stat"))
    try:
        rest = st.rsplit(")", 1)[1].split()
        return None if rest[0] in ("Z", "X") else rest[19]
    except (AttributeError, IndexError):
        return None


def list_processes(proc_root="/proc"):
    out = []
    try:
        names = os.listdir(proc_root)
    except OSError:
        return out
    for n in names:
        if n.isdigit():
            p = read_proc(proc_root, int(n))
            if p:
                out.append(p)
    return out


# ---- classification -------------------------------------------------------------
def never_kill_reason(p, protected_pids=()):
    if p["pid"] <= 1 or p["pid"] in protected_pids:
        return "protected_pid"
    name = p["name"]
    if name in NEVER_COMM or name.startswith("tmux"):
        return "comm:" + name
    arg0 = os.path.basename(p["argv"][0]) if p["argv"] else ""
    if arg0 in NEVER_COMM or arg0 == "claude":
        return "argv0:" + arg0
    joined = " ".join(p["argv"])
    for s in NEVER_ARGV_SUBSTR:
        if s in joined:
            return "argv:" + s
    for s in NEVER_CGROUP_SUBSTR:
        if s in p["cgroup"]:
            return "cgroup:" + s.strip("/")
    return None


def in_scope(p):
    """Inside a transient scope of the heavy-job gate (<...>/heavy-job-<id>.scope)."""
    return any(c.startswith(SCOPE_MARK) and c.endswith(".scope") for c in p["cgroup"].split("/"))


_PY_OPTS_WITH_ARG = ("-X", "-W", "--check-hash-based-pycs")


def _python_script(p):
    """Normalized absolute script path of a python process, or None (-c, -m, stdin,
    unresolvable). Interpreter options are skipped, including the ones that take an
    argument (-X utf8, -W ignore, attached -Xutf8) and flag clusters (-uO, -OO)."""
    argv = p["argv"]
    i = 1
    script = None
    while i < len(argv):
        a = argv[i]
        if a == "--":
            script = argv[i + 1] if i + 1 < len(argv) else None
            break
        if a == "-":
            return None                       # program from stdin
        if a in _PY_OPTS_WITH_ARG:
            i += 2
            continue
        if a.startswith("--"):
            i += 1                            # other long options take no argument
            continue
        if a.startswith("-"):
            cluster = a[1:]
            skip_next = False
            for j, ch in enumerate(cluster):
                if ch in "cm":
                    return None               # -c command / -m module: no script file
                if ch in "XW":
                    skip_next = (j == len(cluster) - 1)   # arg attached or separate
                    break
            i += 2 if skip_next else 1
            continue
        script = a
        break
    if not script:
        return None
    if not os.path.isabs(script):
        if not p["cwd"]:
            return None                       # cannot resolve -> not provably ours
        script = os.path.join(p["cwd"], script)
    return os.path.normpath(script)


def _heavy_python(script, python_allow):
    """True if the normalized script path is listed in the config allowlist:
    under an entry's dir, with a listed basename (or any name for "*")."""
    base = os.path.basename(script)
    for d, names in python_allow:
        if script.startswith(d + os.sep) and (names is None or base in names):
            return True
    return False


def killable_reason(p, python_allow=()):
    """Why p is on the heavy-job allowlist, or None. Never-kill is checked elsewhere.
    python_allow: the config allowlist (load_config); empty = no python process
    is killable."""
    name = p["name"]
    arg0 = os.path.basename(p["argv"][0]) if p["argv"] else ""
    joined = " ".join(p["argv"])
    if name in KILL_COMM or arg0 in KILL_COMM:
        return "heavy:" + (name if name in KILL_COMM else arg0)
    if name in BROWSER_COMM or arg0 in BROWSER_COMM:
        if "--headless" in joined or "ms-playwright" in joined or "headless_shell" in joined:
            return "headless-browser"
        return None
    if name.startswith("python") or arg0.startswith("python"):
        script = _python_script(p)
        if script and _heavy_python(script, python_allow):
            return "python-heavy:" + os.path.basename(script)
        return None
    if name in ("node", "npm", "npx") or arg0 in ("node", "npm", "npx"):
        m = NODE_HEAVY_RE.search(joined)
        if m:
            return "node-heavy:" + m.group(1)
    return None


def select_victim(procs, my_uid, protected_pids=(), min_rss_mb=MIN_RSS_MB, skip_pids=(),
                  python_allow=()):
    """Pick the process to stop. Returns a dict with keys pid, name, rss_mb,
    reason, scope (cgroup or None), targets (pids to signal), or None.
    Preference: anything in a heavy-job scope first, then largest RSS.
    skip_pids: recently signalled pids (a dying process can linger in D state;
    re-targeting it would stall the brake on one victim)."""
    cands = []
    for p in procs:
        if my_uid is not None and p["uid"] != my_uid:
            continue
        if p["pid"] in skip_pids:
            continue
        if never_kill_reason(p, protected_pids):
            continue
        if not identifiable(p):
            continue  # no identity, so it could not be signalled safely later
        scoped = in_scope(p)
        reason = "heavy-job-scope" if scoped else killable_reason(p, python_allow)
        if not reason or p["rss_mb"] < min_rss_mb:
            continue
        cands.append((1 if scoped else 0, p["rss_mb"], p, reason))
    if not cands:
        return None
    cands.sort(key=lambda c: (c[0], c[1]), reverse=True)
    _, _, p, reason = cands[0]
    chosen = [p]
    scope = None
    if in_scope(p):
        scope = p["cgroup"]
        # stop the whole job, but never a never-kill process, and never one
        # that cannot be identified (no start time: it could not be re-checked)
        chosen = sorted((q for q in procs
                         if q["cgroup"] == scope and (my_uid is None or q["uid"] == my_uid)
                         and not never_kill_reason(q, protected_pids) and identifiable(q)),
                        key=lambda q: q["pid"])
    return {"pid": p["pid"], "name": p["name"], "rss_mb": p["rss_mb"], "reason": reason,
            "scope": scope.rsplit("/", 1)[-1] if scope else None,
            "targets": [q["pid"] for q in chosen],
            "ident": {q["pid"]: (q["start"], q["cgroup"]) for q in chosen},
            "cmd": " ".join(p["argv"])[:200]}


def identifiable(q):
    """A process record the brake can re-check later: it has a start time. (A
    process whose /proc entry cannot be read at all never becomes a record:
    list_processes() skips it.)"""
    return q.get("start") is not None


# ---- side effects: the ONE signal path ---------------------------------------
# Invariant (pinned by a static test): send_checked() is the only code that
# sends a signal to a target, and it runs the full check immediately before
# every send. The single other process-stopping call in this file is
# TelegramAlert.abort() on the brake's OWN alert child (see there). Jobs are
# never stopped through their cgroup: every kill is per target.
HAS_PIDFD = hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")


class Target:
    """One selected process. With pidfd (Linux 5.3+, Python 3.9+) the fd is
    opened right after the selection and confirmed against the selected
    identity, so a pid the kernel hands to a new process is never signalled.
    On BOTH paths send_checked() re-runs the full check before every signal:
    same start time, same cgroup, still this user's, not never-kill (a target
    that exec'd into an agent session or moved cgroup is skipped)."""

    def __init__(self, pid, start, cgroup, proc_root="/proc", protected=(), use_pidfd=HAS_PIDFD,
                 kill=None, my_uid=None):
        self.pid, self.start, self.cgroup = pid, start, cgroup
        self.proc_root, self.protected, self.kill = proc_root, protected, kill
        self.uid = os.getuid() if my_uid is None else my_uid
        self.fd = None
        self.state = None   # None | "gone" | "reused"
        if use_pidfd:
            try:
                self.fd = os.pidfd_open(pid)
            except ProcessLookupError:
                self.state = "gone"
            except OSError:
                self.fd = None   # not available here: the /proc re-check alone
            if self.fd is not None and self.check() != "same":
                # the pid already named another process when the fd was opened
                self.state = "reused"
                self.close()

    def check(self):
        """'same', 'gone' or 'reused' (another start time / cgroup / uid, or now never-kill)."""
        p = read_proc(self.proc_root, self.pid)
        if p is None or p.get("start") is None:
            return "gone"
        if (p["start"] != self.start or p["cgroup"] != self.cgroup or p["uid"] != self.uid
                or never_kill_reason(p, self.protected)):
            return "reused"
        return "same"

    def alive(self):
        if self.state:
            return False
        if self.fd is not None:
            # a pidfd becomes readable when its process exits
            poller = select.poll()
            poller.register(self.fd, select.POLLIN)
            if poller.poll(0):
                return False
        c = self.check()
        if c != "same":
            self.state = c
            return False
        return True

    def close(self):
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None


def send_checked(t, sig):
    """THE signal path: 'sent', 'gone', 'reused' or 'eperm'. The full check runs
    immediately before the send, whatever the path; anything but 'same' skips."""
    if t.state:
        return t.state
    c = t.check()
    if c != "same":
        t.state = c
        return c
    try:
        if t.fd is not None:
            signal.pidfd_send_signal(t.fd, sig)
        else:
            (t.kill or os.kill)(t.pid, sig)
        return "sent"
    except ProcessLookupError:
        t.state = "gone"
        return "gone"
    except PermissionError:
        return "eperm"


def terminate(targets, grace=TERM_GRACE_SEC, sleep=time.sleep):
    """SIGTERM every Target, wait up to grace, SIGKILL the ones still alive;
    every signal goes through send_checked().
    Returns {pid: 'term'|'kill'|'gone'|'reused'|'term_then_reused'|'eperm'}."""
    res = {}
    for t in targets:
        r = send_checked(t, signal.SIGTERM)
        res[t.pid] = "term" if r == "sent" else r
    waited = 0.0
    while waited < grace and any(res[t.pid] == "term" and t.alive() for t in targets):
        sleep(0.25)
        waited += 0.25
    for t in [t for t in targets if res[t.pid] == "term" and t.alive()]:
        r = send_checked(t, signal.SIGKILL)
        res[t.pid] = "kill" if r == "sent" else r
    for t in targets:
        if res[t.pid] == "term" and t.state == "reused":
            res[t.pid] = "term_then_reused"   # the pid moved on; no SIGKILL was sent
    return res


def kill_victim(victim, proc_root="/proc", protected=(), grace=TERM_GRACE_SEC, sleep=time.sleep,
                use_pidfd=HAS_PIDFD, kill=None, my_uid=None):
    """Pin every target to its selected identity, then terminate()."""
    targets = [Target(pid, start, cg, proc_root, protected, use_pidfd, kill, my_uid)
               for pid, (start, cg) in sorted(victim["ident"].items())]
    try:
        return terminate(targets, grace, sleep)
    finally:
        for t in targets:
            t.close()


# ---- one brake per install ------------------------------------------------------
LOCK_PATH = os.path.join(STORE, ".ram-emergency-brake.lock")


class InstanceLockError(Exception):
    def __init__(self, msg, held=False):
        Exception.__init__(self, msg)
        self.held = held


def acquire_instance_lock(path):
    """The single-instance lock: an exclusive non-blocking flock on a file opened
    with O_NOFOLLOW, created 0600, that must be a regular file owned by this
    user. Returns the fd (keep it open for the life of the process). Raises
    InstanceLockError(held=True) when another brake holds it, held=False when
    the lock file itself is unsafe or unusable."""
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError as e:
        raise InstanceLockError("cannot open the lock file %s: %s" % (path, e))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise InstanceLockError("the lock file %s is not a regular file" % path)
        if st.st_uid != os.getuid():
            raise InstanceLockError("the lock file %s is owned by uid %d, not by this user (%d)"
                                    % (path, st.st_uid, os.getuid()))
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            holder = (_read(path) or "").strip()[:40]
            raise InstanceLockError("another brake instance holds %s (%s)" % (path, holder or "pid unknown"),
                                    held=True)
        os.ftruncate(fd, 0)
        os.pwrite(fd, ("pid=%d\n" % os.getpid()).encode(), 0)
        return fd
    except BaseException:
        os.close(fd)
        raise


class Ollama:
    def __init__(self, url=OLLAMA_URL, timeout=3.0):
        self.url = url.rstrip("/")
        self.timeout = timeout

    def loaded(self):
        with urllib.request.urlopen(self.url + "/api/ps", timeout=self.timeout) as r:
            data = json.loads(r.read().decode())
        # external input: validate every level, drop anything malformed
        entries = data.get("models") if isinstance(data, dict) else None
        out = []
        for e in entries if isinstance(entries, list) else []:
            if isinstance(e, dict):
                name = e.get("name") or e.get("model")
                if isinstance(name, str) and name:
                    out.append(name)
        return out

    def unload(self, model):
        body = json.dumps({"model": model, "keep_alive": 0}).encode()
        req = urllib.request.Request(self.url + "/api/generate", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10.0) as r:
            r.read()


def read_bot_token(env_path):
    try:
        with open(env_path) as f:
            for line in f:
                if line.startswith("TELEGRAM_BOT_TOKEN="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        return ""
    return ""


# ---- owner chat: a Python mirror of scripts/lib/owner-chat.sh -------------------
# Not called through the shell lib on purpose: that lib parses access.json with
# `node -e`, and the brake runs under a small MemoryMax (see its unit) exactly
# when memory is short. The rules are the lib's (CHATID0): "0" is the installer
# placeholder, never a chat; only a SINGLE DM entry of allowFrom counts (more
# than one would be a guess); groups/channels ("-" ids) are never the owner.
def _normalize_chat(value):
    """The trimmed id, or None for empty / the "0" placeholder (_owner_chat_normalize)."""
    v = str(value).replace("\r", "").strip()
    for q in ('"', "'"):
        if v.endswith(q):
            v = v[:-1]
        if v.startswith(q):
            v = v[1:]
    return v if v and v != "0" else None


def _first_env_value(path, key):
    try:
        with open(path) as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].rstrip("\n")
    except OSError:
        return None
    return None


def channel_state_dir(root=ROOT, home=None):
    """The MAIN install's Telegram channel state dir: install-scoped when it has
    a .env, else the legacy ~/.claude/channels/telegram when that has one, else
    the install-scoped path. TELEGRAM_STATE_DIR is not honoured (a sub-agent's
    own channel carries its dir in that variable; owner-chat.sh does the same)."""
    installed = os.path.join(root, ".claude", "channels", "telegram")
    if os.path.isfile(os.path.join(installed, ".env")):
        return installed
    legacy = os.path.join(home or os.path.expanduser("~"), ".claude", "channels", "telegram")
    if os.path.isfile(os.path.join(legacy, ".env")):
        return legacy
    return installed


def resolve_owner_chat(root=ROOT, home=None, environ=None):
    """(chat id, None) or (None, reason). MARVEEN_ALERT_CHAT_ID wins when set
    (the override the other owner alerts honour); then ALLOWED_CHAT_ID in the
    install's .env; then the single DM entry of <state dir>/access.json."""
    environ = os.environ if environ is None else environ
    v = _normalize_chat(environ.get("MARVEEN_ALERT_CHAT_ID", ""))
    if v:
        return v, None
    env_file = os.path.join(root, ".env")
    if not os.path.isfile(env_file):
        return None, "no owner chat: env file not found: %s" % env_file
    v = _normalize_chat(_first_env_value(env_file, "ALLOWED_CHAT_ID") or "")
    if v:
        return v, None
    access = os.path.join(channel_state_dir(root, home), "access.json")
    try:
        with open(access, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return None, "no owner chat: .env placeholder/empty and no readable access.json"
    ids = []
    for entry in (raw.get("allowFrom") if isinstance(raw, dict) else None) or []:
        if isinstance(entry, bool) or not isinstance(entry, (str, int)):
            continue
        cid = _normalize_chat(entry)
        if cid and not cid.startswith("-") and cid not in ids:
            ids.append(cid)
    if len(ids) == 1:
        return ids[0], None
    if not ids:
        return None, "no owner chat: access.json has no DM entry (groups/channels are never used)"
    return None, "no owner chat: access.json has %d DM entries, refusing to guess" % len(ids)


def token_env_path(root=ROOT, home=None, environ=None):
    environ = os.environ if environ is None else environ
    return environ.get("TELEGRAM_ENV") or os.path.join(channel_state_dir(root, home), ".env")


class TelegramAlert:
    """Async owner alert through scripts/lib/send-telegram.sh (success only on
    curl exit 0 AND "ok":true). The token reaches the helper through the child's
    environment, and the helper keeps it out of curl's argv: it is never in an
    argv or in our log (stderr is redacted). The chat and the token file are
    resolved at every send (a pairing made after the brake started counts)."""

    def __init__(self, helper=SEND_HELPER, env_path=None, chat_id=None, root=ROOT, home=None):
        self.helper = helper
        self.env_path = env_path
        self.chat_id = chat_id
        self.root = root
        self.home = home
        self.proc = None
        self.token = ""

    def start(self, text):
        """Returns None if started, "busy" if a previous send is still running (it is
        never overwritten or orphaned), or a string naming what is missing."""
        if self.proc is not None and self.proc.poll() is None:
            return "busy"
        token = read_bot_token(self.env_path or token_env_path(self.root, self.home))
        if self.chat_id is not None:
            chat, why = (self.chat_id or None), "no owner chat: empty chat id"
        else:
            chat, why = resolve_owner_chat(self.root, self.home)
        miss = []
        if not token:
            miss.append("TELEGRAM_BOT_TOKEN")
        if not chat:
            miss.append("owner chat id (%s)" % why)
        if miss:
            return "missing:" + ",".join(miss)
        self.token = token
        env = dict(os.environ, TG_TOKEN=token, TG_CHAT=chat, TG_TEXT=text,
                   TG_HELPER=self.helper)
        self.proc = subprocess.Popen(
            ["bash", "-c", '. "$TG_HELPER" && send_telegram_message "$TG_TOKEN" "$TG_CHAT" "$TG_TEXT"'],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return None

    def abort(self):
        """Stop a send that overran ALERT_SEND_TIMEOUT_SEC (never leave it orphaned).
        THE ONE EXCEPTION to the single signal path: this kills the brake's OWN
        alert child (a Popen it started and still holds, so no pid reuse is
        possible), never a selected target. Pinned by the static test."""
        if self.proc is not None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:
                pass
            self.proc = None

    def poll(self):
        """None while running; (ok, stderr_redacted) when done."""
        if self.proc is None or self.proc.poll() is None:
            return None
        _, err = self.proc.communicate()
        ok = self.proc.returncode == 0
        text = (err or b"").decode("utf-8", "replace")
        if self.token:
            text = text.replace(self.token, "<token>")
        self.proc = None
        return ok, text.strip()[:500]


# ---- the brake ------------------------------------------------------------------
class Brake:
    def __init__(self, dry_run=False, log_path=LOG_PATH, meminfo_path="/proc/meminfo",
                 psi_path="/proc/pressure/memory", proc_root="/proc", ollama=None,
                 alert=None, killer=None, clock=time.monotonic, my_uid=None,
                 protected_pids=None, simulate_avail_mb=None, log_samples=False,
                 echo=True, python_allow=()):
        self.dry_run = dry_run
        self.python_allow = tuple(python_allow)
        self.log_path = log_path
        self.meminfo_path = meminfo_path
        self.psi_path = psi_path
        self.proc_root = proc_root
        self.ollama = ollama if ollama is not None else Ollama()
        self.alert = alert if alert is not None else TelegramAlert()
        self.killer = killer if killer is not None else (
            lambda victim: kill_victim(victim, self.proc_root, self.protected, my_uid=self.my_uid))
        self.clock = clock
        self.my_uid = os.getuid() if my_uid is None else my_uid
        self.protected = set(protected_pids if protected_pids is not None
                             else (os.getpid(), os.getppid()))
        self.simulate_avail_mb = simulate_avail_mb
        self.log_samples = log_samples
        self.echo = echo
        # state
        self.consec = 0
        self.meminfo_failing = False
        self.recover = 0
        self.incident = False
        self.incident_actions = []
        self.incident_min_mb = None
        self.next_action_at = 0.0
        self.last_ollama_try = -1e9
        self.kill_times = []
        self.recent_kills = {}   # pid -> time signalled
        self.no_candidate_logged = False
        self.act_error_recorded = False
        # Alert lifecycle, independent of the incident: once "pending" it is driven
        # every step (also after incident_end) until a TERMINAL, logged state:
        # "done" (alert_sent / alert_suppressed_cooldown / would_alert) or "gave_up"
        # (alert_gave_up). Non-terminal: "pending", "sending".
        self.alert_state = "idle"   # idle | pending | sending | done | gave_up
        self.alert_attempts = 0
        self.alert_last_try = -1e9
        self.alert_send_started = 0.0
        self.alert_actions = []
        self.alert_min_mb = None
        self.last_alert_ok = -1e9
        self.low = False
        self.last_heartbeat = clock()
        self.hb_min_mb = None

    def log(self, rec):
        rec = dict({"ts": now_iso(), "dry_run": self.dry_run}, **rec)
        line = json.dumps(rec, ensure_ascii=False)
        try:
            with open(self.log_path, "a") as f:
                f.write(line + "\n")
        except OSError:
            pass
        if self.echo:
            print(line, flush=True)

    # one poll cycle
    def step(self):
        now = self.clock()
        try:
            mem = read_meminfo(self.meminfo_path)
        except (OSError, ValueError) as e:
            # no reading = no evidence of an emergency: no action, and the
            # confirmation streak restarts. Logged once per error streak.
            self.consec = 0
            if not self.meminfo_failing:
                self.log({"event": "meminfo_error", "error": str(e)[:200]})
            self.meminfo_failing = True
            return
        if self.meminfo_failing:
            self.meminfo_failing = False
            self.log({"event": "meminfo_ok"})
        if self.simulate_avail_mb is not None:
            mem["avail_mb"] = self.simulate_avail_mb
        avail = mem["avail_mb"]
        psi = read_psi_full(self.psi_path)
        crit = avail < CRIT_MB or (psi is not None and psi >= PSI_FULL_CRIT and avail < PSI_AVAIL_MB)
        self.hb_min_mb = avail if self.hb_min_mb is None else min(self.hb_min_mb, avail)
        if self.log_samples:
            self.log({"event": "sample", "mem_avail_mb": avail, "mem_total_mb": mem["total_mb"],
                      "swap_free_mb": mem["swap_free_mb"], "psi_full_avg10": psi, "critical": crit})

        try:
            # low-memory transitions (diagnostics only)
            if not self.low and avail < WARN_MB:
                self.low = True
                self.log({"event": "low_enter", "mem_avail_mb": avail, "psi_full_avg10": psi})
            elif self.low and avail >= WARN_MB + 200:
                self.low = False
                self.log({"event": "low_exit", "mem_avail_mb": avail})

            self.consec = self.consec + 1 if crit else 0
            if not self.incident and self.consec >= CONFIRM_SAMPLES:
                self.incident = True
                self.recover = 0
                self.incident_actions = []
                self.incident_min_mb = avail
                self.no_candidate_logged = False
                self.act_error_recorded = False
                self.last_ollama_try = -1e9
                if self.alert_state in ("pending", "sending"):
                    # an earlier alert is still in flight or waiting for a retry: never
                    # overwrite it; this incident's actions are added to that alert
                    self.alert_min_mb = min(self.alert_min_mb, avail)
                    self.log({"event": "alert_carried", "alert_state": self.alert_state,
                              "attempts": self.alert_attempts})
                else:
                    self.alert_state = "pending"
                    self.alert_attempts = 0
                    self.alert_last_try = -1e9
                    self.alert_actions = []
                    self.alert_min_mb = avail
                self.log({"event": "incident_start", "mem_avail_mb": avail,
                          "mem_total_mb": mem["total_mb"], "swap_free_mb": mem["swap_free_mb"],
                          "psi_full_avg10": psi})

            if self.incident:
                self.incident_min_mb = min(self.incident_min_mb, avail)
                if self.alert_state in ("pending", "sending"):
                    self.alert_min_mb = min(self.alert_min_mb, avail)
                if crit:
                    self.recover = 0
                    if now >= self.next_action_at:
                        try:
                            self.act(now, avail)
                        except Exception as e:
                            # the alert must still say something happened: record the
                            # failure once per incident, so handle_alert (which waits
                            # for a first action) is not blocked forever by a raising act()
                            if not self.act_error_recorded:
                                self.act_error_recorded = True
                                self._record("a beavatkozás hibára futott (%s)" % type(e).__name__)
                            raise
                elif avail >= RECOVER_MB:
                    self.recover += 1
                    if self.recover >= RECOVER_SAMPLES:
                        self.log({"event": "incident_end", "mem_avail_mb": avail,
                                  "min_mb": self.incident_min_mb, "actions": self.incident_actions})
                        self.incident = False
                        self.consec = 0
                else:
                    self.recover = 0
        finally:
            # the alert is driven every step, incident or not, until it is terminal,
            # also when something above (e.g. act()) raised
            self.poll_alert(now)
            self.handle_alert(now, avail, mem["total_mb"])

        if now - self.last_heartbeat >= HEARTBEAT_SEC:
            self.log({"event": "heartbeat", "mem_avail_mb": avail, "min_mb": self.hb_min_mb,
                      "psi_full_avg10": psi})
            self.last_heartbeat = now
            self.hb_min_mb = None

    def act(self, now, avail):
        # 1. ollama models first: cheap, nothing is lost
        if now - self.last_ollama_try >= OLLAMA_RETRY_SEC:
            self.last_ollama_try = now
            try:
                models = [m for m in self.ollama.loaded() if m]
            except (OSError, ValueError, urllib.error.URLError) as e:
                models = []
                self.log({"event": "ollama_error", "error": str(e)[:200]})
            if models:
                done = []
                for m in models:
                    if self.dry_run:
                        done.append(m)
                        continue
                    try:
                        self.ollama.unload(m)
                        done.append(m)
                    except (OSError, ValueError, urllib.error.URLError) as e:
                        self.log({"event": "ollama_error", "model": m, "error": str(e)[:200]})
                if done:
                    self.log({"event": "would_unload" if self.dry_run else "ollama_unload",
                              "models": done, "mem_avail_mb": avail})
                    self._record("ollama modell kiürítve: " + ", ".join(done))
                    self.next_action_at = now + 3.0
                    return
        # 2. kill the heaviest allowlisted job
        self.kill_times = [t for t in self.kill_times if now - t < KILL_WINDOW_SEC]
        if len(self.kill_times) >= KILL_WINDOW_MAX:
            if not self.no_candidate_logged:
                self.log({"event": "rate_limited", "kills_in_window": len(self.kill_times)})
                self.no_candidate_logged = True
            return
        self.recent_kills = {p: t for p, t in self.recent_kills.items() if now - t < 60.0}
        victim = select_victim(list_processes(self.proc_root), self.my_uid, self.protected,
                               skip_pids=set(self.recent_kills), python_allow=self.python_allow)
        if victim is None:
            if not self.no_candidate_logged:
                self.log({"event": "no_candidate", "mem_avail_mb": avail})
                self._record("nem volt leállítható nehéz folyamat")
                self.no_candidate_logged = True
            self.next_action_at = now + ACTION_COOLDOWN_SEC
            return
        self.no_candidate_logged = False
        rec = {"event": "would_kill" if self.dry_run else "kill", "mem_avail_mb": avail}
        rec.update({k: v for k, v in victim.items() if k != "ident"})
        if not self.dry_run:
            rec["result"] = {str(k): v for k, v in self.killer(victim).items()}
        self.log(rec)
        self.kill_times.append(now)
        for pid in victim["targets"]:
            self.recent_kills[pid] = now
        where = ", heavy-job scope" if victim["scope"] else ""
        self._record("leállítva: %s [%s] (PID %d, %d MB%s)"
                     % (victim["name"], victim["reason"], victim["pid"], victim["rss_mb"], where))
        self.next_action_at = now + ACTION_COOLDOWN_SEC

    def _record(self, text):
        self.incident_actions.append(text)
        if self.alert_state in ("pending", "sending"):
            self.alert_actions.append(text)

    def alert_text(self, avail, total):
        acts = ("; ".join(self.alert_actions) if self.alert_actions
                else "nem kellett beavatkozni, a memória magától visszajött")
        return ("Marveen RAM-vészfék: a szabad memória %d MB-ra esett (%d MB-ból, a küszöb %d MB). "
                "Tett: %s. A vészfék figyel tovább, a napló: store/ram-emergency-brake-log.jsonl"
                % (self.alert_min_mb if self.alert_min_mb is not None else avail,
                   total, CRIT_MB, acts))

    def _alert_failed(self, now, reason):
        """One attempt failed. Retry later, or give up (terminal, logged) at the budget."""
        if self.alert_attempts >= ALERT_MAX_ATTEMPTS:
            self.alert_state = "gave_up"
            self.log({"event": "alert_gave_up", "attempts": self.alert_attempts,
                      "error": str(reason)[:300]})
        else:
            self.alert_state = "pending"

    def handle_alert(self, now, avail, total):
        if self.alert_state != "pending":
            return
        # during the incident wait for the first recorded action, so the text says
        # what was done; once the incident is over, send whatever there is
        if self.incident and not self.alert_actions:
            return
        if now - self.last_alert_ok < ALERT_COOLDOWN_SEC:
            self.log({"event": "alert_suppressed_cooldown"})
            self.alert_state = "done"
            return
        if now - self.alert_last_try < ALERT_RETRY_SEC:
            return
        text = self.alert_text(avail, total)
        self.alert_last_try = now
        self.alert_attempts += 1          # every start() call counts, exactly once
        if self.dry_run:
            self.log({"event": "would_alert", "text": "[DRY-RUN, semmi nem történt] " + text})
            self.alert_state = "done"
            return
        try:
            miss = self.alert.start(text)
        except Exception as e:
            self.log({"event": "alert_error", "attempt": self.alert_attempts,
                      "error": "%s: %s" % (type(e).__name__, str(e)[:200])})
            self._alert_failed(now, e)
            return
        if miss == "busy":
            self.log({"event": "alert_busy", "attempt": self.alert_attempts})
            self._alert_failed(now, "busy")
            return
        if miss:
            # configuration is missing: retrying cannot help -> terminal, logged
            self.log({"event": "alert_not_sent", "error": miss})
            self.alert_state = "gave_up"
            self.log({"event": "alert_gave_up", "attempts": self.alert_attempts, "error": miss})
            return
        self.alert_state = "sending"
        self.alert_send_started = now

    def poll_alert(self, now):
        if self.alert_state != "sending":
            return
        try:
            res = self.alert.poll()
        except Exception as e:
            self.log({"event": "alert_error", "attempt": self.alert_attempts,
                      "error": "%s: %s" % (type(e).__name__, str(e)[:200])})
            self._alert_failed(now, e)
            return
        if res is None:
            if now - self.alert_send_started >= ALERT_SEND_TIMEOUT_SEC:
                abort = getattr(self.alert, "abort", None)
                if abort:
                    abort()
                self.log({"event": "alert_timeout", "attempt": self.alert_attempts})
                self._alert_failed(now, "timeout")
            return
        ok, err = res
        if ok:
            self.last_alert_ok = now
            self.alert_state = "done"
            self.log({"event": "alert_sent", "attempt": self.alert_attempts})
        else:
            self.log({"event": "alert_failed", "error": err, "attempt": self.alert_attempts})
            self._alert_failed(now, err)


def try_mlock():
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        rc = libc.mlockall(1 | 2)  # MCL_CURRENT | MCL_FUTURE
        if rc != 0:
            return "failed errno=%d" % ctypes.get_errno()
        return "ok"
    except (OSError, AttributeError) as e:
        return "failed %s" % e


LOOP_ERROR_LOG_SEC = 60.0


def safe_step(brake, errstate):
    """One brake.step() that cannot kill the loop. An unexpected exception is
    logged as 'loop_error' (at most once per LOOP_ERROR_LOG_SEC, with the count of
    suppressed ones); the Brake object keeps its incident, kill_times and alert
    state, so the next cycle continues where this one failed."""
    try:
        brake.step()
        return True
    except Exception as e:  # deliberately broad: the brake must outlive its own bugs
        errstate["count"] = errstate.get("count", 0) + 1
        now = brake.clock()
        if now - errstate.get("last_log", -1e9) >= LOOP_ERROR_LOG_SEC:
            brake.log({"event": "loop_error", "error": "%s: %s" % (type(e).__name__, str(e)[:200]),
                       "errors_since_last_log": errstate["count"]})
            errstate["last_log"] = now
            errstate["count"] = 0
        return False


def run_loop(brake, cycles, stop, poll_sec=POLL_SEC, sleep=time.sleep):
    errstate = {}
    n = 0
    while not stop:
        safe_step(brake, errstate)
        n += 1
        if cycles and n >= cycles:
            break
        t_end = time.monotonic() + poll_sec
        while not stop and time.monotonic() < t_end:
            sleep(min(0.5, max(0.0, t_end - time.monotonic())))
    return n


def platform_name():
    """sys.platform, or RAM_BRAKE_PLATFORM (a test hook for the non-Linux path)."""
    return os.environ.get("RAM_BRAKE_PLATFORM") or sys.platform


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="RAM emergency brake (Linux only): unload ollama models, then stop the "
                    "heaviest allowlisted job when MemAvailable stays critical.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--cycles", type=int, default=0)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--simulate-avail-mb", type=int, default=None)
    ap.add_argument("--log-samples", action="store_true")
    ap.add_argument("--no-mlock", action="store_true")
    ap.add_argument("--config", default=CONFIG_PATH,
                    help="python-script allowlist (JSON, optional; default: %(default)s)")
    a = ap.parse_args(argv)
    plat = platform_name()
    if not plat.startswith("linux"):
        # /proc/meminfo, /proc/<pid>/ and PSI are the brake's whole input
        print("ram-emergency-brake: Linux only (/proc/meminfo, /proc/<pid>, memory PSI); "
              "platform %r is not supported, nothing to do. Exiting." % plat, file=sys.stderr)
        return 0
    if a.simulate_avail_mb is not None and not a.dry_run:
        # a simulated emergency must never drive real kills
        print("ram-emergency-brake: --simulate-avail-mb requires --dry-run (refused, nothing done)",
              file=sys.stderr)
        return 2
    cycles = 1 if a.once else a.cycles
    lock_fd = None   # held open (and flocked) until the process exits
    if not a.dry_run:
        # one acting brake per install (a dry run acts on nothing and may run beside it)
        lock = os.environ.get("RAM_BRAKE_LOCK") or LOCK_PATH
        try:
            lock_fd = acquire_instance_lock(lock)
        except InstanceLockError as e:
            print("ram-emergency-brake: refused to start: %s" % e, file=sys.stderr)
            return 3 if e.held else 4

    stop = []
    signal.signal(signal.SIGTERM, lambda s, f: stop.append(s))
    signal.signal(signal.SIGINT, lambda s, f: stop.append(s))

    config_error = None
    try:
        python_allow = load_config(a.config)
    except ConfigError as e:
        python_allow, config_error = (), str(e)
        print("ram-emergency-brake: config ignored, generic classes only: %s" % e, file=sys.stderr)
    brake = Brake(dry_run=a.dry_run, simulate_avail_mb=a.simulate_avail_mb,
                  log_samples=a.log_samples or cycles > 0, python_allow=python_allow)
    if config_error:
        brake.log({"event": "config_error", "config": a.config, "error": config_error[:300]})
    mlock = "skipped" if (a.no_mlock or cycles > 0) else try_mlock()
    chat, chat_why = resolve_owner_chat()
    brake.log({"event": "start", "pid": os.getpid(), "crit_mb": CRIT_MB,
               "confirm_samples": CONFIRM_SAMPLES, "poll_sec": POLL_SEC,
               "psi_full_crit": PSI_FULL_CRIT, "mlock": mlock,
               "oom_score_adj": (_read("/proc/self/oom_score_adj") or "").strip(),
               "python_allow_entries": len(python_allow),
               "alert_chat_resolved": bool(chat), "alert_chat_reason": chat_why})
    n = run_loop(brake, cycles, stop)
    # let a pending alert finish before exiting (bounded)
    t_end = time.monotonic() + 20
    while brake.alert_state == "sending" and time.monotonic() < t_end:
        brake.poll_alert(brake.clock())
        time.sleep(0.2)
    if brake.alert_state in ("pending", "sending"):
        # never drop an alert silently
        brake.log({"event": "alert_unfinished_at_stop", "alert_state": brake.alert_state,
                   "attempts": brake.alert_attempts})
    brake.log({"event": "stop", "cycles": n})
    return 0


if __name__ == "__main__":
    sys.exit(main())
