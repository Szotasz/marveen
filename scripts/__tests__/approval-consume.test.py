#!/usr/bin/env python3
"""f2c5edb0: the send path consumes its own approval (scripts/approval-consume.py).

Proven against a stub dashboard that keeps the one-shot state per approval id, like the real
POST /api/approvals/<id>/consume:
  - the first consume of an approval exits 0, a SECOND one exits 3 (already_consumed), and a caller
    that sends only on 0 sends exactly once -- the double send the card is about;
  - the request carries the bearer token and exactly the anchor, the consumer and the Message-Id;
  - 404 -> 4; 500, an unreadable answer, an unreachable dashboard, a missing token -> 2 (never 0);
  - a malformed anchor or Message-Id is refused locally (2) and the dashboard is never called.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(os.path.dirname(HERE), "approval-consume.py")
TOKEN = "test-token-not-a-secret"
HASH = "ab" * 32
OTHER = "cd" * 32

failed = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failed.append(name)


class Stub(BaseHTTPRequestHandler):
    consumed = {}      # approval id -> consumer of the first successful consume
    seen = []          # (path, auth header, parsed body) per request

    def log_message(self, *a):  # keep the test output clean
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = None
        Stub.seen.append((self.path, self.headers.get("Authorization"), body))
        parts = self.path.strip("/").split("/")  # api approvals <id> consume
        aid = parts[2] if len(parts) == 4 and parts[3] == "consume" else None
        if aid == "boom":
            return self._send(500, {"error": "internal"})
        if aid == "garbled":
            return self._send(200, None, raw=b"<html>not json</html>")
        if aid == "missing":
            return self._send(404, {"ok": False, "reason": "not_found"})
        if body is None or body.get("content_hash") != HASH:
            return self._send(409, {"ok": False, "reason": "hash_mismatch"})
        if aid in Stub.consumed:
            return self._send(409, {"ok": False, "reason": "already_consumed",
                                    "approval": {"id": aid, "consumed_by": Stub.consumed[aid]}})
        Stub.consumed[aid] = body.get("consumer")
        return self._send(200, {"ok": True, "approval": {"id": aid, "consumed_at": 1, "consumed_by": body.get("consumer"),
                                                         "consumed_ref": body.get("message_id")}})

    def _send(self, status, obj, raw=None):
        data = raw if raw is not None else json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


srv = HTTPServer(("127.0.0.1", 0), Stub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
API = "http://127.0.0.1:%d" % srv.server_address[1]

tmp = tempfile.mkdtemp(prefix="approval-consume-test-")
TOKEN_FILE = os.path.join(tmp, "token")
with open(TOKEN_FILE, "w", encoding="utf-8") as fh:
    fh.write(TOKEN + "\n")


def run(*args, token_file=TOKEN_FILE, api=API):
    p = subprocess.run([sys.executable, HELPER, "--api", api, "--token-file", token_file, *args],
                       capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    try:
        out = json.loads(p.stdout.strip().splitlines()[-1]) if p.stdout.strip() else {}
    except Exception:
        out = {"unparsed": p.stdout}
    return p.returncode, out


# --- the double send: a caller that sends only on rc 0 ---------------------------------------
sent = []
for attempt in (1, 2):
    rc, out = run("--id", "appr-1", "--content-hash", HASH, "--consumer", "send-tool", "--message-id", "<m%d@example.org>" % attempt)
    if rc == 0:
        sent.append(attempt)
    if attempt == 1:
        check("first consume exits 0 and reports consumed", rc == 0 and out.get("consumed") is True)
        check("first consume echoes the consumer and the Message-Id", out.get("consumed_by") == "send-tool" and out.get("consumed_ref") == "<m1@example.org>")
    else:
        check("SECOND consume of the same approval exits 3 (already_consumed)", rc == 3 and out.get("reason") == "already_consumed")
        check("the refusal names who consumed it first", (out.get("approval") or {}).get("consumed_by") == "send-tool")
check("a caller that sends only on rc 0 sends exactly once", sent == [1])

# --- what goes over the wire -----------------------------------------------------------------
path, auth, body = Stub.seen[0]
check("the request goes to POST /api/approvals/<id>/consume", path == "/api/approvals/appr-1/consume")
check("the request carries the bearer token", auth == "Bearer " + TOKEN)
check("the body is exactly anchor + consumer + message_id",
      body == {"content_hash": HASH, "consumer": "send-tool", "message_id": "<m1@example.org>"})

# --- every other outcome is NOT a yes ----------------------------------------------------------
rc, out = run("--id", "appr-2", "--content-hash", OTHER, "--consumer", "send-tool")
check("another letter (hash mismatch) exits 3", rc == 3 and out.get("reason") == "hash_mismatch")
rc, out = run("--id", "missing", "--content-hash", HASH, "--consumer", "send-tool")
check("unknown approval exits 4", rc == 4)
rc, out = run("--id", "boom", "--content-hash", HASH, "--consumer", "send-tool")
check("a 500 exits 2, not 0", rc == 2)
rc, out = run("--id", "garbled", "--content-hash", HASH, "--consumer", "send-tool")
check("an unreadable 200 answer exits 2, not 0", rc == 2)
closed = socket.socket()
closed.bind(("127.0.0.1", 0))
dead = "http://127.0.0.1:%d" % closed.getsockname()[1]
closed.close()
rc, out = run("--id", "appr-3", "--content-hash", HASH, "--consumer", "send-tool", api=dead)
check("an unreachable dashboard exits 2", rc == 2 and "unreachable" in (out.get("error") or ""))
rc, out = run("--id", "appr-3", "--content-hash", HASH, "--consumer", "send-tool", token_file=os.path.join(tmp, "nope"))
check("a missing token file exits 2", rc == 2)

# --- refused locally, the dashboard is never called --------------------------------------------
before = len(Stub.seen)
rc, _ = run("--id", "appr-4", "--content-hash", "AB" * 32, "--consumer", "send-tool")
check("an upper-case (non-canonical) anchor is refused locally (2)", rc == 2)
rc, _ = run("--id", "appr-4", "--content-hash", HASH, "--consumer", "send-tool", "--message-id", "m1@example.org")
check("a Message-Id without angle brackets is refused locally (2)", rc == 2)
rc, _ = run("--id", "appr/4", "--content-hash", HASH, "--consumer", "send-tool")
check("an id with a slash is refused locally (2)", rc == 2)
check("none of the local refusals reached the dashboard", len(Stub.seen) == before)

# --- the importable function agrees with the CLI ------------------------------------------------
spec = importlib.util.spec_from_file_location("approval_consume", HELPER)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
rc, body = mod.consume(API, TOKEN, "appr-5", HASH, "lib-caller")
check("consume() returns (0, body) on the first call", rc == 0 and body.get("ok") is True)
rc, body = mod.consume(API, TOKEN, "appr-5", HASH, "lib-caller")
check("consume() returns (3, body) on the second call", rc == 3 and body.get("reason") == "already_consumed")

# --- control: this suite can fail -----------------------------------------------------------------
# Without it, a stub that answered 200 to everything would make every refusal check above vacuous.
rc, _ = run("--id", "appr-6", "--content-hash", HASH, "--consumer", "send-tool")
rc2, _ = run("--id", "appr-6", "--content-hash", HASH, "--consumer", "send-tool")
check("control: the stub really keeps one-shot state (0 then 3 on a fresh id)", (rc, rc2) == (0, 3))

srv.shutdown()
print()
if failed:
    print(f"{len(failed)} FAILED: {failed}", file=sys.stderr)
    sys.exit(1)
print("All approval-consume tests passed.")
