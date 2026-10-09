#!/usr/bin/env python3
"""scripts/egyszeri.py: the one-shot writer, against a stub dashboard (hermetic: a throwaway install dir and HOME).

What is measured: every refusal writes nothing (no POST reaches the dashboard); a main-agent one-shot is created with
forceSend on by default, its telegramChatId set by a PUT, and read back from the task-config.json on disk; the optional
registry is merged only where the install keeps one (with a backup, old entries kept); a sub-agent one-shot appends the
cleanup line to the main agent's later one-shot; --no-force-send and --dry-run; a failed later step exits 2
(half-written). The settings come from the install .env (WEB_PORT, MAIN_AGENT_ID), as on a real install.
Run: python3 scripts/__tests__/egyszeri.test.py
"""
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "egyszeri.py")
TOKEN = "test-dashboard-token"
MAIN = "mainagent"

failed = []
ROOTS = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


class Dashboard:
    """The few /api/schedules calls egyszeri.py makes; the task-config.json is written like the real one is."""

    def __init__(self, home):
        self.home = home
        self.tasks = {}
        self.calls = []
        self.fail_chat_put = False

    def cfg_path(self, name):
        return os.path.join(self.home, ".claude", "scheduled-tasks", name, "task-config.json")

    def write_cfg(self, name):
        t = self.tasks[name]
        os.makedirs(os.path.dirname(self.cfg_path(name)), exist_ok=True)
        cfg = {k: v for k, v in t.items() if k not in ("name", "prompt", "description")}
        with open(self.cfg_path(name), "w", encoding="utf-8") as f:
            json.dump(cfg, f)

    def add(self, name, schedule, agent, prompt="p", enabled=True):
        self.tasks[name] = {"name": name, "schedule": schedule, "agent": agent, "prompt": prompt, "enabled": enabled,
                            "type": "heartbeat", "skipIfBusy": False, "forceSend": True}
        self.write_cfg(name)


def handler_for(current):
    """current() returns the Dashboard of the case being run."""

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n).decode() or "null") if n else None

        def handle_any(self, method):
            dash = current()
            data = self.body() if method in ("POST", "PUT") else None
            dash.calls.append((method, self.path, data))
            if self.headers.get("Authorization") != "Bearer " + TOKEN:
                return self.reply(401, {"error": "unauthorized"})
            path = self.path.split("?", 1)[0]
            if method == "GET" and path == "/api/schedules":
                return self.reply(200, list(dash.tasks.values()))
            if method == "POST" and path == "/api/schedules":
                name = data["name"]
                if name in dash.tasks:
                    return self.reply(409, {"error": "Schedule already exists"})
                dash.tasks[name] = {"name": name, "description": data.get("description", ""), "prompt": data["prompt"],
                                    "schedule": data["schedule"], "agent": data["agent"], "enabled": True,
                                    "type": data.get("type", "task"), "skipIfBusy": data.get("skipIfBusy") is True,
                                    "forceSend": data.get("forceSend") is True}
                dash.write_cfg(name)
                return self.reply(200, {"ok": True, "name": name})
            if method == "PUT" and path.startswith("/api/schedules/"):
                name = path[len("/api/schedules/"):]
                if name not in dash.tasks:
                    return self.reply(404, {"error": "Schedule not found"})
                if "telegramChatId" in data and dash.fail_chat_put:
                    return self.reply(500, {"error": "synthetic failure"})
                dash.tasks[name].update(data)
                dash.write_cfg(name)
                return self.reply(200, {"ok": True})
            return self.reply(404, {"error": "not found"})

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

        def do_PUT(self):
            self.handle_any("PUT")

    return H


def install(port, registry=None):
    root = tempfile.mkdtemp(prefix="egyszeri-test-")
    os.makedirs(os.path.join(root, "scripts"))
    shutil.copy2(SCRIPT, os.path.join(root, "scripts", "egyszeri.py"))
    os.makedirs(os.path.join(root, "store"))
    with open(os.path.join(root, "store", ".dashboard-token"), "w", encoding="utf-8") as f:
        f.write(TOKEN + "\n")
    with open(os.path.join(root, ".env"), "w", encoding="utf-8") as f:
        f.write(f"WEB_PORT={port}\nMAIN_AGENT_ID={MAIN}\n")
    if registry is not None:
        with open(os.path.join(root, "store", "schedule-registry.json"), "w", encoding="utf-8") as f:
            json.dump(registry, f)
    home = os.path.join(root, "home")
    os.makedirs(home)
    ROOTS.append(root)
    return root, home


def run(root, home, args, prompt):
    pf = os.path.join(root, "prompt.txt")
    with open(pf, "w", encoding="utf-8") as f:
        f.write(prompt)
    env = {k: v for k, v in os.environ.items()
           if k not in ("WEB_PORT", "MAIN_AGENT_ID", "MARVEEN_API_BASE", "MARVEEN_WEB_PORT", "MARVEEN_TOKEN_FILE")}
    env.update(HOME=home, PYTHONDONTWRITEBYTECODE="1")
    return subprocess.run([sys.executable, os.path.join(root, "scripts", "egyszeri.py"), *args, "--prompt-file", pf],
                          capture_output=True, text=True, env=env, timeout=60)


def cron_of(t):
    return f"{t.minute} {t.hour} {t.day} {t.month} *"


now = datetime.datetime.now(datetime.timezone.utc)
SOON = now + datetime.timedelta(days=3)
LATER = now + datetime.timedelta(days=4)
PAST = now - datetime.timedelta(days=3) if (now - datetime.timedelta(days=3)).year == now.year else now.replace(
    month=1, day=1, hour=0, minute=0)
if LATER.year != now.year:
    # the script reads a dated cron in the current year, so a date across the new year is refused by design
    print("SKIP: today is too close to the end of the year for a future dated cron in the same year")
    sys.exit(0)

dash_holder = {}
srv = HTTPServer(("127.0.0.1", 0), handler_for(lambda: dash_holder["d"]))
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()


def fresh(registry=None):
    root, home = install(port, registry)
    dash_holder["d"] = Dashboard(home)
    return root, home, dash_holder["d"]


def posts(d):
    return [c for c in d.calls if c[0] == "POST"]


def base_args(name, cron, agent, desc="ONE-SHOT test"):
    return ["--name", name, "--cron", cron, "--agent", agent, "--desc", desc]


print("refusals write nothing")
CYR = chr(0x0430)
EMDASH = chr(0x2014)
cases = [
    ("a cron that is not dated", base_args("a", "*/5 * * * *", MAIN), "x /toggle", "not dated"),
    ("a daily cron (fixed minute and hour, any day)", base_args("a2", "0 7 * * *", MAIN), "x /toggle", "not dated"),
    ("a cron time that has passed", base_args("b", cron_of(PAST), MAIN), "x /toggle", "already passed"),
    ("a Cyrillic homoglyph in the prompt", base_args("c", cron_of(SOON), MAIN), f"x {CYR} /toggle", "homoglyph"),
    ("an em dash in the description", base_args("d", cron_of(SOON), MAIN, f"ONE-SHOT {EMDASH} test"), "x /toggle",
     "homoglyph"),
    ("the main agent's prompt without /toggle (MAIN_AGENT_ID from the install .env)",
     base_args("e", cron_of(SOON), MAIN), "wake up", "no /toggle step"),
    ("a sub-agent prompt that calls /api/schedules", base_args("f", cron_of(SOON), "worker") + ["--cleanup-by", "own"],
     "curl /api/schedules", "self-pace gate"),
    ("a sub-agent one-shot without --cleanup-by", base_args("g", cron_of(SOON), "worker"), "wake up", "--cleanup-by"),
]
for label, args, prompt, needle in cases:
    root, home, d = fresh()
    r = run(root, home, args, prompt)
    check(f"REFUSE {label}", r.returncode == 1 and "REFUSED" in r.stdout and needle in r.stdout and not posts(d),
          f"rc={r.returncode} out={r.stdout.strip()[:160]!r} posts={len(posts(d))}")

root, home, d = fresh()
d.add("own", cron_of(SOON), "worker")
r = run(root, home, base_args("h", cron_of(SOON), "worker") + ["--cleanup-by", "own"], "wake up")
check("REFUSE a --cleanup-by task that is not the main agent's", r.returncode == 1 and "--cleanup-by own" in r.stdout
      and not posts(d), r.stdout.strip()[:160])
root, home, d = fresh()
d.add("early", cron_of(now + datetime.timedelta(days=1)), MAIN)
r = run(root, home, base_args("i", cron_of(SOON), "worker") + ["--cleanup-by", "early"], "wake up")
check("REFUSE a --cleanup-by task that runs before the new one", r.returncode == 1 and not posts(d), r.stdout.strip()[:160])
root, home, d = fresh()
d.add("dup", cron_of(SOON), MAIN)
r = run(root, home, base_args("dup", cron_of(SOON), MAIN), "x /toggle")
check("REFUSE an existing name", r.returncode == 1 and "already exists" in r.stdout and not posts(d), r.stdout.strip()[:160])

print("the main agent's one-shot, no registry kept")
root, home, d = fresh()
r = run(root, home, base_args("own-wake", cron_of(SOON), MAIN), "do it, then POST /api/schedules/own-wake/toggle")
p = posts(d)
check("created (exit 0)", r.returncode == 0, f"rc={r.returncode} out={r.stdout[-300:]!r} err={r.stderr[-300:]!r}")
check("one POST with forceSend on by default, skipIfBusy off, type heartbeat", len(p) == 1
      and p[0][2]["forceSend"] is True and p[0][2]["skipIfBusy"] is False and p[0][2]["type"] == "heartbeat", repr(p))
puts = [c for c in d.calls if c[0] == "PUT" and c[1] == "/api/schedules/own-wake"]
check("telegramChatId set by a PUT ('none' by default)", len(puts) == 1 and puts[0][2] == {"telegramChatId": "none"},
      repr(puts))
cfg = json.load(open(d.cfg_path("own-wake"), encoding="utf-8"))
check("read back from disk: enabled, forceSend, telegramChatId", cfg.get("enabled") is True and cfg.get("forceSend") is True
      and cfg.get("telegramChatId") == "none" and "READBACK" in r.stdout, repr(cfg))
check("no registry file is created where none is kept", "registry=none kept" in r.stdout
      and not os.path.exists(os.path.join(root, "store", "schedule-registry.json")), r.stdout[-200:])

print("the registry, where the install keeps one")
root, home, d = fresh({"known": {"old-task": {"agent": MAIN, "note": "kept"}}})
r = run(root, home, base_args("reg-wake", cron_of(SOON), MAIN), "x /toggle")
reg = json.load(open(os.path.join(root, "store", "schedule-registry.json"), encoding="utf-8"))
e = reg["known"].get("reg-wake", {})
check("created (exit 0)", r.returncode == 0, r.stdout[-300:])
check("the entry is merged: creator, one_shot, cron", e.get("creator") == MAIN and e.get("one_shot") is True
      and e.get("cron") == cron_of(SOON) and e.get("agent") == MAIN, repr(e))
check("the old entry stays", reg["known"].get("old-task") == {"agent": MAIN, "note": "kept"}, repr(reg["known"]))
check("a backup is left next to it", any(f.startswith("schedule-registry.json.bak.")
                                         for f in os.listdir(os.path.join(root, "store"))), os.listdir(os.path.join(root, "store")))

print("a sub-agent's one-shot and the main agent's cleanup line")
root, home, d = fresh()
d.add("main-later", cron_of(LATER), MAIN, prompt="main round\nPOST /api/schedules/main-later/toggle")
r = run(root, home, base_args("worker-wake", cron_of(SOON), "worker") + ["--cleanup-by", "main-later"],
        "worker: do the step; the main agent disables this one")
cp = d.tasks["main-later"]["prompt"]
check("created (exit 0)", r.returncode == 0, f"{r.stdout[-300:]!r} {r.stderr[-300:]!r}")
check("the cleanup line is appended to the main agent's later one-shot", cp.startswith("main round")
      and "CLEANUP: if worker-wake fired" in cp and cp.count("CLEANUP:") == 1, cp[-300:])
check("READBACK says cleanup=True", "cleanup=True" in r.stdout, r.stdout[-200:])

print("--no-force-send and --dry-run")
root, home, d = fresh()
r = run(root, home, base_args("nofs", cron_of(SOON), MAIN) + ["--no-force-send"], "x /toggle")
p = posts(d)
check("--no-force-send sends forceSend false", r.returncode == 0 and len(p) == 1 and p[0][2]["forceSend"] is False, repr(p))
root, home, d = fresh()
r = run(root, home, base_args("dry", cron_of(SOON), MAIN) + ["--dry-run"], "x /toggle")
check("--dry-run reads, checks, and writes nothing", r.returncode == 0 and "OK to create" in r.stdout and not posts(d)
      and not any(c[0] == "PUT" for c in d.calls), repr(d.calls))

print("a later step fails: half-written, exit 2")
root, home, d = fresh()
d.fail_chat_put = True
r = run(root, home, base_args("half", cron_of(SOON), MAIN), "x /toggle")
check("exit 2 and the message says the schedule exists", r.returncode == 2 and "HALF-WRITTEN" in r.stdout
      and "half" in d.tasks, f"rc={r.returncode} {r.stdout[-200:]!r}")
check("it stops there: no read-back after a half-written step", "READBACK" not in r.stdout, r.stdout[-200:])

srv.shutdown()
for r in ROOTS:
    shutil.rmtree(r, ignore_errors=True)
print()
if failed:
    print(f"FAILED {len(failed)}: {failed}")
    sys.exit(1)
print("all passed")
