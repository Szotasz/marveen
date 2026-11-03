#!/usr/bin/env python3
"""Tests for scripts/hooks/second-reviewer-gate.py.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
GATE = os.path.join(ROOT, "scripts", "hooks", "second-reviewer-gate.py")

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
TOKEN_FILE = os.path.join(tmp, "token")
with open(TOKEN_FILE, "w") as fh:
    fh.write("tok-123\n")

failures = []
outputs = []


def check(name, cond, detail=""):
    if not cond:
        failures.append("%s %s" % (name, detail))


def reply(obj, status=200):
    answer["status"] = status
    answer["body"] = obj if isinstance(obj, bytes) else json.dumps(obj).encode()


def run(payload, stdin=None, url=None, token_file=TOKEN_FILE, agent="probe-agent"):
    del requests[:]
    env = dict(os.environ,
               SECOND_REVIEWER_URL=url or "http://127.0.0.1:%d/api/review-action" % PORT,
               SECOND_REVIEWER_TOKEN_FILE=token_file)
    env.update(NO_PROXY="127.0.0.1", no_proxy="127.0.0.1")
    env.pop("MARVEEN_AGENT_NAME", None)
    if agent:
        env["MARVEEN_AGENT_NAME"] = agent
    p = subprocess.run([sys.executable, GATE],
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

p = run(PUSH, token_file=os.path.join(tmp, "missing"))
check("G7", p.returncode == 2 and "nem erheto el" in p.stderr and not requests, p.stderr)

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
