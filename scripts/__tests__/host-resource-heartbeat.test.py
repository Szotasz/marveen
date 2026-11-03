#!/usr/bin/env python3
"""Behaviour tests for scripts/host-resource-heartbeat.py.

Run: python3 scripts/__tests__/host-resource-heartbeat.test.py

Hermetic: fake meminfo / loadavg files, a fake disk and a temp log through the
HOST_HEARTBEAT_* test hooks. Exit codes under test: 0 OK, 1 resource warning,
2 measurement failed (incl. a crash and an invalid threshold), 3 log write
failed.
"""
import contextlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "host-resource-heartbeat.py")

if not os.path.isfile(SCRIPT):
    print("FAIL: %s does not exist" % SCRIPT)
    sys.exit(1)

spec = importlib.util.spec_from_file_location("host_resource_heartbeat", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

fails = []


def check(name, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + name + ((" -- " + str(extra)) if (extra and not cond) else ""))
    if not cond:
        fails.append(name)


NCPU = os.cpu_count() or 1
P = "HOST_HEARTBEAT_"


class Env:
    def __init__(self, td):
        self.mem = os.path.join(td, "meminfo")
        self.load = os.path.join(td, "loadavg")
        self.log = os.path.join(td, "heartbeat.jsonl")
        self.set_mem(5000)
        self.set_load(0.1)

    def set_mem(self, avail_mb, total_mb=7940):
        with open(self.mem, "w") as f:
            f.write("MemTotal:       %8d kB\nMemFree:          100000 kB\n"
                    "MemAvailable:   %8d kB\n" % (total_mb * 1024, avail_mb * 1024))

    def set_load(self, load1):
        with open(self.load, "w") as f:
            f.write("%.2f 0.50 0.40 1/300 12345\n" % load1)

    def run(self, *argv, **over):
        # hermetic disk by default (a nearly full real disk must not flip other cases to 1);
        # pass DISK_FREE_MB=None / DISK_USED_PCT=None to measure the real statvfs
        env = self.fixture_env()
        env.update({P + k: v for k, v in over.items()})
        env = {k: v for k, v in env.items() if v is not None}
        return subprocess.run([sys.executable, SCRIPT, *argv], env=env, capture_output=True,
                              text=True, timeout=30)

    def fixture_env(self):
        """The same fixtures as run(), as an environment dict: for in-process and
        child calls, so the real /proc (absent on macOS) is never read."""
        base = {k: v for k, v in os.environ.items() if not k.startswith(P)}
        return dict(base, **{P + "MEMINFO": self.mem, P + "LOADAVG": self.load, P + "LOG": self.log,
                             P + "DISK_FREE_MB": "50000", P + "DISK_USED_PCT": "50"})

    def lines(self):
        try:
            with open(self.log) as f:
                return [json.loads(l) for l in f if l.strip()]
        except OSError:
            return []


def main():
    check("default log path is derived from the script location",
          mod.DEFAULT_LOG == os.path.join(ROOT, "store", "host-resource-heartbeat.jsonl"), mod.DEFAULT_LOG)

    with tempfile.TemporaryDirectory() as td:
        E = Env(td)

        p = E.run()
        check("OK -> exit 0, status line OK, one log line (warn=false)",
              p.returncode == 0 and p.stdout.rstrip().endswith("| OK")
              and len(E.lines()) == 1 and E.lines()[0]["warn"] is False, (p.returncode, p.stdout, p.stderr))

        E.set_mem(400)
        p = E.run()
        check("RAM low (400 MB) -> exit 1, WARN ram, logged warn=true",
              p.returncode == 1 and "WARN ram" in p.stdout and E.lines()[-1]["warn"] is True
              and E.lines()[-1]["mem_avail_mb"] == 400 and E.lines()[-1]["reasons"] == ["ram"],
              (p.returncode, p.stdout))

        # thresholds: a flag beats the environment, which beats the default
        p = E.run("--ram-min-mb", "300")
        check("--ram-min-mb 300 -> 400 MB free is OK (exit 0)", p.returncode == 0, (p.returncode, p.stdout))
        p = E.run(RAM_MIN_MB="300")
        check("HOST_HEARTBEAT_RAM_MIN_MB=300 -> exit 0", p.returncode == 0, (p.returncode, p.stdout))
        p = E.run("--ram-min-mb", "500", RAM_MIN_MB="300")
        check("the flag wins over the environment (500 > 400 -> exit 1)", p.returncode == 1,
              (p.returncode, p.stdout))
        E.set_mem(5000)

        E.set_load(2.5 * NCPU)
        p = E.run()
        check("load high (2.5/core) -> exit 1, WARN load",
              p.returncode == 1 and "WARN load" in p.stdout and E.lines()[-1]["warn"] is True,
              (p.returncode, p.stdout))
        p = E.run("--load-per-core-max", "3")
        check("--load-per-core-max 3 -> 2.5/core is OK", p.returncode == 0, (p.returncode, p.stdout))
        E.set_load(0.1)

        # an invalid threshold is a failed measurement (2), never a silent default
        for argv, over in ((("--ram-min-mb", "lots"), {}), ((), {"RAM_MIN_MB": "lots"}),
                           (("--load-per-core-max", "nan"), {}), (("--disk-used-pct-max", "-1"), {}),
                           (("--no-such-flag",), {})):
            p = E.run(*argv, **over)
            check("invalid threshold/flag %r %r -> exit 2 (not 0/1), says so" % (argv, over),
                  p.returncode == 2 and "MEASUREMENT FAILED" in p.stderr
                  and "not a resource alert" in p.stdout, (p.returncode, p.stdout, p.stderr))

        n = len(E.lines())
        os.remove(E.mem)
        p = E.run()
        check("meminfo unreadable -> exit 2 (not 1), reason on stderr, no log line",
              p.returncode == 2 and "MEASUREMENT FAILED" in p.stderr and "meminfo" in p.stderr
              and len(E.lines()) == n, (p.returncode, p.stderr))
        check("meminfo unreadable: no Traceback, the status line says it is not a resource alert",
              "Traceback" not in p.stderr and "not a resource alert" in p.stdout, p.stdout)

        with open(E.mem, "w") as f:
            f.write("MemTotal:        8130352 kB\nMemFree:          100000 kB\n")
        p = E.run()
        check("MemAvailable line missing -> exit 2 (never read as 0 MB = false alert)",
              p.returncode == 2 and "MemAvailable" in p.stderr, (p.returncode, p.stderr))

        with open(E.mem, "w") as f:
            f.write("MemTotal:        8130352 kB\nMemAvailable:   lots kB\n")
        p = E.run()
        check("MemAvailable unparsable -> exit 2", p.returncode == 2, (p.returncode, p.stderr))
        E.set_mem(5000)

        os.remove(E.load)
        p = E.run()
        check("loadavg unreadable -> exit 2", p.returncode == 2 and "loadavg" in p.stderr,
              (p.returncode, p.stderr))
        with open(E.load, "w") as f:
            f.write("garbage\n")
        p = E.run()
        check("loadavg garbage -> exit 2", p.returncode == 2, (p.returncode, p.stderr))
        # nan compares False against the threshold: a silent "OK" unless rejected
        for bad in ("nan", "inf"):
            with open(E.load, "w") as f:
                f.write("%s 0.50 0.40 1/300 12345\n" % bad)
            p = E.run()
            check("loadavg %r -> exit 2 (not 0), says so" % bad,
                  p.returncode == 2 and "loadavg" in p.stderr and "not finite" in p.stderr,
                  (p.returncode, p.stdout, p.stderr))
        E.set_load(0.1)

        # --no-log: print only
        n = len(E.lines())
        p = E.run("--no-log")
        check("--no-log -> exit 0, no sample written", p.returncode == 0 and len(E.lines()) == n,
              (p.returncode, p.stdout))
        alt = os.path.join(td, "alt.jsonl")
        p = E.run("--log", alt)
        check("--log PATH writes there", p.returncode == 0 and os.path.isfile(alt), (p.returncode, p.stdout))

        # unwritable log: a read-only directory where the file should be
        ro = os.path.join(td, "ro")
        os.mkdir(ro)
        os.chmod(ro, stat.S_IRUSR | stat.S_IXUSR)
        bad_log = os.path.join(ro, "heartbeat.jsonl")
        writable = os.access(ro, os.W_OK)  # root would still write: then this case is moot
        p = E.run(LOG=bad_log)
        check("unwritable log, resources OK -> exit 3, stderr names the failure, flagged line",
              writable or (p.returncode == 3 and "LOG WRITE FAILED" in p.stderr
                           and "LOG WRITE FAILED" in p.stdout and "| OK" in p.stdout),
              (p.returncode, p.stdout, p.stderr))
        E.set_mem(400)
        p = E.run(LOG=bad_log)
        check("unwritable log + RAM low -> exit 1 stays (alert wins), failure still on stderr",
              writable or (p.returncode == 1 and "LOG WRITE FAILED" in p.stderr
                           and "WARN" in p.stdout), (p.returncode, p.stdout, p.stderr))
        os.chmod(ro, stat.S_IRWXU)
        E.set_mem(5000)

    # an unexpected crash (not a MeasureError) exits 2, never 1.
    # Hermetic: loadavg is read BEFORE meminfo, so without fixtures the real
    # /proc/loadavg decides the outcome (on macOS it raises MeasureError and the
    # simulated bug is never reached). Every HOST_HEARTBEAT_* input points at a
    # fixture for the in-process call, and the bug must be shown to be reached.
    with tempfile.TemporaryDirectory() as td:
        E = Env(td)
        saved = dict(os.environ)
        real = mod.meminfo
        reached = []

        def boom(*a, **k):
            reached.append(True)
            raise RuntimeError("simulated bug")
        os.environ.clear()
        os.environ.update(E.fixture_env())
        mod.meminfo = boom
        err, out = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
                code = mod.entry([])
        finally:
            mod.meminfo = real
            os.environ.clear()
            os.environ.update(saved)
        check("uncaught crash -> exit 2 (not 1), named on stderr",
              reached and code == 2 and "UNEXPECTED ERROR" in err.getvalue()
              and "RuntimeError: simulated bug" in err.getvalue(), (reached, code, err.getvalue()))

        # a crash whose own report cannot be written (closed stdout and stderr) still
        # exits 2: run in a child so os._exit does not end this test process. Same
        # fixtures, and a marker file proves the simulated bug was the path taken
        # (a MeasureError report on a broken stderr would also end in exit 2).
        marker = os.path.join(td, "boom-reached")
        child = (
            "import importlib.util,os,sys\n"
            "spec=importlib.util.spec_from_file_location('hrh', %r)\n"
            "m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
            "def boom(*a, **k):\n"
            "    open(%r, 'w').close()\n"
            "    raise RuntimeError('simulated bug')\n"
            "m.meminfo=boom\n"
            "class Broken:\n"
            "    def write(self, *a): raise BrokenPipeError('closed')\n"
            "    def flush(self): raise BrokenPipeError('closed')\n"
            "sys.stdout=Broken(); sys.stderr=Broken()\n"
            "sys.exit(m.entry([]))\n" % (SCRIPT, marker))
        p = subprocess.run([sys.executable, "-c", child], env=E.fixture_env(), capture_output=True,
                           text=True, timeout=30)
        check("crash + unwritable report -> exit 2 (not 1)",
              p.returncode == 2 and os.path.exists(marker), (p.returncode, os.path.exists(marker), p.stderr[-300:]))

    # disk: free space below the floor (default 5 GB) is a resource alert
    with tempfile.TemporaryDirectory() as td:
        e = Env(td)
        p = e.run(DISK_FREE_MB="5119")
        check("disk 5119 MB free -> exit 1, WARN disk_free", p.returncode == 1
              and "WARN disk_free" in p.stdout, (p.returncode, p.stdout))
        p = e.run(DISK_FREE_MB="5120")
        check("disk 5120 MB free -> exit 0", p.returncode == 0, (p.returncode, p.stdout))
        rec = json.loads(open(e.log).read().splitlines()[-1])
        check("log record carries disk_free_mb and disk_path", rec.get("disk_free_mb") == 5120
              and rec.get("disk_path") == "/", rec)
        p = e.run("--disk-min-mb", "1024", DISK_FREE_MB="2048")
        check("--disk-min-mb 1024 -> 2 GB free is OK", p.returncode == 0, (p.returncode, p.stdout))
        p = e.run(DISK_FREE_MB="lots")
        check("unparsable fake disk -> exit 2 (not 1)", p.returncode == 2, (p.returncode, p.stdout))
        missing = os.path.join(td, "no-such-dir")
        p = e.run("--disk-path", missing, DISK_FREE_MB=None)
        check("statvfs on a missing path -> exit 2 (not 1)", p.returncode == 2, (p.returncode, p.stdout))
        p = e.run(DISK_PATH=missing, DISK_USED_PCT=None)
        check("statvfs on a missing path (used%, env path) -> exit 2 (not 1)", p.returncode == 2,
              (p.returncode, p.stdout))
        p = e.run("--disk-path", td, DISK_FREE_MB=None, DISK_USED_PCT=None)
        check("real statvfs on a temp dir -> not exit 2", p.returncode in (0, 1), (p.returncode, p.stdout))

        # disk: more than the used-percent ceiling (default 90%) is a resource alert
        p = e.run(DISK_USED_PCT="90.0")
        check("disk 90.0% used -> exit 0", p.returncode == 0 and "used 90.0%" in p.stdout,
              (p.returncode, p.stdout))
        p = e.run(DISK_USED_PCT="90.1")
        check("disk 90.1% used -> exit 1, WARN disk_used", p.returncode == 1 and "WARN disk_used" in p.stdout
              and "used 90.1%" in p.stdout, (p.returncode, p.stdout))
        rec = json.loads(open(e.log).read().splitlines()[-1])
        check("log record carries disk_used_pct", rec.get("disk_used_pct") == 90.1
              and rec.get("warn") is True, rec)
        # plenty of free MB, but over the ceiling: the free-space floor alone stays silent here
        p = e.run(DISK_FREE_MB="8000", DISK_USED_PCT="93")
        check("disk 93% used with 8 GB free -> exit 1 (not only the free-space floor)", p.returncode == 1,
              (p.returncode, p.stdout))
        p = e.run("--disk-used-pct-max", "95", DISK_USED_PCT="93")
        check("--disk-used-pct-max 95 -> 93% is OK", p.returncode == 0, (p.returncode, p.stdout))
        for bad in ("lots", "nan", ""):
            p = e.run(DISK_USED_PCT=bad)
            check("unparsable fake used%% %r -> exit 2 (not 1)" % bad, p.returncode == 2
                  and "DISK_USED_PCT" in p.stderr, (p.returncode, p.stderr))

    # used% is df's basis: used / (used + avail), root-reserved blocks excluded.
    # A real ext4 root that df shows as 90%; used / f_blocks would read 85.7.
    class FakeSt:
        f_blocks, f_bfree, f_bavail, f_frsize = 84530996, 84530996 - 72423052, 8600124, 1024
    real_statvfs = mod.os.statvfs
    old = os.environ.pop(P + "DISK_USED_PCT", None)
    mod.os.statvfs = lambda path: FakeSt()
    try:
        pct = mod.disk_used_pct("/")
    finally:
        mod.os.statvfs = real_statvfs
        if old is not None:
            os.environ[P + "DISK_USED_PCT"] = old
    check("used% matches df (89.39, not 85.68)", abs(pct - 89.386) < 0.01, pct)

    print()
    if fails:
        print("FAIL: %d check(s): %s" % (len(fails), ", ".join(fails)))
        return 1
    print("OK: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
