#!/usr/bin/env python3
"""scripts/hooks/voice-reply-directive.py against a fake dashboard (card deeaa175, 75c3d163).

The hook's stdout is what the AGENT reads. Pins what it must say for each transcript
state the dashboard reports:
- high (and a server that sends no confidence at all): the plain "[Hang átirat]: <text>";
- uncertain / unreliable: the doubt travels IN THE SAME LINE as the text;
- no transcript: the notice reaches the agent instead of silence;
- calibrationMismatch is for the fleet, not for the agent: the hook never prints it.

The hook runs as a subprocess from a temporary install tree (its own copy, a fake token,
WEB_PORT pointing at a local stub server). No network beyond 127.0.0.1, no real dashboard.
Run: python3 <thisfile>   Exit 0 = all pass.
"""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(os.path.dirname(HERE), "hooks", "voice-reply-directive.py")
FILE_ID = "AwACAgQAAxkBAAITestVoiceId0003"
fails = 0


def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else " -- " + detail))
    if not ok:
        fails += 1


STUB = {"body": {}, "requests": []}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        STUB["requests"].append((self.path, self.headers.get("Authorization")))
        data = json.dumps(STUB["body"]).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]

root = tempfile.mkdtemp(prefix="voice-reply-directive-test-")
os.makedirs(os.path.join(root, "scripts", "hooks"))
os.makedirs(os.path.join(root, "store"))
hook_copy = os.path.join(root, "scripts", "hooks", "voice-reply-directive.py")
shutil.copy(HOOK, hook_copy)
with open(os.path.join(root, "store", ".dashboard-token"), "w") as f:
    f.write("teszt-token\n")


def run(body):
    STUB["body"] = body
    STUB["requests"].clear()
    prompt = 'uzenet chat_id="123456789" attachment_file_id="%s" attachment_kind="voice"' % FILE_ID
    env = dict(os.environ, WEB_PORT=str(port), PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run([sys.executable, hook_copy], input=json.dumps({"prompt": prompt, "cwd": root}),
                       capture_output=True, text=True, env=env, timeout=30)
    return r.returncode, r.stdout


try:
    rc, out = run({"directive": None, "transcript": "Szia", "transcriptStatus": "ok", "transcriptConfidence": "high"})
    check("high: plain transcript line", rc == 0 and "\n[Hang átirat]: Szia\n" in out, repr(out))
    path, auth = STUB["requests"][0] if STUB["requests"] else ("", "")
    check("the request carries the file, the kind and the token",
          ("file=" + FILE_ID) in path and "kind=voice" in path and auth == "Bearer teszt-token", repr((path, auth)))

    rc, out = run({"directive": None, "transcript": "Szia"})
    check("an older server without confidence: plain transcript line", "\n[Hang átirat]: Szia\n" in out, repr(out))

    rc, out = run({"transcript": "Szia", "transcriptStatus": "ok", "transcriptConfidence": "uncertain",
                   "transcriptNotice": "A leirat BIZONYTALAN ..."})
    check("uncertain: the doubt is in the transcript line", "\n[Hang átirat -- BIZONYTALAN]: Szia\n" in out, repr(out))
    check("uncertain: the notice follows", "\n[Hangüzenet]: A leirat BIZONYTALAN ...\n" in out, repr(out))

    rc, out = run({"transcript": "Szia", "transcriptStatus": "ok", "transcriptConfidence": "unreliable"})
    check("unreliable: the stronger mark", "\n[Hang átirat -- NINCS MEGBÍZHATÓ OLVASAT]: Szia\n" in out, repr(out))

    rc, out = run({"transcript": None, "transcriptStatus": "no-transcript",
                   "transcriptNotice": "Hangüzenet erkezett (1.0 mp), de NEM sikerult leiratozni."})
    check("no transcript: the notice reaches the agent", "[Hangüzenet]: Hangüzenet erkezett (1.0 mp)" in out, repr(out))
    check("no transcript: no transcript line", "[Hang átirat" not in out, repr(out))

    rc, out = run({"transcript": "Szia", "transcriptStatus": "ok", "transcriptConfidence": "high",
                   "calibrationMismatch": {"expected": "faster-whisper-medium-x", "actual": "small@y"}})
    check("calibrationMismatch is never shown to the agent",
          "small@y" not in out and "faster-whisper" not in out and "calibration" not in out.lower(), repr(out))
finally:
    server.shutdown()
    shutil.rmtree(root, ignore_errors=True)

print("%d FAIL" % fails if fails else "ALL PASS")
sys.exit(1 if fails else 0)
