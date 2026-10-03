#!/usr/bin/env python3
"""Test of scripts/hooks/persona-change-notify.py, with the network stubbed.

Review of #1546: removing the change detection kept the whole suite green, because
nothing ran the script. This does: the hook is copied into a throwaway tree (so its
ROOT is the temp dir and nothing real is read or written), the Telegram call is
replaced with a recorder, and every case drives main() the way the harness does.
"""
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "hooks", "persona-change-notify.py")
FAILED = []


def check(name, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")
    if not ok:
        FAILED.append(name)


class Clock:
    """The hook's `time` module with time_ns() shifted forward, so a file written a moment ago looks
    old enough (past the racy margin) for the stat fast path to trust. Everything else is real."""

    def __init__(self, ahead_s):
        self.ahead_ns = int(ahead_s * 1e9)

    def time_ns(self):
        return time.time_ns() + self.ahead_ns

    def __getattr__(self, name):
        return getattr(time, name)


class Tree:
    """A throwaway project root with the hook inside, a token, and a recorded network."""

    def __init__(self, with_token=True, notify="1"):
        self.root = tempfile.mkdtemp(prefix="persona-guard-test-")
        hooks = os.path.join(self.root, "scripts", "hooks")
        os.makedirs(hooks)
        shutil.copy(SRC, os.path.join(hooks, "persona-change-notify.py"))
        os.makedirs(os.path.join(self.root, "store"))
        self.state = os.path.join(self.root, "tg")
        os.makedirs(self.state)
        if with_token:
            with open(os.path.join(self.state, ".env"), "w") as f:
                f.write("TELEGRAM_BOT_TOKEN=TESTTOKEN\n")
            with open(os.path.join(self.state, "access.json"), "w") as f:
                json.dump({"allowFrom": ["4242"]}, f)
        os.environ["TELEGRAM_STATE_DIR"] = self.state
        # The send is opt-in (default off); every case below that expects a message
        # turns it on explicitly, and the opt-in cases at the end set it per case.
        if notify is None:
            os.environ.pop("PERSONA_GUARD_NOTIFY", None)
        else:
            os.environ["PERSONA_GUARD_NOTIFY"] = notify
        spec = importlib.util.spec_from_file_location("pcn_" + str(id(self)), os.path.join(hooks, "persona-change-notify.py"))
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.sent = []
        self.mod.urllib.request.urlopen = lambda req, timeout=None: self.sent.append(json.loads(req.data.decode()))

    def write(self, rel, text):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(text)

    def remove(self, rel):
        os.remove(os.path.join(self.root, rel))

    def run(self, tool="Bash"):
        sys.stdin = io.StringIO(json.dumps({"tool_name": tool}))
        return self.mod.main()

    def age(self, ahead_s=10):
        """From now on the hook believes it is `ahead_s` later when it records a stat key."""
        self.mod.time = Clock(ahead_s)

    def count_hashing(self):
        """Wrap digest() so a case can tell whether a run read the files. Returns the call list."""
        calls = []
        real = self.mod.digest
        self.mod.digest = lambda path: (calls.append(path), real(path))[1]
        return calls

    def log(self):
        p = os.path.join(self.root, "store", "persona-changes.log")
        return open(p).read() if os.path.exists(p) else ""

    def done(self):
        shutil.rmtree(self.root, ignore_errors=True)


def main():
    t = Tree()
    t.write("CLAUDE.md", "a\n")
    t.write("SOUL.md", "s\n")
    t.write("agents/igor/SOUL.md", "i\n")

    print("first run records, never alerts")
    check("exit code", t.run(), 0)
    check("nothing sent", t.sent, [])

    print("no change: silent")
    t.run()
    check("nothing sent", t.sent, [])

    print("a MODIFIED file alerts, even when written through Bash")
    t.write("CLAUDE.md", "a\nb\n")
    t.run("Bash")
    check("one message", len(t.sent), 1)
    check("names the file and the kind", "CLAUDE.md (modositva, 2 sor)" in t.sent[0]["text"], True)
    check("goes to the owner chat", t.sent[0]["chat_id"], "4242")
    check("logged with the kind", "\tCLAUDE.md\tmodositva\tBash\t2 sor" in t.log(), True)

    print("a NEW persona file alerts (gap 1 of the review)")
    t.sent.clear()
    t.write("agents/zola/SOUL.md", "z\nz\nz\n")
    t.run("Write")
    check("one message", len(t.sent), 1)
    check("says created", "agents/zola/SOUL.md (letrehozva, 3 sor)" in t.sent[0]["text"], True)
    t.sent.clear()
    t.run()
    check("and only once", t.sent, [])

    print("a DELETED persona file alerts (gap 2 of the review)")
    t.remove("agents/igor/SOUL.md")
    t.run("Bash")
    check("one message", len(t.sent), 1)
    check("says deleted", "agents/igor/SOUL.md (torolve)" in t.sent[0]["text"], True)
    check("logged as deleted", "\tagents/igor/SOUL.md\ttorolve\t" in t.log(), True)
    t.sent.clear()
    t.run()
    check("a deletion is reported once, not every call", t.sent, [])

    print("a file that is re-created after its deletion alerts again as created")
    t.write("agents/igor/SOUL.md", "back\n")
    t.run()
    check("created again", len(t.sent) == 1 and "agents/igor/SOUL.md (letrehozva" in t.sent[0]["text"], True)
    t.done()

    print("no token: nothing is sent, but the log line is still written")
    n = Tree(with_token=False)
    os.environ["TELEGRAM_STATE_DIR"] = n.state
    n.write("CLAUDE.md", "a\n")
    n.run()
    n.write("CLAUDE.md", "changed\n")
    check("exit code stays 0", n.run(), 0)
    check("nothing sent", n.sent, [])
    check("log written", "\tCLAUDE.md\tmodositva\t" in n.log(), True)
    n.done()


    print("opt-in: DEFAULT (no env, no .env line) detects and logs, sends nothing")
    d = Tree(notify=None)
    d.write("CLAUDE.md", "a\n")
    d.run()
    d.write("CLAUDE.md", "a\nb\n")
    check("exit code", d.run(), 0)
    check("nothing sent", d.sent, [])
    check("still logged", "\tCLAUDE.md\tmodositva\t" in d.log(), True)
    print("opt-in: turning it on later does not replay the edit made while off")
    os.environ["PERSONA_GUARD_NOTIFY"] = "1"
    d.run()
    check("no replay", d.sent, [])
    d.write("CLAUDE.md", "a\nb\nc\n")
    d.run()
    check("a NEW edit after switching on is sent", len(d.sent), 1)
    d.done()

    print("opt-in: an install .env line turns it on (env unset)")
    e = Tree(notify=None)
    e.write(".env", "WEB_PORT=3420\nPERSONA_GUARD_NOTIFY=1\n")
    e.write("CLAUDE.md", "a\n")
    e.run()
    e.write("CLAUDE.md", "changed\n")
    e.run()
    check("sent via .env", len(e.sent), 1)
    e.done()

    print("opt-in: an explicit env value wins over the .env line")
    f = Tree(notify="0")
    f.write(".env", "PERSONA_GUARD_NOTIFY=1\n")
    f.write("CLAUDE.md", "a\n")
    f.run()
    f.write("CLAUDE.md", "changed\n")
    f.run()
    check("env 0 beats .env 1", f.sent, [])
    check("logged", "\tCLAUDE.md\tmodositva\t" in f.log(), True)
    f.done()

    print("opt-in: a typo fails toward quiet")
    g = Tree(notify="ture")
    g.write("CLAUDE.md", "a\n")
    g.run()
    g.write("CLAUDE.md", "changed\n")
    g.run()
    check("typo sends nothing", g.sent, [])
    g.done()
    os.environ.pop("PERSONA_GUARD_NOTIFY", None)

    print("opt-in: the .env reader follows src/env-parse.ts, one grammar for both")
    for label, body, want_on in (
        ('quoted "1"', 'PERSONA_GUARD_NOTIFY="1"\n', True),
        ("single-quoted '1'", "PERSONA_GUARD_NOTIFY='1'\n", True),
        ("indented line", "   PERSONA_GUARD_NOTIFY=1\n", True),
        ("spaces around =", "PERSONA_GUARD_NOTIFY = 1\n", True),
        ("CRLF line ends", "PERSONA_GUARD_NOTIFY=1\r\nWEB_PORT=1\r\n", True),
        ("last line wins (on)", "PERSONA_GUARD_NOTIFY=0\nPERSONA_GUARD_NOTIFY=1\n", True),
        ("last line wins (off)", "PERSONA_GUARD_NOTIFY=1\nPERSONA_GUARD_NOTIFY=0\n", False),
        ("commented out", "# PERSONA_GUARD_NOTIFY=1\n", False),
        ("inline comment is part of the value", "PERSONA_GUARD_NOTIFY=1 # on\n", False),
        ("export prefix is a different key", "export PERSONA_GUARD_NOTIFY=1\n", False),
        ("mismatched quotes", "PERSONA_GUARD_NOTIFY=\"1'\n", False),
    ):
        h = Tree(notify=None)
        h.write(".env", body)
        check(".env " + label, h.mod.notify_enabled(), want_on)
        h.done()

    print("notify OFF is log-only: every event kind leaves exactly one row, nothing is sent")
    o = Tree(notify=None)  # token and chat are present, so a send would be recorded
    o.write("CLAUDE.md", "a\n")
    o.write("agents/x/SOUL.md", "x\n")
    o.run()
    o.write("CLAUDE.md", "a\nb\n")
    o.run("Bash")
    o.write("agents/new/SOUL.md", "n\n")
    o.run("Write")
    o.remove("agents/x/SOUL.md")
    o.run("Bash")
    o.run()
    rows = [r.split("\t")[1:] for r in o.log().splitlines()]
    check("nothing sent", o.sent, [])
    check("one row per event, none repeated", len(rows), 3)
    check("modified row", rows[0:1], [["CLAUDE.md", "modositva", "Bash", "2 sor"]])
    check("created row", rows[1:2], [["agents/new/SOUL.md", "letrehozva", "Write", "1 sor"]])
    check("deleted row", rows[2:3], [["agents/x/SOUL.md", "torolve", "Bash", "-1 sor"]])
    o.done()

    print("stat fast path: an unchanged, aged file is not read again")
    a = Tree()
    a.write("CLAUDE.md", "a\n")
    a.write("SOUL.md", "s\n")  # a watched name that does not exist is looked up on every run, so keep both
    a.write("agents/x/SOUL.md", "x\n")
    a.age()
    a.run()  # records hashes and stat keys, dated 10 s after the writes
    calls = a.count_hashing()
    a.run()
    check("second run reads no file", calls, [])
    check("and sends nothing", a.sent, [])

    print("stat fast path: a change is still caught when the stat key moved")
    time.sleep(0.05)  # a different timestamp tick than the first write
    a.write("CLAUDE.md", "b\n")  # same size, different bytes
    a.run("Bash")
    check("same-size rewrite alerts", len(a.sent), 1)
    check("the changed file was read", any(c.endswith("CLAUDE.md") for c in calls), True)
    check("the untouched file was not", any(c.endswith("SOUL.md") for c in calls), False)

    print("stat fast path: restoring the mtime does not hide a rewrite (ctime moves)")
    a.sent.clear()
    a.age()
    a.run()
    path = os.path.join(a.root, "CLAUDE.md")
    old_ns = os.stat(path).st_mtime_ns
    time.sleep(0.05)
    a.write("CLAUDE.md", "c\n")
    os.utime(path, ns=(old_ns, old_ns))
    check("mtime and size are back to the recorded values", (os.stat(path).st_mtime_ns, os.stat(path).st_size), (old_ns, 2))
    a.run("Bash")
    check("still alerts", len(a.sent), 1)

    print("stat fast path: a deleted file is still reported as deleted")
    a.sent.clear()
    a.age()
    a.run()
    a.remove("agents/x/SOUL.md")
    a.run("Bash")
    check("deletion alerts", len(a.sent) == 1 and "agents/x/SOUL.md (torolve)" in a.sent[0]["text"], True)
    a.done()

    print("stat fast path: a file written moments ago (racy) is always read")
    r = Tree()
    r.write("CLAUDE.md", "a\n")
    r.write("SOUL.md", "s\n")
    r.run()
    calls = r.count_hashing()
    r.run()
    check("no aging: both files read again", len(calls), 2)
    path = os.path.join(r.root, "CLAUDE.md")
    st = os.stat(path)
    r.write("CLAUDE.md", "z\n")
    os.utime(path, ns=(st.st_mtime_ns, st.st_mtime_ns))
    r.run("Bash")
    check("a rewrite inside the racy window alerts", len(r.sent), 1)
    r.done()

    print("stat fast path: the racy rule reads the NEWER of mtime and ctime, not mtime alone")
    m = Tree()
    for rel in ("CLAUDE.md", "SOUL.md"):
        m.write(rel, "a\n")
        old_s = time.time() - 100
        os.utime(os.path.join(m.root, rel), (old_s, old_s))  # mtime far in the past, ctime is now
    m.age(1)  # 1 s after the write: past an old mtime, inside the 2 s window of the fresh ctime
    m.run()
    calls = m.count_hashing()
    m.run()
    check("a back-dated mtime does not make a fresh file trusted", len(calls), 2)
    m.done()

    print("stat fast path: a missing or corrupt cache falls back to hashing, quietly")
    c = Tree()
    c.write("CLAUDE.md", "a\n")
    c.write("SOUL.md", "s\n")
    c.age()
    c.run()
    stat_file = os.path.join(c.root, "store", ".persona-stat.json")
    os.remove(stat_file)
    calls = c.count_hashing()
    check("exit code", c.run(), 0)
    check("missing cache: both files read", len(calls), 2)
    check("missing cache: no false alert", c.sent, [])
    with open(stat_file, "w") as f:
        f.write("{not json")
    calls.clear()
    check("exit code", c.run(), 0)
    check("corrupt cache: both files read", len(calls), 2)
    check("corrupt cache: no false alert", c.sent, [])
    c.done()
    os.environ.pop("PERSONA_GUARD_NOTIFY", None)

    print()
    if FAILED:
        print("FAILED:", ", ".join(FAILED))
        return 1
    print("All persona-change-notify tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
