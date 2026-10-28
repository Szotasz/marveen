#!/usr/bin/env python3
"""Admission gate for heavy jobs (video render, ffmpeg encode, local LLM batch,
full test suite, TypeScript build, headless browser test). Opt-in: nothing in
Marveen calls it on its own; an agent or a script wraps a heavy command in it.
Linux only (it reads /proc/meminfo and uses a systemd --user scope).

Usage:
  heavy-job-gate.sh [--min-mb N] [--max-mem 2G] [--swap-max 256M]
                    [--wait-sec S] [--label TEXT] [--allow-uncapped]
                    [--max-sec N] [--agent NAME] -- <command...>

What it does, in order:
  1. Takes a GLOBAL exclusive flock, so only ONE heavy job runs at a time,
     in arrival order (FIFO ticket queue, see below; the fairness and
     short-lane rules change only who takes the lock next).
  2. Waits until MemAvailable >= the admission floor. The floor is
     max(--min-mb, cap + reserve): a job may only start if its worst case
     (its whole memory cap) still leaves the reserve for the rest of the host.
  3. Runs the command inside a transient user scope:
       systemd-run --user --scope --collect -p MemoryMax=<cap>M
                   -p MemorySwapMax=<swap>M
     (both normalized to MB; a bare number on the command line means MB)
     so a runaway job is OOM-killed inside its own cgroup, not the host.
  4. When the command's main process ends, stops the WHOLE scope
     (systemctl --user stop; the scope has TimeoutStopSec=5s, so a descendant
     that ignores SIGTERM is SIGKILLed) and verifies that its cgroup is empty
     (bounded wait, cgroup.kill as the last resort). No descendant outlives the
     job; one that still does is logged (finish line scope_stop=leftover) and warned.
  5. Propagates the command's exit code (signal death -> 128 + signo).
  6. Appends start / wait / refuse / finish lines (JSON, one per line) to the
     log, store/heavy-job-log.jsonl by default.

Configuration (environment; a command-line flag wins over its variable):
  HEAVY_JOB_STORE       directory of the lock, the queue and the log
                        (default: <install root>/store)
  HEAVY_JOB_MIN_MB      default --min-mb   (2500)
  HEAVY_JOB_MAX_MEM     default --max-mem  (2G)
  HEAVY_JOB_SWAP_MAX    default --swap-max (256M)
  HEAVY_JOB_WAIT_SEC    default --wait-sec (300)
  HEAVY_JOB_RESERVE_MB  the reserve in the floor (500)
  HEAVY_JOB_AGENT       default --agent (fairness tag, see below)
  HEAVY_JOB_OLLAMA_UNLOAD=1  unload idle ollama models once when memory is
                        short at admission (off by default, see below)
An invalid value is a usage error (64), like the same value as a flag.

The lock fd is NOT inherited by the job: only the gate process holds the lock,
so it is released when the gate ends, whatever the job's descendants do.

While the job runs, SIGTERM/SIGINT/SIGHUP sent to the gate are forwarded to it
(finish line "forwarded_signals"). A signal the gate inherited as ignored (nohup,
setsid + SIG_IGN) is neither handled nor forwarded, and the job inherits the
ignore, so such a job survives e.g. a hangup of its launching session.

FIFO queue in front of the lock. On admission every (non-nested) call creates a
ticket atomically (temp file + rename) in the queue directory next to the lock
(store/.heavy-job-queue/), named <time_ns, 20 digits>-<pid, 10 digits>.ticket
so that the names sort by arrival; the content is JSON {pid, start, label,
created, fair, and agent / max_sec when given} (start = the process start time
from /proc/<pid>/stat). A waiter may try the flock ONLY while no LIVE ticket is
ahead of it. "Ahead" is arrival order (FIFO), changed by exactly two rules: the
fairness deferral and the short lane (both below). This holds for the very
first attempt too, so a late arrival never barges in when the lock happens to
be free while a job that is ahead of it is still queued. A ticket is stale, and
is ignored and removed by whoever sees it, when it is unreadable or its owner is
gone (pid dead or zombie, or the pid now belongs to a process with a different
start time), so a crashed waiter never blocks the queue. The own ticket is
removed as soon as the lock is taken, and on every other way out of the queue:
timeout (73), refusal, exception, and SIGTERM/SIGINT/SIGHUP while queued (exit
128 + signo, "refuse" line with reason=signal). A signal the caller inherited as
ignored (nohup, setsid + SIG_IGN) stays ignored while queued. A ticket that
exists but cannot be read right now (EIO, EMFILE, EACCES) is not deleted: it is
judged by the pid in its name. A waiter whose --wait-sec runs out loses its
place. The "wait" and lock-timeout "refuse" lines carry the queue position
("queue_pos", 1 = next) and the labels ahead ("ahead", sanitized: whitespace
collapsed, non-printables replaced, at most 100 characters).
They also carry, as measurement only, MemAvailable at that moment
("mem_avail_mb") and the lock holder's live scope memory and cap
("holder_mem_mb", "holder_max_mb"; None when unreadable or uncapped).
If the queue cannot be used (the ticket cannot be created, the queue directory
cannot be listed, the lock record that holds the short-lane counter cannot be
read, or the own ticket vanished and cannot be re-created) the gate fails
closed: exit 74, "refuse" line with reason=queue_io_error.

Known limits: ordering uses the wall clock (time_ns), so a backward clock step
can let a later arrival sort before an earlier one. A waiter that is stopped
(state T, e.g. SIGSTOP) while at the head of the queue is still alive, so it
blocks everyone behind it until its own --wait-sec deadline or until it is
continued or killed.

Lock and memory waits share ONE deadline (--wait-sec).

Runtime ceiling (--max-sec N, optional): counted from the job's start (after
the lock and memory waits, which --wait-sec bounds). When the job is still
running after N seconds, the gate stops the WHOLE scope (the same teardown as
at a normal end: SIGTERM, SIGKILL after TimeoutStopSec, cgroup.kill as the last
resort), also sends SIGTERM to the main process and SIGKILL after
KILL_GRACE_SEC if it is still there, and exits 76 whatever the killed job's own
code was. The finish line says so: max_sec_exceeded=true, max_sec, killed_exit
(the code the killed main process ended with). Without --max-sec nothing
changes: no ceiling. Under --allow-uncapped there is no scope, so only the main
process is signalled (its descendants are not torn down, as at a normal end).

Fairness (--agent NAME, or HEAVY_JOB_AGENT; optional): the same agent must not
take the lock back-to-back while another job is waiting. A tagged call writes
agent=NAME into the lock record and its ticket. While the lock record (it
outlives the job) names agent X -- X's job is running or was the last to run --
every queued ticket tagged X is DEFERRED: the waiting tickets that are not
deferred go first, in arrival order, then the deferred ones, in arrival order.
So when X's job ends, the oldest waiting job of anyone else runs next, then X's
next one. A deferred ticket yields only to tickets that know this rule (their
content carries "fair": 1, written by every gate of this version), so a waiter
started by an older gate version is never yielded to and cannot deadlock
against a deferred ticket. Untagged calls are never deferred; when no call is
tagged and no short ticket waits, the order is plain FIFO.
A verified nested call ignores both flags: it takes no ticket and runs inside
the outer job, under the outer job's ceiling.

Short lane: a call with --max-sec N, N <= SHORT_MAX_SEC (300), is short. Within
the same fairness class, the waiting short tickets go before the long ones,
among themselves in arrival order (still one job at a time: this changes only
who takes the lock next). Starvation bound: the lock record counts the short
jobs in a row that passed the oldest waiting long ticket (short_streak=<n>
short_passed=<its place>). Only a job that actually starts (past the memory
floor) changes the count: a long one resets it, a short one that passed that
ticket adds one, a short one that passed nobody keeps it. Once
SHORT_OVERTAKE_MAX (3) did, the lane is closed while that ticket waits, so it
goes next. The ceiling makes the claim honest: a "short" job still running
after N seconds is stopped (76). Short lines carry "short": true; a start line
that passed long tickets carries "passed" (their labels) and "short_streak".
The queue reads the lock record strictly: one that exists but cannot be read
is a queue_io_error (74); a malformed counter closes the lane (plain order).

Exit codes of the gate itself (the command's own code is passed through):
  64  usage error
  73  refused: another heavy job held the lock, or older queued jobs were still
      ahead, for the whole --wait-sec
  74  refused: the lock file cannot be created/opened (no lock = no admission),
      or the FIFO queue is unusable ("queue_io_error"): no ticket can be
      created, the queue directory cannot be listed, the lock record cannot
      be read, or the own ticket vanished and cannot be re-created during the
      wait
  75  refused: MemAvailable stayed below the floor for the whole --wait-sec,
      OR MemAvailable could not be read (at admission or during the wait):
      a gate that cannot measure does not admit ("meminfo_error" refuse line)
  76  the job RAN and was stopped by the gate because it exceeded --max-sec
      (only with --max-sec; finish line max_sec_exceeded=true)
  77  refused: the memory-capped systemd scope is unavailable (no systemd-run,
      no user manager, the probe failed, or HEAVY_JOB_NO_SCOPE=1). The job is
      NOT run uncapped unless the caller passes --allow-uncapped, which is
      logged ("uncapped" line) and warned; the lock and the memory floor still
      apply then.
  128 + signo: SIGTERM (143), SIGINT (130) or SIGHUP (129) arrived while the
      call was waiting in the queue (ticket removed, "refuse" line
      reason=signal), unless that signal was inherited as ignored

Nested calls (a gated job that itself calls the gate) run the command directly
without re-locking, but ONLY if that is verifiable: HEAVY_JOB_ACTIVE=1 and
the per-job HEAVY_JOB_TOKEN are exported to the child, and a nested call is
honoured only when ALL hold: the global lock is really held (a LOCK_NB flock on
a fresh open of the lock file fails), the lock record carries the same token,
and the caller's own cgroup (/proc/self/cgroup) is inside the scope unit named
in that record. Otherwise the call is treated as a normal one
("nested_unverified" line, with the reason). Under --allow-uncapped there is no
scope, so a nested call is never verified (it waits for the lock like any other).

Lock record (the lock file's content, token FIRST, read whole):
  token=<hex> pid=<gate pid> unit=<scope unit or -> since=<time> label=<label>
  [agent=<name>] [short_streak=<n> short_passed=<place>]
The token is never printed or logged; refusal messages name the holder pid and
whether that pid is alive.

Ollama unload (HEAVY_JOB_OLLAMA_UNLOAD=1, off by default): when memory is short
at admission, every loaded ollama model is unloaded once (POST /api/generate
keep_alive=0) at HEAVY_JOB_OLLAMA_URL, else OLLAMA_URL, else
http://localhost:11434. Worth it when the only ollama consumer is the memory
embedding model, which reloads itself on the next search. Leave it off when an
agent runs on a local ollama model: the unload would cost that agent a reload.

Test hooks (env): HEAVY_JOB_MEMINFO (meminfo path), HEAVY_JOB_LOCK,
HEAVY_JOB_QUEUE_DIR (ticket directory; default: .heavy-job-queue next to the
lock file, so a test lock gets its own queue), HEAVY_JOB_LOG,
HEAVY_JOB_NO_SCOPE=1 (treat the scope as unavailable), HEAVY_JOB_POLL_SEC (poll
interval), HEAVY_JOB_CGROUP_FS (cgroup fs root for the post-job emptiness
check, default /sys/fs/cgroup; never used by the nested check),
HEAVY_JOB_STOP_WAIT_SEC (emptiness wait bound).
"""
import fcntl
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULT_MIN_MB = 2500
DEFAULT_MAX_MEM = "2G"
DEFAULT_SWAP_MAX = "256M"
DEFAULT_WAIT_SEC = 300  # stays under the agents' Bash tool ceiling (600 s)
DEFAULT_RESERVE_MB = 500  # what must remain for the rest of the host at the job's worst case

EXIT_USAGE = 64
EXIT_LOCK_TIMEOUT = 73
EXIT_LOCK_IO = 74
EXIT_MEM_TIMEOUT = 75
EXIT_NO_CAP = 77
EXIT_RUNTIME_LIMIT = 76  # --max-sec exceeded: the gate stopped the job

KILL_GRACE_SEC = 5.0  # --max-sec: SIGTERM to the main process, SIGKILL after this
_AGENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

SCOPE_PREFIX = "heavy-job-"
SCOPE_STOP_TIMEOUT = "5s"    # TimeoutStopSec of the scope: SIGTERM, then SIGKILL after this
SYSTEMCTL_TIMEOUT = 30       # hard bound on one systemctl call (stop waits for the kill)
DEFAULT_STOP_WAIT_SEC = 10.0  # bound on the cgroup-empty wait after the stop

TICKET_SUFFIX = ".ticket"
TICKET_TMP_PREFIX = ".tmp-"
QUEUE_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)

SHORT_MAX_SEC = 300               # --max-sec <= this is a short job
SHORT_OVERTAKE_MAX = 3            # at most this many short jobs in a row pass a waiting long one
_POS_RE = re.compile(r"^\d{20}-\d{10}$")


def env_path(name, default):
    return os.environ.get(name) or default


def store_dir():
    """Where the lock, the queue and the log live: HEAVY_JOB_STORE, else the
    store/ directory of the install root (the parent of scripts/)."""
    return env_path("HEAVY_JOB_STORE", os.path.join(ROOT, "store"))


def meminfo_path():
    return env_path("HEAVY_JOB_MEMINFO", "/proc/meminfo")


def lock_path():
    return env_path("HEAVY_JOB_LOCK", os.path.join(store_dir(), ".heavy-job.lock"))


def log_path():
    return env_path("HEAVY_JOB_LOG", os.path.join(store_dir(), "heavy-job-log.jsonl"))


def poll_sec():
    try:
        return max(0.05, float(os.environ.get("HEAVY_JOB_POLL_SEC", "5")))
    except ValueError:
        return 5.0


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def log(rec):
    rec = dict({"ts": now_iso(), "pid": os.getpid()}, **rec)
    try:
        with open(log_path(), "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def say(msg):
    sys.stderr.write("[heavy-job-gate] " + msg + "\n")
    sys.stderr.flush()


def mem_available_mb(path=None):
    """MemAvailable in MB, or None if unreadable."""
    try:
        with open(path or meminfo_path()) as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


_SIZE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?\s*$", re.I)


def parse_size_mb(text, allow_zero=False):
    """'2G' -> 2048, '300M' -> 300, '1536' -> 1536 (MB). Raises ValueError."""
    m = _SIZE_RE.match(text or "")
    if not m:
        raise ValueError("bad size: %r" % text)
    num = float(m.group(1))
    unit = m.group(2).upper()
    factor = {"": 1, "K": 1.0 / 1024, "M": 1, "G": 1024, "T": 1024 * 1024}[unit]
    mb = int(num * factor)
    if mb < 0 or (mb == 0 and not allow_zero):
        raise ValueError("size must be positive: %r" % text)
    return mb


def usage(err=None):
    if err:
        say("error: " + err)
    sys.stderr.write(
        "usage: heavy-job-gate.sh [--min-mb N] [--max-mem 2G] [--swap-max 256M] "
        "[--wait-sec S] [--label TEXT] [--allow-uncapped] [--max-sec N] [--agent NAME] "
        "-- <command...>\n")
    return EXIT_USAGE


# flag -> (option key, environment variable that sets its default)
_ENV_DEFAULTS = (("--min-mb", "min_mb", "HEAVY_JOB_MIN_MB"),
                 ("--max-mem", "max_mem", "HEAVY_JOB_MAX_MEM"),
                 ("--swap-max", "swap_max", "HEAVY_JOB_SWAP_MAX"),
                 ("--wait-sec", "wait_sec", "HEAVY_JOB_WAIT_SEC"))


def coerce_opt(key, flag, val):
    """One option value, validated the same way for a flag and its env default."""
    if key in ("min_mb", "wait_sec"):
        try:
            val = int(val)
        except ValueError:
            raise ValueError("%s needs an integer" % flag)
        if val < 0:
            raise ValueError("%s must be >= 0" % flag)
    if key == "max_sec":
        try:
            val = int(val)
        except ValueError:
            raise ValueError("%s needs an integer" % flag)
        if val < 1:
            raise ValueError("%s must be >= 1" % flag)
    if key in ("max_mem", "swap_max"):
        try:
            parse_size_mb(val, allow_zero=(key == "swap_max"))
        except ValueError as e:
            raise ValueError("%s: %s" % (flag, e))
    if key == "agent" and not _AGENT_RE.match(val):
        raise ValueError("%s must be 1-64 characters of A-Z a-z 0-9 . _ - (starting "
                         "with a letter or digit)" % flag)
    return val


def reserve_mb():
    """HEAVY_JOB_RESERVE_MB (integer >= 0), else DEFAULT_RESERVE_MB. Raises ValueError."""
    raw = os.environ.get("HEAVY_JOB_RESERVE_MB")
    if not raw:
        return DEFAULT_RESERVE_MB
    try:
        val = int(raw)
    except ValueError:
        raise ValueError("HEAVY_JOB_RESERVE_MB needs an integer")
    if val < 0:
        raise ValueError("HEAVY_JOB_RESERVE_MB must be >= 0")
    return val


def parse_args(argv):
    opts = {"min_mb": DEFAULT_MIN_MB, "max_mem": DEFAULT_MAX_MEM,
            "swap_max": DEFAULT_SWAP_MAX, "wait_sec": DEFAULT_WAIT_SEC,
            "label": None, "allow_uncapped": False, "max_sec": None, "agent": None}
    for flag, key, var in _ENV_DEFAULTS:
        if os.environ.get(var):
            opts[key] = coerce_opt(key, var, os.environ[var])
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            cmd = argv[i + 1:]
            if not cmd:
                raise ValueError("no command after --")
            return opts, cmd
        if a in ("-h", "--help"):
            raise ValueError("help")
        if a == "--allow-uncapped":
            opts["allow_uncapped"] = True
            i += 1
            continue
        key = {"--min-mb": "min_mb", "--max-mem": "max_mem", "--swap-max": "swap_max",
               "--wait-sec": "wait_sec", "--label": "label", "--max-sec": "max_sec",
               "--agent": "agent"}.get(a)
        if key is None or i + 1 >= len(argv):
            raise ValueError("unknown or incomplete option: %s" % a)
        opts[key] = coerce_opt(key, a, argv[i + 1])
        i += 2
    raise ValueError("missing -- before the command")


def ollama_url():
    return os.environ.get("HEAVY_JOB_OLLAMA_URL") or os.environ.get("OLLAMA_URL") \
        or "http://localhost:11434"


def unload_ollama():
    """Unload every loaded ollama model, only when HEAVY_JOB_OLLAMA_UNLOAD=1
    (opt-in). Returns the list of unloaded names."""
    if os.environ.get("HEAVY_JOB_OLLAMA_UNLOAD") != "1":
        return []
    base = ollama_url().rstrip("/")
    done = []
    try:
        with urllib.request.urlopen(base + "/api/ps", timeout=3) as r:
            data = json.loads(r.read().decode())
        # external input: validate every level, skip anything malformed
        entries = data.get("models") if isinstance(data, dict) else None
        models = []
        for e in entries if isinstance(entries, list) else []:
            if isinstance(e, dict):
                name = e.get("name") or e.get("model")
                if isinstance(name, str) and name:
                    models.append(name)
        for m in models:
            req = urllib.request.Request(
                base + "/api/generate", data=json.dumps({"model": m, "keep_alive": 0}).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                r.read()
            done.append(m)
    except Exception:  # best effort only: it never admits, and it must not crash the gate
        pass
    return done


def queue_dir():
    return env_path("HEAVY_JOB_QUEUE_DIR",
                    os.path.join(os.path.dirname(lock_path()), ".heavy-job-queue"))


def proc_stat(pid):
    """(state, starttime) from /proc/<pid>/stat; None if there is no such process.
    Raises OSError/IndexError if it exists but cannot be read or parsed."""
    try:
        with open("/proc/%d/stat" % pid) as f:
            data = f.read()
    except FileNotFoundError:
        return None
    rest = data.rsplit(")", 1)[1].split()
    return rest[0], rest[19]


def ticket_owner_alive(info):
    """True if the process that wrote this ticket is still the one running under
    its pid: not dead, not a zombie, and (when recorded) the same start time, so
    a reused pid does not keep a crashed waiter's ticket alive."""
    pid = info.get("pid") if isinstance(info, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        st = proc_stat(pid)
    except (OSError, IndexError):
        return pid_alive(pid)
    if st is None or st[0] in ("Z", "X"):
        return False
    start = info.get("start")
    return start is None or str(start) == st[1]


def is_short(info):
    v = info.get("max_sec") if isinstance(info, dict) else None
    return isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= SHORT_MAX_SEC


def queue_pos(name):
    """The place in the queue: the ticket name without its suffix, <time_ns>-<pid>."""
    return name.split(".", 1)[0]


def queue_enter(label, agent=None, max_sec=None):
    """Create this process's ticket atomically (write a temp file, then rename).
    The name sorts by arrival: <time_ns, 20 digits>-<pid, 10 digits>.ticket.
    "fair": 1 says this gate knows the deferral and the short-lane rules;
    "agent" and "max_sec" are written only when given."""
    d = queue_dir()
    os.makedirs(d, exist_ok=True)
    pid = os.getpid()
    try:
        start = proc_stat(pid)[1]
    except (OSError, IndexError, TypeError):
        start = None
    path = os.path.join(d, "%020d-%010d%s" % (time.time_ns(), pid, TICKET_SUFFIX))
    info = {"pid": pid, "start": start, "label": label[:100], "created": now_iso(), "fair": 1}
    if agent:
        info["agent"] = agent
    if max_sec is not None:
        info["max_sec"] = max_sec
    body = json.dumps(info, ensure_ascii=False)
    write_ticket(path, body)
    return path, body


def write_ticket(path, body):
    """Atomic: a reader sees either no ticket or the complete one."""
    d = os.path.dirname(path)
    tmp = os.path.join(d, "%s%d-%s" % (TICKET_TMP_PREFIX, os.getpid(), secrets.token_hex(4)))
    try:
        wfd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        try:
            os.write(wfd, body.encode("utf-8"))
        finally:
            os.close(wfd)
        os.rename(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def queue_leave(path):
    if not path:
        return
    try:
        os.unlink(path)
    except OSError:
        pass


class QueueIOError(Exception):
    """The queue directory or the own ticket cannot be used: fail closed (74)."""


def sanitize_label(text):
    """A label read back from another ticket, safe for stderr and the log:
    whitespace collapsed to '_', non-printable characters replaced, <= 100 chars
    (the same shape as the label in the lock record)."""
    text = re.sub(r"\s+", "_", str(text))
    return "".join(c if c.isprintable() else "?" for c in text)[:100]


def read_ticket(path):
    """The ticket as a dict, or None if its content is malformed (bad UTF-8, bad
    JSON, not an object, or not a regular file). Raises FileNotFoundError if it
    is gone, and any other OSError (EMFILE, EIO, EACCES, ...) as is: a read
    failure says nothing about the ticket, so the caller must not delete it."""
    try:
        with open(path, encoding="utf-8") as f:
            info = json.loads(f.read(4096))
    except IsADirectoryError:
        return None
    except ValueError:  # includes UnicodeDecodeError and JSONDecodeError
        return None
    return info if isinstance(info, dict) else None


def pid_from_ticket_name(name):
    try:
        return int(name[:-len(TICKET_SUFFIX)].rsplit("-", 1)[1])
    except (IndexError, ValueError):
        return 0


def is_deferred(info, last_agent):
    """A ticket tagged with the agent the lock record names (running or last run)."""
    agent = info.get("agent") if isinstance(info, dict) else None
    return bool(last_agent) and isinstance(agent, str) and agent == last_agent


def lane_open(rec, live):
    """The short lane is closed once SHORT_OVERTAKE_MAX short jobs in a row
    passed the long ticket the lock record names, while that ticket still waits
    (it goes first then). A malformed counter closes the lane: today's order."""
    k = rec.get("short_streak")
    if k is None:
        return True
    try:
        k = int(k)
    except ValueError:
        return False
    return not (k >= SHORT_OVERTAKE_MAX and rec.get("short_passed") in live)


def queue_ahead(ticket, my_agent=None, last_agent=None, my_short=False, rec=None, scan=None):
    """Live tickets ahead of ours, as a list of sanitized labels: the older ones
    first, oldest first. Stale tickets (owner not alive, or malformed content)
    are removed on the way. A ticket that exists but cannot be read right now is
    judged by the pid in its NAME: kept and counted as ahead while that pid
    lives. Raises QueueIOError if the queue directory cannot be listed.

    Order: (deferred, not short-lane, place). Fairness (only when the lock
    record names an agent, last_agent): a DEFERRED ticket (tagged last_agent)
    comes after every ticket that is not. Short lane (while lane_open): a
    short ticket (max_sec <= SHORT_MAX_SEC) comes before the long ones of the
    same deferral. A YOUNGER ticket is ahead of us only if it knows these rules
    ("fair": 1), so a waiter of an older gate is never yielded to. With no agent
    record and no short ticket this is plain FIFO. scan (dict, optional) gets
    "passed": [(place, label)] of the older long tickets we pass in the lane."""
    d = os.path.dirname(ticket)
    my_pos = queue_pos(os.path.basename(ticket))
    me_deferred = bool(last_agent) and my_agent == last_agent
    try:
        names = sorted(os.listdir(d))
    except OSError as e:
        raise QueueIOError("cannot list the queue directory %s: %s" % (d, e))
    entries = {}  # place -> ticket dict, or None for an unreadable live ticket
    for name in names:
        full = os.path.join(d, name)
        if name.startswith(TICKET_TMP_PREFIX):
            # a half-written ticket of a writer that died between write and rename
            try:
                pid = int(name[len(TICKET_TMP_PREFIX):].split("-", 1)[0])
            except ValueError:
                pid = 0
            if pid != os.getpid() and not ticket_owner_alive({"pid": pid}):
                queue_leave(full)
            continue
        pos = queue_pos(name)
        if not name.endswith(TICKET_SUFFIX) or pos == my_pos:
            continue
        try:
            info = read_ticket(full)
        except FileNotFoundError:
            continue
        except OSError:
            # transient or permission read error: not proof of staleness
            if ticket_owner_alive({"pid": pid_from_ticket_name(name)}):
                entries[pos] = None
            else:
                queue_leave(full)
            continue
        if info is None or not ticket_owner_alive(info):
            queue_leave(full)
            continue
        entries[pos] = info
    # our own place counts as waiting too: every waiter must see the same lane
    lane = lane_open(rec or {}, set(entries) | {my_pos})
    my_key = (me_deferred, not (lane and my_short), my_pos)
    ahead, younger, passed = [], [], []
    for pos in sorted(entries):
        info = entries[pos]
        if info is None:
            # unreadable: an older one is ahead; a younger one cannot be shown
            # to know the rules: not ahead
            if pos < my_pos:
                ahead.append("?unreadable")
            continue
        deferred = is_deferred(info, last_agent)
        label = sanitize_label(info.get("label", "?"))
        if (deferred, not (lane and is_short(info)), pos) < my_key:
            if pos < my_pos:
                ahead.append(label)
            elif info.get("fair") == 1:
                younger.append(label)
        elif pos < my_pos and deferred == me_deferred:
            passed.append((pos, label))  # an older long ticket we pass in the short lane
    if scan is not None:
        scan["passed"] = passed
    return ahead + younger


def acquire_in_turn(fd, ticket, ticket_body, deadline, on_first_wait, lp=None, my_agent=None,
                    my_short=False, scan=None):
    """FIFO admission: try the non-blocking flock ONLY while no live ticket is
    ahead of ours (this holds for the very first attempt too, so nobody barges
    in when the lock happens to be free). Returns (acquired, labels still ahead).
    The lock record (lp) is re-read on every round for the agent it names (the
    fairness rule) and the short-lane counter (see queue_ahead); scan gets the
    last round's record ("rec") and passed tickets ("passed"). Raises
    QueueIOError if the queue or the lock record cannot be used any more (fail
    closed)."""
    scan = {} if scan is None else scan
    waited = False
    ahead = []
    while True:
        if not os.path.exists(ticket):
            # our ticket vanished (e.g. removed by hand, or the directory is
            # gone): put it back under the same name, so we keep our place
            try:
                write_ticket(ticket, ticket_body)
            except OSError as e:
                raise QueueIOError("own ticket vanished and cannot be re-created: %s" % e)
        rec = read_record(lp, strict=True) if lp else {}
        scan["rec"] = rec
        ahead = queue_ahead(ticket, my_agent, rec.get("agent"), my_short, rec, scan)
        if ahead == []:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True, []
            except BlockingIOError:
                pass
        if not waited:
            on_first_wait(ahead)
            waited = True
        if time.monotonic() >= deadline:
            return False, ahead
        time.sleep(min(poll_sec(), max(0.01, deadline - time.monotonic())))


class QueueSignal(Exception):
    def __init__(self, signo):
        Exception.__init__(self, signo)
        self.signo = signo


def read_record(path, strict=False):
    """The lock record as a dict (whole file read, first occurrence of a key wins).
    strict (the queue's own read, which the short-lane counter depends on): a
    record that exists but cannot be read raises QueueIOError (fail closed)."""
    try:
        with open(path) as f:
            text = f.read(65536)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        if strict:
            raise QueueIOError("cannot read the lock record %s: %s" % (path, e))
        return {}
    rec = {}
    for field in text.split():
        k, sep, v = field.partition("=")
        if sep and k not in rec:
            rec[k] = v
    return rec


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, OverflowError):
        return False


def holder_info(rec):
    """(human text, log fields) for a lock record; never contains the token."""
    try:
        pid = int(rec.get("pid", ""))
    except ValueError:
        pid = None
    alive = pid_alive(pid) if pid and pid > 0 else None
    state = "unknown" if alive is None else ("alive" if alive else "NOT alive")
    text = "holder pid %s (%s), label %s, since %s" % (
        pid if pid else "unknown", state, rec.get("label", "?"), rec.get("since", "?"))
    return text, {"holder_pid": pid, "holder_alive": alive, "holder_label": rec.get("label"),
                  "holder_unit": rec.get("unit")}


def wait_mem_fields(rec):
    """Measurement only: the free memory and the lock holder's
    live scope memory at the moment a lock wait starts or times out, so the log
    shows whether there was headroom while the queue waited (the start line's
    mem_avail_mb is read only AFTER the lock is released). Never decides
    anything; every unreadable value is None."""
    out = {"mem_avail_mb": mem_available_mb(), "holder_mem_mb": None, "holder_max_mb": None}
    unit = rec.get("unit", "")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", unit or "") or unit == "-":
        return out
    _, rel = systemctl("show", "-p", "ControlGroup", "--value", unit + ".scope")
    cg = own_scope_dir((cgroup_fs().rstrip("/") + rel) if rel.startswith("/") else None, unit)
    if cg:
        cur = read_int(os.path.join(cg, "memory.current"))
        mx = read_int(os.path.join(cg, "memory.max"))   # "max" (no cap) reads as None
        out["holder_mem_mb"] = cur // (1024 * 1024) if cur is not None else None
        out["holder_max_mb"] = mx // (1024 * 1024) if mx is not None else None
    return out


def self_cgroup_parts():
    try:
        with open("/proc/self/cgroup") as f:
            for line in f:
                if line.startswith("0::"):
                    return [c for c in line[3:].strip().split("/") if c]
    except OSError:
        pass
    return []


def nested_check(path):
    """(True, None) if this call really runs inside a live gated job: the global
    lock is held by someone (a fresh LOCK_NB flock fails), the lock record
    carries our HEAVY_JOB_TOKEN, and our own cgroup is inside the scope unit
    that record names. Otherwise (False, reason)."""
    token = os.environ.get("HEAVY_JOB_TOKEN", "")
    if not token:
        return False, "no_token"
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return False, "lock_file_missing"
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            rec = read_record(path)
            if rec.get("token") != token:
                return False, "token_mismatch"
            unit = rec.get("unit", "-")
            if not unit.startswith(SCOPE_PREFIX):
                return False, "no_scope_unit"
            if (unit + ".scope") not in self_cgroup_parts():
                return False, "not_in_scope"
            return True, None
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False, "lock_not_held"
    finally:
        os.close(fd)


def scope_available():
    if os.environ.get("HEAVY_JOB_NO_SCOPE") == "1":
        return False
    if not shutil.which("systemd-run"):
        return False
    try:
        p = subprocess.run(["systemd-run", "--user", "--scope", "--quiet", "--collect", "true"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        return p.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def cgroup_dir_of(pid):
    try:
        with open("/proc/%d/cgroup" % pid) as f:
            for line in f:
                if line.startswith("0::"):
                    return "/sys/fs/cgroup" + line[3:].strip()
    except OSError:
        return None
    return None


def read_int(path):
    try:
        with open(path) as f:
            return int(f.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def read_oom_kills(cg):
    try:
        with open(os.path.join(cg, "memory.events")) as f:
            for line in f:
                k, _, v = line.partition(" ")
                if k == "oom_kill":
                    return int(v)
    except (OSError, ValueError):
        return None
    return None


def cgroup_fs():
    return env_path("HEAVY_JOB_CGROUP_FS", "/sys/fs/cgroup")


def stop_wait_sec():
    try:
        return max(0.1, float(os.environ.get("HEAVY_JOB_STOP_WAIT_SEC", DEFAULT_STOP_WAIT_SEC)))
    except ValueError:
        return DEFAULT_STOP_WAIT_SEC


def systemctl(*args):
    """(returncode, stdout) of `systemctl --user ...`; rc None if it could not run."""
    try:
        p = subprocess.run(["systemctl", "--user"] + list(args), stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, timeout=SYSTEMCTL_TIMEOUT)
        return p.returncode, p.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None, ""


def cgroup_pids(cg):
    """PIDs in the cgroup, [] if it is gone. None if it exists but cannot be read."""
    try:
        with open(os.path.join(cg, "cgroup.procs")) as f:
            return [int(x) for x in f.read().split()]
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        return None


def wait_empty(cg, bound):
    end = time.monotonic() + bound
    while True:
        pids = cgroup_pids(cg)
        if pids == []:
            return []
        if time.monotonic() >= end:
            return pids
        time.sleep(0.1)


def own_scope_dir(path, unit):
    """path if it is THIS job's own scope cgroup (<...>/<unit>.scope), else None.
    Every cgroup the gate reads stats from or kills must pass this: a gate that
    itself runs inside another heavy-job gate scope sees that OUTER scope first,
    and a prefix match would make it tear down its own caller."""
    if path and os.path.basename(path.rstrip("/")) == unit + ".scope":
        return path
    return None


def stop_scope(unit, cg_hint=None):
    """Stop the whole transient scope after the job's main process ended, and
    verify its cgroup is empty (bounded). Returns fields for the finish line."""
    name = unit + ".scope"
    _, rel = systemctl("show", "-p", "ControlGroup", "--value", name)
    cg = (cgroup_fs().rstrip("/") + rel) if rel.startswith("/") else cg_hint
    cg = own_scope_dir(cg, unit)
    before = cgroup_pids(cg) if cg else []
    rc, _ = systemctl("stop", name)
    out = {"scope_survivors": len(before) if before else 0, "scope_stop_rc": rc}
    if not cg:
        # no cgroup path: the unit was already collected (it was empty) or
        # systemctl is unusable; the stop rc says which (5 = not loaded)
        out["scope_stop"] = "already_gone" if rc == 5 else "unverified"
        return out
    left = wait_empty(cg, stop_wait_sec())
    if left == []:
        out["scope_stop"] = "stopped" if before else "empty"
        return out
    # last resort: the kernel kills every process in the cgroup at once
    try:
        with open(os.path.join(cg, "cgroup.kill"), "w") as f:
            f.write("1")
    except OSError:
        for pid in left or []:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    left = wait_empty(cg, 3.0)
    if left == []:
        out["scope_stop"] = "killed"
        return out
    out["scope_stop"] = "leftover"
    out["scope_leftover_pids"] = left[:20] if left is not None else "unreadable"
    return out


def run_child(argv, env, unit=None, max_sec=None):
    """Run argv, forward SIGTERM/SIGINT/SIGHUP (except the ones inherited as
    ignored, which stay ignored for the gate and the child), track the scope cgroup's peak
    memory and oom_kill counter while it runs. When the main process ends and
    `unit` is set, the whole scope is stopped (no descendant outlives the job).
    With max_sec, a job still running after max_sec seconds is stopped (the
    whole scope, then SIGTERM / SIGKILL to the main process) and the code is
    EXIT_RUNTIME_LIMIT; stats carry max_sec_exceeded and killed_exit.
    Returns (exit_code, stats)."""
    # The lock fd is deliberately NOT passed (os.open fds are non-inheritable
    # and Popen closes the rest): only the gate process holds the lock.
    child = subprocess.Popen(argv, env=env)
    forwarded = []

    def fwd(signo, _frame):
        forwarded.append(signo)
        try:
            child.send_signal(signo)
        except OSError:
            pass

    # A signal the gate inherited as SIG_IGN (nohup, setsid + ignore) is NOT
    # forwarded, and the gate keeps ignoring it, so the child (forked from an
    # ignoring parent; exec keeps SIG_IGN, systemd-run --scope too) ignores it
    # as well. Installing a handler here would make exec reset the child's
    # disposition to default, and a forwarded SIGHUP would kill the job.
    old = {}
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        if signal.getsignal(s) != signal.SIG_IGN:
            old[s] = signal.signal(s, fwd)
    stats = {"peak_mb": None, "oom_kill": None}
    cg = None
    t_run = time.monotonic()
    timed_out = False
    scope_stopped = False
    kill_at = None
    try:
        while True:
            try:
                rc = child.wait(timeout=0.5)
                break
            except subprocess.TimeoutExpired:
                pass
            if max_sec is not None and not timed_out and time.monotonic() - t_run >= max_sec:
                timed_out = True
                if unit:
                    stats.update(stop_scope(unit, cg))
                    scope_stopped = True
                if child.poll() is None:
                    try:
                        child.terminate()
                    except OSError:
                        pass
                kill_at = time.monotonic() + KILL_GRACE_SEC
            if kill_at is not None and time.monotonic() >= kill_at and child.poll() is None:
                try:
                    child.kill()
                except OSError:
                    pass
                kill_at = None
            if cg is None and unit:
                cg = own_scope_dir(cgroup_dir_of(child.pid), unit)
            if cg:
                peak = read_int(os.path.join(cg, "memory.peak"))
                if peak is not None:
                    stats["peak_mb"] = peak // (1024 * 1024)
                ok = read_oom_kills(cg)
                if ok is not None:
                    stats["oom_kill"] = ok
        if unit and not scope_stopped:
            # still under the forwarding handlers: a SIGTERM now must not kill
            # the gate half-way through the teardown
            stats.update(stop_scope(unit, cg))
    finally:
        for s, h in old.items():
            signal.signal(s, h)
    if forwarded:
        stats["forwarded_signals"] = forwarded
    code = rc if rc >= 0 else 128 + (-rc)
    if timed_out:
        stats.update({"max_sec_exceeded": True, "max_sec": max_sec, "killed_exit": code})
        return EXIT_RUNTIME_LIMIT, stats
    return code, stats


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        opts, cmd = parse_args(argv)
    except ValueError as e:
        return usage(None if str(e) == "help" else str(e))
    try:
        cap_mb = parse_size_mb(opts["max_mem"])
        swap_mb = parse_size_mb(opts["swap_max"], allow_zero=True)
        reserve = reserve_mb()
    except ValueError as e:
        return usage(str(e))

    label = opts["label"] or os.path.basename(cmd[0])
    cmd_text = " ".join(cmd)[:400]
    agent = opts["agent"]
    if agent is None and os.environ.get("HEAVY_JOB_AGENT"):
        agent = os.environ["HEAVY_JOB_AGENT"]
        if not _AGENT_RE.match(agent):
            return usage("HEAVY_JOB_AGENT must be 1-64 characters of A-Z a-z 0-9 . _ - "
                         "(starting with a letter or digit)")
    max_sec = opts["max_sec"]

    # Nested call: the outer gate already holds the lock and the cgroup cap,
    # but the environment alone is not trusted (it leaks to daemonized
    # descendants): the lock must be held and carry our token.
    if os.environ.get("HEAVY_JOB_ACTIVE") == "1":
        ok, why = nested_check(lock_path())
        if ok:
            log({"event": "nested", "label": label, "cmd": cmd_text})
            try:
                rc = subprocess.call(cmd)
                return rc if rc >= 0 else 128 + (-rc)  # same convention as run_child
            except OSError as e:
                say("cannot run command: %s" % e)
                return 127
        say("HEAVY_JOB_ACTIVE is set but no live gated job owns the lock (%s); "
            "treating this as a normal call" % why)
        log({"event": "nested_unverified", "label": label, "reason": why})

    # 0. the cap must be available before anything else is spent on this job
    scoped = scope_available()
    if not scoped:
        if not opts["allow_uncapped"]:
            say("REFUSED: the memory-capped systemd --user scope is unavailable, and this gate "
                "does not run a heavy job without its cap. Not started. (Explicit override: "
                "--allow-uncapped, logged.)")
            log({"event": "refuse", "reason": "no_cap", "label": label, "cmd": cmd_text,
                 "exit": EXIT_NO_CAP})
            return EXIT_NO_CAP
        say("WARNING: --allow-uncapped: running WITHOUT the cgroup memory cap "
            "(lock and memory floor still apply; only the kernel OOM killer stands behind it)")
        log({"event": "uncapped", "label": label, "cmd": cmd_text})

    floor_mb = max(opts["min_mb"], cap_mb + reserve)
    wait_sec = opts["wait_sec"]
    deadline = time.monotonic() + wait_sec
    t0 = time.monotonic()

    lp = lock_path()
    try:
        os.makedirs(os.path.dirname(lp), exist_ok=True)
        fd = os.open(lp, os.O_RDWR | os.O_CREAT, 0o644)
    except OSError as e:
        say("REFUSED: cannot open the lock file %s: %s. Not started." % (lp, e))
        log({"event": "refuse", "reason": "lock_io_error", "label": label, "cmd": cmd_text,
             "error": str(e)[:200], "exit": EXIT_LOCK_IO})
        return EXIT_LOCK_IO

    # 1. global lock, taken in arrival order (FIFO ticket queue in front of it)
    def on_first_wait(ahead):
        holder_rec = read_record(lp)
        text, fields = holder_info(holder_rec)
        pos = len(ahead) + 1
        if ahead:
            say("queued behind older heavy jobs: queue position %d (ahead: %s); lock record: %s; "
                "waiting up to %ds" % (pos, ", ".join(ahead), text, wait_sec))
        else:
            say("another heavy job is running (%s); queue position 1; waiting up to %ds"
                % (text, wait_sec))
        rec = {"event": "wait", "reason": "lock", "label": label, "wait_sec": wait_sec,
               "queue_pos": pos, "ahead": ahead}
        if agent:
            rec["agent"] = agent
        if my_short:
            rec["short"] = True
        log(dict(rec, **fields, **wait_mem_fields(holder_rec)))

    state = {"cleanup": False, "pending": None}

    def on_signal(signo, _frame):
        if state["cleanup"]:
            state["pending"] = state["pending"] or signo
            return
        raise QueueSignal(signo)

    ticket = None
    got, ahead, caught, qerr = False, [], None, None
    scan = {}
    my_short = is_short({"max_sec": max_sec})  # one definition for every waiter's view
    # A disposition inherited as SIG_IGN is kept (e.g. nohup'd / setsid jobs that
    # must survive a hangup); only the others clean up the ticket and exit.
    old_handlers = {}
    for s in QUEUE_SIGNALS:
        if signal.getsignal(s) != signal.SIG_IGN:
            old_handlers[s] = signal.signal(s, on_signal)
    try:
        try:
            ticket, ticket_body = queue_enter(label, agent, max_sec)
        except OSError as e:
            raise QueueIOError("cannot create a ticket in %s: %s" % (queue_dir(), e))
        got, ahead = acquire_in_turn(fd, ticket, ticket_body, deadline, on_first_wait,
                                     lp=lp, my_agent=agent, my_short=my_short, scan=scan)
    except QueueSignal as e:
        caught = e.signo
    except QueueIOError as e:
        qerr = str(e)
    finally:
        # a signal from here on is remembered, not raised: the ticket must go
        state["cleanup"] = True
        queue_leave(ticket)
        for s, h in old_handlers.items():
            signal.signal(s, h)
    caught = caught or state["pending"]
    if caught:
        # killed while queued (e.g. a supervisor's SIGTERM): leave no ticket
        say("stopped by signal %d while waiting in the queue. Not started." % caught)
        log({"event": "refuse", "reason": "signal", "label": label, "cmd": cmd_text,
             "signal": caught, "waited_sec": round(time.monotonic() - t0, 1),
             "exit": 128 + caught})
        os.close(fd)  # releases the flock too, if it was just taken
        return 128 + caught
    if qerr:
        # fail closed: a queue that cannot be used gives no ordering, so no admission
        say("REFUSED: the heavy-job queue is unusable (%s). Not started." % qerr)
        log({"event": "refuse", "reason": "queue_io_error", "label": label, "cmd": cmd_text,
             "error": qerr[:200], "waited_sec": round(time.monotonic() - t0, 1),
             "exit": EXIT_LOCK_IO})
        os.close(fd)
        return EXIT_LOCK_IO
    if not got:
        holder_rec = read_record(lp)
        text, fields = holder_info(holder_rec)
        say("REFUSED: another heavy job held the lock for %ds (%s)%s. Not started. "
            "Retry later." % (wait_sec, text,
                              ("; still behind %d older job(s) in the queue: %s"
                               % (len(ahead), ", ".join(ahead))) if ahead else ""))
        log(dict({"event": "refuse", "reason": "lock_timeout", "label": label, "cmd": cmd_text,
                  "waited_sec": round(time.monotonic() - t0, 1),
                  "queue_pos": len(ahead) + 1, "ahead": ahead,
                  "exit": EXIT_LOCK_TIMEOUT}, **fields, **wait_mem_fields(holder_rec)))
        os.close(fd)
        return EXIT_LOCK_TIMEOUT
    token = secrets.token_hex(16)
    unit = "%s%d-%d" % (SCOPE_PREFIX, int(time.time()), os.getpid())
    # short-lane counter: the previous holder's, carried while this job is
    # not yet admitted; changed only once it passes the memory floor (below)
    passed, streak = scan.get("passed") or [], None
    prev = scan.get("rec") or {}
    carry_tail = ""
    if _POS_RE.match(prev.get("short_passed", "")) and re.fullmatch(r"\d+", prev.get("short_streak", "")):
        carry_tail = " short_streak=%s short_passed=%s" % (prev["short_streak"], prev["short_passed"])
    lane_tail = ""  # a long job resets the count
    if my_short and passed:
        # count the short jobs in a row that passed the oldest long ticket
        streak = 1
        if prev.get("short_passed") == passed[0][0]:
            try:
                streak = int(prev.get("short_streak", "0")) + 1
            except ValueError:
                streak = SHORT_OVERTAKE_MAX  # malformed: treat the lane as used up
        lane_tail = " short_streak=%d short_passed=%s" % (streak, passed[0][0])
    elif my_short:
        lane_tail = carry_tail  # a short job that passed nobody keeps the count
    since = now_iso()

    def write_record(tail):
        try:
            os.ftruncate(fd, 0)
            # token FIRST, so a reader that stops early can never lose it
            os.pwrite(fd, ("token=%s pid=%d unit=%s since=%s label=%s%s%s\n"
                           % (token, os.getpid(), unit if scoped else "-", since,
                              re.sub(r"\s+", "_", label)[:100],
                              (" agent=" + agent) if agent else "", tail)).encode(), 0)
        except OSError as e:
            # without the token a nested call cannot be verified; say so, still run capped
            say("warning: cannot write the lock holder record: %s" % e)

    write_record(carry_tail)

    # 2. memory floor
    avail = mem_available_mb()
    if avail is not None and avail < floor_mb:
        say("MemAvailable %d MB < required %d MB; waiting up to %ds"
            % (avail, floor_mb, max(0, round(deadline - time.monotonic()))))
        log({"event": "wait", "reason": "memory", "label": label, "mem_avail_mb": avail,
             "need_mb": floor_mb})
        unloaded = unload_ollama()
        if unloaded:
            say("unloaded idle ollama model(s): %s" % ", ".join(unloaded))
            log({"event": "ollama_unload", "label": label, "models": unloaded})
            time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))
            avail = mem_available_mb()
        while avail is not None and avail < floor_mb and time.monotonic() < deadline:
            time.sleep(min(poll_sec(), max(0.01, deadline - time.monotonic())))
            avail = mem_available_mb()
    if avail is None:
        # fail closed: no measurement, no admission
        say("REFUSED: cannot read MemAvailable from %s, so the memory floor cannot be checked. "
            "Not started." % meminfo_path())
        log({"event": "refuse", "reason": "meminfo_error", "label": label, "cmd": cmd_text,
             "meminfo": meminfo_path(), "need_mb": floor_mb,
             "waited_sec": round(time.monotonic() - t0, 1), "exit": EXIT_MEM_TIMEOUT})
        os.close(fd)
        return EXIT_MEM_TIMEOUT
    if avail < floor_mb:
        say("REFUSED: MemAvailable %d MB stayed below the required %d MB for %ds "
            "(cap %d MB + %d MB reserve, or --min-mb). Not started. Free memory or retry later."
            % (avail, floor_mb, wait_sec, cap_mb, reserve))
        log({"event": "refuse", "reason": "memory_timeout", "label": label, "cmd": cmd_text,
             "mem_avail_mb": avail, "need_mb": floor_mb,
             "waited_sec": round(time.monotonic() - t0, 1), "exit": EXIT_MEM_TIMEOUT})
        os.close(fd)
        return EXIT_MEM_TIMEOUT

    # 3. run, capped
    if lane_tail != carry_tail:
        write_record(lane_tail)  # admitted: now this job counts in the short lane
    env = dict(os.environ, HEAVY_JOB_ACTIVE="1", HEAVY_JOB_TOKEN=token)
    if scoped:
        argv_run = ["systemd-run", "--user", "--scope", "--collect", "--quiet",
                    "--unit=" + unit,
                    "-p", "TimeoutStopSec=" + SCOPE_STOP_TIMEOUT,
                    # normalized to MB: systemd reads a bare number as BYTES and
                    # may reject a lowercase suffix, while this gate documents
                    # a bare number as MB and accepts '2g'.
                    "-p", "MemoryMax=%dM" % cap_mb,
                    "-p", "MemorySwapMax=%dM" % swap_mb,
                    "--"] + cmd
    else:
        argv_run = list(cmd)   # only reachable with --allow-uncapped (logged above)

    start_rec = {"event": "start", "label": label, "cmd": cmd_text, "unit": unit if scoped else None,
                 "capped": scoped,
                 "max_mem": "%dM" % cap_mb, "swap_max": "%dM" % swap_mb, "mem_avail_mb": avail,
                 "need_mb": floor_mb, "waited_sec": round(time.monotonic() - t0, 1)}
    if max_sec is not None:
        start_rec["max_sec"] = max_sec
    if agent:
        start_rec["agent"] = agent
    if my_short:
        start_rec["short"] = True
    if streak:
        start_rec["passed"] = [lbl for _, lbl in passed]
        start_rec["short_streak"] = streak
    log(start_rec)
    t_start = time.monotonic()
    try:
        code, stats = run_child(argv_run, env, unit=unit if scoped else None, max_sec=max_sec)
    except OSError as e:
        say("cannot run command: %s" % e)
        code, stats = 127, {}
    dur = round(time.monotonic() - t_start, 1)
    rec = {"event": "finish", "label": label, "exit": code, "dur_sec": dur,
           "unit": unit if scoped else None}
    rec.update({k: v for k, v in stats.items() if v})
    if stats.get("max_sec_exceeded"):
        rec["killed_exit"] = stats.get("killed_exit")  # kept even when 0
    # A SIGKILL/SIGTERM death of a capped job is either its own memory cap or a
    # sender outside the gate (the host OOM killer, a watchdog, a person). The
    # gate deliberately makes no claim about which: the journal
    # ("<unit>.scope: Failed with result 'oom-kill'") has the answer.
    if stats.get("scope_stop") in ("leftover", "unverified"):
        say("WARNING: the job's scope %s could not be verified empty after the job ended (%s); "
            "a descendant may still be running" % (unit, stats.get("scope_stop")))
    if stats.get("max_sec_exceeded"):
        say("STOPPED: the job was still running after --max-sec %ds and was stopped by the gate "
            "(whole scope); exit %d (the killed job's own code: %s)"
            % (max_sec, EXIT_RUNTIME_LIMIT, stats.get("killed_exit")))
    if scoped and code in (137, 143) and not stats.get("forwarded_signals"):
        signame = "SIGKILL" if code == 137 else "SIGTERM"
        rec["stopped_by_signal"] = signame
        say("the job was stopped by %s: either its memory cap or a sender outside the gate; "
            "see journalctl --user -u %s.scope" % (signame, unit))
    log(rec)
    os.close(fd)  # releases the flock
    return code


if __name__ == "__main__":
    sys.exit(main())
