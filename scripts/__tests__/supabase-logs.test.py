#!/usr/bin/env python3
"""Contract tests for scripts/supabase-logs.py (SUPALOGS822).

THE PROPERTY UNDER TEST is not "the query works" -- it is that the PAT never
becomes durable text (argv, stdout, stderr) and that the script FAILS CLOSED
when it cannot fetch the token. Hermetic: one local HTTP stub plays both the
dashboard vault and the vendor API; no network, no real secret.

Run: python3 scripts/__tests__/supabase-logs.test.py
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# Deliberately NOT PAT-shaped (push-protection would rightly reject a fake sbp_).
FAKE_PAT = "FAKE-TOKEN-FOR-TESTS-ONLY-not-a-real-supabase-pat"
FAILS: list[str] = []
STATE = {"vault_empty": False, "api_status": 200, "hits": []}


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("ok   - " if cond else "FAIL - ") + name + (("  :: " + detail) if (detail and not cond) else ""))
    if not cond:
        FAILS.append(name)


class Stub(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path.startswith("/api/vault/"):
            body = json.dumps({"value": "" if STATE["vault_empty"] else FAKE_PAT}).encode()
            self.send_response(200)
        elif "/analytics/endpoints/logs" in u.path:
            auth = self.headers.get("Authorization", "")
            STATE["hits"].append({
                "path": u.path,
                "qs": urllib.parse.parse_qs(u.query),
                "auth_sha": hashlib.sha256(auth.encode()).hexdigest()[:12],
                "ua": self.headers.get("User-Agent", ""),
            })
            if STATE["api_status"] == 200 and STATE.get("api_error"):
                body = json.dumps({"result": None, "error": "Backend error! Retry your query."}).encode()
            elif STATE["api_status"] == 200:
                body = json.dumps({"result": [{"c": 42}], "error": None}).encode()
            else:
                body = json.dumps({"message": "Bad Request: window too large"}).encode()
            self.send_response(STATE["api_status"])
        else:
            body = b"{}"
            self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run(args: list[str], tmp: Path, base: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, CLAW_DASHBOARD_ORIGIN=base, SUPABASE_API_BASE=base)
    return subprocess.run([sys.executable, str(tmp / "scripts" / "supabase-logs.py"), *args],
                         capture_output=True, text=True, env=env, timeout=30)


def main() -> None:
    srv = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"
    tmp = Path(tempfile.mkdtemp(prefix="supabase-logs-test-"))
    try:
        (tmp / "scripts").mkdir()
        (tmp / "store").mkdir()
        shutil.copy(REPO / "scripts" / "supabase-logs.py", tmp / "scripts" / "supabase-logs.py")
        (tmp / "store" / ".dashboard-token").write_text("dashboard-token-xyz")

        # 1. usage
        r = run([], tmp, base)
        check("[1] usage: exit 2 without args", r.returncode == 2, str(r.returncode))
        check("[1] usage: the API was NOT called", not STATE["hits"])

        # 2. happy path: token hidden everywhere visible, present on the wire
        STATE["hits"].clear()
        r = run(["proj-ref", "select count(*) c from logs where source_name = 'edge_logs'"], tmp, base)
        check("[2] exit 0", r.returncode == 0, f"rc={r.returncode} err={r.stderr[:200]}")
        check("[2] stdout carries the vendor body", '"c": 42' in r.stdout or '"c":42' in r.stdout, r.stdout[:120])
        check("[2] stderr carries http status and window", "http=200" in r.stderr and "window=" in r.stderr, r.stderr[:160])
        check("[2] the token is NOT in stdout", FAKE_PAT not in r.stdout)
        check("[2] the token is NOT in stderr", FAKE_PAT not in r.stderr)
        check("[2] exactly one API call", len(STATE["hits"]) == 1, str(len(STATE["hits"])))
        hit = STATE["hits"][0]
        want = hashlib.sha256(("Bearer " + FAKE_PAT).encode()).hexdigest()[:12]
        check("[2] the Authorization header carries the token (sha prefix)", hit["auth_sha"] == want)
        check("[2] the path is the SUCCESSOR endpoint, not logs.all",
              hit["path"].endswith("/analytics/endpoints/logs") and "logs.all" not in hit["path"], hit["path"])
        qs = hit["qs"]
        check("[2] sql + both timestamps are sent", all(k in qs for k in ("sql", "iso_timestamp_start", "iso_timestamp_end")), str(list(qs)))
        check("[2] a named User-Agent is sent", bool(hit["ua"]) and "python" not in hit["ua"].lower(), hit["ua"])

        # 3. window cap: 25h rejected BEFORE any call
        STATE["hits"].clear()
        r = run(["proj-ref", "select 1", "--hours", "25"], tmp, base)
        check("[3] a 25h window is a usage error (exit 2)", r.returncode == 2, str(r.returncode))
        check("[3] and the API was NOT called", not STATE["hits"])

        # 4. FAIL-CLOSED: empty vault -> exit 3, nothing sent
        STATE["hits"].clear(); STATE["vault_empty"] = True
        r = run(["proj-ref", "select 1"], tmp, base)
        check("[4] empty vault: exit 3", r.returncode == 3, f"rc={r.returncode}")
        check("[4] empty vault: the API was NOT called", not STATE["hits"])
        STATE["vault_empty"] = False

        # 5. FAIL-CLOSED: missing dashboard token -> exit 3
        os.rename(tmp / "store" / ".dashboard-token", tmp / "store" / ".dashboard-token.off")
        r = run(["proj-ref", "select 1"], tmp, base)
        check("[5] missing dashboard-token: exit 3", r.returncode == 3, f"rc={r.returncode}")
        check("[5] missing dashboard-token: the API was NOT called", not STATE["hits"])
        os.rename(tmp / "store" / ".dashboard-token.off", tmp / "store" / ".dashboard-token")

        # 6. vendor HTTP error -> exit 4, message visible, token still hidden
        STATE["hits"].clear(); STATE["api_status"] = 400
        r = run(["proj-ref", "select 1"], tmp, base)
        check("[6] HTTP 400: exit 4", r.returncode == 4, f"rc={r.returncode}")
        check("[6] the vendor message reaches stdout", "window too large" in r.stdout, r.stdout[:120])
        check("[6] the token is NOT in stdout/stderr", FAKE_PAT not in (r.stdout + r.stderr))
        STATE["api_status"] = 200

        # 7. HTTP 200 with a non-null error field is NOT success: exit 4
        STATE["hits"].clear(); STATE["api_error"] = True
        r = run(["proj-ref", "select 1"], tmp, base)
        check("[7] 200 + error field: exit 4, not 0", r.returncode == 4, f"rc={r.returncode}")
        check("[7] the error reason reaches stderr", "NEM futott le" in r.stderr and "Backend error" in r.stderr, r.stderr[:160])
        STATE["api_error"] = False

        # 8. --legacy targets logs.all (transition only), default never does
        STATE["hits"].clear()
        r = run(["proj-ref", "select count(*) c from function_logs", "--legacy"], tmp, base)
        check("[8] --legacy: exit 0", r.returncode == 0, f"rc={r.returncode}")
        check("[8] --legacy: the path is logs.all", STATE["hits"] and STATE["hits"][0]["path"].endswith("/analytics/endpoints/logs.all"), str(STATE["hits"][:1]))
        check("[8] --legacy: stderr names the deprecated endpoint", "DEPRECATED" in r.stderr, r.stderr[:120])
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)

    if FAILS:
        print("FAILED: " + ", ".join(FAILS))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
