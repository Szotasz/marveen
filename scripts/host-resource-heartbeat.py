#!/usr/bin/env python3
"""Lightweight resource heartbeat for the fleet host. Read-only.

Measures available RAM, the 1-minute load per core and the root filesystem,
prints one status line, appends one JSONL sample, and exits with:

  0 = OK
  1 = resource WARNING (over a threshold): available RAM below --ram-min-mb,
      or 1-min load per core above --load-per-core-max, or free space on the
      watched filesystem below --disk-min-mb, or that filesystem more than
      --disk-used-pct-max percent used, as df counts it. A fixed free-space
      floor alone fires late on a large disk, and a percentage alone fires
      late on a small one, so both are checked.
      This is the ONLY code that means "resource alert".
  2 = MEASUREMENT FAILED: /proc/meminfo, /proc/loadavg or statvfs unreadable
      or incomplete, an invalid threshold, or any unexpected crash. Nothing is
      known about the resources; this is NOT a resource alert.
  3 = measured OK, but the log line could not be written (reason on stderr).
      With a resource warning the code stays 1 and the log failure is still
      reported on stderr and on the status line.

Linux only (it reads /proc). Meant to be run by a scheduler or a heartbeat
task that alerts on exit 1 and reports exit 2/3 as a monitoring problem.

Thresholds (flag > environment > default):
  --ram-min-mb          HOST_HEARTBEAT_RAM_MIN_MB          600
  --load-per-core-max   HOST_HEARTBEAT_LOAD_PER_CORE_MAX   2.0
  --disk-min-mb         HOST_HEARTBEAT_DISK_MIN_MB         5120
  --disk-used-pct-max   HOST_HEARTBEAT_DISK_USED_PCT_MAX   90
  --disk-path           HOST_HEARTBEAT_DISK_PATH           /
  --log                 HOST_HEARTBEAT_LOG                 <repo>/store/host-resource-heartbeat.jsonl
  --no-log              (print only, write no sample)

Test hooks (environment): HOST_HEARTBEAT_MEMINFO, HOST_HEARTBEAT_LOADAVG
(paths of fake /proc files), HOST_HEARTBEAT_DISK_FREE_MB (fake free MB,
integer), HOST_HEARTBEAT_DISK_USED_PCT (fake used percent, number).
"""
import argparse
import json
import math
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_LOG = os.path.join(ROOT, "store", "host-resource-heartbeat.jsonl")
ENV_PREFIX = "HOST_HEARTBEAT_"

DEFAULTS = {
    "ram_min_mb": 600,
    "load_per_core_max": 2.0,
    "disk_min_mb": 5 * 1024,
    "disk_used_pct_max": 90.0,
}

EXIT_OK = 0
EXIT_WARN = 1
EXIT_MEASURE_FAILED = 2
EXIT_LOG_FAILED = 3


class MeasureError(Exception):
    pass


def env(name):
    return os.environ.get(ENV_PREFIX + name)


def meminfo(path=None):
    path = path or env("MEMINFO") or "/proc/meminfo"
    d = {}
    try:
        with open(path) as f:
            for line in f:
                k, _, v = line.partition(":")
                try:
                    d[k] = int(v.strip().split()[0])  # kB
                except (ValueError, IndexError):
                    pass
    except OSError as e:
        raise MeasureError("cannot read %s: %s" % (path, e))
    for k in ("MemTotal", "MemAvailable"):
        if k not in d:
            # a missing value must never read as 0 MB free (a false RAM alert)
            raise MeasureError("%s has no usable %s line" % (path, k))
    return d["MemTotal"] // 1024, d["MemAvailable"] // 1024


def loadavg(path=None):
    path = path or env("LOADAVG") or "/proc/loadavg"
    try:
        with open(path) as f:
            load1 = float(f.read().split()[0])
    except OSError as e:
        raise MeasureError("cannot read %s: %s" % (path, e))
    except (ValueError, IndexError):
        raise MeasureError("%s is not a loadavg line" % path)
    if not math.isfinite(load1):
        # nan would compare False against the threshold: a silent "OK"
        raise MeasureError("%s load is not finite: %r" % (path, load1))
    return load1


def disk_free_mb(path):
    fake = env("DISK_FREE_MB")
    if fake is not None:
        try:
            return int(fake)
        except ValueError:
            raise MeasureError("%sDISK_FREE_MB is not an integer: %r" % (ENV_PREFIX, fake))
    try:
        st = os.statvfs(path)
    except OSError as e:
        raise MeasureError("cannot statvfs %s: %s" % (path, e))
    return st.f_bavail * st.f_frsize // (1024 * 1024)


def disk_used_pct(path):
    """Used percent the way df shows it: used / (used + available to users).
    The root-reserved blocks count as neither, so this reads higher than
    used / f_blocks (a few points on a typical ext4 root)."""
    fake = env("DISK_USED_PCT")
    if fake is not None:
        try:
            pct = float(fake)
        except ValueError:
            raise MeasureError("%sDISK_USED_PCT is not a number: %r" % (ENV_PREFIX, fake))
        if not math.isfinite(pct):
            # nan would compare False against the threshold: a silent "OK"
            raise MeasureError("%sDISK_USED_PCT is not finite: %r" % (ENV_PREFIX, fake))
        return pct
    try:
        st = os.statvfs(path)
    except OSError as e:
        raise MeasureError("cannot statvfs %s: %s" % (path, e))
    used = st.f_blocks - st.f_bfree
    if used + st.f_bavail <= 0:
        raise MeasureError("statvfs %s reports no usable blocks" % path)
    return 100.0 * used / (used + st.f_bavail)


def threshold(args, key, kind):
    """flag > environment > default. A value that is not a finite, non-negative
    number is a MeasureError: a threshold that silently fell back to a default
    (or to nan, which compares False) would hide exactly the alert it sets."""
    raw = getattr(args, key)
    source = "--" + key.replace("_", "-")
    if raw is None:
        raw = env(key.upper())
        source = ENV_PREFIX + key.upper()
    if raw is None:
        return DEFAULTS[key]
    try:
        val = kind(raw)
    except (TypeError, ValueError):
        raise MeasureError("%s is not a valid %s: %r" % (source, kind.__name__, raw))
    if not math.isfinite(val) or val < 0:
        raise MeasureError("%s must be a finite, non-negative number: %r" % (source, raw))
    return val


class ArgError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    # argparse exits 2 on a bad flag by itself; route it through the same
    # "measurement failed" report instead of a bare usage dump.
    def error(self, message):
        raise ArgError(message)


def parse_args(argv):
    p = Parser(description="One-line host resource heartbeat (RAM, load, root disk).")
    p.add_argument("--ram-min-mb", dest="ram_min_mb")
    p.add_argument("--load-per-core-max", dest="load_per_core_max")
    p.add_argument("--disk-min-mb", dest="disk_min_mb")
    p.add_argument("--disk-used-pct-max", dest="disk_used_pct_max")
    p.add_argument("--disk-path", dest="disk_path")
    p.add_argument("--log", dest="log")
    p.add_argument("--no-log", dest="no_log", action="store_true")
    return p.parse_args(argv)


def failed(reason):
    sys.stderr.write("host-resource-heartbeat: MEASUREMENT FAILED: %s\n" % reason)
    print("MEASUREMENT FAILED (not a resource alert): %s" % reason)
    return EXIT_MEASURE_FAILED


def main(argv=None):
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
    except ArgError as e:
        return failed("bad arguments: %s" % e)
    ncpu = os.cpu_count() or 1
    disk_path = args.disk_path or env("DISK_PATH") or "/"
    try:
        ram_min = threshold(args, "ram_min_mb", int)
        lpc_max = threshold(args, "load_per_core_max", float)
        disk_min = threshold(args, "disk_min_mb", int)
        pct_max = threshold(args, "disk_used_pct_max", float)
        load1 = loadavg()
        total_mb, avail_mb = meminfo()
        disk_mb = disk_free_mb(disk_path)
        disk_pct = disk_used_pct(disk_path)
    except MeasureError as e:
        return failed(str(e))
    lpc = load1 / ncpu
    reasons = []
    if avail_mb < ram_min:
        reasons.append("ram")
    if lpc > lpc_max:
        reasons.append("load")
    if disk_mb < disk_min:
        reasons.append("disk_free")
    if disk_pct > pct_max:
        reasons.append("disk_used")
    warn = bool(reasons)
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "ncpu": ncpu,
           "load1": round(load1, 2), "load_per_core": round(lpc, 2),
           "mem_total_mb": total_mb, "mem_avail_mb": avail_mb,
           "disk_path": disk_path, "disk_free_mb": disk_mb,
           "disk_used_pct": round(disk_pct, 2), "warn": warn, "reasons": reasons}
    log_err = None
    if not args.no_log:
        log_path = args.log or env("LOG") or DEFAULT_LOG
        try:
            with open(log_path, "a") as f:
                f.write(json.dumps(rec) + "\n")
        except OSError as e:
            log_err = "cannot write %s: %s" % (log_path, e)
            sys.stderr.write("host-resource-heartbeat: LOG WRITE FAILED: %s\n" % log_err)
    print("RAM free %d/%d MB | load %.2f (%.2f/core, %d cores) | disk %s free %.1f GB, "
          "used %.1f%% | %s%s"
          % (avail_mb, total_mb, load1, lpc, ncpu, disk_path, disk_mb / 1024.0, disk_pct,
             ("WARN " + ",".join(reasons)) if warn else "OK",
             " | LOG WRITE FAILED" if log_err else ""))
    if warn:
        return EXIT_WARN
    return EXIT_LOG_FAILED if log_err else EXIT_OK


def entry(argv=None):
    """main() with a crash net: an unexpected exception must never exit 1,
    because 1 is the resource alert."""
    try:
        return main(argv)
    except Exception as e:  # deliberately broad: a crash is a failed measurement
        try:
            sys.stderr.write("host-resource-heartbeat: UNEXPECTED ERROR (measurement failed): %s: %s\n"
                             % (type(e).__name__, e))
            print("MEASUREMENT FAILED (not a resource alert): %s" % type(e).__name__)
            sys.stdout.flush()
        except BaseException:
            # Reporting the crash failed too (e.g. closed stdout). Leave without
            # running any more Python, so nothing can turn this into exit 1.
            os._exit(EXIT_MEASURE_FAILED)
        return EXIT_MEASURE_FAILED


if __name__ == "__main__":
    sys.exit(entry())
