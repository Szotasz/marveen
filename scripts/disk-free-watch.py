#!/usr/bin/env python3
"""
disk-free-watch.py -- a model-free free-space watcher (DISKFREEWATCH1027).

Why: on 2026-10-27 the data volume filled up (117 MiB free) and the whole
fleet stopped (Bash, Slack, Gromzo, transcripts: ENOSPC) with no warning
before it. This runs as a `command` scheduled task (every 15 minutes, no LLM)
and tells the owner (Slack, through notify.sh) and the main agent (an
inter-agent message) when the free space falls below a threshold.

The measure is the volume's free space as df reports it (statvfs f_bavail),
never du: on APFS du counts clones in full (a Chrome code_sign_clone showed
177 GB in du for about 1 GB real). The sizes of the known growing folders in
the alert are du figures, marked as such: they say where to look, not what
deleting would free.

Levels: ok, warn (< DISK_WARN_GB, default 50), crit (< DISK_CRIT_GB, default
20). Hysteresis, so it never alerts every run:
  - an alert goes out when the level gets worse (ok -> warn, ok/warn -> crit);
  - while crit, it repeats at most every CRIT_REPEAT_S (60 min);
  - the level goes back to ok only above warn + RECOVER_MARGIN_GB (10 GB),
    with one "rendben" message; between warn and that margin nothing changes.

Exit code: 0 whenever it measured (an alert is not a failure); 1 only when it
could not measure or not save its state, so the runner's failure streak
catches a broken watcher.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile, time, urllib.request

GB = 1024 ** 3
CRIT_REPEAT_S = 3600
RECOVER_MARGIN_GB = 10
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.path.expanduser("~")
# The known growing folders (the card): sizes only for the alert text.
KNOWN_DIRS = [os.path.join(ROOT, "agents", "iris", "workspace"), os.path.join(HOME, "Movies"), os.path.join(HOME, ".colima")]


def level_of(free_gb, warn_gb, crit_gb):
    if free_gb < crit_gb:
        return "crit"
    if free_gb < warn_gb:
        return "warn"
    return "ok"


def decide(prev, free_gb, now, warn_gb, crit_gb):
    """-> (new_state, message_kind or None). Pure: prev is the saved state
    ({"level", "alerted_at"}), message_kind is "warn", "crit" or "recovered"."""
    prev_level = prev.get("level", "ok")
    alerted_at = prev.get("alerted_at", 0) or 0
    raw = level_of(free_gb, warn_gb, crit_gb)
    rank = {"ok": 0, "warn": 1, "crit": 2}
    if rank[raw] > rank[prev_level]:
        return {"level": raw, "alerted_at": now}, raw
    if raw == "crit":
        if now - alerted_at >= CRIT_REPEAT_S:
            return {"level": "crit", "alerted_at": now}, "crit"
        return {"level": "crit", "alerted_at": alerted_at}, None
    if prev_level != "ok" and free_gb >= warn_gb + RECOVER_MARGIN_GB:
        return {"level": "ok", "alerted_at": now}, "recovered"
    # Better than before but inside the margin: keep the worse level, say nothing.
    return {"level": prev_level, "alerted_at": alerted_at}, None


def du_gb(path, timeout_s=20):
    if not os.path.exists(path):
        return None
    try:
        out = subprocess.run(["du", "-sk", path], capture_output=True, text=True, timeout=timeout_s).stdout
        return int(out.split()[0]) / (1024 * 1024)
    except (subprocess.SubprocessError, ValueError, IndexError, OSError):
        return None


def message(kind, free_gb, total_gb, warn_gb, crit_gb, dirs):
    if kind == "recovered":
        return "Lemez: ismét rendben, %.0f GB szabad (%.0f GB-ból)." % (free_gb, total_gb)
    head = ("KRITIKUS: %.1f GB szabad a lemezen (küszöb %d GB). Ha elfogy, a flotta leáll." % (free_gb, crit_gb)) if kind == "crit" \
        else ("Figyelem: %.0f GB szabad a lemezen (küszöb %d GB)." % (free_gb, warn_gb))
    lines = [head, "Ismert növekvő mappák (du szerint, APFS-klónok miatt felülbecsülhet):"]
    for path, size in dirs:
        shown = path.replace(HOME, "~", 1)
        lines.append("- %s: %s" % (shown, "nincs meg" if size is None else "%.1f GB" % size))
    return "\n".join(lines)


def save_state(path, state):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".disk-free-watch-")
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def send(text, root):
    """Slack to the owner (notify.sh), and an inter-agent message to the main agent. True if at
    least one went out. The token never reaches an argv (Dani 50671 (1)): urllib, no subprocess."""
    try:
        slack = subprocess.run([os.path.join(root, "scripts", "notify.sh"), text], capture_output=True, text=True, timeout=60).returncode == 0
    except (OSError, subprocess.SubprocessError):
        slack = False
    agent = False
    try:
        token = open(os.path.join(root, "store", ".dashboard-token")).read().strip()
        # The main agent's self-notice form (CLAUDE.md, level 1): an unregistered sender id would be refused.
        body = json.dumps({"from": "marveen", "to": "marveen", "content": "[DISKFREEWATCH1027] " + text}).encode("utf-8")
        req = urllib.request.Request("http://localhost:3420/api/messages", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=30) as r:
            agent = r.status == 200
    except (OSError, ValueError):
        agent = False
    if not (slack and agent):
        print("disk-free-watch: sent slack=%s agent=%s" % (slack, agent), file=sys.stderr)
    return slack or agent


def main(argv=None):
    ap = argparse.ArgumentParser(description="free-space watcher")
    ap.add_argument("--path", default=HOME, help="a path on the watched volume")
    ap.add_argument("--state", default=os.path.join(ROOT, "store", "disk-free-watch.json"))
    ap.add_argument("--free-gb", type=float, help="tests: use this instead of measuring")
    ap.add_argument("--dry-run", action="store_true", help="print the message instead of sending it")
    ap.add_argument("--root", default=ROOT, help="tests: the install root (notify.sh, store/.dashboard-token)")
    args = ap.parse_args(argv)
    warn_gb = float(os.environ.get("DISK_WARN_GB", "50"))
    crit_gb = float(os.environ.get("DISK_CRIT_GB", "20"))
    try:
        usage = shutil.disk_usage(args.path)
    except OSError as e:
        print("disk-free-watch: cannot measure %s: %s" % (args.path, e), file=sys.stderr)
        return 1
    free_gb = args.free_gb if args.free_gb is not None else usage.free / GB
    try:
        prev = json.load(open(args.state))
    except (OSError, ValueError):
        prev = {}
    prev = prev if isinstance(prev, dict) else {}
    state, kind = decide(prev, free_gb, int(time.time()), warn_gb, crit_gb)
    if kind:
        dirs = [] if kind == "recovered" else [(p, du_gb(p)) for p in KNOWN_DIRS]
        text = message(kind, free_gb, usage.total / GB, warn_gb, crit_gb, dirs)
        if args.dry_run:
            print(text)
        elif not send(text, args.root):
            # Nothing went out: the state stays, so the next run tries again, and exit 1 lets the
            # runner's failure streak see it (Dani 50671 (2)).
            print("disk-free-watch: %.1f GB free, level %s, the alert could NOT be sent" % (free_gb, state["level"]), file=sys.stderr)
            return 1
    try:
        save_state(args.state, state)
    except OSError as e:
        print("disk-free-watch: cannot save state: %s" % e, file=sys.stderr)
        return 1
    print("disk-free-watch: %.1f GB free, level %s%s" % (free_gb, state["level"], (", sent " + kind) if kind else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
