#!/usr/bin/env python3
"""Contract tests for scripts/hook-load-watch.py (card 723bbb70, point (3)).

Run: python3 scripts/__tests__/hook-load-watch.test.py

Hermetic: every test builds a throwaway install root with its own settings and small stand-in gates (python and
node), and the alert POST goes to a local stub server (or the DRYRUN print). Nothing outside the temp dirs is read
or written. The cases that need node are skipped, loudly, when node is not on the PATH.

What the stand-ins model, from the live measurement (af12a1d3, on a throwaway copy):
  static-gate.mjs    a static import (bash-egress-parser -> self-pace-gate): a broken dependency -> exit 1, OPEN;
  dep-gate.py        a module-level import (email-approval-gate -> email_extract): the same, in python;
  lazy-bash-gate.mjs a dependency loaded only on the Bash branch, fail-closed: a broken one -> exit 2 on Bash only.
                     The probe MUST call Bash to see it -- the case a probe with a neutral tool name would miss;
  webfetch-gate.py   a gate that is not wired to Bash: probed with the neutral tool name, which it records;
  helper.py          called somewhere in the "...; exit 0" helper form: left out everywhere.
"""
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WATCH = os.path.join(os.path.dirname(HERE), "hook-load-watch.py")
NODE = shutil.which("node")

GOOD_PY = "import json, sys\njson.load(sys.stdin)\nsys.exit(0)\n"
DEP_GATE_PY = ("import json, os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n"
               "import dep_mod  # module level, like email_extract in email-approval-gate\n"
               "json.load(sys.stdin)\nsys.exit(0)\n")
WEBFETCH_PY = ("import json, os, sys\np = json.load(sys.stdin)\n"
               "open(os.path.join(os.environ['CLAUDE_PROJECT_DIR'], 'seen-tool.txt'), 'w').write(p['tool_name'])\n"
               "sys.exit(0)\n")
STATIC_GATE_MJS = ("import { readFileSync } from 'node:fs'\nimport { ok } from './static-dep.mjs'\n"
                   "JSON.parse(readFileSync(0, 'utf-8'))\nprocess.exit(ok ? 0 : 0)\n")
LAZY_GATE_MJS = ("import { readFileSync } from 'node:fs'\nconst p = JSON.parse(readFileSync(0, 'utf-8'))\n"
                 "if (p.tool_name !== 'Bash') process.exit(0)\n"
                 "try { await import('./lazy-dep.mjs') } catch (e) {\n"
                 "  process.stderr.write(`lazy-bash-gate: dependency failed to load (${e.message}), BLOCKING\\n`); process.exit(2)\n}\n"
                 "process.exit(0)\n")
BROKEN = "this is ( not code\n"


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def write(path, text, mode=0o755):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(path, mode)


def make_root(base, node=True):
    root = os.path.join(base, "install")
    hooks = os.path.join(root, "scripts", "hooks")
    write(os.path.join(hooks, "good-gate.py"), GOOD_PY)
    write(os.path.join(hooks, "dep_mod.py"), "VALUE = 1\n", 0o644)
    write(os.path.join(hooks, "dep-gate.py"), DEP_GATE_PY)
    write(os.path.join(hooks, "webfetch-gate.py"), WEBFETCH_PY)
    write(os.path.join(hooks, "helper.py"), GOOD_PY)
    main = [
        {"matcher": "Bash", "hooks": [{"type": "command", "command": 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/good-gate.py"', "timeout": 10}]},
        {"matcher": "Bash", "hooks": [{"type": "command", "command": 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/dep-gate.py"', "timeout": 10}]},
        {"matcher": "WebFetch", "hooks": [{"type": "command", "command": 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/webfetch-gate.py"', "timeout": 10}]},
        {"matcher": "Write|Edit", "hooks": [{"type": "command", "command": 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/helper.py"', "timeout": 10}]},
    ]
    agent = [
        {"matcher": "Write|Edit", "hooks": [{"type": "command", "command":
            "bash -c '[ -f %s/scripts/hooks/helper.py ] && exec python3 %s/scripts/hooks/helper.py; exit 0'" % (root, root)}]},
    ]
    if node:
        write(os.path.join(root, "scripts", "static-gate.mjs"), STATIC_GATE_MJS)
        write(os.path.join(root, "scripts", "static-dep.mjs"), "export const ok = true\n", 0o644)
        write(os.path.join(hooks, "lazy-bash-gate.mjs"), LAZY_GATE_MJS)
        write(os.path.join(hooks, "lazy-dep.mjs"), "export const loaded = true\n", 0o644)
        main.append({"matcher": "Bash", "hooks": [{"type": "command", "command": 'node "$CLAUDE_PROJECT_DIR/scripts/static-gate.mjs"', "timeout": 10}]})
        agent.append({"matcher": "Bash|.*send_email.*", "hooks": [{"type": "command", "command":
            'command -v node >/dev/null 2>&1 || { echo "node missing, BLOCKING" >&2; exit 2; }; node "%s/scripts/hooks/lazy-bash-gate.mjs"' % root, "timeout": 10}]})
    write(os.path.join(root, ".claude", "settings.json"), json.dumps({"hooks": {"PreToolUse": main}}), 0o644)
    for a in ("a1", "a2"):
        write(os.path.join(root, "agents", a, ".claude", "settings.json"), json.dumps({"hooks": {"PreToolUse": agent}}), 0o644)
    os.makedirs(os.path.join(root, "store"), exist_ok=True)
    return root


def run(root, *args, **env):
    # the caller's own PYTHONDONTWRITEBYTECODE would hide whether the watcher sets it for the probes
    full = {k: v for k, v in os.environ.items() if not k.startswith("HOOK_LOAD_WATCH_") and k != "PYTHONDONTWRITEBYTECODE"}
    full.update(HOOK_LOAD_WATCH_ROOT=root)
    full.update({k: str(v) for k, v in env.items()})
    r = subprocess.run([sys.executable, WATCH, *args], capture_output=True, text=True, env=full, timeout=120)
    return r.returncode, r.stdout + r.stderr


def lines_of(out, klass):
    return [l for l in out.splitlines() if "] %s " % klass in l or "] %-7s" % klass in l]


class Stub:
    """A local /api/messages stand-in: records every request and answers with the configured status and body."""

    def __init__(self, status=200, body=None):
        self.status, self.body, self.requests = status, body if body is not None else {"id": 7, "status": "pending"}, []
        stub = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                stub.requests.append({"path": self.path, "auth": self.headers.get("Authorization"),
                                      "body": json.loads(self.rfile.read(n) or b"{}")})
                data = json.dumps(stub.body).encode()
                self.send_response(stub.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Base(unittest.TestCase):
    node = True

    def setUp(self):
        if self.node and not NODE:
            self.skipTest("node is not on the PATH")
        self.tmp = tempfile.mkdtemp(prefix="hook-load-watch-test-")
        self.root = make_root(self.tmp, node=self.node)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def p(self, rel):
        return os.path.join(self.root, rel)

    def append(self, rel, text=BROKEN):
        with open(self.p(rel), "a", encoding="utf-8") as fh:
            fh.write(text)


class Derivation(Base):
    def test_union_helper_rule_and_probe_choice(self):
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 0, out)
        self.assertIn("derived 5 commands, 5 scripts", out)
        self.assertIn("helpers left out: scripts/hooks/helper.py", out)
        # the helper is left out EVERYWHERE, also where the main settings call it in the plain form
        self.assertNotIn("helper.py (a f", out)
        # one command line for the two agents that run the identical command
        self.assertRegex(out, r"OK +rc=0 +scripts/hooks/lazy-bash-gate\.mjs \(2 ügynök\) probe=Bash")
        self.assertRegex(out, r"OK +rc=0 +scripts/static-gate\.mjs \(a fő ügynök\) probe=Bash")
        self.assertRegex(out, r"OK +rc=0 +scripts/hooks/webfetch-gate\.py \(a fő ügynök\) probe=HookLoadProbe")
        self.assertEqual(read(self.p("seen-tool.txt")), "HookLoadProbe", "a gate not wired to Bash gets the neutral tool name")

    def test_check_writes_nothing_and_no_bytecode(self):
        # the state dir is taken BEFORE the first run: a --check that ticks writes its stamp on a healthy run too
        before = sorted(os.listdir(self.p("store")))
        # a healthy run first: dep-gate imports the VALID dep_mod, which python would cache as bytecode next to it
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 0, out)
        self.assertFalse(os.path.exists(self.p("scripts/hooks/__pycache__")), "the probe wrote python bytecode")
        self.assertEqual(sorted(os.listdir(self.p("store"))), before, "a healthy --check wrote into the state dir")
        self.append("scripts/hooks/dep_mod.py")
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 1, out)
        self.assertEqual(sorted(os.listdir(self.p("store"))), before, "a --check with a finding wrote into the state dir")


class Findings(Base):
    def test_static_import_broken_is_open(self):
        self.append("scripts/static-dep.mjs")
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"OPEN +rc=1 +scripts/static-gate\.mjs .*SyntaxError")

    def test_module_level_python_dependency_broken_is_open(self):
        self.append("scripts/hooks/dep_mod.py")
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"OPEN +rc=1 +scripts/hooks/dep-gate\.py .*SyntaxError")

    def test_lazy_bash_dependency_is_seen_because_the_probe_calls_bash(self):
        self.append("scripts/hooks/lazy-dep.mjs")
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"CLOSED +rc=2 +scripts/hooks/lazy-bash-gate\.mjs \(2 ügynök\) probe=Bash")
        # control: the same broken gate passes a call with the neutral tool name -- a neutral probe would be blind here
        r = subprocess.run([NODE, self.p("scripts/hooks/lazy-bash-gate.mjs")], input=json.dumps(
            {"tool_name": "HookLoadProbe", "tool_input": {}}), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0)

    def test_missing_python_file_is_closed(self):
        os.remove(self.p("scripts/hooks/good-gate.py"))
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"CLOSED +rc=2 +scripts/hooks/good-gate\.py .*can't open file")

    def test_deny_on_a_harmless_call_is_closed(self):
        write(self.p("scripts/hooks/good-gate.py"), "import json, sys\njson.load(sys.stdin)\nprint(json.dumps("
              "{'hookSpecificOutput': {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny'}}))\n")
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"CLOSED +rc=0 +scripts/hooks/good-gate\.py")

    def test_timeout_kills_the_hook_process_group(self):
        pidfile = self.p("slow.pid")
        write(self.p("scripts/hooks/good-gate.py"), "import os, subprocess, time\n"
              "c = subprocess.Popen(['sleep', '30'])\nopen(%r, 'w').write(str(c.pid))\ntime.sleep(30)\n" % pidfile)
        d = json.loads(read(self.p(".claude/settings.json")))
        d["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"] = 1
        write(self.p(".claude/settings.json"), json.dumps(d), 0o644)
        t0 = time.monotonic()
        rc, out = run(self.root, "--check")
        self.assertLess(time.monotonic() - t0, 20)
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"TIMEOUT rc=None +scripts/hooks/good-gate\.py")
        pid = int(read(pidfile))
        time.sleep(0.3)
        with self.assertRaises(ProcessLookupError, msg="the hook's child outlived the timeout"):
            os.kill(pid, 0)

    def test_unreadable_agent_settings_is_a_finding(self):
        write(self.p("agents/a2/.claude/settings.json"), "{ broken", 0o644)
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"SETTINGS rc=None agents/a2/\.claude/settings\.json \(1 ügynök\)")

    def test_settings_without_a_hook_is_nothing_to_measure(self):
        write(self.p(".claude/settings.json"), json.dumps({"hooks": {}}), 0o644)
        for a in ("a1", "a2"):
            write(self.p("agents/%s/.claude/settings.json" % a), json.dumps({}), 0o644)
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 3, out)
        self.assertIn("NOTHING TO MEASURE", out)


class Tick(Base):
    def tick(self, **env):
        env.setdefault("HOOK_LOAD_WATCH_ALERT_DRYRUN", 1)
        return run(self.root, **env)

    def state(self):
        try:
            return json.loads(read(self.p("store/.hook-load-watch.json")))
        except OSError:
            return None

    def test_alert_cycle(self):
        rc, out = self.tick()
        self.assertEqual((rc, out.count("ALERT_DRYRUN")), (0, 0), out)
        self.assertTrue(read(self.p("store/.hook-load-watch")).endswith(" 5/5 ok\n"))
        self.append("scripts/hooks/dep_mod.py")
        rc, out = self.tick()
        self.assertEqual(rc, 0, out)
        self.assertIn("ALERT_DRYRUN: [HOOK-FIGYELŐ] 1/5", out)
        self.assertIn("scripts/hooks/dep-gate.py (a fő ügynök): NYITVA", out)
        first = self.state()
        self.assertEqual(first["fingerprint"], ["scripts/hooks/dep-gate.py|OPEN|1"])
        rc, out = self.tick()
        self.assertEqual(out.count("ALERT_DRYRUN"), 0, "an unchanged finding inside the window was repeated")
        self.append("scripts/static-dep.mjs")
        rc, out = self.tick()
        self.assertIn("ALERT_DRYRUN: [HOOK-FIGYELŐ] 2/5", out)
        self.assertEqual(self.state()["first_seen"], first["first_seen"], "a changed set keeps the incident start")
        time.sleep(1.1)
        rc, out = self.tick(HOOK_LOAD_WATCH_COOLDOWN=1)
        self.assertIn("ALERT_DRYRUN: [HOOK-FIGYELŐ] 2/5", out, "no repeat after the cooldown")
        write(self.p("scripts/hooks/dep_mod.py"), "VALUE = 1\n", 0o644)
        write(self.p("scripts/static-dep.mjs"), "export const ok = true\n", 0o644)
        rc, out = self.tick()
        self.assertIn("ALERT_DRYRUN: [HOOK-FIGYELŐ] HELYREÁLLT: mind az 5 PreToolUse", out)
        self.assertEqual(self.state(), {})
        rc, out = self.tick()
        self.assertEqual(out.count("ALERT_DRYRUN"), 0, out)

    def test_garbage_cooldown_does_not_repeat_every_tick(self):
        self.append("scripts/hooks/dep_mod.py")
        self.tick(HOOK_LOAD_WATCH_COOLDOWN="abc")
        rc, out = self.tick(HOOK_LOAD_WATCH_COOLDOWN="0")
        self.assertEqual(out.count("ALERT_DRYRUN"), 0, out)

    def write_env(self, **kv):
        write(self.p(".env"), "".join("%s=%s\n" % kv_ for kv_ in kv.items()), 0o600)
        write(self.p("store/.dashboard-token"), "test-token-123\n", 0o600)

    def test_post_shape_sender_rule_and_honest_delivery(self):
        self.append("scripts/hooks/dep_mod.py")
        self.write_env(MAIN_AGENT_ID="boss", SYSTEM_SENDER_IDS="other,x", WEB_PORT="1")
        stub = Stub(status=403, body={"error": "unknown agent"})
        try:
            rc, out = run(self.root, HOOK_LOAD_WATCH_API=stub.url)
            self.assertEqual(rc, 1, out)
            self.assertIn("ALERT NOT SENT: HTTP 403 (from=boss to=boss)", out)
            self.assertIsNone(self.state(), "a refused alert advanced the state")
            stub.status, stub.body = 200, {"id": 41, "status": "pending"}
            rc, out = run(self.root, HOOK_LOAD_WATCH_API=stub.url)
            self.assertEqual(rc, 0, out)
            self.assertIn("alert sent: id=41 from=boss to=boss", out)
            req = stub.requests[-1]
            self.assertEqual((req["path"], req["auth"]), ("/api/messages", "Bearer test-token-123"))
            self.assertEqual((req["body"]["from"], req["body"]["to"]), ("boss", "boss"))
            self.assertTrue(req["body"]["content"].startswith("[HOOK-FIGYELŐ] 1/5"))
            # listed in SYSTEM_SENDER_IDS (with the server's normalisation): the watcher speaks under its own name
            self.write_env(MAIN_AGENT_ID="boss", SYSTEM_SENDER_IDS="other, hook-load-watch ")
            os.remove(self.p("store/.hook-load-watch.json"))
            rc, out = run(self.root, HOOK_LOAD_WATCH_API=stub.url)
            self.assertIn("alert sent: id=41 from=hook-load-watch to=boss", out)
            # a 2xx answer WITHOUT a message id is not a delivery
            stub.body = {"ok": True}
            os.remove(self.p("store/.hook-load-watch.json"))
            rc, out = run(self.root, HOOK_LOAD_WATCH_API=stub.url)
            self.assertEqual(rc, 1, out)
            self.assertIn("ALERT NOT SENT: HTTP 200 without a message id", out)
        finally:
            stub.close()

    def test_unreachable_api_is_not_a_delivery(self):
        self.append("scripts/hooks/dep_mod.py")
        self.write_env(MAIN_AGENT_ID="boss")
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        rc, out = run(self.root, HOOK_LOAD_WATCH_API="http://127.0.0.1:%d" % port)
        self.assertEqual(rc, 1, out)
        self.assertIn("ALERT NOT SENT: URLError", out)
        self.assertIsNone(self.state())
        self.assertTrue(os.path.exists(self.p("store/.hook-load-watch")), "the liveness stamp is written on every tick")


class PythonOnly(Base):
    """The python half runs without node too, so a CI image without node still measures most of the contract."""
    node = False

    def test_python_gates_without_node(self):
        rc, out = run(self.root, "--check")
        self.assertEqual(rc, 0, out)
        self.assertIn("derived 3 commands, 3 scripts", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
