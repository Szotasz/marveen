#!/usr/bin/env python3
"""fleet-snapshot -- what did that update actually take from us?

WHY THIS EXISTS. On 2026-09-01 an update removed three things and said nothing: the runAsUser
plumbing in agent-process.ts, and two security profiles. We found each one separately, by
tripping over its consequence hours later. Nobody could answer the only question that mattered
at 09:23, which was "what is different now".

That question is answerable mechanically, but only if somebody wrote down the BEFORE. This is
that. Run `before`, run the update, run `after`. It prints what disappeared, what shrank, and
what is new -- no memory, no judgement.

USAGE
  python3 scripts/fleet-snapshot.py before        # write the snapshot
  python3 scripts/fleet-snapshot.py after         # diff the live tree against it
  python3 scripts/fleet-snapshot.py show          # what is in the snapshot

The snapshot is installation state, so it lives under store/ (gitignored), like the upstream
ledger. One file, overwritten by each `before`; the previous one is kept as .prev so a missed
`after` is still recoverable.

WHAT IT WATCHES, and each item is on the list because it was lost or nearly lost:

  templates/profiles/*.json   two were deleted; agents fell back to permissive
  scripts/*.sh, *.py          31 fleet helpers live only on our branches
  marker counts in src/       runAsUser went to zero in agent-process.ts
  agents/*/agent-config.json  the runAsUser and securityProfile assignments

It deliberately does NOT snapshot node_modules, dist or .git: those are rebuilt, and noise in
a diff is what makes people stop reading it.
"""

import hashlib
import json
import os
import sys

ROOT = os.environ.get("FLEET_ROOT", "/home/marveen/marveen")
STORE = os.path.join(ROOT, "store")
SNAP = os.path.join(STORE, "fleet-snapshot.json")

# (path, needle) -> how many times the needle must appear. Counted, not just present:
# a file can survive an update with the patch cut out of it, which is exactly what happened.
MARKERS = [
    ("src/web/agent-process.ts", "runAsUser"),
    ("src/web/agent-config.ts", "runAsUser"),
    ("src/web/routes/agent-terminal.ts", "tmuxInvocationFor"),
    ("scripts/agent-msg.sh", "argumentum erkezett"),
]


def sha(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()[:16]
    except Exception:
        return None


def collect():
    snap = {"profiles": {}, "scripts": {}, "markers": {}, "agents": {}}

    pdir = os.path.join(ROOT, "templates", "profiles")
    if os.path.isdir(pdir):
        for fn in sorted(os.listdir(pdir)):
            if fn.endswith(".json"):
                p = os.path.join(pdir, fn)
                mode = None
                try:
                    with open(p) as f:
                        mode = json.load(f).get("permissionMode")
                except Exception:
                    pass
                snap["profiles"][fn] = {"sha": sha(p), "permissionMode": mode}

    sdir = os.path.join(ROOT, "scripts")
    if os.path.isdir(sdir):
        for fn in sorted(os.listdir(sdir)):
            if fn.endswith((".sh", ".py")):
                p = os.path.join(sdir, fn)
                if os.path.isfile(p):
                    snap["scripts"][fn] = {"sha": sha(p), "size": os.path.getsize(p)}

    for path, needle in MARKERS:
        full = os.path.join(ROOT, path)
        n = 0
        if os.path.isfile(full):
            try:
                with open(full, encoding="utf-8", errors="replace") as f:
                    n = f.read().count(needle)
            except Exception:
                n = -1
        else:
            n = -1  # -1 means the FILE is gone, which is not the same as the needle being gone
        snap["markers"]["%s :: %s" % (path, needle)] = n

    adir = os.path.join(ROOT, "agents")
    if os.path.isdir(adir):
        for name in sorted(os.listdir(adir)):
            cfg = os.path.join(adir, name, "agent-config.json")
            if os.path.isfile(cfg):
                try:
                    with open(cfg) as f:
                        d = json.load(f)
                    snap["agents"][name] = {
                        "runAsUser": d.get("runAsUser"),
                        "securityProfile": d.get("securityProfile"),
                        "model": d.get("model"),
                    }
                except Exception:
                    snap["agents"][name] = {"unreadable": True}

    return snap


def cmd_before():
    os.makedirs(STORE, exist_ok=True)
    if os.path.isfile(SNAP):
        try:
            os.replace(SNAP, SNAP + ".prev")
        except Exception:
            pass
    snap = collect()
    import time
    snap["_taken_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(SNAP, "w") as f:
        json.dump(snap, f, indent=1, sort_keys=True)
    print("snapshot written: %s" % SNAP)
    print("  profiles: %d   scripts: %d   markers: %d   agents: %d" % (
        len(snap["profiles"]), len(snap["scripts"]), len(snap["markers"]), len(snap["agents"])))
    print()
    print("Now run the update. Afterwards:  python3 scripts/fleet-snapshot.py after")
    return 0


def cmd_after():
    if not os.path.isfile(SNAP):
        print("NO SNAPSHOT. Nothing to compare against -- that is the whole failure mode this")
        print("tool exists for. Run `before` next time, BEFORE the update.")
        return 1
    with open(SNAP) as f:
        old = json.load(f)
    new = collect()

    findings = []

    for fn, meta in old.get("profiles", {}).items():
        if fn not in new["profiles"]:
            findings.append("PROFILE GONE      %s (was permissionMode=%s)" % (fn, meta.get("permissionMode")))
        elif new["profiles"][fn]["sha"] != meta["sha"]:
            findings.append("profile changed   %s (permissionMode %s -> %s)" % (
                fn, meta.get("permissionMode"), new["profiles"][fn].get("permissionMode")))
    for fn in new["profiles"]:
        if fn not in old.get("profiles", {}):
            findings.append("profile new       %s" % fn)

    for fn, meta in old.get("scripts", {}).items():
        if fn not in new["scripts"]:
            findings.append("SCRIPT GONE       scripts/%s" % fn)
        elif new["scripts"][fn]["sha"] != meta["sha"]:
            findings.append("script changed    scripts/%s (%d -> %d bytes)" % (
                fn, meta["size"], new["scripts"][fn]["size"]))
    for fn in new["scripts"]:
        if fn not in old.get("scripts", {}):
            findings.append("script new        scripts/%s" % fn)

    for key, n_old in old.get("markers", {}).items():
        n_new = new["markers"].get(key, -1)
        if n_new == n_old:
            continue
        if n_new == -1:
            findings.append("FILE GONE         %s" % key.split(" :: ")[0])
        elif n_new < n_old:
            findings.append("MARKER LOST       %s (%d -> %d)" % (key, n_old, n_new))
        else:
            findings.append("marker grew       %s (%d -> %d)" % (key, n_old, n_new))

    for name, meta in old.get("agents", {}).items():
        cur = new["agents"].get(name)
        if cur is None:
            findings.append("AGENT CONFIG GONE %s" % name)
            continue
        for field in ("runAsUser", "securityProfile", "model"):
            if meta.get(field) != cur.get(field):
                findings.append("agent changed     %s.%s: %s -> %s" % (
                    name, field, meta.get(field), cur.get(field)))

    print("snapshot taken at: %s" % old.get("_taken_at", "?"))
    print()
    if not findings:
        print("RESULT: nothing our snapshot watches has changed.")
        return 0

    lost = [f for f in findings if f[:4].isupper() and " GONE" in f or f.startswith("MARKER LOST")]
    for f in findings:
        print("  " + f)
    print()
    if lost:
        print("RESULT: %d change(s), %d of them LOSSES. Do not start agents yet." % (len(findings), len(lost)))
        print("Restore from the branch that still has it:")
        print("  cd %s && git checkout rebase-proba -- <path>" % ROOT)
        print("Then rebuild and run: bash scripts/fleet-patch-check.sh")
        return 1
    print("RESULT: %d change(s), none of them losses." % len(findings))
    return 0


def cmd_show():
    if not os.path.isfile(SNAP):
        print("no snapshot yet")
        return 1
    with open(SNAP) as f:
        print(f.read())
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "before":
        sys.exit(cmd_before())
    if cmd == "after":
        sys.exit(cmd_after())
    if cmd == "show":
        sys.exit(cmd_show())
    print(__doc__)
    sys.exit(2)
