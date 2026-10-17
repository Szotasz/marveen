#!/usr/bin/env python3
"""Tests for scripts/telegram-pending-watchdog.py (TGPENDING1016).

Every case runs the real script as a subprocess against ONE local stub HTTP server that plays both the
Bot API (/bot<token>/getWebhookInfo) and the dashboard (/api/agents/<name>/restart, /api/daily-log), so
the script's own HTTP code is exercised, offline. Time is driven with TPW_NOW, one run per "tick".

The positive control is the frozen-poller shape measured on 2026-10-16 (pending_update_count=1 that does
not drain); the negative control is a healthy fleet (pending 0) and a single transient update.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "telegram-pending-watchdog.py")

TOKENS = {  # synthetic, shaped like real bot tokens
    "main": "1111111111:AAMainMainMainMainMainMainMainMainMain",
    "alpha": "2222222222:AAAlphaAlphaAlphaAlphaAlphaAlphaAlpha",
    "beta": "3333333333:AABetaBetaBetaBetaBetaBetaBetaBetaBeta",
}
DASH_TOKEN = "dash-secret-0123456789abcdef"


class Stub:
    def __init__(self):
        self.pending = {t: 0 for t in TOKENS.values()}   # token -> pending_update_count
        self.webhook = set()                              # tokens with a webhook url
        self.broken = set()                               # tokens whose getWebhookInfo answers 502
        self.restart_status = 200
        self.restarts, self.daily, self.auth = [], [], []
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                if self.path.startswith("/bot") and self.path.endswith("/getWebhookInfo"):
                    tok = self.path[4:-len("/getWebhookInfo")]
                    if tok in stub.broken:
                        # echoes the request path, token included: redact() must keep it out of the log
                        return self._send(502, {"ok": False, "description": f"Bad Gateway for /bot{tok}/getWebhookInfo"})
                    if tok not in stub.pending:
                        return self._send(401, {"ok": False, "description": "Unauthorized"})
                    url = "https://example.invalid/hook" if tok in stub.webhook else ""
                    return self._send(200, {"ok": True, "result": {"url": url, "has_custom_certificate": False,
                                                                   "pending_update_count": stub.pending[tok]}})
                self._send(404, {})

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n).decode()
                stub.auth.append(self.headers.get("Authorization"))
                if self.path.startswith("/api/agents/") and self.path.endswith("/restart"):
                    name = self.path[len("/api/agents/"):-len("/restart")]
                    stub.restarts.append((name, body))
                    if stub.restart_status == 200:
                        return self._send(200, {"ok": True})
                    return self._send(stub.restart_status, {"error": "Agent is not running and was stopped on purpose",
                                                            "code": "stopped-not-desired"})
                if self.path == "/api/daily-log":
                    stub.daily.append(json.loads(body))
                    return self._send(200, {"ok": True})
                self._send(404, {})

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.tmp = tempfile.TemporaryDirectory()
        d = self.d = self.tmp.name
        write(f"{d}/.env", "MAIN_AGENT_ID=mainbot\nWEB_PORT=1\n")
        write(f"{d}/store/.dashboard-token", DASH_TOKEN + "\n")
        write(f"{d}/main-tg/.env", f'TELEGRAM_BOT_TOKEN="{TOKENS["main"]}"\n')
        write(f"{d}/agents/alpha/.claude/channels/telegram/.env", f"TELEGRAM_BOT_TOKEN={TOKENS['alpha']}\n")
        write(f"{d}/agents/beta/.claude/channels/telegram/.env", f"TELEGRAM_BOT_TOKEN={TOKENS['beta']}\n")
        self.out = []

    def tearDown(self):
        self.stub.close()
        self.tmp.cleanup()

    def run_at(self, t, **env):
        e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": self.d,
             "TPW_INSTALL_DIR": self.d, "TPW_MAIN_TG_ENV": f"{self.d}/main-tg/.env",
             "TPW_TELEGRAM_BASE": self.stub.base, "TPW_DASHBOARD_BASE": self.stub.base,
             "TPW_STATE_FILE": f"{self.d}/state.json", "TPW_NOW": str(t), **env}
        r = subprocess.run([sys.executable, SCRIPT], env=e, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.out.append(r.stdout + r.stderr)
        return r.stdout + r.stderr

    def restarted(self):
        return [n for n, _ in self.stub.restarts]

    # --- negative controls -------------------------------------------------------------------------
    def test_healthy_fleet_touches_nothing(self):
        for t in (0, 180, 360, 540):
            out = self.run_at(1_000_000 + t)
        self.assertEqual(self.restarted(), [])
        self.assertEqual(self.stub.daily, [])
        self.assertIn("pending: mainbot=0 alpha=0 beta=0", out)

    def test_one_transient_update_is_not_a_freeze(self):
        T = 1_000_000
        self.stub.pending[TOKENS["alpha"]] = 1
        self.run_at(T)
        self.stub.pending[TOKENS["alpha"]] = 0          # the poller picked it up
        self.run_at(T + 180)
        self.stub.pending[TOKENS["alpha"]] = 1          # a new one: the streak starts over
        self.run_at(T + 360)
        self.assertEqual(self.restarted(), [])

    def test_two_runs_too_close_do_not_count(self):
        T = 1_000_000
        self.stub.pending[TOKENS["alpha"]] = 1
        self.run_at(T)
        self.run_at(T + 60)                             # < MIN_STUCK_S after the first sighting
        self.assertEqual(self.restarted(), [])

    def test_a_late_run_does_not_continue_the_streak(self):
        T = 1_000_000
        self.stub.pending[TOKENS["alpha"]] = 1
        self.run_at(T)
        self.run_at(T + 600)                            # > MAX_GAP_S: no evidence for the time between
        self.assertEqual(self.restarted(), [])
        self.run_at(T + 780)                            # now two consecutive runs, 180 s apart
        self.assertEqual(self.restarted(), ["alpha"])

    # --- positive controls -------------------------------------------------------------------------
    def test_frozen_subagent_poller_is_restarted_once(self):
        T = 1_000_000
        self.stub.pending[TOKENS["beta"]] = 1
        self.run_at(T)
        self.assertEqual(self.restarted(), [])
        out = self.run_at(T + 180)
        self.assertEqual(self.restarted(), ["beta"])
        self.assertIn("beta: STUCK (pending 1 for 180s across 2 runs) -> restart OK", out)
        self.assertEqual(self.stub.auth[0], "Bearer " + DASH_TOKEN)
        self.assertEqual(len(self.stub.daily), 1)
        self.assertEqual(self.stub.daily[0]["agent_id"], "beta")
        self.assertIn("pending_update_count=1", self.stub.daily[0]["content"])

    def test_frozen_main_agent_goes_through_the_restart_endpoint_with_its_id(self):
        T = 1_000_000
        self.stub.pending[TOKENS["main"]] = 2
        self.run_at(T)
        self.run_at(T + 185)
        self.assertEqual(self.restarted(), ["mainbot"])

    def test_cooldown_one_attempt_per_15_minutes(self):
        T = 1_000_000
        self.stub.pending[TOKENS["alpha"]] = 1          # never drains: the restart did not help
        for k in range(0, 8):                           # 0 .. 1260 s
            self.run_at(T + 180 * k)
        # first at 180; the streak rebuilds at 360/540 but the cooldown holds until 180 + 900 = 1080
        self.assertEqual(self.restarted(), ["alpha", "alpha"])
        self.assertTrue(any("waiting" in o for o in self.out))

    def test_refused_restart_is_logged_and_still_braked(self):
        T = 1_000_000
        self.stub.restart_status = 409
        self.stub.pending[TOKENS["alpha"]] = 1
        out = ""
        for k in range(0, 4):
            out += self.run_at(T + 180 * k)
        self.assertEqual(self.restarted(), ["alpha"])
        self.assertIn("restart FAILED: HTTP 409 stopped-not-desired", out)
        self.assertIn("NEM sikerült", self.stub.daily[0]["content"])

    def test_dry_run_decides_but_restarts_nothing(self):
        T = 1_000_000
        self.stub.pending[TOKENS["alpha"]] = 1
        self.run_at(T, TPW_DRY_RUN="1")
        out = self.run_at(T + 180, TPW_DRY_RUN="1")
        self.assertIn("alpha: STUCK (pending 1 for 180s) -- DRY_RUN, would restart", out)
        self.assertEqual(self.restarted(), [])
        self.assertEqual(self.stub.daily, [])

    # --- what must be skipped ----------------------------------------------------------------------
    def test_api_error_is_no_evidence(self):
        T = 1_000_000
        self.stub.broken.add(TOKENS["alpha"])
        self.stub.pending[TOKENS["alpha"]] = 5
        for k in range(0, 3):
            out = self.run_at(T + 180 * k)
        self.assertEqual(self.restarted(), [])
        self.assertIn("alpha=?", out)
        self.assertIn("getWebhookInfo HTTP 502", out)

    def test_webhook_bot_is_skipped(self):
        T = 1_000_000
        self.stub.webhook.add(TOKENS["alpha"])
        self.stub.pending[TOKENS["alpha"]] = 3
        self.run_at(T)
        out = self.run_at(T + 180)
        self.assertEqual(self.restarted(), [])
        self.assertIn("alpha=webhook(skip)", out)

    def test_shared_token_is_never_restarted_blind(self):
        T = 1_000_000
        write(f"{self.d}/agents/beta/.claude/channels/telegram/.env", f"TELEGRAM_BOT_TOKEN={TOKENS['alpha']}\n")
        self.stub.pending[TOKENS["alpha"]] = 1
        self.run_at(T)
        out = self.run_at(T + 180)
        self.assertIn("beta=shares-token-with-alpha(skip)", out)
        self.assertEqual(self.restarted(), ["alpha"])   # the first owner only; beta is reported, not guessed

    def test_symlinked_env_is_one_bot(self):
        os.makedirs(f"{self.d}/agents/gamma/.claude/channels", exist_ok=True)
        os.symlink(f"{self.d}/main-tg", f"{self.d}/agents/gamma/.claude/channels/telegram")
        out = self.run_at(1_000_000)
        self.assertIn("pending: mainbot=0 alpha=0 beta=0", out)
        self.assertNotIn("gamma", out)

    # --- secrets -----------------------------------------------------------------------------------
    def test_no_token_anywhere_in_output_state_or_requests(self):
        T = 1_000_000
        self.stub.pending[TOKENS["alpha"]] = 1
        self.stub.broken.add(TOKENS["beta"])
        self.run_at(T)
        self.run_at(T + 180)
        with open(f"{self.d}/state.json") as fh:
            state = fh.read()
        hay = "".join(self.out) + state + json.dumps(self.stub.daily) + json.dumps(self.stub.restarts)
        for name, tok in list(TOKENS.items()) + [("dashboard", DASH_TOKEN)]:
            self.assertNotIn(tok, hay, name)
            self.assertNotIn(tok.split(":")[-1], hay, name)
        self.assertEqual(oct(os.stat(f"{self.d}/state.json").st_mode & 0o777), "0o600")


if __name__ == "__main__":
    unittest.main(verbosity=2)
