#!/usr/bin/env python3
"""Card f90928e3 part B, N6: scripts/hooks/email-draft-log.py (AC17).

Proven here:
  - every draft shape the approval gate recognises (the tool-name matrix of
    mail-tool-name-cases.json, manage_email with draft true / "true") produces
    EXACTLY ONE daily-log entry for agent brainy; a literal "True", 1 or a
    missing flag does not (the gate's strict test);
  - every send shape (same matrix, manage_email sends, and the Bash corpus
    send-invocation-cases.json, which holds no MCP draft) produces none;
  - a failed tool result, an unknown tool, malformed stdin: no entry, exit 0;
  - a dashboard 500 or timeout, a forbidden port, a missing token: exit 0,
    nothing on stdout, a note on stderr;
  - the body, cc, bcc and attachments never reach the payload;
  - the entry format: recipients (to only), subject cut at 80 chars with an
    ellipsis, Budapest time.

The dashboard is a stub on an ephemeral loopback port (never 18800 / 18899).
Run: python3 <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
HOOK = os.path.join(HOOKS, "email-draft-log.py")
FORBIDDEN = (18800, 18899)

failed = []

# ---- loopback-only socket guard for this test process (Brainy 1769) ----------------
# connect() to anything but 127.0.0.1 / ::1, or to 18800 / 18899 / a test-only
# blocked port, is refused BEFORE the real connect. The hook runs as a
# subprocess; it has its own FORBIDDEN_PORTS check, and the OS sandbox covers
# non-loopback for it.
import socket  # noqa: E402

BLOCKED_TEST_PORT = 0
_real_connect = socket.socket.connect


def _guarded_connect(self, address):
    host, port = (address[0], address[1]) if isinstance(address, tuple) else (None, None)
    if host not in ("127.0.0.1", "::1", "localhost") or port in FORBIDDEN or port == BLOCKED_TEST_PORT:
        raise PermissionError(f"socket guard: connect to {address!r} refused")
    return _real_connect(self, address)


socket.socket.connect = _guarded_connect
_probe = socket.socket()
_probe.bind(("127.0.0.1", 0))
BLOCKED_TEST_PORT = _probe.getsockname()[1]
_probe.listen(1)
_selftests = []
for _addr in (("192.0.2.1", 80), ("127.0.0.1", 18800), ("127.0.0.1", 18899), ("127.0.0.1", BLOCKED_TEST_PORT)):
    _s = socket.socket()
    try:
        _s.connect(_addr)
        _selftests.append(False)
    except PermissionError:
        _selftests.append(True)
    except OSError:
        _selftests.append(False)
    finally:
        _s.close()
_probe.close()
if not all(_selftests):
    print("socket guard self-test FAILED", _selftests)
    sys.exit(1)
print("  [PASS] socket guard self-test (non-loopback, 18800, 18899, blocked test port refused)")


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if not ok and detail else ""))
    if not ok:
        failed.append(name)


def load_hook():
    spec = importlib.util.spec_from_file_location("email_draft_log", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---- in-process driver (the name matrix: hundreds of calls, no subprocess) ----
hook = load_hook()


def in_process(payload, failure=None):
    """Run main() on `payload` with _post captured. Returns the entries posted."""
    posted = []
    orig_post, orig_stdin = hook._post, sys.stdin
    hook._post = lambda gate, text: posted.append(text)
    sys.stdin = io.StringIO(payload if isinstance(payload, str) else json.dumps(payload))
    try:
        hook.main()
    finally:
        hook._post, sys.stdin = orig_post, orig_stdin
    return posted


OK_RESP = [{"type": "text", "text": "Draft created with ID: r-1"}]


def call(tool, tool_input, resp=OK_RESP, **extra):
    p = {"hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": tool_input,
         "tool_response": resp}
    p.update(extra)
    return p


LETTER = {"to": ["dani@pelda.hu"], "subject": "Ajanlat", "body": "TITKOS-TORZS-JELZO"}

# ---- 1. the classifier matrix: draft kinds -> one entry, all others -> none ----
cases = json.load(open(os.path.join(HOOKS, "mail-tool-name-cases.json"), encoding="utf-8"))
names = []
for server in cases["servers"]:
    for prefix in cases["prefixes"]:
        for base, spec in cases["bases"].items():
            names.append((server + prefix + base, spec["kind"], base))
for c in cases["cases"]:
    names.append((c["name"], c["expected"], c["name"].rsplit("__", 1)[-1]))

draft_bad, other_bad, n_draft, n_other = [], [], 0, 0
for name, kind, base in names:
    if not name:
        continue
    posted = in_process(call(name, dict(LETTER)))
    # update_draft is a "draft" KIND but not a draft the gate treats as one
    # (an update may carry only the changed fields); manage_email without
    # draft true is a send.
    is_draft = kind == "draft" and "update_draft" not in name.lower()
    if is_draft:
        n_draft += 1
        if len(posted) != 1:
            draft_bad.append((name, len(posted)))
    else:
        n_other += 1
        if posted:
            other_bad.append((name, len(posted)))
check(f"matrix: {n_draft} draft tool names -> exactly one entry each", n_draft > 20 and not draft_bad, str(draft_bad[:3]))
check(f"matrix: {n_other} non-draft tool names (sends, reads, update_draft, telegram) -> none", n_other > 200 and not other_bad, str(other_bad[:3]))

# ---- 2. manage_email: the strict draft flag -------------------------------------
for flag in (True, "true"):
    for op in ("draft", "reply", "send", "forward"):
        posted = in_process(call("mcp__gmail__manage_email", dict(LETTER, operation=op, draft=flag)))
        check(f"manage_email {op} draft={flag!r} -> one entry", len(posted) == 1, str(posted))
for flag in ("True", "yes", 1, "false", False, None, "TRUE"):
    posted = in_process(call("mcp__gmail__manage_email", dict(LETTER, operation="reply", draft=flag)))
    check(f"manage_email reply draft={flag!r} is a send -> none", posted == [], str(posted))
posted = in_process(call("mcp__gmail__manage_email", dict(LETTER, operation="reply")))
check("manage_email reply without the flag -> none", posted == [])
posted = in_process(call("mcp__gmail__manage_email", {"operation": "search", "query": "x"}))
check("manage_email search -> none", posted == [])

# ---- 3. Bash corpus: every send case, and every case at all -> none -------------
bash_cases = json.load(open(os.path.join(HOOKS, "send-invocation-cases.json"), encoding="utf-8"))["cases"]
sends = [c for c in bash_cases if c["expected"]]
leaks = [c["name"] for c in bash_cases
         if in_process(call("Bash", {"command": c["cmd"]}, resp={"stdout": "", "stderr": ""}))]
check(f"Bash corpus: {len(sends)} send cases of {len(bash_cases)} -> none (a Bash call is never a draft)",
      len(sends) > 10 and not leaks, str(leaks[:3]))

# ---- 4. failed results, unknown tools, bad payloads ------------------------------
dr = ("mcp__gmail__draft_email", dict(LETTER))
fail_shapes = {
    "PostToolUseFailure event": call(*dr, resp=None, hook_event_name="PostToolUseFailure"),
    "is_error dict": call(*dr, resp={"is_error": True, "content": "x"}),
    "isError dict": call(*dr, resp={"isError": True, "content": [{"type": "text", "text": "x"}]}),
    "error key": call(*dr, resp={"error": "boom"}),
    "is_error block": call(*dr, resp=[{"type": "text", "text": "x", "is_error": True}]),
    "Error text block": call(*dr, resp=[{"type": "text", "text": "Error: quota exceeded"}]),
    "Error string": call(*dr, resp="Error: invalid recipient"),
    "Error in content dict": call(*dr, resp={"content": [{"type": "text", "text": "Error 400"}]}),
    "tool_response missing": {"hook_event_name": "PostToolUse", "tool_name": dr[0], "tool_input": dr[1]},
    "tool_response null": call(*dr, resp=None),
}
for label, p in fail_shapes.items():
    check(f"failed result ({label}) -> none", in_process(p) == [])
check("successful dict result -> one entry",
      len(in_process(call(*dr, resp={"content": [{"type": "text", "text": "Draft created"}]}))) == 1)
check("successful string result -> one entry", len(in_process(call(*dr, resp="Draft created"))) == 1)
for tool in ("mcp__foo__do_something", "Read", "Edit", "mcp__plugin_telegram_telegram__reply",
             "mcp__gmail__search_emails", "mcp__gmail__list_drafts", "mcp__gmail__delete_draft", ""):
    check(f"unknown / non-mail tool {tool!r} -> none", in_process(call(tool, dict(LETTER))) == [])
for label, raw in (("not JSON", "{nope"), ("empty", ""), ("JSON list", "[1,2]"), ("JSON null", "null"),
                   ("tool_input a string", json.dumps({"tool_name": dr[0], "tool_input": "x", "tool_response": "ok"})),
                   ("no tool_name", json.dumps({"tool_input": dr[1], "tool_response": "ok"}))):
    check(f"malformed stdin ({label}) -> none", in_process(raw) == [])

# ---- 5. entry format ------------------------------------------------------------
text = in_process(call(*dr))[0]
check("format: [Levélvázlat] <to>, tárgy: <subject>, <YYYY-MM-DD HH:MM>",
      re.fullmatch(r"\[Levélvázlat\] dani@pelda\.hu, tárgy: Ajanlat, \d{4}-\d\d-\d\d \d\d:\d\d", text) is not None, text)
long_subject = "Á" * 120
text = in_process(call(dr[0], dict(LETTER, subject=long_subject)))[0]
subj = re.search(r"tárgy: (.*), \d{4}-", text).group(1)
check("subject cut to 80 chars with an ellipsis", subj == "Á" * 79 + "…" and len(subj) == 80, repr(subj))
text = in_process(call(dr[0], dict(LETTER, subject="x" * 80)))[0]
check("80-char subject is kept whole", ("x" * 80 + ", ") in text and "…" not in text)
text = in_process(call(dr[0], dict(LETTER, to=["a@x.hu", "b@x.hu"], subject="Sor\nAtores\t  tab")))[0]
check("several recipients joined; whitespace in the subject collapsed",
      "a@x.hu, b@x.hu, tárgy: Sor Atores tab," in text, text)
text = in_process(call("mcp__gmail__manage_email", {"operation": "reply", "draft": True, "messageId": "m1"}))[0]
check("no recipient / no subject (a messageId reply draft) still one readable entry",
      text.startswith("[Levélvázlat] (nincs címzett), tárgy: (nincs tárgy), "), text)
text = in_process(call(dr[0], dict(LETTER, to="Dani <dani@pelda.hu>")))[0]
check("a string `to` is accepted", text.startswith("[Levélvázlat] Dani <dani@pelda.hu>,"), text)
many = [f"u{i}@x.hu" for i in range(15)]
text = in_process(call(dr[0], dict(LETTER, to=many)))[0]
check("more than 10 recipients are capped with a count", "u9@x.hu (+5)," in text and "u10@" not in text, text)

# ---- 6. end-to-end: real subprocess against a stub dashboard ---------------------
class Stub:
    def __init__(self, status=200, delay=0.0):
        self.received, self.status, self.delay = [], status, delay
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n).decode("utf-8")
                outer.received.append((self.path, self.headers.get("Authorization"), raw))
                if outer.delay:
                    time.sleep(outer.delay)
                try:
                    self.send_response(outer.status)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"ok":true}')
                except OSError:
                    pass

            def log_message(self, *a):
                pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        assert self.srv.server_port not in FORBIDDEN
        self.port = self.srv.server_port
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def run_hook(stdin_text, port, token="test-token-123", extra_env=None):
    with tempfile.TemporaryDirectory() as td:
        store = os.path.join(td, "store")
        os.makedirs(store)
        if token is not None:
            with open(os.path.join(store, ".dashboard-token"), "w", encoding="utf-8") as fh:
                fh.write(token + "\n")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "EMAIL_APPROVAL_GATE_STORE": store,
               "WEB_PORT": str(port), "HOME": td}
        env.update(extra_env or {})
        t0 = time.time()
        r = subprocess.run([sys.executable, HOOK], input=stdin_text, capture_output=True, text=True,
                           env=env, timeout=30)
        return r.returncode, r.stdout, r.stderr, time.time() - t0


full = call("mcp__gmail__create_draft", {
    "to": ["dani@pelda.hu"], "cc": ["CC-JELZO@pelda.hu"], "bcc": ["BCC-JELZO@pelda.hu"],
    "subject": "Ajanlat", "body": "TITKOS-TORZS-JELZO", "html": "<p>HTML-JELZO</p>",
    "attachments": ["/tmp/CSATOLMANY-JELZO.pdf"], "attachment_names": ["CSATOLMANY-JELZO.pdf"]},
    cwd="/Users/x/agents/ezermester", transcript_path="/Users/x/agents/ezermester/.claude-config/projects/a/s.jsonl")
stub = Stub()
try:
    code, out, err, _ = run_hook(json.dumps(full), stub.port)
finally:
    stub.close()
check("e2e: draft -> exit 0, stdout empty, one POST to /api/daily-log",
      code == 0 and out == "" and len(stub.received) == 1 and stub.received[0][0] == "/api/daily-log",
      f"code={code} out={out!r} err={err!r} n={len(stub.received)}")
if stub.received:
    path, auth, raw = stub.received[0]
    body = json.loads(raw)
    check("e2e: Bearer token from the store, agent_id brainy (not the writing agent)",
          auth == "Bearer test-token-123" and body["agent_id"] == "brainy", f"{auth} {body.get('agent_id')}")
    check("e2e: payload carries exactly agent_id + content", sorted(body) == ["agent_id", "content"])
    leaked = [m for m in ("TITKOS-TORZS-JELZO", "HTML-JELZO", "CC-JELZO", "BCC-JELZO", "CSATOLMANY-JELZO", "/tmp/")
              if m in raw]
    check("e2e: body, html, cc, bcc and attachments never appear in the payload", not leaked, str(leaked))
    check("e2e: content is the expected entry",
          body["content"].startswith("[Levélvázlat] dani@pelda.hu, tárgy: Ajanlat, "), body["content"])

stub = Stub()
try:
    send = call("mcp__gmail__send_email", dict(LETTER))
    code, out, err, _ = run_hook(json.dumps(send), stub.port)
    n_send = len(stub.received)
    code2, out2, _, _ = run_hook(json.dumps(call(*dr, resp={"is_error": True})), stub.port)
    code3, out3, _, _ = run_hook("{nope", stub.port)
    code4, out4, _, _ = run_hook(json.dumps(call("Bash", {"command": "echo hi"})), stub.port)
finally:
    stub.close()
check("e2e: send / failed / malformed / Bash -> exit 0, empty stdout, zero POSTs",
      (code, code2, code3, code4) == (0, 0, 0, 0) and (out, out2, out3, out4) == ("", "", "", "")
      and n_send == 0 and not stub.received, f"{(code, code2, code3, code4)} n={len(stub.received)}")

stub = Stub(status=500)
try:
    code, out, err, _ = run_hook(json.dumps(full), stub.port)
finally:
    stub.close()
check("e2e: dashboard 500 -> exit 0, no stdout, a note on stderr",
      code == 0 and out == "" and "HTTP Error 500" in err and "email-draft-log" in err, f"{code} {out!r} {err!r}")

stub = Stub(delay=5.0)
try:
    code, out, err, took = run_hook(json.dumps(full), stub.port)
finally:
    stub.close()
check("e2e: dashboard timeout -> exit 0 within ~2 s, no stdout, a note on stderr",
      code == 0 and out == "" and "email-draft-log" in err and took < 4.5, f"{code} {err!r} {took:.1f}s")

# nothing listens on this port (a socket we bound and closed): connection refused
probe = Stub()
dead_port = probe.port
probe.close()
code, out, err, _ = run_hook(json.dumps(full), dead_port)
check("e2e: dashboard down -> exit 0, no stdout, a note on stderr",
      code == 0 and out == "" and "email-draft-log" in err, f"{code} {err!r}")

for port in FORBIDDEN:
    code, out, err, _ = run_hook(json.dumps(full), port)
    check(f"e2e: WEB_PORT={port} is refused before any connection, exit 0",
          code == 0 and out == "" and "refused WEB_PORT" in err, f"{code} {err!r}")
code, out, err, _ = run_hook(json.dumps(full), 3420, token=None)
check("e2e: missing token file -> exit 0, no stdout, a note on stderr",
      code == 0 and out == "" and "email-draft-log" in err, f"{code} {err!r}")
code, out, err, _ = run_hook(json.dumps(full), "notaport")
check("e2e: non-numeric WEB_PORT -> exit 0, a note on stderr",
      code == 0 and out == "" and "email-draft-log" in err, f"{code} {err!r}")

# ---- 7. the gate is untouched and its functions are the ones in use -----------------
src = open(HOOK, encoding="utf-8").read()
check("the hook imports the gate's classifier instead of carrying its own draft regex",
      "scope_kind" in src and "owner_cc_scope" in src and "draft_email|create_draft" not in src)

print()
if failed:
    print(f"FAILED {len(failed)}: {failed}")
    sys.exit(1)
print("ALL PASS")
