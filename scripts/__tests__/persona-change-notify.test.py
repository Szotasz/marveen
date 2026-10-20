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

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "hooks", "persona-change-notify.py")
FAILED = []


def check(name, got, want):
    ok = got == want
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got={got!r} want={want!r}")
    if not ok:
        FAILED.append(name)


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
        # The hook imports urllib.request only when it is about to send, so the module has no
        # `urllib` attribute to stub; the recorder goes on the real module (the same object).
        import urllib.request
        urllib.request.urlopen = lambda req, timeout=None: self.sent.append(json.loads(req.data.decode()))

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

    print("urllib.request is imported only when a message is about to be sent")
    import subprocess
    z = Tree(notify=None)
    z.write("CLAUDE.md", "a\n")
    z.write("SOUL.md", "s\n")
    hook = os.path.join(z.root, "scripts", "hooks", "persona-change-notify.py")
    probe = (
        "import io, runpy, sys\n"
        "sys.stdin = io.StringIO('{\"tool_name\": \"Bash\"}')\n"
        "try:\n"
        "    runpy.run_path(sys.argv[1], run_name='__main__')\n"
        "except SystemExit:\n"
        "    pass\n"
        "print('urllib.request' in sys.modules)\n"
    )

    def imported(notify):
        env = dict(os.environ, PERSONA_GUARD_NOTIFY=notify)
        out = subprocess.run([sys.executable, "-c", probe, hook], env=env, capture_output=True, text=True)
        return out.stdout.strip() or out.stderr.strip()

    check("first run, notify off: not imported", imported("0"), "False")
    z.write("CLAUDE.md", "a\nb\n")
    check("change detected, notify off: not imported", imported("0"), "False")
    check("no change, notify on: not imported", imported("1"), "False")

    # The send itself, in a fresh interpreter where nothing has imported urllib.request yet (the
    # in-process cases above run in a process that already has it, which would hide a wrong import).
    # socket.getaddrinfo is replaced through sitecustomize: it records the host the request is going
    # to and fails the lookup, which the hook swallows. The message content is pinned in-process above.
    stub_dir = tempfile.mkdtemp(prefix="persona-guard-stub-")
    rec = os.path.join(stub_dir, "host.txt")
    with open(os.path.join(stub_dir, "sitecustomize.py"), "w") as f:
        f.write(
            "import os, socket\n"
            "def lookup(host, *a, **k):\n"
            "    open(os.environ['PCN_REC'], 'w').write(str(host))\n"
            "    raise OSError('stubbed')\n"
            "socket.getaddrinfo = lookup\n"
        )
    z.write("CLAUDE.md", "a\nb\nc\n")
    env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}  # a proxy would be the host recorded
    env.update(PERSONA_GUARD_NOTIFY="1", PCN_REC=rec, PYTHONPATH=stub_dir)
    out = subprocess.run([sys.executable, "-c", probe, hook], env=env, capture_output=True, text=True)
    check("notify on + change, fresh interpreter: urllib.request is imported", out.stdout.strip(), "True")
    check("and the request reaches the network layer for the Telegram API", open(rec).read() if os.path.exists(rec) else None, "api.telegram.org")
    shutil.rmtree(stub_dir, ignore_errors=True)
    z.done()

    print("a failing import in the send path stays fail-open: exit 0, log still written, nothing sent")
    q = Tree()
    q.write("CLAUDE.md", "a\n")
    q.run()
    q.write("CLAUDE.md", "a\nb\n")
    saved = sys.modules.get("urllib.request")
    sys.modules["urllib.request"] = None  # makes `import urllib.request` raise ImportError
    try:
        check("exit code", q.run(), 0)
    finally:
        sys.modules["urllib.request"] = saved
    check("nothing sent", q.sent, [])
    check("still logged", "\tCLAUDE.md\tmodositva\t" in q.log(), True)
    q.done()
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
    print()
    if FAILED:
        print("FAILED:", ", ".join(FAILED))
        return 1
    print("All persona-change-notify tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
