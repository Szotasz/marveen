#!/usr/bin/env python3
"""TOOLLOGREDACT924: the tool-log hook must not write a secret into tool_call_log.

The redact in scripts/hooks/tool-log-capture.py let four formatted, fabricated
secret shapes through (Boni's #1533 review, measured on develop): a quoted value,
a space-separated --token flag, a JWT after a *_KEY= name, and Authorization:
Basic. This suite pins the fixed pattern set, both directions:

  - LEAK cases: every shape comes out with the secret body replaced, and the
    secret body is nowhere in the output;
  - KEEP cases: harmless text (shell variable references, `mkdir -p`, a plain
    URL, ordinary words that merely contain a secret word) is left readable;
  - BINDING: the hook run as a process POSTs the REDACTED summary. A redact that
    works but is bypassed at the POST would otherwise pass every unit case.

Every fabricated secret is ASSEMBLED at run time from pieces, so no literal
secret shape sits in this file for the secret scan to trip on.

Run: python3 <thisfile>   Exit 0 = all pass.
"""
import http.server
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
HOOK = os.path.join(HOOKS, "tool-log-capture.py")

spec = importlib.util.spec_from_file_location("toollog", HOOK)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

R = "[REDACTED]"
# Fabricated secret bodies, assembled so the source never holds the shape.
SBP = "sbp" + "_" + "a1b2c3d4e5" * 4
GHO = "gho" + "_" + "Zy" * 18
GHPAT = "github" + "_pat_" + "Q7" * 15
JWT = "ey" + "J" + "hbGciOiJIUzI1NiJ9" + ".ey" + "J" + "yb2xlIjoic2VydmljZSJ9" + "." + "c2lnbmF0dXJlZmFrZXh5"
BASIC = "ZmFrZXVzZXI6" + "ZmFrZXBhc3N3b3Jk"
PASS = "fakePassw0rd" + "_9x8y"
# An opaque value with no known prefix, not hex, not a JWT: only the NAME or
# the FLAG around it can identify it, so each pattern below is pinned alone.
OPAQUE = "q9W8e7R6t5Y4u3I2" + "o1P0aSdFgH"

LEAK = [
    # the four shapes Boni measured leaking on develop
    ("quoted value after a secret name (PATSZIVARGAS912 shape)", f'export SUPABASE_ACCESS_TOKEN="{SBP}"', SBP),
    ("space-separated --token flag", f"supabase link --project-ref x --token {SBP}", SBP),
    ("JWT after a *_KEY= name", f"SERVICE_ROLE_KEY={JWT} node x.js", JWT),
    ("Authorization: Basic", f'curl -H "Authorization: Basic {BASIC}" https://example.org', BASIC),
    # the rest of the set asked of #1533
    ("single-quoted password", f"PGPASSWORD='{PASS}' psql -h db", PASS),
    ("gho_ token piped to gh", f"echo {GHO} | gh auth login --with-token", GHO),
    ("github_pat_ in a URL", f"git clone https://{GHPAT}@github.com/o/r.git", GHPAT),
    ("user:pass embedded in a URL", f"git clone https://deploy:{PASS}@example.org/r.git", PASS),
    ("--password= flag", f"mysql --password={PASS} -u root", PASS),
    ("bare JWT in a header", f'curl -H "apikey: {JWT}" https://x.supabase.co', JWT),
    ("sbp_ with no name before it", f"echo {SBP} > /tmp/x", SBP),
    ("JSON key with a quoted value", f'{{"password": "{PASS}"}}', PASS),
    # each of these is caught by exactly ONE pattern (mutation-checked)
    ("spaced --token flag, opaque value", f"deploy --token {OPAQUE}", OPAQUE),
    ("spaced --password flag, quoted", f"tool --password '{OPAQUE}' run", OPAQUE),
    ("*_KEY= name, opaque value", f"STRIPE_WEBHOOK_KEY={OPAQUE} node x.js", OPAQUE),
    ("standalone JWT", f"echo {JWT} | cut -d. -f2", JWT),
    ("token-only credential in a URL", f"git clone https://{OPAQUE}@example.org/r.git", OPAQUE),
    ("raw 40-char hex blob", "sha=" + "ab12cd34" * 5 + " verify", "ab12cd34" * 5),
]

KEEP = [
    ("shell variable reference, quoted", 'export TOKEN="$SUPABASE_TOKEN"', 'export TOKEN="$SUPABASE_TOKEN"'),
    ("shell variable reference, flag", 'supabase link --token "$SUPABASE_ACCESS_TOKEN"', 'supabase link --token "$SUPABASE_ACCESS_TOKEN"'),
    ("shell variables as URL credentials", "git clone https://$GH_USER:$GH_TOKEN@github.com/o/r.git", "git clone https://$GH_USER:$GH_TOKEN@github.com/o/r.git"),
    ("mkdir -p is not a password flag", "mkdir -p /tmp/some/dir", "mkdir -p /tmp/some/dir"),
    ("ssh -p port", "ssh -p 2222 host", "ssh -p 2222 host"),
    ("plain URL", "git clone https://github.com/o/r.git", "git clone https://github.com/o/r.git"),
    ("an author field is not auth", 'git log --author="someone@example.org"', 'git log --author="someone@example.org"'),
]

fails = 0


def check(name, ok, detail=""):
    global fails
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(': ' + detail) if detail and not ok else ''}")
    if not ok:
        fails += 1


print("LEAK shapes: the secret body must be gone")
for name, text, secret in LEAK:
    out = mod._redact(text)
    check(name, secret not in out and R in out, f"secret still present={secret in out}, marker={R in out}")

print("KEEP shapes: harmless text stays readable")
for name, text, want in KEEP:
    out = mod._redact(text)
    check(name, out == want, f"got {out!r}")

print("the summary path (what the hook POSTs) redacts, Bash and generic")
s = mod._input_summary({"command": LEAK[0][1]}, "Bash")
check("Bash summary", SBP not in s and R in s)
s = mod._input_summary({"prompt": LEAK[2][1]}, "Task")
check("generic-field summary", JWT not in s and R in s)

print("BINDING: the hook process POSTs the redacted summary")
got = {}


class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        if self.path.endswith("/tool-log"):
            got["body"] = body.decode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
stage = tempfile.mkdtemp(prefix="toollog-redact-")
try:
    os.makedirs(os.path.join(stage, "scripts", "hooks"))
    os.makedirs(os.path.join(stage, "store"))
    for f in ("tool-log-capture.py", "ledger_lib.py"):
        shutil.copy(os.path.join(HOOKS, f), os.path.join(stage, "scripts", "hooks", f))
    with open(os.path.join(stage, "store", ".dashboard-token"), "w") as fh:
        fh.write("test-dashboard-token")
    payload = {"hook_event_name": "PostToolUse", "session_id": "s", "tool_name": "Bash",
               "tool_input": {"command": LEAK[1][1]}, "cwd": stage, "tool_use_id": "t1", "duration_ms": 5}
    env = dict(os.environ, WEB_PORT=str(srv.server_address[1]))
    r = subprocess.run([sys.executable, os.path.join(stage, "scripts", "hooks", "tool-log-capture.py")],
                       input=json.dumps(payload), capture_output=True, text=True, env=env, timeout=30)
    body = got.get("body")
    check("the hook reached the server", body is not None, f"rc={r.returncode} stderr={r.stderr[:200]}")
    if body is not None:
        summ = json.loads(body).get("input_summary", "")
        # Booleans only in the failure detail: on a real leak, echoing the
        # summary would print the secret into the CI log.
        check("the POSTed summary carries no secret", SBP not in body and R in summ,
              f"secret in body={SBP in body}, marker in summary={R in summ}")
finally:
    srv.shutdown()
    shutil.rmtree(stage, ignore_errors=True)

if fails:
    print(f"\n{fails} tool-log redact test(s) FAILED")
    sys.exit(1)
print("\nAll tool-log redact tests passed.")
