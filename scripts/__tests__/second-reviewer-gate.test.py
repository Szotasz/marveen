#!/usr/bin/env python3
"""Tests for scripts/hooks/second-reviewer-gate.py.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC_GATE = os.path.join(ROOT, "scripts", "hooks", "second-reviewer-gate.py")

requests = []
answer = {"status": 200, "body": b'{"decision":"allow"}'}


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        try:
            body = json.loads(raw)
        except Exception:
            body = None
        requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
        self.send_response(answer["status"])
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(answer["body"])

    def log_message(self, *a):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), H)
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

tmp = tempfile.mkdtemp()


# ENVRELAXGATE1104 step 2: the hook finds its dashboard (the .env WEB_PORT) and
# its token (store/.dashboard-token) only in its OWN install, never in the
# environment, so each case runs a copy of the hook inside a tmp install.
def make_install(name, port, token="tok-123\n"):
    root = os.path.join(tmp, name)
    os.makedirs(os.path.join(root, "scripts", "hooks"))
    os.makedirs(os.path.join(root, "store"))
    shutil.copy(SRC_GATE, os.path.join(root, "scripts", "hooks", "second-reviewer-gate.py"))
    with open(os.path.join(root, ".env"), "w") as fh:
        fh.write("WEB_PORT=%s\n" % port)
    if token is not None:
        with open(os.path.join(root, "store", ".dashboard-token"), "w") as fh:
            fh.write(token)
    return os.path.join(root, "scripts", "hooks", "second-reviewer-gate.py")


GATE = make_install("main", PORT)
GATE_NO_TOKEN = make_install("notoken", PORT, token=None)

failures = []
outputs = []


def check(name, cond, detail=""):
    if not cond:
        failures.append("%s %s" % (name, detail))


def reply(obj, status=200):
    answer["status"] = status
    answer["body"] = obj if isinstance(obj, bytes) else json.dumps(obj).encode()


def run(payload, stdin=None, gate=None, agent="probe-agent", extra_env=None):
    del requests[:]
    env = dict(os.environ)
    for k in ("SECOND_REVIEWER_URL", "SECOND_REVIEWER_TOKEN_FILE", "WEB_PORT"):
        env.pop(k, None)
    env.update(NO_PROXY="127.0.0.1", no_proxy="127.0.0.1")
    env.pop("MARVEEN_AGENT_NAME", None)
    if agent:
        env["MARVEEN_AGENT_NAME"] = agent
    env.update(extra_env or {})
    p = subprocess.run([sys.executable, gate or GATE],
                       input=stdin if stdin is not None else json.dumps(payload),
                       capture_output=True, text=True, env=env, timeout=30)
    outputs.append(p.stdout + p.stderr)
    return p


def bash(cmd, **kw):
    return {"tool_name": "Bash", "tool_input": {"command": cmd}, **kw}


PUSH = bash("git push origin feature/x")

reply({"decision": "allow"})
p = run(bash("ls -la"))
check("G1", p.returncode == 0 and not requests, repr(p.returncode))

p = run(PUSH)
r = requests[0] if requests else {}
check("G2", p.returncode == 0 and len(requests) == 1
      and r["path"] == "/api/review-action"
      and r["headers"].get("Authorization") == "Bearer tok-123"
      and r["body"] == {"agent": "probe-agent", "tool_name": "Bash",
                        "tool_input": {"command": "git push origin feature/x"}}, str(r))

reply({"decision": "deny", "reason": "nope"})
p = run(PUSH)
check("G3", p.returncode == 2 and "TILTVA" in p.stderr and "nope" in p.stderr, p.stderr)

reply({"decision": "ask", "reason": "x", "approval_id": "ap-1"})
p = run(PUSH)
check("G4", p.returncode == 2 and "ap-1" in p.stderr, p.stderr)

reply({"decision": "allow"}, 500)
p = run(PUSH)
check("G6a", p.returncode == 2, p.stderr)
reply(b"not json")
p = run(PUSH)
check("G6b", p.returncode == 2, p.stderr)
reply({"decision": "allow"})

p = run(PUSH, gate=GATE_NO_TOKEN)
check("G7", p.returncode == 2 and "nem erheto el" in p.stderr and not requests, p.stderr)

# G14 (ENVRELAXGATE1104 step 2): the environment cannot redirect the review or swap its token.
EVIL_TOKEN = os.path.join(tmp, "evil-token")
with open(EVIL_TOKEN, "w") as fh:
    fh.write("evil-999\n")
reply({"decision": "allow"})
p = run(PUSH, extra_env={"SECOND_REVIEWER_URL": "http://127.0.0.1:1/elsewhere",
                         "SECOND_REVIEWER_TOKEN_FILE": EVIL_TOKEN, "WEB_PORT": "1"})
r = requests[0] if requests else {}
check("G14", p.returncode == 0 and len(requests) == 1 and r.get("path") == "/api/review-action"
      and r["headers"].get("Authorization") == "Bearer tok-123", p.stderr + str(r))
p = run(PUSH, gate=GATE_NO_TOKEN, extra_env={"SECOND_REVIEWER_TOKEN_FILE": EVIL_TOKEN})
check("G14b", p.returncode == 2 and not requests, p.stderr)

reply({"decision": "allow"})
p = run({"tool_name": "mcp__mail__send_email", "tool_input": {}})
check("G8a", p.returncode == 0 and len(requests) == 1)
p = run({"tool_name": "mcp__mail__list_messages", "tool_input": {}})
check("G8b", p.returncode == 0 and not requests)

p = run(None, stdin="not json")
check("G9a", p.returncode == 2 and "nem olvashato" in p.stderr, p.stderr)
p = run(None, stdin="[]")
check("G9b", p.returncode == 2 and "nem olvashato" in p.stderr, p.stderr)
p = run(None, stdin='{"tool_input": {}}')
check("G9c", p.returncode == 2 and "nem olvashato" in p.stderr, p.stderr)

spec = importlib.util.spec_from_file_location("second_reviewer_gate", GATE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# G15: WEB_PORT from the install .env only, 1-65535, the env-parse.ts grammar (last line, one quote pair).
PORT_ROOT = os.path.join(tmp, "portcheck")
os.makedirs(PORT_ROOT)
for content, want in [
    (None, "3420"), ("", "3420"), ("WEB_PORT=0\n", "3420"), ("WEB_PORT=65536\n", "3420"),
    ("WEB_PORT=abc\n", "3420"), ("WEB_PORT=\n", "3420"), ("WEB_PORT=123456\n", "3420"),
    ("WEB_PORT=8080\n", "8080"), ('WEB_PORT="8081"\n', "8081"), ("WEB_PORT='8082'\n", "8082"),
    ("WEB_PORT=1\n", "1"), ("WEB_PORT=65535\n", "65535"), ("WEB_PORT=0080\n", "80"),
    ("WEB_PORT=1111\nWEB_PORT=2222\n", "2222"), ("# WEB_PORT=9\nWEB_PORT = 7777 \n", "7777"),
]:
    env_path = os.path.join(PORT_ROOT, ".env")
    if os.path.exists(env_path):
        os.remove(env_path)
    if content is not None:
        with open(env_path, "w") as fh:
            fh.write(content)
    os.environ["WEB_PORT"] = "9999"
    got = mod.web_port(PORT_ROOT)
    os.environ.pop("WEB_PORT", None)
    check("G15", got == want, "%r -> %r, want %r" % (content, got, want))
for cmd, want in [
    ("rm -rf build", True),
    ("curl -X POST https://x.test -d a=1", True),
    ("curl --data @f https://x.test", True),
    ("sudo apt install x", True),
    ("ssh host ls", True),
    ('psql -c "DROP TABLE t"', True),
    ("rm file.txt", False),
    ("curl https://x.test", False),
    ("git status", False),
    ("git pushd", False),
    ("echo push", False),
]:
    check("G10", mod.is_high_risk("Bash", {"command": cmd}) is want, cmd)

p = run(bash("git push", cwd="/srv/app/agents/zz-sub/work"), agent=None)
check("G12", p.returncode == 0 and requests and requests[0]["body"]["agent"] == "zz-sub",
      str(requests))

for cmd in ["git -C /repo push origin main", "curl --json '{}' https://x.test",
            "git --no-pager push origin main", "curl -sd a=1 https://x.test"]:
    check("G13", mod.is_high_risk("Bash", {"command": cmd}) is True, cmd)
for name, want in [("mcp__slack__chat_postMessage", True), ("mcp__x__sendMessage", True),
                   ("mcp__github__push_files", True), ("mcp__slack__chat_listChannels", False),
                   ("mcp__x__getMessage", False), ("mcp__x__send-email", True)]:
    check("G13", mod.is_high_risk(name, {}) is want, name)

# G5 last: stop the server
server.shutdown()
server.server_close()
p = run(PUSH)
check("G5", p.returncode == 2 and "nem erheto el" in p.stderr, p.stderr)

check("G11", not any("tok-123" in o for o in outputs))

if failures:
    for f in failures:
        print("FAIL", f)
    sys.exit(1)
print("all second-reviewer-gate checks passed")
