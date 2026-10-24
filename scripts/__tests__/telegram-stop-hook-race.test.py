#!/usr/bin/env python3
"""Regression test for the 2026-08-12 duplicate-reply incident.

The Stop hook (scripts/hooks/telegram_progress_clear.py) was registered TWICE in
~/.claude/settings.json -- once per resolved python3 path -- so every Stop event
ran two copies of it concurrently. With the old exists()-then-create marker the
twins split down different branches:

    copy A: no marker -> write it -> BLOCK (nudge the agent to reply properly)
    copy B: marker present (A just wrote it) -> "already nudged" -> deliver the
            raw transcript text itself

The agent, nudged by A, then replied through its tool -- and the user received
the same answer twice. This test runs the hook exactly the way the harness did:
two copies at once, same session, same state dir.

Asserts, against a stubbed Bot API:
  1. first Stop, twin copies   -> exactly ONE block decision, ZERO sends
  2. post-nudge, twin copies   -> exactly ONE send (the guaranteed fallback)
  3. replied chat, twin copies -> ZERO sends (reply already went out via tool)

Run: python3 scripts/__tests__/telegram-stop-hook-race.test.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer

# STOP_HOOK_UNDER_TEST lets the suite be pointed at a variant of the hook --
# used to verify this test actually FAILS against the pre-fix implementation.
HOOK = os.environ.get("STOP_HOOK_UNDER_TEST") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "hooks",
    "telegram_progress_clear.py")
CHAT = "8619483467"
PLACEHOLDER_MID = 4242

SENDS = []
_LOCK = threading.Lock()


class Stub(BaseHTTPRequestHandler):
    """Minimal Bot API stub: records sendMessage, accepts everything else."""

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        if self.path.endswith("/sendMessage"):
            with _LOCK:
                SENDS.append(json.loads(body.decode()))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(
            {"ok": True, "result": {"message_id": 1}}).encode())

    def log_message(self, *a):
        pass


def make_state(tmp, *, replied=False):
    """A state dir mid-turn: one pending placeholder, a transcript with the
    agent's final answer, and no reply sent (unless `replied`)."""
    sd = os.path.join(tmp, "telegram")
    pdir = os.path.join(sd, "progress")
    os.makedirs(pdir, exist_ok=True)
    with open(os.path.join(sd, ".env"), "w") as f:
        f.write("TELEGRAM_BOT_TOKEN=TESTTOKEN\n")
    transcript = os.path.join(tmp, "transcript.jsonl")
    with open(transcript, "w") as f:
        f.write(json.dumps({"type": "assistant", "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": "A reggeli napindito."}]}}) + "\n")
    sid = "sess-race"
    with open(os.path.join(pdir, f"{sid}.json"), "w") as f:
        json.dump([{"chat_id": CHAT, "message_id": PLACEHOLDER_MID,
                    "transcript_path": transcript}], f)
    if replied:
        open(os.path.join(pdir, f"replied-{sid}-{CHAT}.marker"), "w").close()
    return sd, sid, transcript


def run_twins(sd, sid, transcript, base, *, stop_active):
    """Fire two copies of the hook concurrently, exactly as the doubly
    registered settings.json did. Returns their stdout list."""
    event = json.dumps({"session_id": sid, "transcript_path": transcript,
                        "stop_hook_active": stop_active})
    env = dict(os.environ, TELEGRAM_STATE_DIR=sd, TELEGRAM_API_BASE=base)

    def one(_):
        p = subprocess.run([sys.executable, HOOK], input=event, env=env,
                           capture_output=True, text=True, timeout=30)
        return p.stdout.strip()

    with ThreadPoolExecutor(max_workers=2) as ex:
        return list(ex.map(one, range(2)))


def blocks(outs):
    n = 0
    for o in outs:
        try:
            if json.loads(o).get("decision") == "block":
                n += 1
        except Exception:
            pass
    return n


def main():
    srv = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    failures = []

    def check(name, cond, extra=""):
        print(f"  {'PASS' if cond else 'FAIL'}: {name}" + ("" if cond else f"  [{extra}]"))
        if not cond:
            failures.append(name)

    # (1) First Stop, two copies at once -> one nudge, nothing delivered.
    tmp = tempfile.mkdtemp()
    try:
        SENDS.clear()
        sd, sid, tr = make_state(tmp)
        outs = run_twins(sd, sid, tr, base, stop_active=False)
        print("\n(1) first Stop, twin hook copies")
        check("exactly one block decision", blocks(outs) == 1, f"blocks={blocks(outs)}")
        check("no message delivered yet", len(SENDS) == 0, f"sends={len(SENDS)}")

        # (2) The agent still did not reply -> the guaranteed fallback fires ONCE.
        SENDS.clear()
        outs = run_twins(sd, sid, tr, base, stop_active=True)
        print("\n(2) post-nudge Stop, twin hook copies")
        check("exactly one fallback send", len(SENDS) == 1, f"sends={len(SENDS)}")
        check("no further block", blocks(outs) == 0, f"blocks={blocks(outs)}")
        if SENDS:
            check("delivered to the right chat", str(SENDS[0].get("chat_id")) == CHAT)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # (3) The reply DID go out via the tool -> no fallback prose at all.
    tmp = tempfile.mkdtemp()
    try:
        SENDS.clear()
        sd, sid, tr = make_state(tmp, replied=True)
        outs = run_twins(sd, sid, tr, base, stop_active=False)
        print("\n(3) chat already answered via the reply tool")
        check("nothing delivered", len(SENDS) == 0, f"sends={len(SENDS)}")
        check("no bogus nudge", blocks(outs) == 0, f"blocks={blocks(outs)}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    srv.shutdown()
    print()
    if failures:
        print(f"RESULT: {len(failures)} FAILED: {failures}")
        return 1
    print("RESULT: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
