#!/usr/bin/env python3
"""scripts/jegyzetek.py (the Notes page CLI) against a fake dashboard.

Pins the review fixes:
  - a note id that is not 6 hex characters is refused BEFORE any request
    (`torol ../agents/cody` used to become DELETE /api/agents/cody once the
    server normalised the path);
  - --ki is required on `uj` and `torol` (no guessed author), and a flag
    without a value is a clean error, not an IndexError;
  - an unreachable dashboard or a missing token file is one FAIL line and
    exit 1, never a traceback;
  - the port follows the agent-msg.sh chain (WEB_PORT works without
    MARVEEN_WEB_PORT);
  - `ertesit` relays ids only (never the note text), skips MAIN_AGENT_ID,
    and exits 1 when a message could not be sent.

Run: python3 scripts/__tests__/jegyzetek.test.py
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, "scripts", "jegyzetek.py")
FAILS = []

NOTES = [
    {"id": "abc123", "assignee": "Cody", "content": "SECRET-NOTE-TEXT check the build", "created_at": 1791700000,
     "due_date": None},
    {"id": "def456", "assignee": "mindenki", "content": "everyone line", "created_at": 1791700000,
     "due_date": "2026-10-01"},
    {"id": "aaa111", "assignee": "boss", "content": "main agent line", "created_at": 1791700000, "due_date": None},
]
AGENTS = [{"name": "cody", "running": True}, {"name": "margo", "running": False}, {"name": "boss", "running": True}]


class Fake(http.server.BaseHTTPRequestHandler):
    calls = []
    messages_status = 200

    def log_message(self, *a):
        pass

    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"null") if n else None

    def do_GET(self):
        Fake.calls.append(("GET", self.path, None))
        if self.path == "/api/notes":
            return self._send(200, NOTES)
        if self.path == "/api/agents":
            return self._send(200, AGENTS)
        return self._send(404, {"error": "nope"})

    def do_POST(self):
        body = self._body()
        Fake.calls.append(("POST", self.path, body))
        if self.path == "/api/messages":
            return self._send(Fake.messages_status, {"id": 7} if Fake.messages_status == 200 else {"error": "x"})
        return self._send(200, {"ok": True, "id": "abc123"})

    def do_DELETE(self):
        Fake.calls.append(("DELETE", self.path, self._body()))
        return self._send(200, {"ok": True})


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
threading.Thread(target=server.serve_forever, daemon=True).start()
PORT = server.server_address[1]
TMP = tempfile.mkdtemp(prefix="jegyzetek-test-")
TOKEN = os.path.join(TMP, "token")
with open(TOKEN, "w") as f:
    f.write("t0k\n")


def check(name, cond, detail=""):
    print(("PASS  " if cond else "FAIL  ") + name + (("  -- " + detail) if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def cli(*args, env_extra=None, base=True):
    env = {k: v for k, v in os.environ.items() if k not in ("MARVEEN_WEB_PORT", "WEB_PORT", "MARVEEN_API_BASE")}
    env["MARVEEN_TOKEN_FILE"] = TOKEN
    env["MAIN_AGENT_ID"] = "boss"
    if base:
        env["MARVEEN_API_BASE"] = "http://127.0.0.1:%d" % PORT
    env.update(env_extra or {})
    Fake.calls = []
    r = subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, env=env, timeout=60)
    return r, list(Fake.calls)


# --- id validation ---------------------------------------------------------------------------
for bad in ("../agents/cody", "abc12", "abc1234", "xyz123", "%2e%2e"):
    r, calls = cli("torol", bad, "--ki", "cody")
    check("torol %r is refused" % bad, r.returncode == 1 and "not a note id" in r.stderr, r.stderr)
    check("torol %r sends no request" % bad, calls == [], str(calls))
r, calls = cli("torol", "#ABC123", "--ki", "cody", "--ok", "done")
check("torol #ABC123 deletes /api/notes/abc123", ("DELETE", "/api/notes/abc123", {"by": "cody", "reason": "done"}) in calls, str(calls))

# --- required --ki, flag without value -----------------------------------------------------------
r, calls = cli("uj", "cody", "text")
check("uj without --ki is refused, no request", r.returncode == 1 and "--ki NAME" in r.stderr and calls == [], r.stderr)
r, calls = cli("torol", "abc123")
check("torol without --ki is refused, no request", r.returncode == 1 and calls == [], r.stderr)
r, calls = cli("uj", "cody", "text", "--ki")
check("a flag without a value is a clean error", r.returncode == 1 and "--ki needs a value" in r.stderr
      and "Traceback" not in r.stderr, r.stderr)
r, calls = cli("uj", "Cody ", "text", "--ki", "margo", "--hatarido", "2026-10-20")
post = [c for c in calls if c[0] == "POST"]
check("uj posts a lower-cased assignee and the named author",
      post and post[0][2] == {"assignee": "cody", "content": "text", "created_by": "margo", "due_date": "2026-10-20"},
      str(post))

# --- clean failures ----------------------------------------------------------------------------
r, _ = cli("lista", env_extra={"MARVEEN_API_BASE": "http://127.0.0.1:9"})
check("unreachable dashboard: one FAIL line, exit 1, no traceback",
      r.returncode == 1 and "not reachable" in r.stderr and "Traceback" not in r.stderr, r.stderr)
r, _ = cli("lista", env_extra={"MARVEEN_TOKEN_FILE": os.path.join(TMP, "missing")})
check("missing token file: one FAIL line, exit 1, no traceback",
      r.returncode == 1 and "dashboard token" in r.stderr and "Traceback" not in r.stderr, r.stderr)

# --- port chain --------------------------------------------------------------------------------
r, calls = cli("lista", base=False, env_extra={"WEB_PORT": str(PORT)})
check("WEB_PORT alone reaches the dashboard", r.returncode == 0 and ("GET", "/api/notes", None) in calls, r.stderr)
r, calls = cli("lista", "--kinek", "CODY")
check("lista --kinek matches case-insensitively and includes mindenki",
      "#abc123" in r.stdout and "#def456" in r.stdout and "#aaa111" not in r.stdout, r.stdout)

# --- ertesit -----------------------------------------------------------------------------------
r, calls = cli("ertesit", "reggel", "--dry-run")
check("ertesit names the line ids", "#abc123, #def456" in r.stdout, r.stdout)
check("ertesit never relays the note text", "SECRET-NOTE-TEXT" not in r.stdout, r.stdout)
check("ertesit skips MAIN_AGENT_ID", "--- boss" not in r.stdout, r.stdout)
check("ertesit reports a stopped agent", "margo NOT RUNNING" in r.stdout, r.stdout)
check("dry run sends nothing", not [c for c in calls if c[1] == "/api/messages"], str(calls))

Fake.messages_status = 200
r, calls = cli("ertesit", "este")
sent = [c for c in calls if c[1] == "/api/messages"]
check("ertesit sends one message, from MAIN_AGENT_ID, exit 0",
      r.returncode == 0 and len(sent) == 1 and sent[0][2].get("from") == "boss" and sent[0][2].get("to") == "cody",
      r.stdout + r.stderr + str(sent))
check("the sent message carries no note text", sent and "SECRET-NOTE-TEXT" not in json.dumps(sent[0][2]), str(sent))
Fake.messages_status = 500
r, calls = cli("ertesit", "este")
check("a failed send makes ertesit exit 1", r.returncode == 1 and "not sent to cody" in r.stderr, r.stdout + r.stderr)

server.shutdown()
print("\n%d failure(s)" % len(FAILS))
sys.exit(1 if FAILS else 0)
