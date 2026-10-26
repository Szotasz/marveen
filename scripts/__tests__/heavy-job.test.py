#!/usr/bin/env python3
"""Behaviour tests for scripts/heavy-job.py (the heavy-job admission gate).

Run: python3 scripts/__tests__/heavy-job.test.py

Mostly hermetic: a fake /proc/meminfo, a temp lock and a temp log, and a FAKE
`systemd-run` and `systemctl` first on PATH (systemd-run records its argv on
request and execs the command after "--"; both can drive a fake scope cgroup
under a temp dir), so those sections never touch the user manager.

The LIVE section at the end uses the real systemd-run/systemctl: it creates a
few small transient heavy-job-*.scope units (sleep/sh/true, 200M cap) to
check the scope teardown and the cgroup-based nested check. It is skipped when
no user scope can be created, or with HEAVY_JOB_TEST_NO_LIVE=1.
"""
import sys

# Linux only, like the gate itself (systemd --user scopes, cgroup v2, /proc). On any other
# platform the gate refuses every call with 77 by design, so nothing here can be measured:
# report a counted skip (the script-tests-runner contract: exit 77 plus a reason line)
# instead of a wall of FAILs. This runs before anything platform-specific is touched.
if not sys.platform.startswith("linux"):
    print("SKIP (control unmet): heavy-job gate is Linux only (systemd --user scopes, cgroup v2, "
          "/proc/meminfo); sys.platform is %r" % sys.platform)
    sys.exit(77)

import fcntl
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GATE = os.path.join(ROOT, "scripts", "heavy-job.py")
WRAPPER = os.path.join(ROOT, "scripts", "heavy-job.sh")

spec = importlib.util.spec_from_file_location("heavy_job", GATE)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

fails = []


def check(name, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + name + ((" -- " + str(extra)) if (extra and not cond) else ""))
    if not cond:
        fails.append(name)


def write_meminfo(path, avail_mb):
    with open(path + ".tmp", "w") as f:
        f.write("MemTotal:        8130352 kB\nMemFree:          100000 kB\n"
                "MemAvailable:   %8d kB\nSwapFree:        4000000 kB\n" % (avail_mb * 1024))
    os.replace(path + ".tmp", path)


FAKE_SYSTEMD_RUN = r"""#!/bin/sh
# probe (no "--"): exit $FAKE_SR_PROBE_RC; job: record argv, then exec the
# command after "--"
has_dd=0
for a in "$@"; do
  case "$a" in --) has_dd=1;; esac
done
if [ -n "$FAKE_SR_ARGS" ]; then printf "%s
" "$@" >> "$FAKE_SR_ARGS"; echo ---- >> "$FAKE_SR_ARGS"; fi
[ "$has_dd" = 0 ] && exit "${FAKE_SR_PROBE_RC:-0}"
unit=
memmax=
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in
    --unit=*) unit="${1#--unit=}";;
    MemoryMax=*M) memmax="${1#MemoryMax=}"; memmax="${memmax%M}";;
  esac
  shift
done
shift
if [ -n "$FAKE_CGFS" ] && [ -n "$unit" ] && [ "$FAKE_SR_NO_CG" != 1 ]; then
  # a fake scope cgroup with the memory.max systemd would set (or
  # $FAKE_SR_MEMMAX); with FAKE_CG_REGISTER=1 the job registers itself (and,
  # cooperatively, its background children) in cgroup.procs, which the fake
  # systemctl reads and kills on stop
  d="$FAKE_CGFS/fake/$unit.scope"
  mkdir -p "$d"
  : > "$d/cgroup.procs"
  if [ -n "$FAKE_SR_MEMMAX" ]; then echo "$FAKE_SR_MEMMAX" > "$d/memory.max"
  elif [ -n "$memmax" ]; then echo $(( memmax * 1048576 )) > "$d/memory.max"; fi
  if [ "$FAKE_CG_REGISTER" = 1 ]; then echo $$ > "$d/cgroup.procs"; fi
  export FAKE_CG_PROCS="$d/cgroup.procs"
fi
exec "$@"
"""

FAKE_SYSTEMCTL = r"""#!/bin/sh
# fake `systemctl --user show -p ControlGroup --value U | stop U` over $FAKE_CGFS
[ -n "$FAKE_SC_LOG" ] && echo "$*" >> "$FAKE_SC_LOG"
[ "$1" = "--user" ] && shift
verb="$1"; shift
for a in "$@"; do unit="$a"; done
if [ "$verb" = show ] && [ "$unit" = "--value" ]; then
  # the user manager's own cgroup (no unit named)
  echo "${FAKE_MANAGER_CG:-/fake-manager}"
  exit 0
fi
[ "$FAKE_SC_FAIL" = 1 ] && exit 1
d="$FAKE_CGFS/fake/$unit"
case "$verb" in
  show)
    if [ "$FAKE_SC_GHOST" = 1 ]; then echo "/ghost/$unit"; exit 0; fi
    [ -n "$FAKE_CGFS" ] && [ -d "$d" ] && echo "/fake/$unit"
    exit 0;;
  stop)
    [ "$FAKE_SC_GHOST" = 1 ] && exit 0
    [ -n "$FAKE_CGFS" ] && [ -d "$d" ] || exit 5
    [ "$FAKE_SC_STOP_NOOP" = 1 ] && exit 0
    for p in $(cat "$d/cgroup.procs"); do kill -KILL "$p" 2>/dev/null; done
    rm -rf "$d"
    exit 0;;
esac
exit 1
"""


def gone(pid):
    """True if pid no longer runs (missing, or a zombie waiting for its reaper)."""
    try:
        with open("/proc/%d/stat" % pid) as f:
            return f.read().rsplit(")", 1)[1].split()[0] == "Z"
    except OSError:
        return True


def own_hup_job(started):
    """Python job that installs its OWN SIGHUP handler (exit 9), as programs that do
    not keep an inherited ignore do; it exits 5 if no SIGHUP reaches it."""
    return ("import signal,sys,time\n"
            "signal.signal(signal.SIGHUP, lambda *a: sys.exit(9))\n"
            "open(%r, 'w').close()\n"
            "time.sleep(1)\n"
            "sys.exit(5)\n" % started)


def shq(text):
    return "'" + text.replace("'", "'\\''") + "'"


def lock_free(path):
    fd = os.open(path, os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    except BlockingIOError:
        return False
    finally:
        os.close(fd)


def read_pid(path, bound=5.0):
    end = time.monotonic() + bound
    while time.monotonic() < end:
        try:
            with open(path) as f:
                return int(f.read().split()[0])
        except (OSError, ValueError, IndexError):
            time.sleep(0.05)
    return None


class Env:
    def __init__(self, td, avail_mb=6000, live=False):
        """live=True: the REAL systemd-run/systemctl (real transient scopes), only
        meminfo/lock/log stay fake."""
        self.meminfo = os.path.join(td, "meminfo")
        self.lock = os.path.join(td, "gate.lock")
        self.log = os.path.join(td, "log.jsonl")
        self.bin = os.path.join(td, "livebin" if live else "fakebin")
        os.makedirs(self.bin, exist_ok=True)
        if not live:
            for name, body in (("systemd-run", FAKE_SYSTEMD_RUN), ("systemctl", FAKE_SYSTEMCTL)):
                with open(os.path.join(self.bin, name), "w") as f:
                    f.write(body)
                os.chmod(os.path.join(self.bin, name), 0o755)
        write_meminfo(self.meminfo, avail_mb)
        self.live = live
        # a fake cgroup2 root (mount table entry + the user manager's
        # cgroup.controllers with "memory"); the fake systemd-run makes each
        # job's scope cgroup there, with the memory.max systemd would set
        self.cgfs = os.path.join(td, "cg")
        self.mounts = os.path.join(td, "mounts")
        os.makedirs(os.path.join(self.cgfs, "fake-manager"), exist_ok=True)
        with open(os.path.join(self.cgfs, "fake-manager", "cgroup.controllers"), "w") as f:
            f.write("cpu memory pids\n")
        with open(self.mounts, "w") as f:
            f.write("proc /proc proc rw 0 0\ncgroup2 %s cgroup2 rw,nosuid 0 0\n" % self.cgfs)

    def env(self, **extra):
        e = dict(os.environ)
        for k in ("HEAVY_JOB_ACTIVE", "HEAVY_JOB_TOKEN", "HEAVY_JOB_NO_SCOPE"):
            e.pop(k, None)
        e.update({"HEAVY_JOB_MEMINFO": self.meminfo, "HEAVY_JOB_LOCK": self.lock,
                  "HEAVY_JOB_LOG": self.log,
                  "PATH": self.bin + os.pathsep + os.environ.get("PATH", ""),
                  "HEAVY_JOB_POLL_SEC": "0.1",
                  # never touch the real ollama from a test
                  "HEAVY_JOB_OLLAMA_URL": "off"})
        if not self.live:
            e.update({"FAKE_CGFS": self.cgfs, "HEAVY_JOB_CGROUP_FS": self.cgfs,
                      "HEAVY_JOB_MOUNTS": self.mounts})
        e.update(extra)
        return e

    def run(self, args, timeout=30, **extra):
        return subprocess.run([WRAPPER] + args, env=self.env(**extra), capture_output=True,
                              text=True, timeout=timeout)

    def events(self):
        try:
            with open(self.log) as f:
                return [json.loads(l) for l in f if l.strip()]
        except OSError:
            return []


def live_scope_ok():
    """The live sections need what the gate itself needs: a scope that can be
    created AND a cgroup2 root with the memory controller delegated (the
    gate's own check, against the real mount table and user manager)."""
    saved = {k: os.environ.pop(k) for k in list(os.environ)
             if k in ("HEAVY_JOB_CGROUP_FS", "HEAVY_JOB_MOUNTS", "HEAVY_JOB_NO_SCOPE")}
    try:
        return gate.scope_available()[0]
    finally:
        os.environ.update(saved)


def main():
    # --- pure helpers
    check("parse_size_mb 2G = 2048", gate.parse_size_mb("2G") == 2048)
    check("parse_size_mb 300M = 300", gate.parse_size_mb("300M") == 300)
    check("parse_size_mb 1536 = 1536", gate.parse_size_mb("1536") == 1536)
    try:
        gate.parse_size_mb("lots")
        check("parse_size_mb rejects garbage", False)
    except ValueError:
        check("parse_size_mb rejects garbage", True)

    with tempfile.TemporaryDirectory() as td:
        E = Env(td)

        # --- usage errors
        p = E.run(["echo", "x"])
        check("missing -- is a usage error (64)", p.returncode == 64, "rc=%s" % p.returncode)
        p = E.run(["--min-mb", "abc", "--", "true"])
        check("non-integer --min-mb is a usage error (64)", p.returncode == 64)

        # --- exit code propagation
        p = E.run(["--", "sh", "-c", "exit 7"])
        check("command exit code 7 propagated", p.returncode == 7, "rc=%s" % p.returncode)
        p = E.run(["--", "true"])
        check("command exit code 0 propagated", p.returncode == 0)
        p = E.run(["--", "sh", "-c", "kill -9 $$"])
        check("signal death -> 128+9 = 137", p.returncode == 137, "rc=%s" % p.returncode)
        p = E.run(["--", "/nonexistent/binary-xyz"])
        check("missing binary -> 127", p.returncode == 127, "rc=%s" % p.returncode)

        # --- child sees HEAVY_JOB_ACTIVE=1
        p = E.run(["--", "sh", "-c", 'test "$HEAVY_JOB_ACTIVE" = 1'])
        check("child gets HEAVY_JOB_ACTIVE=1", p.returncode == 0)

        p = E.run(["--help"])
        check("--help: usage (64) that says Linux only and lists the exit codes",
              p.returncode == 64 and "Linux only" in p.stderr and "77" in p.stderr, p.stderr)

        ev = E.events()
        kinds = [e["event"] for e in ev]
        check("start and finish lines logged", "start" in kinds and "finish" in kinds, str(kinds))
        fin = [e for e in ev if e["event"] == "finish"]
        check("finish line carries the exit code", any(e.get("exit") == 7 for e in fin))

    # --- not Linux (stubbed platform check): every call refused 77, nothing created
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        marker = os.path.join(td, "ran")
        qdir = os.path.join(td, ".heavy-job-queue")
        for extra, why in (([], "plain call"), (["--allow-uncapped"], "--allow-uncapped")):
            p = E.run(extra + ["--label", "MAC", "--", "touch", marker], HEAVY_JOB_PLATFORM="darwin")
            ev = E.events()
            check("platform darwin, %s: refused 77, not run" % why,
                  p.returncode == 77 and not os.path.exists(marker), (p.returncode, p.stderr))
            check("platform darwin, %s: clear message, refuse line reason=unsupported_platform" % why,
                  "needs Linux" in p.stderr and ev and ev[-1].get("event") == "refuse"
                  and ev[-1].get("reason") == "unsupported_platform"
                  and ev[-1].get("platform") == "darwin" and ev[-1].get("exit") == 77, (p.stderr, ev[-1:]))
        p = E.run(["--", "touch", marker], HEAVY_JOB_PLATFORM="darwin", HEAVY_JOB_ACTIVE="1",
                  HEAVY_JOB_TOKEN="x")
        check("platform darwin, nested env set: still refused 77 (no nested shortcut)",
              p.returncode == 77 and not os.path.exists(marker), p.returncode)
        check("platform darwin: no lock file and no queue directory were created",
              not os.path.exists(E.lock) and not os.path.exists(qdir), os.listdir(td))
        p = E.run(["--", "touch", marker], HEAVY_JOB_PLATFORM="linux")
        check("platform check control: linux -> admitted and run",
              p.returncode == 0 and os.path.exists(marker), (p.returncode, p.stderr))

    # --- memory refusal: floor not reached, command must NOT run
    with tempfile.TemporaryDirectory() as td:
        E = Env(td, avail_mb=1000)
        marker = os.path.join(td, "ran")
        t0 = time.monotonic()
        p = E.run(["--min-mb", "2000", "--max-mem", "100M", "--wait-sec", "1", "--",
                   "touch", marker])
        dt = time.monotonic() - t0
        check("low memory -> refused with 75", p.returncode == 75, "rc=%s" % p.returncode)
        check("refused command did not run", not os.path.exists(marker))
        check("refusal waited ~--wait-sec (>=0.9s)", dt >= 0.9, "dt=%.2f" % dt)
        check("refusal message is clear", "REFUSED" in p.stderr and "MemAvailable" in p.stderr,
              p.stderr)
        ev = E.events()
        check("wait + refuse logged",
              [e["event"] for e in ev] == ["wait", "refuse"]
              and ev[1].get("reason") == "memory_timeout", str(ev))

    # --- floor = max(--min-mb, cap + reserve)
    with tempfile.TemporaryDirectory() as td:
        E = Env(td, avail_mb=2400)
        p = E.run(["--min-mb", "0", "--max-mem", "2G", "--wait-sec", "0", "--", "true"])
        check("2G cap needs 2548 MB free: 2400 refused", p.returncode == 75, "rc=%s" % p.returncode)
        p = E.run(["--min-mb", "0", "--max-mem", "1G", "--wait-sec", "0", "--", "true"])
        check("1G cap needs 1524 MB free: 2400 admitted", p.returncode == 0, "rc=%s" % p.returncode)

    # --- wait, then memory recovers, then run
    with tempfile.TemporaryDirectory() as td:
        E = Env(td, avail_mb=500)
        threading.Timer(1.0, write_meminfo, (E.meminfo, 5000)).start()
        t0 = time.monotonic()
        p = E.run(["--min-mb", "2000", "--max-mem", "100M", "--wait-sec", "20", "--", "true"])
        dt = time.monotonic() - t0
        check("waits for memory then runs (exit 0)", p.returncode == 0, "rc=%s" % p.returncode)
        check("it actually waited (>=0.9s) and not the full timeout (<10s)", 0.9 <= dt < 10,
              "dt=%.2f" % dt)
        kinds = [e["event"] for e in E.events()]
        check("wait -> start -> finish logged", kinds == ["wait", "start", "finish"], str(kinds))

    # --- memory short: idle ollama models are unloaded (fake ollama server)
    calls = []
    ps_payload = [json.dumps({"models": [{"name": "nomic-embed-text:latest"}]}).encode()]

    class FakeOllama(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = ps_payload[0]
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            calls.append(("GET", self.path))

        def do_POST(self):
            n = int(self.headers.get("Content-Length", "0"))
            calls.append(("POST", self.path, json.loads(self.rfile.read(n).decode())))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

    srv = HTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as td:
        E = Env(td, avail_mb=1000)
        url = "http://127.0.0.1:%d" % srv.server_address[1]
        p = E.run(["--min-mb", "2000", "--max-mem", "100M", "--wait-sec", "1", "--", "true"],
                  HEAVY_JOB_OLLAMA_URL=url)
        post = [c for c in calls if c[0] == "POST"]
        check("memory short -> ollama model unloaded with keep_alive=0",
              post and post[0][1] == "/api/generate"
              and post[0][2] == {"model": "nomic-embed-text:latest", "keep_alive": 0}, calls)
        check("ollama_unload logged",
              "ollama_unload" in [e["event"] for e in E.events()], E.events())
        check("still refused when unloading was not enough (75)", p.returncode == 75)
        calls.clear()
        E2 = Env(td, avail_mb=6000)
        E2.run(["--", "true"], HEAVY_JOB_OLLAMA_URL=url)
        check("enough memory -> ollama untouched", calls == [], calls)

        # /api/ps is external input; malformed payloads must neither crash nor admit
        for name, payload in [
                ("mixed junk entries", {"models": ["x", 5, None, {"name": 7}, {"model": "good:1"}]}),
                ("top-level list", ["a", {"name": "b"}]),
                ("models is a string", {"models": "nomic"}),
                ("not JSON", None)]:
            ps_payload[0] = b"not json {" if payload is None else json.dumps(payload).encode()
            calls.clear()
            E3 = Env(td, avail_mb=1000)
            p = E3.run(["--min-mb", "2000", "--max-mem", "100M", "--wait-sec", "1", "--", "true"],
                       HEAVY_JOB_OLLAMA_URL=url)
            post = [c[2]["model"] for c in calls if c[0] == "POST"]
            check("ollama %s: no crash, still refused (75)" % name,
                  p.returncode == 75 and "Traceback" not in p.stderr, (p.returncode, p.stderr[-300:]))
            want = ["good:1"] if name == "mixed junk entries" else []
            check("ollama %s: only valid names unloaded %s" % (name, want), post == want, post)
    srv.shutdown()

    # --- a gate that cannot measure does not admit (exit 75, meminfo_error)
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        marker = os.path.join(td, "ran")
        os.remove(E.meminfo)
        p = E.run(["--wait-sec", "1", "--", "touch", marker])
        ev = E.events()
        check("meminfo unreadable at admission -> refused 75", p.returncode == 75, "rc=%s" % p.returncode)
        check("meminfo unreadable: command did not run", not os.path.exists(marker))
        check("meminfo unreadable: refuse line with reason=meminfo_error",
              ev and ev[-1]["event"] == "refuse" and ev[-1].get("reason") == "meminfo_error", ev)
        with open(E.meminfo, "w") as f:
            f.write("MemTotal:        8130352 kB\nMemFree:          100000 kB\n")
        p = E.run(["--wait-sec", "1", "--", "touch", marker])
        check("MemAvailable line missing -> refused 75", p.returncode == 75 and not os.path.exists(marker))
        with open(E.meminfo, "w") as f:
            f.write("MemAvailable:   lots kB\n")
        p = E.run(["--wait-sec", "1", "--", "touch", marker])
        check("MemAvailable unparsable -> refused 75", p.returncode == 75 and not os.path.exists(marker))
    with tempfile.TemporaryDirectory() as td:
        E = Env(td, avail_mb=500)
        marker = os.path.join(td, "ran")

        def break_meminfo():
            with open(E.meminfo + ".tmp", "w") as f:
                f.write("MemTotal:        8130352 kB\n")
            os.replace(E.meminfo + ".tmp", E.meminfo)
        threading.Timer(0.5, break_meminfo).start()
        t0 = time.monotonic()
        p = E.run(["--min-mb", "2000", "--max-mem", "100M", "--wait-sec", "20", "--", "touch", marker])
        dt = time.monotonic() - t0
        ev = E.events()
        check("meminfo breaks mid-wait -> refused 75 (not admitted)", p.returncode == 75
              and not os.path.exists(marker), "rc=%s" % p.returncode)
        check("mid-wait meminfo error refuses promptly (<10s)", dt < 10, "dt=%.2f" % dt)
        check("mid-wait: refuse line is meminfo_error", ev[-1].get("reason") == "meminfo_error", ev)

    # --- the lock wait lines carry MemAvailable and the holder's live
    # scope memory (measurement only; the start line's value is read after the
    # lock is released, so it cannot show headroom during the wait)
    with tempfile.TemporaryDirectory() as td:
        E = Env(td, avail_mb=4321)
        cgfs = os.path.join(td, "cg")
        unit = "heavy-job-1-42"
        scope = os.path.join(cgfs, "fake", unit + ".scope")
        os.makedirs(scope)
        with open(os.path.join(scope, "memory.current"), "w") as f:
            f.write("%d\n" % (653 * 1024 * 1024))
        with open(os.path.join(scope, "memory.max"), "w") as f:
            f.write("%d\n" % (2048 * 1024 * 1024))
        fd = os.open(E.lock, os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.write(fd, ("token=x pid=1 unit=%s since=x label=holder\n" % unit).encode())
        fake = {"FAKE_CGFS": cgfs, "HEAVY_JOB_CGROUP_FS": cgfs}
        p = E.run(["--wait-sec", "1", "--label", "waiter", "--", "true"], **fake)
        ev = E.events()
        w = [e for e in ev if e["event"] == "wait" and e.get("reason") == "lock"]
        r = [e for e in ev if e.get("reason") == "lock_timeout"]
        want = {"mem_avail_mb": 4321, "holder_mem_mb": 653, "holder_max_mb": 2048}
        check("wait/lock line: mem_avail_mb + holder_mem_mb + holder_max_mb",
              p.returncode == 73 and w and all(w[-1].get(k) == v for k, v in want.items()), (p.returncode, w))
        check("lock_timeout line: the same three fields",
              r and all(r[-1].get(k) == v for k, v in want.items()), r)
        with open(os.path.join(scope, "memory.max"), "w") as f:
            f.write("max\n")
        p = E.run(["--wait-sec", "1", "--", "true"], **fake)
        w = [e for e in E.events() if e["event"] == "wait" and e.get("reason") == "lock"]
        check("holder scope with no cap: holder_max_mb is None, current still read",
              w[-1].get("holder_max_mb") is None and w[-1].get("holder_mem_mb") == 653, w[-1])
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, 0)
        os.write(fd, b"token=x pid=1 unit=- since=x label=uncapped\n")
        p = E.run(["--wait-sec", "1", "--", "true"], **fake)
        w = [e for e in E.events() if e["event"] == "wait" and e.get("reason") == "lock"]
        check("uncapped holder (unit=-): holder fields None, mem_avail_mb still logged, still 73",
              p.returncode == 73 and w[-1].get("mem_avail_mb") == 4321
              and w[-1].get("holder_mem_mb") is None and "holder_mem_mb" in w[-1], w[-1])
        os.close(fd)

    # --- lock exclusivity
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        fd = os.open(E.lock, os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.write(fd, b"pid=1 label=test-holder")
        marker = os.path.join(td, "ran")
        p = E.run(["--wait-sec", "1", "--", "touch", marker])
        check("held lock -> refused with 73", p.returncode == 73, "rc=%s" % p.returncode)
        check("lock-refused command did not run", not os.path.exists(marker))
        check("lock refusal names the holder", "test-holder" in p.stderr, p.stderr)
        check("lock refusal names the holder pid and that it is alive",
              "holder pid 1 (alive)" in p.stderr, p.stderr)
        rf = [e for e in E.events() if e.get("reason") == "lock_timeout"]
        check("lock_timeout line carries holder_pid/holder_alive",
              rf and rf[-1].get("holder_pid") == 1 and rf[-1].get("holder_alive") is True, rf)
        dead = subprocess.Popen(["true"])
        dead.wait()
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, 0)
        os.write(fd, ("token=x pid=%d unit=- since=x label=gone" % dead.pid).encode())
        p = E.run(["--wait-sec", "1", "--", "touch", marker])
        check("dead holder pid is named as NOT alive", p.returncode == 73
              and ("holder pid %d (NOT alive)" % dead.pid) in p.stderr, p.stderr)

        # HEAVY_JOB_ACTIVE alone is NOT trusted (lock held, but no token)
        p = E.run(["--wait-sec", "1", "--", "touch", marker], HEAVY_JOB_ACTIVE="1")
        check("ACTIVE=1 without a token -> normal call -> waits, refused 73",
              p.returncode == 73 and not os.path.exists(marker), "rc=%s" % p.returncode)
        p = E.run(["--wait-sec", "1", "--", "touch", marker], HEAVY_JOB_ACTIVE="1",
                  HEAVY_JOB_TOKEN="deadbeef")
        ev = E.events()
        check("ACTIVE=1 with a token the lock does not carry -> refused 73, nested_unverified logged",
              p.returncode == 73 and any(e["event"] == "nested_unverified"
                                         and e.get("reason") == "token_mismatch" for e in ev),
              "rc=%s" % p.returncode)

        # lock held AND the token matches, but the caller is NOT inside the
        # scope the record names (a descendant that escaped, or anyone with the env):
        # not verified -> a normal call -> waits for the lock -> 73, command not run
        tok = {"HEAVY_JOB_ACTIVE": "1", "HEAVY_JOB_TOKEN": "cafe1234"}

        def set_record(data):
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, 0)
            os.write(fd, data)

        def last_unverified():
            u = [e for e in E.events() if e["event"] == "nested_unverified"]
            return u[-1].get("reason") if u else None
        set_record(b"token=cafe1234 pid=1 unit=heavy-job-1-1 since=x label=outer\n")
        p = E.run(["--wait-sec", "1", "--", "touch", marker], **tok)
        check("token matches but caller not in the recorded scope -> not verified, refused 73",
              p.returncode == 73 and not os.path.exists(marker) and last_unverified() == "not_in_scope",
              (p.returncode, last_unverified()))
        set_record(b"token=cafe1234 pid=1 unit=- since=x label=outer\n")
        p = E.run(["--wait-sec", "1", "--", "touch", marker], **tok)
        check("record without a scope unit (uncapped holder) -> no_scope_unit, refused 73",
              p.returncode == 73 and last_unverified() == "no_scope_unit", (p.returncode, last_unverified()))
        # a record read must not truncate the token away (the old reader kept 300 chars)
        set_record(b"pid=1 label=" + b"x" * 1000 + b" unit=heavy-job-1-1 token=cafe1234\n")
        p = E.run(["--wait-sec", "1", "--", "true"], **tok)
        check("token after 1000 bytes of record is still found (not_in_scope, not token_mismatch)",
              last_unverified() == "not_in_scope", last_unverified())
        check("the token is never printed or logged",
              "cafe1234" not in p.stderr
              and not any("cafe1234" in json.dumps(e) for e in E.events()), p.stderr)
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)

        # lock not held any more (the outer job ended; a daemon kept the env)
        p = E.run(["--wait-sec", "1", "--", "true"], **tok)
        ev = E.events()
        check("ACTIVE+token but lock not held -> normal gated run (start/finish, lock_not_held)",
              p.returncode == 0 and ev[-1]["event"] == "finish" and ev[-2]["event"] == "start"
              and any(e.get("reason") == "lock_not_held" for e in ev), [e["event"] for e in ev[-4:]])

        # with the FAKE systemd-run there is no real scope, so a job calling the gate
        # again is NOT verified (the live section checks the verified path)
        inner = "%s --wait-sec 1 -- sh -c 'exit 6'" % WRAPPER
        p = E.run(["--wait-sec", "5", "--", "sh", "-c", inner])
        check("nested call outside a real scope: not verified, inner refused 73",
              p.returncode == 73 and last_unverified() == "not_in_scope", (p.returncode, p.stderr))

        # the lock record the gate writes: token FIRST; the job does not inherit the lock fd
        out = os.path.join(td, "job-view")
        p = E.run(["--", "sh", "-c", 'cat "$HEAVY_JOB_LOCK" > %s; echo >> %s; '
                   'ls -l /proc/$$/fd >> %s' % (out, out, out)])
        with open(out) as f:
            view = f.read()
        check("lock record starts with token=, names pid and unit",
              view.startswith("token=") and " pid=" in view and " unit=heavy-job-" in view, view[:200])
        check("the job does not hold the lock fd", E.lock not in view.split("\n", 1)[1], view)

        # two concurrent jobs must not overlap
        stamps = os.path.join(td, "stamps")
        job = ('python3 -c "import time,sys;f=open(sys.argv[1],\'a\');'
               'f.write(\'S %.3f\\n\'%time.time());f.flush();time.sleep(0.8);'
               'f.write(\'E %.3f\\n\'%time.time())" ' + stamps)
        procs = [subprocess.Popen([WRAPPER, "--wait-sec", "20", "--", "sh", "-c", job],
                                  env=E.env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                 for _ in range(2)]
        rcs = [pr.wait(timeout=30) for pr in procs]
        with open(stamps) as f:
            lines = [l.split() for l in f if l.strip()]
        seq = [k for k, _ in lines]
        check("two concurrent jobs both succeed", rcs == [0, 0], str(rcs))
        check("jobs are serialized (S E S E, no overlap)", seq == ["S", "E", "S", "E"], str(seq))

    # --- FIFO ticket queue in front of the lock
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        qdir = os.path.join(td, ".heavy-job-queue")  # default: next to the lock
        order = os.path.join(td, "order")
        marker = os.path.join(td, "ran")

        def tickets():
            try:
                return sorted(os.listdir(qdir))
            except OSError:
                return []

        def hold():
            fd = os.open(E.lock, os.O_RDWR | os.O_CREAT, 0o644)
            fcntl.flock(fd, fcntl.LOCK_EX)
            os.ftruncate(fd, 0)
            os.write(fd, b"pid=1 label=queue-holder")
            return fd

        def waiter(name, poll, wait_sec=30, preexec_fn=None, job=None):
            job = job or "echo %s >> %s; sleep 0.3" % (name, order)
            return subprocess.Popen([WRAPPER, "--wait-sec", str(wait_sec), "--label", name, "--",
                                     "sh", "-c", job], env=E.env(HEAVY_JOB_POLL_SEC=str(poll)),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                    preexec_fn=preexec_fn)

        def last_line(label):
            ev = [e for e in E.events() if e.get("label") == label]
            return ev[-1] if ev else {}

        def wait_line(label, bound=10):
            end = time.monotonic() + bound
            while time.monotonic() < end:
                w = [e for e in E.events() if e["event"] == "wait" and e.get("label") == label]
                if w:
                    return w[-1]
                time.sleep(0.02)
            return None

        def read_order():
            try:
                with open(order) as f:
                    return f.read().split()
            except OSError:
                return []

        def put_ticket(ns, pid, label, start="auto", raw=None):
            os.makedirs(qdir, exist_ok=True)
            path = os.path.join(qdir, "%020d-%010d.ticket" % (ns, pid))
            if start == "auto":
                start = gate.proc_stat(pid)[1]
            with open(path, "w") as f:
                f.write(raw if raw is not None else
                        json.dumps({"pid": pid, "start": start, "label": label, "created": "x"}))
            return path

        # (1) A, B, C queue up behind a held lock, in that order. The LATER ones poll
        # FASTER (A 1.0s, B 0.5s, C 0.1s), so without the queue C would win the race.
        fd = hold()
        procs = []
        for name, poll in (("A", 1.0), ("B", 0.5), ("C", 0.1)):
            procs.append(waiter(name, poll))
            wait_line(name)  # its ticket exists before the next one arrives
        waits = {n: wait_line(n) for n in "ABC"}
        check("FIFO: wait lines carry the queue position A=1, B=2, C=3",
              [(waits[n] or {}).get("queue_pos") for n in "ABC"] == [1, 2, 3], waits)
        check("FIFO: C's wait line lists the labels ahead [A, B]",
              (waits["C"] or {}).get("ahead") == ["A", "B"], waits["C"])
        check("FIFO: three live tickets while they wait", len(tickets()) == 3, tickets())
        os.close(fd)
        outs = [p.communicate(timeout=30) for p in procs]
        rcs = [p.returncode for p in procs]
        check("FIFO: A, B, C all run (exit 0)", rcs == [0, 0, 0], rcs)
        check("FIFO: they acquire in arrival order A, B, C", read_order() == ["A", "B", "C"],
              read_order())
        check("FIFO: C's stderr prints its queue position",
              "queue position 3 (ahead: A, B)" in outs[2][1], outs[2][1])
        check("FIFO: no ticket left after all three ran", tickets() == [], tickets())

        # (2) a late arrival does not barge in when the lock is free but an older
        # live ticket exists: A2 (slow poll) is queued, the lock is released, and D
        # (fast poll) arrives while A2 has not polled yet
        os.remove(order)
        fd = hold()
        a2 = waiter("A2", 3.0)
        wait_line("A2")
        os.close(fd)
        d = waiter("D", 0.1)
        wd = wait_line("D")
        for p in (a2, d):
            p.communicate(timeout=30)
        check("no barging: D waited behind A2 (queue_pos 2, ahead [A2])",
              wd and wd.get("queue_pos") == 2 and wd.get("ahead") == ["A2"], wd)
        check("no barging: A2 ran before D although D polled faster and the lock was free",
              read_order() == ["A2", "D"] and a2.returncode == 0 and d.returncode == 0,
              (read_order(), a2.returncode, d.returncode))

        # (2b) deterministic: lock free, an older LIVE ticket -> not admitted, 73
        blocker = subprocess.Popen(["sleep", "30"])
        older = put_ticket(1, blocker.pid, "older-live")
        p = E.run(["--wait-sec", "1", "--label", "D2", "--", "touch", marker])
        rf = E.events()[-1]
        check("no barging: free lock + older live ticket -> refused 73, not run",
              p.returncode == 73 and not os.path.exists(marker), (p.returncode, p.stderr))
        check("no barging: refuse line says sor_hely 2 behind [older-live]",
              rf.get("reason") == "lock_timeout" and rf.get("queue_pos") == 2
              and rf.get("ahead") == ["older-live"], rf)
        check("no barging: the older live ticket is kept, D2's own ticket is gone",
              tickets() == [os.path.basename(older)], tickets())

        # (3) stale tickets do not block: the same ticket once its owner is dead
        blocker.kill()
        blocker.wait()
        t0 = time.monotonic()
        p = E.run(["--wait-sec", "5", "--", "touch", marker])
        check("stale ticket (dead pid) does not block: admitted at once",
              p.returncode == 0 and os.path.exists(marker) and time.monotonic() - t0 < 3,
              (p.returncode, p.stderr))
        check("stale ticket (dead pid) was removed", tickets() == [], tickets())
        os.remove(marker)
        zombie = subprocess.Popen(["sleep", "30"])
        put_ticket(2, zombie.pid, "zombie")
        zombie.kill()
        end = time.monotonic() + 5
        while time.monotonic() < end and not gone(zombie.pid):
            time.sleep(0.02)
        put_ticket(3, os.getpid(), "reused-pid", start="1")          # alive pid, other start time
        put_ticket(4, os.getpid() + 1, "garbage", start=None, raw="not json {")  # unreadable
        with open(os.path.join(qdir, ".tmp-%d-dead" % blocker.pid), "w") as f:
            f.write("half")                                          # dead writer's temp file
        p = E.run(["--wait-sec", "5", "--", "touch", marker])
        zombie.wait()
        check("zombie / reused-pid / unreadable tickets do not block",
              p.returncode == 0 and os.path.exists(marker), (p.returncode, p.stderr))
        check("... and are all removed, with the dead writer's temp file", tickets() == [],
              tickets())

        # the ticket is gone once the lock is taken (the job sees an empty queue)
        seen = os.path.join(td, "seen")
        p = E.run(["--", "sh", "-c", "ls -A %s > %s" % (qdir, seen)])
        with open(seen) as f:
            view = f.read()
        check("own ticket removed when the lock is acquired", p.returncode == 0 and view == "",
              view)

        # (4) the ticket is removed after a 73 timeout ...
        fd = hold()
        p = E.run(["--wait-sec", "1", "--label", "T73", "--", "true"])
        check("73 timeout -> no ticket left", p.returncode == 73 and tickets() == [],
              (p.returncode, tickets()))
        # ... and after SIGTERM of a waiter (a supervisor's SIGTERM, 143)
        w = waiter("TERM", 0.1)
        wait_line("TERM")
        had = len(tickets())
        w.send_signal(15)
        w.communicate(timeout=10)
        rf = [e for e in E.events() if e.get("label") == "TERM"][-1]
        check("SIGTERM while queued -> exit 143, its ticket removed",
              had == 1 and w.returncode == 143 and tickets() == [], (had, w.returncode, tickets()))
        check("SIGTERM while queued -> refuse line reason=signal, exit 143",
              rf.get("event") == "refuse" and rf.get("reason") == "signal" and rf.get("exit") == 143, rf)
        # a SIGKILLed waiter cannot clean up: its leftover ticket must not block
        k = waiter("KILL", 0.1)
        wait_line("KILL")
        k.kill()
        k.communicate(timeout=10)
        left = tickets()
        os.close(fd)
        t0 = time.monotonic()
        p = E.run(["--wait-sec", "5", "--", "true"])
        check("SIGKILLed waiter's leftover ticket does not block the next job",
              len(left) == 1 and p.returncode == 0 and time.monotonic() - t0 < 3 and tickets() == [],
              (left, p.returncode, tickets()))

        # SIGINT (130) and SIGHUP (129) while queued, handler installed (not ignored)
        fd = hold()
        for signo, code, name in ((signal.SIGINT, 130, "INT"), (signal.SIGHUP, 129, "HUP")):
            w = waiter(name, 0.1)
            wait_line(name)
            had = len(tickets())
            w.send_signal(signo)
            w.communicate(timeout=10)
            rf = last_line(name)
            check("SIG%s while queued -> exit %d, ticket removed, refuse reason=signal" % (name, code),
                  had == 1 and w.returncode == code and tickets() == []
                  and rf.get("reason") == "signal" and rf.get("exit") == code,
                  (had, w.returncode, tickets(), rf))

        # an inherited SIG_IGN is kept (nohup / setsid jobs):
        # the waiter survives SIGHUP while queued and still runs in its turn
        os.remove(order)
        h = waiter("HUPIGN", 0.1, preexec_fn=lambda: signal.signal(signal.SIGHUP, signal.SIG_IGN))
        wait_line("HUPIGN")
        h2 = waiter("AFTER", 0.1)
        wait_line("AFTER")
        h.send_signal(signal.SIGHUP)
        time.sleep(0.5)
        alive_after_hup = h.poll() is None and len(tickets()) == 2
        os.close(fd)
        for pr in (h, h2):
            pr.communicate(timeout=30)
        check("SIGHUP inherited as ignored: the waiter survives SIGHUP while queued",
              alive_after_hup, tickets())
        check("... and still runs in order before the later arrival",
              h.returncode == 0 and h2.returncode == 0 and read_order() == ["HUPIGN", "AFTER"],
              (h.returncode, h2.returncode, read_order()))

        # a live ticket that cannot be READ (EACCES here, like EIO/EMFILE) is not
        # deleted: judged by the pid in its name, it stays ahead while that pid lives
        if os.path.exists(marker):
            os.remove(marker)  # left by the zombie/reused-pid run above
        blocker = subprocess.Popen(["sleep", "30"])
        locked = put_ticket(5, blocker.pid, "locked")
        os.chmod(locked, 0)
        p = E.run(["--wait-sec", "1", "--label", "BEHIND", "--", "touch", marker])
        rf = last_line("BEHIND")
        check("unreadable ticket of a live pid: kept, counted ahead, 73, not run",
              p.returncode == 73 and os.path.exists(locked) and not os.path.exists(marker)
              and rf.get("ahead") == ["?unreadable"], (p.returncode, tickets(), rf))
        blocker.kill()
        blocker.wait()
        p = E.run(["--wait-sec", "5", "--", "touch", marker])
        check("unreadable ticket of a dead pid: removed, next job admitted",
              p.returncode == 0 and os.path.exists(marker) and tickets() == [],
              (p.returncode, tickets()))
        os.remove(marker)

        # labels read back from other tickets are sanitized before stderr/log
        blocker = subprocess.Popen(["sleep", "30"])
        put_ticket(6, blocker.pid, "evil\nlabel\x1b[31mcaf\u00e9 " + "x" * 300)
        p = E.run(["--wait-sec", "0", "--label", "SAN", "--", "true"])
        blocker.kill()
        blocker.wait()
        el = (last_line("SAN").get("ahead") or [""])[0]
        check("foreign label sanitized: no whitespace/control chars, <= 100 chars, UTF-8 kept",
              p.returncode == 73 and len(el) == 100 and el.startswith("evil_label?[31mcaf\u00e9_x")
              and "\n" not in p.stderr.split("ahead: ", 1)[-1].split(";")[0]
              and "\x1b" not in p.stderr, (el, p.stderr))

        # exit 74 / queue_io_error: no ticket can be created at all ...
        with open(os.path.join(td, "plain"), "w") as f:
            f.write("x")
        p = E.run(["--", "touch", marker], HEAVY_JOB_QUEUE_DIR=os.path.join(td, "plain", "queue"))
        rf = E.events()[-1]
        check("queue dir under a plain file -> refused 74, not run, reason=queue_io_error",
              p.returncode == 74 and not os.path.exists(marker)
              and rf.get("event") == "refuse" and rf.get("reason") == "queue_io_error"
              and rf.get("exit") == 74, (p.returncode, rf))

        # ... or the queue breaks DURING the wait: 74, never 73 and never admitted
        fd = hold()
        w = waiter("RMDIR", 0.1, job="touch %s" % marker)
        wait_line("RMDIR")
        shutil.rmtree(qdir)
        w.communicate(timeout=10)
        rf = last_line("RMDIR")
        check("queue dir deleted during the wait -> 74 queue_io_error, not 73, not run",
              w.returncode == 74 and rf.get("reason") == "queue_io_error" and not os.path.exists(marker),
              (w.returncode, rf))
        w = waiter("CHMOD", 0.1, job="touch %s" % marker)
        wait_line("CHMOD")
        os.chmod(qdir, 0)
        try:
            w.communicate(timeout=10)
        finally:
            os.chmod(qdir, 0o755)
        rf = last_line("CHMOD")
        check("queue dir made inaccessible during the wait -> 74 queue_io_error, not run",
              w.returncode == 74 and rf.get("reason") == "queue_io_error" and not os.path.exists(marker),
              (w.returncode, rf))
        os.close(fd)

        # the queue directory is overridable (HEAVY_JOB_QUEUE_DIR)
        alt = os.path.join(td, "alt-queue")
        p = E.run(["--", "sh", "-c", "ls -A %s > %s" % (alt, seen)], HEAVY_JOB_QUEUE_DIR=alt)
        with open(seen) as f:
            view = f.read()
        check("HEAVY_JOB_QUEUE_DIR is used (created, empty while the job runs)",
              p.returncode == 0 and os.path.isdir(alt) and view == "", (p.stderr, view))

    # --- the cgroup cap handed to systemd-run is normalized to MB
    # (a bare number is MB for this gate but BYTES for systemd; '2g' is accepted here)
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        argfile = os.path.join(td, "systemd-run.args")

        def scoped_args(extra):
            if os.path.exists(argfile):
                os.remove(argfile)
            p = E.run(extra + ["--", "sh", "-c", "exit 5"], FAKE_SR_ARGS=argfile)
            with open(argfile) as f:
                runs = f.read().split("----\n")
            return p.returncode, [l for l in runs[-2].splitlines() if l]  # last = the real job

        rc, args = scoped_args(["--max-mem", "1536", "--swap-max", "0"])
        check("scoped run still propagates the exit code (5)", rc == 5, "rc=%s" % rc)
        check("bare number --max-mem 1536 -> MemoryMax=1536M", "MemoryMax=1536M" in args, args)
        check("--swap-max 0 -> MemorySwapMax=0M", "MemorySwapMax=0M" in args, args)
        rc, args = scoped_args(["--max-mem", "2g", "--swap-max", "256m"])
        check("lowercase 2g -> MemoryMax=2048M", "MemoryMax=2048M" in args, args)
        check("lowercase 256m -> MemorySwapMax=256M", "MemorySwapMax=256M" in args, args)
        check("no raw user string reaches systemd",
              not any(a in ("MemoryMax=2g", "MemorySwapMax=256m") for a in args), args)

    # --- no cap, no job (unless --allow-uncapped, which is logged)
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        marker = os.path.join(td, "ran")
        p = E.run(["--", "touch", marker], HEAVY_JOB_NO_SCOPE="1")
        ev = E.events()
        check("scope unavailable (NO_SCOPE=1) -> refused 77, not run", p.returncode == 77
              and not os.path.exists(marker), "rc=%s" % p.returncode)
        check("no_cap refuse line logged", ev and ev[-1]["event"] == "refuse"
              and ev[-1].get("reason") == "no_cap", ev)
        p = E.run(["--", "touch", marker], FAKE_SR_PROBE_RC="1")
        check("scope probe failing -> refused 77, not run", p.returncode == 77
              and not os.path.exists(marker), "rc=%s" % p.returncode)
        p = E.run(["--allow-uncapped", "--", "touch", marker], HEAVY_JOB_NO_SCOPE="1")
        ev = E.events()
        kinds = [e["event"] for e in ev]
        check("--allow-uncapped runs the job", p.returncode == 0 and os.path.exists(marker))
        check("--allow-uncapped is logged ('uncapped', start capped=false) and warned",
              "uncapped" in kinds and ev[-2].get("capped") is False and "WITHOUT" in p.stderr,
              (kinds, p.stderr))
        os.remove(marker)
        p = E.run(["--", "touch", marker])
        check("scope available -> runs capped (start capped=true)",
              p.returncode == 0 and E.events()[-2].get("capped") is True)

    # --- the lock file cannot be opened -> its own exit code (74), not a usage error
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        blocker = os.path.join(td, "plainfile")
        with open(blocker, "w") as f:
            f.write("x")
        marker = os.path.join(td, "ran")
        p = E.run(["--", "touch", marker], HEAVY_JOB_LOCK=os.path.join(blocker, "sub", "x.lock"))
        check("lock file unopenable -> refused 74, not run", p.returncode == 74
              and not os.path.exists(marker), "rc=%s" % p.returncode)
        check("lock_io_error refuse line logged", E.events()[-1].get("reason") == "lock_io_error")

    # --- a 137/143 death of a capped job gets ONE neutral line (no claim which)
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        for sig, code, name in (("-9", 137, "SIGKILL"), ("-TERM", 143, "SIGTERM")):
            p = E.run(["--", "sh", "-c", "kill %s $$" % sig])
            want = ("the job was stopped by %s: either its memory cap or the RAM emergency "
                    "brake; see store/ram-emergency-brake-log.jsonl" % name)
            lines = [l for l in p.stderr.split("\n") if "stopped by" in l]
            check("%s death -> exit %d, one neutral line" % (name, code),
                  p.returncode == code and len(lines) == 1 and lines[0].endswith(want), p.stderr)
            fin = E.events()[-1]
            check("%s death: finish line says only the signal" % name,
                  fin.get("stopped_by_signal") == name and "killed_by_brake" not in fin
                  and "likely_cap_oom" not in fin, fin)
        p = E.run(["--", "sh", "-c", "exit 3"])
        check("ordinary non-zero exit -> no stop line", p.returncode == 3 and "stopped by" not in p.stderr)

        # signals sent to the gate while the job runs: forwarded unless inherited as ignored
        started = os.path.join(td, "started")

        def run_and_signal(signo, job, preexec_fn=None):
            if os.path.exists(started):
                os.remove(started)
            g = subprocess.Popen([WRAPPER, "--", "sh", "-c", job], env=E.env(),
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                 preexec_fn=preexec_fn)
            end = time.monotonic() + 10
            while time.monotonic() < end and not os.path.exists(started):
                time.sleep(0.02)
            g.send_signal(signo)
            g.communicate(timeout=30)
            return g.returncode, E.events()[-1]

        rc, fin = run_and_signal(signal.SIGTERM, "touch %s; exec sleep 5" % started)
        check("SIGTERM to the gate during the run is forwarded: child dies, exit 143",
              rc == 143 and fin.get("forwarded_signals") == [signal.SIGTERM], (rc, fin))
        rc, fin = run_and_signal(signal.SIGHUP, "exec python3 -c %s" % shq(own_hup_job(started)),
                                 preexec_fn=lambda: signal.signal(signal.SIGHUP, signal.SIG_IGN))
        check("SIGHUP inherited as ignored: SIGHUP to the gate during the run is not forwarded "
              "(a job with its own SIGHUP handler finishes with its own exit code 5)",
              rc == 5 and fin.get("event") == "finish" and not fin.get("forwarded_signals"),
              (rc, fin))
        sigign = os.path.join(td, "sigign")
        p = subprocess.run([WRAPPER, "--", "sh", "-c", "grep SigIgn /proc/self/status > %s" % sigign],
                           env=E.env(), capture_output=True, text=True,
                           preexec_fn=lambda: signal.signal(signal.SIGHUP, signal.SIG_IGN))
        with open(sigign) as f:
            mask = int(f.read().split()[1], 16)
        check("SIGHUP inherited as ignored: the job itself inherits the ignore",
              p.returncode == 0 and mask & (1 << (signal.SIGHUP - 1)), hex(mask))
        check("brake-log attribution feature is removed",
              not hasattr(gate, "killed_by_brake") and not hasattr(gate, "brake_log_path"))

    # --- lock is released after a job, so the next one starts immediately
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        E.run(["--", "true"])
        t0 = time.monotonic()
        p = E.run(["--wait-sec", "5", "--", "true"], FAKE_SR_NO_CG="1")
        check("lock released after finish (next job immediate)",
              p.returncode == 0 and time.monotonic() - t0 < 3)
        fin = E.events()[-1]
        check("no fake cgroup: the scope is reported already_gone (stop rc 5)",
              fin.get("scope_stop") == "already_gone" and fin.get("scope_stop_rc") == 5, fin)

    # --- hermetic: the whole scope is stopped when the main process ends
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        cgfs = os.path.join(td, "cg")
        sclog = os.path.join(td, "systemctl.log")
        pidf = os.path.join(td, "bg.pid")
        fake = {"FAKE_CGFS": cgfs, "HEAVY_JOB_CGROUP_FS": cgfs, "FAKE_SC_LOG": sclog,
                "FAKE_CG_REGISTER": "1"}
        job = 'sleep 34.927 >/dev/null 2>&1 & echo $! >> "$FAKE_CG_PROCS"; echo $! > %s; exit 0' % pidf
        p = E.run(["--", "sh", "-c", job], **fake)
        bg = read_pid(pidf)
        fin = E.events()[-1]
        with open(sclog) as f:
            calls = f.read()
        check("fake scope: backgrounded child is gone after the gate returns",
              p.returncode == 0 and bg and gone(bg), (p.returncode, bg))
        check("fake scope: lock is free after the gate returns", lock_free(E.lock))
        check("fake scope: systemctl --user stop <unit>.scope was called",
              ("stop %s.scope" % fin.get("unit")) in calls, calls)
        check("fake scope: finish line scope_stop=stopped with the survivor count",
              fin.get("scope_stop") == "stopped" and fin.get("scope_survivors", 0) >= 1, fin)

        # stop does nothing and the processes stay: bounded wait, then leftover, warned
        os.remove(pidf)
        t0 = time.monotonic()
        p = E.run(["--", "sh", "-c", job], FAKE_SC_STOP_NOOP="1",
                  HEAVY_JOB_STOP_WAIT_SEC="0.3", **fake)
        dt = time.monotonic() - t0
        bg = read_pid(pidf)
        fin = E.events()[-1]
        check("stubborn scope: finish line scope_stop=leftover with pids",
              fin.get("scope_stop") == "leftover" and bg in fin.get("scope_leftover_pids", []), fin)
        check("stubborn scope: WARNING printed", "could not be verified empty" in p.stderr, p.stderr)
        check("stubborn scope: the wait is bounded (<10s), lock still released",
              dt < 10 and lock_free(E.lock), "dt=%.2f" % dt)
        if bg and not gone(bg):
            os.kill(bg, 9)

        p = E.run(["--", "true"], FAKE_SC_FAIL="1", **fake)
        fin = E.events()[-1]
        check("systemctl unusable: scope_stop=unverified, WARNING printed, exit code kept",
              p.returncode == 0 and fin.get("scope_stop") == "unverified"
              and "could not be verified empty" in p.stderr, (fin, p.stderr))

    # --- LIVE: real transient scopes (skipped if the user manager cannot make one)
    try:
        live = live_scope_ok()
    except (OSError, subprocess.TimeoutExpired):
        live = False
    if os.environ.get("HEAVY_JOB_TEST_NO_LIVE") == "1":
        live = False
    if not live:
        print("  SKIP live scope tests (no systemd --user scope here)")
    else:
        with tempfile.TemporaryDirectory() as td:
            E = Env(td, live=True)
            pidf = os.path.join(td, "bg.pid")
            small = ["--max-mem", "200M", "--min-mb", "0"]

            # a job that backgrounds a long-lived child and exits at once
            t0 = time.monotonic()
            p = E.run(small + ["--", "sh", "-c", "sleep 31.927 & echo $! > %s; exit 0" % pidf])
            dt = time.monotonic() - t0
            bg = read_pid(pidf)
            fin = E.events()[-1]
            check("LIVE: sleep-30-and-exit job -> exit 0, the child is gone after the gate returns",
                  p.returncode == 0 and bg and gone(bg), (p.returncode, bg, p.stderr))
            check("LIVE: the lock is free after the gate returns", lock_free(E.lock))
            check("LIVE: finish line scope_stop=stopped, 1 survivor, promptly (<10s)",
                  fin.get("scope_stop") == "stopped" and fin.get("scope_survivors") == 1 and dt < 10,
                  (fin, dt))
            st = subprocess.run(["systemctl", "--user", "show", "-p", "ActiveState", "--value",
                                 fin.get("unit", "x") + ".scope"], capture_output=True, text=True)
            check("LIVE: the scope unit is no longer active", st.stdout.strip() != "active", st.stdout)

            # a descendant that ignores SIGTERM: stop escalates to SIGKILL (TimeoutStopSec=5s)
            os.remove(pidf)
            t0 = time.monotonic()
            p = E.run(small + ["--", "sh", "-c",
                               '(trap "" TERM; exec sleep 32.927) & echo $! > %s; exit 0' % pidf])
            dt = time.monotonic() - t0
            bg = read_pid(pidf)
            fin = E.events()[-1]
            check("LIVE: SIGTERM-ignoring descendant is SIGKILLed, gone, lock free",
                  p.returncode == 0 and bg and gone(bg) and lock_free(E.lock), (p.returncode, bg))
            check("LIVE: that stop is bounded (4s <= dt < 20s), scope_stop=stopped",
                  4 <= dt < 20 and fin.get("scope_stop") == "stopped", (dt, fin))

            # a nohup'd gate (SIGHUP ignored) in a REAL scope: a SIGHUP to the gate
            # during the run does not reach the job, which exits with its own code
            started = os.path.join(td, "started")
            g = subprocess.Popen([WRAPPER] + small + ["--", "python3", "-c", own_hup_job(started)],
                                 env=E.env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 preexec_fn=lambda: signal.signal(signal.SIGHUP, signal.SIG_IGN))
            end = time.monotonic() + 10
            while time.monotonic() < end and not os.path.exists(started):
                time.sleep(0.02)
            g.send_signal(signal.SIGHUP)
            g.wait(timeout=30)
            fin = E.events()[-1]
            check("LIVE: SIGHUP-ignoring gate: SIGHUP during the run not forwarded, job exit 5",
                  g.returncode == 5 and not fin.get("forwarded_signals"), (g.returncode, fin))

            # the cap is read back from the job's own REAL scope
            p = E.run(small + ["--", "sleep", "0.5"])
            fin = E.events()[-1]
            check("LIVE: the real scope's memory.max is the requested 200M (cap_verified true)",
                  p.returncode == 0 and fin.get("cap_verified") is True
                  and fin.get("cap_seen") == "memory.max=%d" % (200 * 1024 * 1024), fin)

            # a plain job leaves nothing behind
            p = E.run(small + ["--", "true"])
            fin = E.events()[-1]
            check("LIVE: plain job -> scope already gone or empty, lock free",
                  p.returncode == 0 and fin.get("scope_stop") in ("already_gone", "empty")
                  and lock_free(E.lock), fin)

            # a genuine nested call inside a real scope is verified
            inner = "%s --wait-sec 1 -- sh -c 'exit 6'" % WRAPPER
            p = E.run(small + ["--wait-sec", "5", "--", "sh", "-c", inner])
            kinds = [e["event"] for e in E.events()]
            check("LIVE: nested call inside the real scope: verified, inner exit 6 comes through",
                  p.returncode == 6 and kinds[-2] == "nested", (p.returncode, kinds[-3:], p.stderr))
            inner = "%s -- sh -c 'kill -9 $$'" % WRAPPER
            p = E.run(small + ["--wait-sec", "5", "--", "sh", "-c", inner])
            check("LIVE: nested call: signal death -> 137", p.returncode == 137
                  and E.events()[-2]["event"] == "nested", p.returncode)
            inner = "%s -- sh -c 'exit 4'" % WRAPPER
            p = E.run(small + ["--wait-sec", "5", "--", "sh", "-c", inner])
            check("LIVE: nested call: exit 4 propagated", p.returncode == 4, p.returncode)
            # a verified nested call takes no queue ticket
            seen = os.path.join(td, "seen")
            inner = "%s -- sh -c 'ls -A %s > %s'" % (WRAPPER, os.path.join(td, ".heavy-job-queue"),
                                                     seen)
            p = E.run(small + ["--wait-sec", "5", "--", "sh", "-c", inner])
            with open(seen) as f:
                view = f.read()
            check("LIVE: verified nested call takes no queue ticket",
                  p.returncode == 0 and E.events()[-2]["event"] == "nested" and view == "",
                  (p.returncode, view))

            # an outsider holding the LIVE token (and ACTIVE=1) is not in the scope:
            # not verified, waits, refused 73; the message names the live holder
            outer = subprocess.Popen([WRAPPER] + small + ["--", "sleep", "4"], env=E.env(),
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            tok = None
            end = time.monotonic() + 10
            while time.monotonic() < end and not tok:
                tok = gate.read_record(E.lock).get("token") if not lock_free(E.lock) else None
                if not tok:
                    time.sleep(0.05)
            marker = os.path.join(td, "ran")
            p = E.run(small + ["--wait-sec", "1", "--", "touch", marker],
                      HEAVY_JOB_ACTIVE="1", HEAVY_JOB_TOKEN=tok or "none")
            u = [e for e in E.events() if e["event"] == "nested_unverified"]
            check("LIVE: live token outside the scope -> not_in_scope, refused 73, not run",
                  tok and p.returncode == 73 and not os.path.exists(marker)
                  and u and u[-1].get("reason") == "not_in_scope", (tok, p.returncode, u[-1:]))
            check("LIVE: refusal names the live holder pid as alive",
                  ("holder pid %d (alive)" % outer.pid) in p.stderr, p.stderr)
            outer.wait(timeout=30)

    # a gate running INSIDE another heavy-job scope must never read stats
    # from, wait on or kill that outer scope (only its own <unit>.scope)
    with tempfile.TemporaryDirectory() as td:
        outer_cg = os.path.join(td, "heavy-job-111-1.scope")
        os.makedirs(outer_cg)
        victim = subprocess.Popen(["sleep", "30"])
        with open(os.path.join(outer_cg, "cgroup.procs"), "w") as f:
            f.write("%d\n" % victim.pid)
        with open(os.path.join(outer_cg, "memory.peak"), "w") as f:
            f.write("%d\n" % (777 * 1024 * 1024))
        kill_file = os.path.join(outer_cg, "cgroup.kill")
        open(kill_file, "w").close()
        saved = (gate.systemctl, gate.cgroup_dir_of)
        gate.systemctl = lambda *a: (5, "")  # show: nothing, stop: not loaded
        gate.cgroup_dir_of = lambda pid: outer_cg
        os.environ["HEAVY_JOB_STOP_WAIT_SEC"] = "0.3"
        try:
            out = gate.stop_scope("heavy-job-222-2", cg_hint=outer_cg)
            code, stats = gate.run_child(["sleep", "0.8"], dict(os.environ), unit="heavy-job-222-2")
        finally:
            gate.systemctl, gate.cgroup_dir_of = saved
            os.environ.pop("HEAVY_JOB_STOP_WAIT_SEC", None)
        with open(kill_file) as f:
            killed = f.read()
        alive = not gone(victim.pid)
        victim.kill()
        victim.wait()
        check("nested in an outer scope: stop_scope leaves the outer cgroup alone",
              killed == "" and alive and out.get("scope_stop") == "already_gone", (killed, alive, out))
        check("nested in an outer scope: run_child reads no stats from the outer cgroup",
              code == 0 and stats.get("peak_mb") is None, (code, stats))

    test_cap_enforcement()
    test_lock_and_queue_safety()
    test_max_sec_and_fairness()
    test_short_lane()

    print()
    if fails:
        print("FAIL: %d check(s): %s" % (len(fails), ", ".join(fails)))
        return 1
    print("OK: all checks passed")
    return 0


def test_cap_enforcement():
    """The cap must be enforceable before admission (cgroup2 + memory delegated
    to the user manager) and in force after the start (the job scope's own
    memory.max); a teardown that cannot be checked is "unknown"."""
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        marker = os.path.join(td, "ran")

        def refused(why, **extra):
            p = E.run(["--label", why, "--", "touch", marker], **extra)
            ev = E.events()[-1]
            return p, ev

        # cgroup v1 / hybrid: the configured root is a tmpfs, cgroup2 sits below it
        hybrid = os.path.join(td, "mounts-hybrid")
        with open(hybrid, "w") as f:
            f.write("tmpfs %s tmpfs ro 0 0\ncgroup2 %s/unified cgroup2 rw 0 0\n"
                    "cgroup %s/memory cgroup rw,memory 0 0\n" % (E.cgfs, E.cgfs, E.cgfs))
        p, ev = refused("hybrid", HEAVY_JOB_MOUNTS=hybrid)
        check("cap: hybrid hierarchy (tmpfs at the cgroup root) -> refused 77, not run",
              p.returncode == 77 and not os.path.exists(marker), (p.returncode, p.stderr))
        check("cap: hybrid refuse line reason=no_cap, cap_check names not_cgroup2",
              ev.get("reason") == "no_cap" and ev.get("cap_check", "").startswith("not_cgroup2"), ev)
        nomount = os.path.join(td, "mounts-none")
        with open(nomount, "w") as f:
            f.write("proc /proc proc rw 0 0\n")
        p, ev = refused("nomount", HEAVY_JOB_MOUNTS=nomount)
        check("cap: no cgroup mount at the root -> refused 77",
              p.returncode == 77 and ev.get("cap_check", "").startswith("not_cgroup2"), (p.returncode, ev))

        # cgroup2, but no memory controller delegated to the user manager
        ctl = os.path.join(E.cgfs, "fake-manager", "cgroup.controllers")
        with open(ctl, "w") as f:
            f.write("cpu pids\n")
        p, ev = refused("nomem")
        check("cap: no memory controller in the user manager's cgroup -> refused 77, not run",
              p.returncode == 77 and not os.path.exists(marker)
              and ev.get("cap_check", "").startswith("no_memory_controller"), (p.returncode, ev))
        os.remove(ctl)
        p, ev = refused("noctl")
        check("cap: user manager's cgroup.controllers unreadable -> refused 77",
              p.returncode == 77 and ev.get("cap_check", "").startswith("no_memory_controller"), ev)
        p = E.run(["--allow-uncapped", "--", "touch", marker])
        ev = E.events()
        check("cap: --allow-uncapped still runs it uncapped, the uncapped line says why",
              p.returncode == 0 and os.path.exists(marker) and ev[-3].get("event") == "uncapped"
              and ev[-3].get("cap_check", "").startswith("no_memory_controller")
              and ev[-2].get("capped") is False, ev[-3:])
        os.remove(marker)
        with open(ctl, "w") as f:
            f.write("cpu memory pids\n")

        # the scope came up but its memory.max is not the requested cap
        for memmax, why in (("max", "no limit"), (str(1024 * 1024 * 1024), "1G instead of 2G")):
            t0 = time.monotonic()
            p = E.run(["--max-mem", "2G", "--min-mb", "0", "--label", "CAP", "--", "sh", "-c",
                       'sleep 5 & echo $! >> "$FAKE_CG_PROCS"; wait; touch %s' % marker],
                      FAKE_SR_MEMMAX=memmax, HEAVY_JOB_CAP_VERIFY_SEC="0.5", FAKE_CG_REGISTER="1")
            dt = time.monotonic() - t0
            fin = E.events()[-1]
            check("cap: job scope memory.max %s -> stopped 77 promptly, the job did not finish" % why,
                  p.returncode == 77 and dt < 4 and not os.path.exists(marker), (p.returncode, dt, p.stderr))
            check("cap: %s -> finish line cap_verified false, cap_stopped, cap_seen, warned" % why,
                  fin.get("event") == "finish" and fin.get("cap_verified") is False
                  and fin.get("cap_stopped") is True and fin.get("cap_seen") == "memory.max=" + memmax
                  and "not under the requested cap" in p.stderr, (fin, p.stderr))
        check("cap: the stopped jobs released the lock", lock_free(E.lock))

        # the cap in force -> verified, the job's own code
        p = E.run(["--max-mem", "300M", "--min-mb", "0", "--", "sh", "-c", "sleep 0.3; exit 4"])
        fin = E.events()[-1]
        check("cap: memory.max = the requested 300M -> cap_verified true, own exit code 4",
              p.returncode == 4 and fin.get("cap_verified") is True
              and fin.get("cap_seen") == "memory.max=%d" % (300 * 1024 * 1024), fin)
        # a job that ends before any scope cgroup shows up: not claimed verified
        p = E.run(["--", "true"], FAKE_SR_NO_CG="1")
        fin = E.events()[-1]
        check("cap: job ended before its scope could be read -> cap_verified null, exit kept, warned",
              p.returncode == 0 and "cap_verified" in fin and fin["cap_verified"] is None
              and "cap could not be measured" in p.stderr, (fin, p.stderr))

        # an instantly exiting job whose scope showed a WRONG memory.max: it ran
        # uncapped, so its own code is replaced by 77 and the gate warns
        for memmax, job, own in (("max", ["true"], 0), (str(512 * 1024 * 1024), ["sh", "-c", "exit 3"], 3)):
            p = E.run(["--max-mem", "300M", "--min-mb", "0", "--label", "INSTANT", "--"] + job,
                      FAKE_SR_MEMMAX=memmax)
            fin = E.events()[-1]
            check("cap: instant job, scope memory.max=%s -> exit 77 (not its own %d), WARNING" % (memmax, own),
                  p.returncode == 77 and "WARNING" in p.stderr and "not under the requested cap" in p.stderr,
                  (p.returncode, p.stderr))
            check("cap: instant job, memory.max=%s -> finish line exit 77, cap_verified false, job_exit %d"
                  % (memmax, own),
                  fin.get("exit") == 77 and fin.get("cap_verified") is False and fin.get("job_exit") == own
                  and fin.get("cap_seen") == "memory.max=" + memmax, fin)

        # a properly capped instant job whose scope was already collected when
        # the gate looked (systemd still names the cgroup, the directory is gone):
        # not measurable -> its own code, cap_verified null, a warning
        p = E.run(["--max-mem", "300M", "--min-mb", "0", "--", "sh", "-c", "exit 3"], FAKE_SC_GHOST="1")
        fin = E.events()[-1]
        check("cap: capped instant job, scope already collected -> its own exit 3, cap_verified null, warned",
              p.returncode == 3 and "cap_verified" in fin and fin["cap_verified"] is None
              and "cap could not be measured" in p.stderr, (p.returncode, fin, p.stderr))

        # teardown: systemd names a cgroup that is not where the gate looks
        p = E.run(["--", "true"], FAKE_SC_GHOST="1")
        fin = E.events()[-1]
        check("cap: teardown of a cgroup that is not there (systemd still has the unit) -> "
              "scope_stop=unknown and a WARNING, never 'empty'",
              p.returncode == 0 and fin.get("scope_stop") == "unknown"
              and "could not be verified empty" in p.stderr, (fin, p.stderr))

    # helpers: the configured cgroup root, never a hardcoded /sys/fs/cgroup
    saved = os.environ.get("HEAVY_JOB_CGROUP_FS")
    os.environ["HEAVY_JOB_CGROUP_FS"] = "/nonexistent-cgroot"
    try:
        d = gate.cgroup_dir_of(os.getpid())
    finally:
        if saved is None:
            os.environ.pop("HEAVY_JOB_CGROUP_FS", None)
        else:
            os.environ["HEAVY_JOB_CGROUP_FS"] = saved
    check("cap: cgroup_dir_of uses HEAVY_JOB_CGROUP_FS", bool(d) and d.startswith("/nonexistent-cgroot/"), d)
    with tempfile.TemporaryDirectory() as td:
        check("cap: cgroup_pids of an existing cgroup without cgroup.procs is None (unknown), "
              "of a missing one []", gate.cgroup_pids(td) is None
              and gate.cgroup_pids(os.path.join(td, "gone")) == [], gate.cgroup_pids(td))


def test_lock_and_queue_safety():
    """The lock is never opened through a symlink, is created 0600 and must be a
    regular file owned by the caller; the queue directory must be a real
    directory owned by the caller. Each violation: exit 74, nothing written."""
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        marker = os.path.join(td, "ran")
        target = os.path.join(td, "precious")
        with open(target, "w") as f:
            f.write("do not touch\n")

        # a symlinked lock must not clobber its target
        link = os.path.join(td, "link.lock")
        os.symlink(target, link)
        p = E.run(["--", "touch", marker], HEAVY_JOB_LOCK=link)
        ev = E.events()[-1]
        with open(target) as f:
            body = f.read()
        check("lock: a symlinked lock file -> refused 74 (lock_io_error), not run",
              p.returncode == 74 and not os.path.exists(marker) and ev.get("reason") == "lock_io_error",
              (p.returncode, ev, p.stderr))
        check("lock: ... and its target is untouched", body == "do not touch\n", body)
        dangling = os.path.join(td, "dangling.lock")
        os.symlink(os.path.join(td, "would-be-created"), dangling)
        p = E.run(["--", "touch", marker], HEAVY_JOB_LOCK=dangling)
        check("lock: a dangling symlink -> refused 74, nothing created through it",
              p.returncode == 74 and not os.path.exists(os.path.join(td, "would-be-created")), p.returncode)

        # not a regular file
        fifo = os.path.join(td, "fifo.lock")
        os.mkfifo(fifo)
        p = E.run(["--", "touch", marker], HEAVY_JOB_LOCK=fifo)
        check("lock: a FIFO as the lock -> refused 74, not run",
              p.returncode == 74 and not os.path.exists(marker) and "not a regular file" in p.stderr,
              (p.returncode, p.stderr))

        # owned by someone else (simulated: the gate runs in-process as another uid)
        own = os.path.join(td, "own.lock")
        with open(own, "w") as f:
            f.write("token=t pid=1 unit=- since=x label=other\n")
        env = E.env(HEAVY_JOB_LOCK=own)
        saved_env, saved_uid = dict(os.environ), os.getuid
        os.environ.clear()
        os.environ.update(env)
        os.getuid = lambda: saved_uid() + 4242
        try:
            rc = gate.main(["--", "touch", marker])
        finally:
            os.getuid = saved_uid
            os.environ.clear()
            os.environ.update(saved_env)
        with open(own) as f:
            body = f.read()
        check("lock: a lock owned by another uid -> refused 74, not run, record untouched",
              rc == 74 and not os.path.exists(marker) and body.startswith("token=t pid=1"), (rc, body))

        # a new lock is created 0600
        fresh = os.path.join(td, "fresh.lock")
        p = E.run(["--", "true"], HEAVY_JOB_LOCK=fresh)
        mode = os.stat(fresh).st_mode & 0o777
        check("lock: a new lock file is created 0600", p.returncode == 0 and mode == 0o600, oct(mode))

        # a symlinked queue directory: no ticket may land in its target
        qtarget = os.path.join(td, "qtarget")
        os.makedirs(qtarget)
        qlink = os.path.join(td, "qlink")
        os.symlink(qtarget, qlink)
        p = E.run(["--", "touch", marker], HEAVY_JOB_QUEUE_DIR=qlink)
        ev = E.events()[-1]
        check("queue: a symlinked queue directory -> refused 74 (queue_io_error), not run",
              p.returncode == 74 and not os.path.exists(marker) and ev.get("reason") == "queue_io_error",
              (p.returncode, ev))
        check("queue: ... and nothing was written into its target", os.listdir(qtarget) == [],
              os.listdir(qtarget))
        # a queue directory owned by someone else (simulated uid)
        qdir = os.path.join(td, "q-other")
        os.makedirs(qdir)
        os.getuid = lambda: saved_uid() + 4242
        try:
            try:
                gate.write_ticket(os.path.join(qdir, "1-1.ticket"), "{}")
                ok = False
            except OSError as e:
                ok = "owned by uid" in str(e)
        finally:
            os.getuid = saved_uid
        check("queue: a queue directory owned by another uid -> the ticket write is refused",
              ok and os.listdir(qdir) == [], os.listdir(qdir))


def test_max_sec_and_fairness():
    """--max-sec (runtime ceiling, exit 76) and --agent (no back-to-back lock
    for the same agent while someone else waits)."""
    # --- usage
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        for args, why in ((["--max-sec", "0"], "--max-sec 0"), (["--max-sec", "abc"], "--max-sec abc"),
                          (["--max-sec", "-3"], "--max-sec -3"), (["--max-sec"], "--max-sec without a value"),
                          (["--agent", "bad name"], "--agent with a space"), (["--agent", "-x"], "--agent -x"),
                          (["--agent", "a" * 65], "--agent of 65 chars")):
            p = E.run(args + ["--", "true"])
            check("usage: %s -> 64" % why, p.returncode == 64, (p.returncode, p.stderr[-200:]))
        p = E.run(["--", "true"], HEAVY_JOB_AGENT="bad name")
        check("usage: invalid HEAVY_JOB_AGENT -> 64", p.returncode == 64, p.returncode)
        check("usage: nothing ran or was logged for the usage errors", E.events() == [], E.events())
        p = E.run(["--max-sec", "1", "--agent", "agent-1", "--", "true"])
        check("usage: valid --max-sec 1 --agent agent-1 accepted", p.returncode == 0, p.stderr)

    # --- --max-sec: not reached -> the command's own code, no ceiling marks
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        p = E.run(["--max-sec", "30", "--", "sh", "-c", "exit 7"])
        ev = E.events()
        st = [e for e in ev if e["event"] == "start"][-1]
        fin = ev[-1]
        check("max-sec not reached: own exit code 7 kept", p.returncode == 7, p.returncode)
        check("max-sec not reached: start line names max_sec 30, finish line has no max_sec_exceeded",
              st.get("max_sec") == 30 and "max_sec_exceeded" not in fin and fin.get("exit") == 7, (st, fin))
        p = E.run(["--", "sh", "-c", "sleep 1.5; exit 3"])
        st = [e for e in E.events() if e["event"] == "start"][-1]
        check("no --max-sec: a 1.5 s job runs to its own end (3), start line has no max_sec / agent",
              p.returncode == 3 and "max_sec" not in st and "agent" not in st, (p.returncode, st))

    # --- --max-sec: exceeded, the whole (fake) scope is stopped, exit 76
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        cgfs = os.path.join(td, "cg")
        sclog = os.path.join(td, "systemctl.log")
        pidf = os.path.join(td, "bg.pid")
        fake = {"FAKE_CGFS": cgfs, "HEAVY_JOB_CGROUP_FS": cgfs, "FAKE_SC_LOG": sclog,
                "FAKE_CG_REGISTER": "1"}
        job = 'sleep 33.94 >/dev/null 2>&1 & echo $! >> "$FAKE_CG_PROCS"; echo $! > %s; wait' % pidf
        t0 = time.monotonic()
        p = E.run(["--max-sec", "1", "--label", "MAXSEC", "--", "sh", "-c", job], **fake)
        dt = time.monotonic() - t0
        bg = read_pid(pidf)
        fin = E.events()[-1]
        with open(sclog) as f:
            calls = f.read()
        check("max-sec exceeded: exit 76", p.returncode == 76, (p.returncode, p.stderr))
        check("max-sec exceeded: stopped promptly (1 s ceiling, < 8 s in all)", 0.9 <= dt < 8, "dt=%.2f" % dt)
        check("max-sec exceeded: the scope was stopped, the backgrounded child is gone",
              ("stop %s.scope" % fin.get("unit")) in calls and bg and gone(bg), (calls, bg))
        check("max-sec exceeded: finish line exit 76, max_sec_exceeded, max_sec 1, killed_exit 137",
              fin.get("event") == "finish" and fin.get("exit") == 76 and fin.get("max_sec_exceeded") is True
              and fin.get("max_sec") == 1 and fin.get("killed_exit") == 137, fin)
        check("max-sec exceeded: one finish line, lock free afterwards",
              [e["event"] for e in E.events()].count("finish") == 1 and lock_free(E.lock), E.events())
        check("max-sec exceeded: stderr says STOPPED and 76, not the brake text",
              "STOPPED" in p.stderr and "exit 76" in p.stderr and "emergency brake" not in p.stderr, p.stderr)

    # --- --max-sec: no scope teardown possible (stop is rc 5): SIGTERM, then SIGKILL after the grace
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        t0 = time.monotonic()
        p = E.run(["--max-sec", "1", "--", "sh", "-c", "exec sleep 34.94"])
        dt = time.monotonic() - t0
        fin = E.events()[-1]
        check("max-sec, no fake cgroup: SIGTERM ends the job, exit 76, killed_exit 143",
              p.returncode == 76 and fin.get("killed_exit") == 143 and dt < 5, (p.returncode, fin, dt))
        ign = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(35)"
        t0 = time.monotonic()
        p = E.run(["--max-sec", "1", "--", "python3", "-c", ign])
        dt = time.monotonic() - t0
        fin = E.events()[-1]
        check("max-sec, SIGTERM ignored: SIGKILL after the grace, exit 76, killed_exit 137",
              p.returncode == 76 and fin.get("killed_exit") == 137, (p.returncode, fin))
        check("max-sec, SIGTERM ignored: bounded (>= 1 + grace - 0.5, < 12 s)",
              1 + gate.KILL_GRACE_SEC - 0.5 <= dt < 12, "dt=%.2f" % dt)
        # a job that exits 0 on SIGTERM is still reported as cut off (76), its own code kept as killed_exit
        soft = "import signal,sys,time; signal.signal(signal.SIGTERM, lambda *a: sys.exit(0)); time.sleep(35)"
        p = E.run(["--max-sec", "1", "--", "python3", "-c", soft])
        fin = E.events()[-1]
        check("max-sec: a job that exits 0 on the SIGTERM is still 76, killed_exit 0 kept in the log",
              p.returncode == 76 and fin.get("killed_exit") == 0 and fin.get("max_sec_exceeded") is True,
              (p.returncode, fin))

    # --- fairness
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        qdir = os.path.join(td, ".heavy-job-queue")
        order = os.path.join(td, "order")

        def tickets():
            try:
                return sorted(os.listdir(qdir))
            except OSError:
                return []

        def hold(record):
            fd = os.open(E.lock, os.O_RDWR | os.O_CREAT, 0o644)
            fcntl.flock(fd, fcntl.LOCK_EX)
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, 0)
            os.write(fd, record)
            return fd

        def set_record(record):
            with open(E.lock, "wb") as f:
                f.write(record)

        def waiter(name, agent=None, poll=0.1, wait_sec=30, job=None, extra_env=None):
            args = [WRAPPER, "--wait-sec", str(wait_sec), "--label", name]
            if agent:
                args += ["--agent", agent]
            job = job or "echo %s >> %s; sleep 0.3" % (name, order)
            env = E.env(HEAVY_JOB_POLL_SEC=str(poll), **(extra_env or {}))
            return subprocess.Popen(args + ["--", "sh", "-c", job], env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

        def wait_line(label, bound=10, since=0):
            """The newest wait line of `label` among the log lines from index `since` on
            (labels repeat across the scenarios, so an older run's line must not count)."""
            end = time.monotonic() + bound
            while time.monotonic() < end:
                w = [e for e in E.events()[since:] if e["event"] == "wait" and e.get("label") == label]
                if w:
                    return w[-1]
                time.sleep(0.02)
            return None

        def read_order():
            try:
                with open(order) as f:
                    return f.read().split()
            except OSError:
                return []

        def run_queue(record, first, second):
            """Lock held with `record`; `first` then `second` queue up; release; their run order."""
            if os.path.exists(order):
                os.remove(order)
            fd = hold(record)
            procs = []
            for name, agent in (first, second):
                n = len(E.events())
                procs.append(waiter(name, agent))
                wait_line(name, since=n)
            os.close(fd)
            for pr in procs:
                pr.communicate(timeout=30)
            return read_order(), [pr.returncode for pr in procs]

        def put_ticket(ns, pid, info):
            os.makedirs(qdir, exist_ok=True)
            path = os.path.join(qdir, "%020d-%010d.ticket" % (ns, pid))
            info = dict({"pid": pid, "start": gate.proc_stat(pid)[1], "created": "x"}, **info)
            with open(path, "w") as f:
                f.write(json.dumps(info))
            return path

        # (F1) the lock record names agent A (A's job runs / ran last). A2 (agent A)
        # queues FIRST, B1 SECOND: B1 goes first, A2 does not re-take back-to-back
        o, rcs = run_queue(b"token=t pid=1 unit=- since=x label=A1 agent=A\n", ("A2", "A"), ("B1", None))
        check("fair: after A's job, B1 (queued later) runs before A2", o == ["B1", "A2"] and rcs == [0, 0],
              (o, rcs))
        wb = wait_line("B1")
        check("fair: B1's wait line: queue position 1, nothing ahead (A2 is deferred)",
              wb.get("queue_pos") == 1 and wb.get("ahead") == [], wb)
        # (F1 control) the same with an untagged A2: plain FIFO, A2 first
        o, rcs = run_queue(b"token=t pid=1 unit=- since=x label=A1 agent=A\n", ("A2", None), ("B1", None))
        check("fair control: untagged A2 keeps its FIFO place (A2, B1)", o == ["A2", "B1"], o)
        # (F1 control) a record without agent (an untagged holder): FIFO even for tagged A2
        o, rcs = run_queue(b"token=t pid=1 unit=- since=x label=A1\n", ("A2", "A"), ("B1", "B"))
        check("fair control: untagged last holder -> FIFO (A2, B1)", o == ["A2", "B1"], o)
        # (F3) the last holder is B: A2 is not deferred, B1 (agent B) is -> A2, B1
        o, rcs = run_queue(b"token=t pid=1 unit=- since=x label=B0 agent=B\n", ("A2", "A"), ("B1", "B"))
        check("fair: last holder B -> A2 first, B1 (agent B) is the one that waits", o == ["A2", "B1"], o)
        # HEAVY_JOB_AGENT works like --agent
        if os.path.exists(order):
            os.remove(order)
        fd = hold(b"token=t pid=1 unit=- since=x label=A1 agent=A\n")
        a2 = waiter("A2env", extra_env={"HEAVY_JOB_AGENT": "A"})
        wait_line("A2env")
        b1 = waiter("B1env")
        wait_line("B1env")
        os.close(fd)
        for pr in (a2, b1):
            pr.communicate(timeout=30)
        check("fair: HEAVY_JOB_AGENT=A defers like --agent A (B1env, A2env)",
              read_order() == ["B1env", "A2env"], read_order())

        # (F6) end to end through real gate runs: A1 (agent A) runs; A2 (agent A) then B1
        # (agent B) queue up behind it -> A1, B1, A2; the lock record of each run names its agent
        if os.path.exists(order):
            os.remove(order)
        set_record(b"")
        a1 = waiter("A1", "A", job="echo A1 >> %s; sleep 1.5" % order)
        end = time.monotonic() + 10
        while time.monotonic() < end and "agent=A" not in open(E.lock).read():
            time.sleep(0.02)
        rec_a = gate.read_record(E.lock)
        n = len(E.events())
        a2 = waiter("A2", "A")
        wait_line("A2", since=n)
        n = len(E.events())
        b1 = waiter("B1", "B")
        wait_line("B1", since=n)
        for pr in (a1, a2, b1):
            pr.communicate(timeout=30)
        check("fair end to end: A1 then B1 then A2 (A does not re-take while B waits)",
              read_order() == ["A1", "B1", "A2"] and [a1.returncode, a2.returncode, b1.returncode] == [0, 0, 0],
              read_order())
        check("fair: a tagged run writes agent=A into the lock record, after the label",
              rec_a.get("agent") == "A" and rec_a.get("label") == "A1" and "token" in rec_a, rec_a)
        p = E.run(["--label", "UNT", "--", "true"])
        check("fair: an untagged run writes no agent into the lock record",
              "agent" not in gate.read_record(E.lock) and gate.read_record(E.lock).get("label") == "UNT",
              gate.read_record(E.lock))
        st = [e for e in E.events() if e["event"] == "start" and e.get("label") == "B1"][-1]
        check("fair: the start line of a tagged run names its agent", st.get("agent") == "B", st)

        # ticket content: "fair": 1 always, "agent" only when tagged
        fd = hold(b"token=t pid=1 unit=- since=x label=X\n")
        t1 = waiter("TAG", "A")
        wait_line("TAG")
        t2 = waiter("NOTAG")
        wait_line("NOTAG")
        bodies = {}
        for name in tickets():
            with open(os.path.join(qdir, name)) as f:
                b = json.loads(f.read())
            bodies[b["label"]] = b
        t1.send_signal(15)
        t2.send_signal(15)
        t1.communicate(timeout=10)
        t2.communicate(timeout=10)
        os.close(fd)
        check("fair: tickets carry fair=1; agent only on the tagged one",
              bodies.get("TAG", {}).get("fair") == 1 and bodies["TAG"].get("agent") == "A"
              and bodies.get("NOTAG", {}).get("fair") == 1 and "agent" not in bodies["NOTAG"], bodies)

        # (F4) a deferred ticket yields only to tickets that know the rule (fair: 1)
        marker = os.path.join(td, "ran")
        set_record(b"token=t pid=1 unit=- since=x label=A1 agent=A\n")
        blocker = subprocess.Popen(["sleep", "30"])
        newer = put_ticket(time.time_ns() + 10 ** 12, blocker.pid, {"label": "aware", "fair": 1})
        p = E.run(["--wait-sec", "1", "--agent", "A", "--label", "DEF", "--", "touch", marker])
        rf = E.events()[-1]
        check("fair: deferred A waits for a younger fair-aware ticket -> 73, not run, ahead [aware]",
              p.returncode == 73 and not os.path.exists(marker) and rf.get("ahead") == ["aware"]
              and rf.get("queue_pos") == 2, (p.returncode, rf))
        os.remove(newer)
        put_ticket(time.time_ns() + 10 ** 12, blocker.pid, {"label": "oldgate"})
        p = E.run(["--wait-sec", "2", "--agent", "A", "--", "touch", marker])
        check("fair: deferred A does NOT wait for a younger ticket of an older gate (no fair key): runs",
              p.returncode == 0 and os.path.exists(marker), (p.returncode, p.stderr))
        os.remove(marker)
        for name in tickets():
            os.remove(os.path.join(qdir, name))

        # (F5) an untagged new caller skips an OLDER deferred ticket, but not an older non-deferred one
        set_record(b"token=t pid=1 unit=- since=x label=A1 agent=A\n")
        put_ticket(1, blocker.pid, {"label": "olderA", "fair": 1, "agent": "A"})
        p = E.run(["--wait-sec", "2", "--label", "U", "--", "touch", marker])
        check("fair: last holder A -> an older ticket of agent A is skipped, U runs",
              p.returncode == 0 and os.path.exists(marker), (p.returncode, p.stderr))
        os.remove(marker)
        set_record(b"token=t pid=1 unit=- since=x label=B0 agent=B\n")
        p = E.run(["--wait-sec", "1", "--label", "U2", "--", "touch", marker])
        rf = E.events()[-1]
        check("fair: last holder B -> the older agent-A ticket is ahead, U2 refused 73",
              p.returncode == 73 and not os.path.exists(marker) and rf.get("ahead") == ["olderA"], (p.returncode, rf))
        blocker.kill()
        blocker.wait()

    # --- LIVE: a real transient scope is stopped by --max-sec
    try:
        live = live_scope_ok()
    except (OSError, subprocess.TimeoutExpired):
        live = False
    if os.environ.get("HEAVY_JOB_TEST_NO_LIVE") == "1":
        live = False
    if not live:
        print("  SKIP live --max-sec test (no systemd --user scope here)")
        return
    with tempfile.TemporaryDirectory() as td:
        E = Env(td, live=True)
        pidf = os.path.join(td, "bg.pid")
        t0 = time.monotonic()
        p = E.run(["--max-mem", "200M", "--min-mb", "0", "--max-sec", "1", "--", "sh", "-c",
                   "sleep 35.94 & echo $! > %s; wait" % pidf])
        dt = time.monotonic() - t0
        bg = read_pid(pidf)
        fin = E.events()[-1]
        st = subprocess.run(["systemctl", "--user", "show", "-p", "ActiveState", "--value",
                             fin.get("unit", "x") + ".scope"], capture_output=True, text=True)
        check("LIVE max-sec: exit 76, the child is gone, the scope is not active, lock free",
              p.returncode == 76 and bg and gone(bg) and st.stdout.strip() != "active" and lock_free(E.lock),
              (p.returncode, bg, st.stdout, p.stderr))
        check("LIVE max-sec: bounded (< 15 s), finish line max_sec_exceeded",
              dt < 15 and fin.get("max_sec_exceeded") is True and fin.get("exit") == 76, (dt, fin))


# --- the short lane (--max-sec <= 300 goes before long jobs)

JOB_SH = """#!/bin/sh
# job.sh NAME STAMPS [SEC]: wall-clock start/end stamps, for the run order and overlap
echo "S $(date +%s.%N) $1" >> "$2"
sleep "${3:-0.3}"
echo "E $(date +%s.%N) $1" >> "$2"
"""

def finish(procs, bound=90):
    for p in procs:
        try:
            p.communicate(timeout=bound)
        except subprocess.TimeoutExpired:
            p.kill()
            p.communicate()


class Q:
    """One short-lane scenario: a temp lock, queue and log (Env), a job that stamps
    its run, and gate calls through the wrapper W (the real one or a mutant copy)."""

    def __init__(self, td, W, avail_mb=6000, **env):
        self.W = W
        self.E = Env(td, avail_mb=avail_mb)
        self.stamps = os.path.join(td, "stamps")
        self.job = os.path.join(td, "job.sh")
        with open(self.job, "w") as f:
            f.write(JOB_SH)
        os.chmod(self.job, 0o755)
        self.extra = env
        self.fd = None

    def env(self, **extra):
        return self.E.env(**dict(self.extra, **extra))

    def argv(self, name, wait_sec=30, args=(), sec=None):
        return [self.W, "--wait-sec", str(wait_sec), "--label", name] + list(args) + \
            ["--", self.job, name, self.stamps] + ([str(sec)] if sec else [])

    def start(self, name, wait_sec=30, args=(), **extra):
        n = len(self.E.events())
        p = subprocess.Popen(self.argv(name, wait_sec, args), env=self.env(**extra),
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        p.wl = self.wait_line(name, since=n)
        return p

    def wait_line(self, label, since=0, bound=10):
        end = time.monotonic() + bound
        while time.monotonic() < end:
            w = [e for e in self.E.events()[since:] if e["event"] == "wait" and e.get("label") == label
                 and e.get("reason") == "lock"]
            if w:
                return w[0]
            time.sleep(0.02)
        return {}

    def line(self, label, kind, ok=None):
        ev = [e for e in self.E.events() if e.get("label") == label and e["event"] == kind
              and (ok is None or e.get("reason") == ok)]
        return ev[-1] if ev else {}

    def hold(self):
        self.fd = os.open(self.E.lock, os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        os.ftruncate(self.fd, 0)
        os.write(self.fd, b"token=t pid=1 unit=- since=x label=holder\n")

    def release(self):
        os.close(self.fd)
        self.fd = None

    def runs(self):
        """[(name, start, end)] of the jobs that ran, in start order."""
        try:
            with open(self.stamps) as f:
                lines = [l.split() for l in f]
        except OSError:
            return []
        starts, out = {}, []
        for parts in lines:
            if len(parts) != 3:
                continue
            kind, t, name = parts
            if kind == "S":
                starts.setdefault(name, []).append(float(t))
            elif starts.get(name):
                out.append((name, starts[name].pop(0), float(t)))
        return sorted(out, key=lambda r: r[1])

    def order(self):
        return [r[0] for r in self.runs()]

    def serial(self):
        """Never two jobs at once: every job starts after the previous one ended."""
        r = self.runs()
        return all(r[i + 1][1] >= r[i][2] for i in range(len(r) - 1))


def lane_overtake(td, W, s_sec=300):
    """L (no --max-sec) queues first, S (--max-sec s_sec) second: S runs first."""
    q = Q(td, W)
    q.hold()
    l = q.start("L")
    s = q.start("S", args=["--max-sec", str(s_sec)])
    q.release()
    finish([l, s])
    st = q.line("S", "start")
    return q.order(), s.wl, st, q.line("L", "start"), q.serial(), [l.returncode, s.returncode]


def lane_limit(td, W):
    """L, then S1..S4 (short): S1, S2, S3 overtake L; the 4th does not."""
    q = Q(td, W)
    q.hold()
    procs = [q.start("L", wait_sec=20)]
    procs += [q.start("S%d" % i, wait_sec=20, args=["--max-sec", "60"]) for i in range(1, 5)]
    q.release()
    finish(procs)
    o = q.order()
    k = [q.line(n, "start").get("short_streak") for n in ("S1", "S2", "S3", "S4")]
    ok = (o == ["S1", "S2", "S3", "L", "S4"] and k == [1, 2, 3, None] and q.serial()
          and [p.returncode for p in procs] == [0] * 5
          and "short_streak" not in gate.read_record(q.E.lock))
    return ok, (o, k, [p.returncode for p in procs])


def lane_count_started(td, W):
    """L waits; S1 (short, needs more memory than there is) overtakes it, takes
    the lock and is refused 75 without starting; S2, S3, S4 (short) follow. S1
    must not count: S2, S3, S4 are the three that pass L, then L runs."""
    q = Q(td, W, avail_mb=1000)
    small = ["--max-mem", "100M", "--min-mb", "0"]   # floor 600 MB: admitted
    q.hold()
    procs = [q.start("L", wait_sec=30, args=small)]
    procs.append(q.start("S1", wait_sec=3, args=["--max-sec", "60", "--max-mem", "100M",
                                                 "--min-mb", "2000"]))   # floor 2000 MB: 75
    procs += [q.start("S%d" % i, wait_sec=30, args=small + ["--max-sec", "60"]) for i in (2, 3, 4)]
    q.release()
    finish(procs)
    o = q.order()
    k = [q.line(n, "start").get("short_streak") for n in ("S2", "S3", "S4")]
    rcs = [p.returncode for p in procs]
    ok = (rcs == [0, 75, 0, 0, 0] and q.line("S1", "refuse").get("reason") == "memory_timeout"
          and o == ["S2", "S3", "S4", "L"] and k == [1, 2, 3] and q.serial())
    return ok, (o, k, rcs)


def fc_unreadable_record(td, W):
    """A queued waiter whose lock record becomes unreadable: 74, not 73, not run."""
    q = Q(td, W)
    marker = os.path.join(td, "ran")
    q.hold()
    w = subprocess.Popen([W, "--wait-sec", "5", "--label", "W", "--", "touch", marker],
                         env=q.env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    q.wait_line("W")
    os.chmod(q.E.lock, 0)
    finish([w])
    os.chmod(q.E.lock, 0o644)
    q.release()
    rf = q.line("W", "refuse")
    return (w.returncode == 74 and rf.get("reason") == "queue_io_error" and "lock record" in rf.get("error", "")
            and not os.path.exists(marker)), (w.returncode, rf)


def mutant_wrapper(td, name, old, new, count=1):
    """A copy of the gate with ONE rule broken (old -> new), and its wrapper.
    None if the source does not contain `old` exactly `count` times."""
    with open(GATE) as f:
        src = f.read()
    if src.count(old) != count:
        return None
    d = os.path.join(td, "mutant-" + name)
    os.makedirs(d)
    with open(os.path.join(d, "heavy-job.py"), "w") as f:
        f.write(src.replace(old, new))
    shutil.copy(WRAPPER, os.path.join(d, "heavy-job.sh"))
    return os.path.join(d, "heavy-job.sh")


def test_short_lane():
    def scenario(fn, *args):
        with tempfile.TemporaryDirectory() as td:
            return fn(td, *args)

    # --- short lane
    o, wl, st, lst, serial, rcs = scenario(lane_overtake, WRAPPER, 300)
    check("short lane: a short job (--max-sec 300) queued after a long one runs first (S, L), one at a time",
          o == ["S", "L"] and serial and rcs == [0, 0] and wl.get("queue_pos") == 1
          and wl.get("short") is True, (o, wl, serial, rcs))
    check("short lane: the start line says short, passed [L], short_streak 1; the long one has none",
          st.get("short") is True and st.get("passed") == ["L"] and st.get("short_streak") == 1
          and "short" not in lst and "passed" not in lst, (st, lst))
    o, wl, st, lst, serial, rcs = scenario(lane_overtake, WRAPPER, 301)
    check("short lane: --max-sec 301 is long: no overtaking (L, S)", o == ["L", "S"] and serial
          and "short" not in st, (o, st))
    ok, info = scenario(lane_limit, WRAPPER)
    check("short lane: S1, S2, S3 overtake the waiting L; the 4th short does NOT (S1 S2 S3 L S4), "
          "never two at once, the long run resets the count", ok, info)
    ok, info = scenario(lane_count_started, WRAPPER)
    check("short lane: a short job refused 75 (never started) does not count: S2 S3 S4 pass L, then L",
          ok, info)

    # --- invariant: exactly one job at a time, also in a mixed burst with nothing held
    with tempfile.TemporaryDirectory() as td:
        q = Q(td, WRAPPER)
        procs = []
        for name, args in (("L1", ()), ("S1", ("--max-sec", "60")), ("L2", ()),
                           ("S2", ("--max-sec", "60")), ("S3", ("--max-sec", "300")), ("L3", ())):
            procs.append(subprocess.Popen(q.argv(name, 30, args, sec=0.2), env=q.env(),
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        finish(procs)
        r = q.runs()
        check("invariant: a burst of 6 mixed short/long calls all run, never two at once (timestamps)",
              [p.returncode for p in procs] == [0] * 6 and len(r) == 6 and q.serial(), r)

    # --- the new failure path fails closed
    ok, info = scenario(fc_unreadable_record, WRAPPER)
    check("fail closed: an unreadable lock record (the short-lane counter) -> 74, not 73, not run",
          ok, info)
    # --- mutants: each rule broken on its own must be caught by its test
    mutants = (
        ("lane-off", "    return isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= SHORT_MAX_SEC\n",
         "    return False\n", 1, lane_overtake, (300,)),
        ("lane-boundary", "1 <= v <= SHORT_MAX_SEC", "1 <= v < SHORT_MAX_SEC", 1, lane_overtake, (300,)),
        ("lane-no-limit",
         '    return not (k >= SHORT_OVERTAKE_MAX and rec.get("short_long_pos") in live)\n',
         "    return True\n", 1, lane_limit, ()),
        ("lane-no-count", '                streak = int(prev.get("short_streak", "0")) + 1\n',
         "                streak = 1\n", 1, lane_limit, ()),
        ("lane-count-unstarted", "    write_record(carry_tail)\n", "    write_record(lane_tail)\n", 1,
         lane_count_started, ()),
        ("fc-record-read", "read_record(lp, strict=True)", "read_record(lp)", 1, fc_unreadable_record, ()),
    )
    with tempfile.TemporaryDirectory() as mtd:
        for name, old, new, count, fn, args in mutants:
            W = mutant_wrapper(mtd, name, old, new, count)
            if W is None:
                check("mutant %s: applies to the gate source" % name, False, "pattern not found")
                continue
            res = scenario(fn, W, *args)
            if fn is lane_overtake:
                caught = res[0] != ["S", "L"]
            else:
                caught = not res[0]
            check("mutant %s: caught by %s" % (name, fn.__name__), caught, res)


if __name__ == "__main__":
    sys.exit(main())
