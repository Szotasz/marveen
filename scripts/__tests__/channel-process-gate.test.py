#!/usr/bin/env python3
"""Tests for scripts/hooks/channel-process-gate.py.

The fixtures are PINNED here in full, not read from the live machine: a gate
whose test input is whatever `ps` happens to print today can go both falsely
red and falsely green, and the input is unrecoverable afterwards.
Provenance: captured from a live host 2026-09-12, then ANONYMISED --
session names and home paths were renamed, the SHAPE (column order, pid
lineage, argv layout) is exactly what `ps` and `tmux list-panes` emitted
session pid 3004904 (telegram+discord), trimmed to the relevant rows.
"""
import os, subprocess, sys, tempfile, unittest

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "hooks", "channel-process-gate.py")

TMUX = """agent-ultronai 888007
agent-heimdall 2972889
main-agent-channels 3004904
main-agent-worker 1426101
"""

CLAUDE_BOTH = ("3004904 3004900 /usr/bin/claude --dangerously-skip-permissions "
               "--model claude-opus-5[1m] --channels "
               "plugin:telegram@claude-plugins-official "
               "plugin:discord@claude-plugins-official")
BUN_TG = ("3005020 3004904 bun run --cwd /home/user/.claude/plugins/cache/"
          "claude-plugins-official/telegram/0.0.7 --shell=bun --silent start")
BUN_DC = ("3005021 3004904 bun run --cwd /home/user/.claude/plugins/cache/"
          "claude-plugins-official/discord/0.0.4 --shell=bun --silent start")
OTHER = ("2972889 2972880 /usr/bin/claude --dangerously-skip-permissions "
         "--model ultron-main --channels plugin:discord@claude-plugins-official")
OTHER_BUN = ("2972962 2972889 bun run --cwd /home/user/.claude/plugins/cache/"
             "claude-plugins-official/discord/0.0.4 --shell=bun --silent start")
HEADER = "    PID    PPID COMMAND"
NOISE = ("3008580 3004904 /bin/bash -c grep -v "
         "plugins/cache/claude-plugins-official/telegram/ ps.txt")
# A child of OUR session whose --cwd carries the plugin-shaped tail but does NOT
# live under plugins/cache. Upstream review (2026-09-15) measured that removing
# the `plugins/cache` filter leaves all 16 tests green, i.e. any child started
# with a --cwd could pass as a live worker. This row is what makes that mutant red.
MASQUERADE = ("3005022 3004904 bun run --cwd /home/user/.local/share/"
              "claude-plugins-official/telegram/0.0.7 --shell=bun --silent start")


def run(ps_rows, extra=()):
    with tempfile.TemporaryDirectory() as d:
        ps = os.path.join(d, "ps.txt")
        tm = os.path.join(d, "tmux.txt")
        with open(ps, "w") as fh:
            fh.write("\n".join([HEADER] + list(ps_rows)) + "\n")
        with open(tm, "w") as fh:
            fh.write(TMUX)
        cmd = [sys.executable, GATE, "--ps-file", ps, "--tmux-file", tm,
               "--state", os.path.join(d, "state.json")] + list(extra)
        return subprocess.run(cmd, capture_output=True, text=True)


class GateTest(unittest.TestCase):
    def test_all_workers_alive_is_green(self):
        r = run([CLAUDE_BOTH, BUN_TG, BUN_DC, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("[zold] main-agent-channels", r.stdout)
        self.assertNotIn("PIROS", r.stdout)

    def test_missing_telegram_worker_is_red(self):
        """The measured 09-05 / 09-06 failure: declared but no worker."""
        r = run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("[PIROS] main-agent-channels", r.stdout)
        self.assertIn("HIANYZO=claude-plugins-official/telegram", r.stdout)

    def test_missing_discord_worker_is_red(self):
        r = run([CLAUDE_BOTH, BUN_TG, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("HIANYZO=claude-plugins-official/discord", r.stdout)

    def test_other_sessions_stay_green_when_one_is_red(self):
        r = run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN])
        self.assertIn("[zold] agent-heimdall", r.stdout)

    def test_a_foreign_bun_worker_does_not_count_as_ours(self):
        """A worker whose parent is a DIFFERENT session must not mask a gap."""
        stolen = BUN_TG.replace("3005020 3004904", "3005020 2972889")
        r = run([CLAUDE_BOTH, BUN_DC, stolen, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)

    def test_a_child_outside_plugins_cache_does_not_count_as_a_worker(self):
        """Only children running FROM the plugin cache count as live workers.

        Without the `plugins/cache` filter the path tail alone would satisfy the
        <marketplace>/<plugin> extraction, so a child started with any --cwd could
        mask a genuinely missing worker. Closes the third point of the upstream
        review: that mutant used to stay green across all 16 tests.
        """
        r = run([CLAUDE_BOTH, BUN_DC, MASQUERADE, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("HIANYZO=claude-plugins-official/telegram", r.stdout)
        self.assertIn("HIANYZO=claude-plugins-official/telegram", r.stdout)

    def test_empty_ps_is_measurement_error_not_green(self):
        r = run([])
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("MERESI HIBA", r.stderr)

    def test_no_channel_session_is_measurement_error_not_green(self):
        r = run([BUN_TG, BUN_DC])
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)

    def test_only_filter_on_absent_session_is_error_not_green(self):
        r = run([OTHER, OTHER_BUN], extra=["--only", "main-agent-channels"])
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)

    def test_command_line_mentioning_a_plugin_path_is_not_a_worker(self):
        """Our own measuring command must not be read as process evidence."""
        r = run([CLAUDE_BOTH, BUN_DC, NOISE, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("HIANYZO=claude-plugins-official/telegram", r.stdout)

    def test_no_send_without_notify_flag(self):
        r = run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN])
        self.assertNotIn("ERTESITES", r.stderr)


class NotifyBranchTest(unittest.TestCase):
    """The alarm path itself, measured against a local stub -- never the owner."""

    def setUp(self):
        import http.server, threading, json as _json
        self.seen = []
        seen = self.seen

        class H(http.server.BaseHTTPRequestHandler):
            # MERVE 2026-09-12 07:30: a valodi discord API User-Agent nelkul
            # 403 "error code: 1010"-et ad (Cloudflare), ezert a kapu elso eles
            # riasztasa NEM ment ki -- pedig ez a stub akkor is 200-at mondott.
            # A stub azota ugyanugy utasit el, mint a valosag, kulonben a
            # notify-agak zoldje semmit nem bizonyit a kezbesitesrol.
            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(n).decode()
                ua = self.headers.get("User-Agent", "")
                if not ua or ua.startswith("Python-urllib"):
                    seen.append((self.path, {"_rejected": "no-user-agent"}, ua))
                    self.send_response(403)
                    self.end_headers()
                    self.wfile.write(b"error code: 1010")
                    return
                seen.append((self.path, _json.loads(body), ua))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *a):
                pass

        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def _fake_home(self, d):
        ch = os.path.join(d, ".claude", "channels")
        os.makedirs(os.path.join(ch, "discord"))
        os.makedirs(os.path.join(ch, "telegram"))
        with open(os.path.join(ch, "discord", ".env"), "w") as fh:
            fh.write("DISCORD_BOT_TOKEN=stub-token\nDISCORD_CHANNEL_ID=4242\n")
        with open(os.path.join(ch, "telegram", ".env"), "w") as fh:
            fh.write("TELEGRAM_BOT_TOKEN=stub-token\nTELEGRAM_OWNER_CHAT_ID=99\n")
        return d

    def _run(self, rows, home, extra_env=None):
        with tempfile.TemporaryDirectory() as d:
            ps = os.path.join(d, "ps.txt")
            tm = os.path.join(d, "tmux.txt")
            with open(ps, "w") as fh:
                fh.write("\n".join([HEADER] + list(rows)) + "\n")
            with open(tm, "w") as fh:
                fh.write(TMUX)
            env = dict(os.environ)
            env["DISCORD_API_BASE"] = "http://127.0.0.1:%d" % self.port
            env["TELEGRAM_API_BASE"] = "http://127.0.0.1:%d" % self.port
            env["HOME"] = home
            env.update(extra_env or {})
            return subprocess.run(
                [sys.executable, GATE, "--ps-file", ps, "--tmux-file", tm,
                 "--state", os.path.join(d, "state.json"), "--notify"],
                capture_output=True, text=True, env=env)

    def test_dead_telegram_is_announced_on_discord(self):
        with tempfile.TemporaryDirectory() as home:
            self._fake_home(home)
            r = self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN], home)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(len(self.seen), 1, self.seen)
        path, body, _ua = self.seen[0]
        self.assertIn("/channels/4242/messages", path)   # discord, not telegram
        self.assertIn("telegram", body["content"])
        # a kezbesites felteteke, nem stilus: UA nelkul a valodi API 403-at ad
        self.assertTrue(_ua and not _ua.startswith("Python-urllib"), _ua)
        self.assertIn("main-agent-channels", body["content"])
        self.assertIn("elkuldve", r.stderr)

    def test_dead_discord_is_announced_on_telegram(self):
        with tempfile.TemporaryDirectory() as home:
            self._fake_home(home)
            r = self._run([CLAUDE_BOTH, BUN_TG, OTHER, OTHER_BUN], home)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(len(self.seen), 1, self.seen)
        path, body, _ua = self.seen[0]
        self.assertIn("/sendMessage", path)              # telegram, not discord
        self.assertEqual(body["chat_id"], "99")
        self.assertTrue(_ua and not _ua.startswith("Python-urllib"), _ua)
        self.assertIn("discord", body["text"])

    def test_green_sends_nothing(self):
        with tempfile.TemporaryDirectory() as home:
            self._fake_home(home)
            r = self._run([CLAUDE_BOTH, BUN_TG, BUN_DC, OTHER, OTHER_BUN], home)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.seen, [])

    def test_alert_targets_file_beats_the_env_channel(self):
        """The .env id is a guild channel, not the owner DM -- it must lose."""
        with tempfile.TemporaryDirectory() as home:
            self._fake_home(home)
            tgt = os.path.join(home, "targets.json")
            with open(tgt, "w") as fh:
                fh.write('{"discord_owner_dm": "777", "telegram_owner_dm": "888"}')
            r = self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN], home,
                          extra_env={"CHANNEL_GATE_TARGETS": tgt})
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        path, _, _ua = self.seen[0]
        self.assertIn("/channels/777/messages", path)
        self.assertNotIn("/channels/4242/", path)

    def test_explicit_env_id_beats_everything(self):
        with tempfile.TemporaryDirectory() as home:
            self._fake_home(home)
            tgt = os.path.join(home, "targets.json")
            with open(tgt, "w") as fh:
                fh.write('{"discord_owner_dm": "777"}')
            r = self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN], home,
                          extra_env={"CHANNEL_GATE_TARGETS": tgt,
                                     "CHANNEL_GATE_DISCORD_ID": "555"})
        self.assertIn("/channels/555/messages", self.seen[0][0])

    def test_telegram_address_falls_back_to_the_paired_sender(self):
        """No chat id in .env: the paired sender in access.json is the DM."""
        with tempfile.TemporaryDirectory() as home:
            self._fake_home(home)
            ch = os.path.join(home, ".claude", "channels", "telegram")
            with open(os.path.join(ch, ".env"), "w") as fh:
                fh.write("TELEGRAM_BOT_TOKEN=stub-token\n")   # no chat id
            with open(os.path.join(ch, "access.json"), "w") as fh:
                fh.write('{"allowFrom": ["876500"]}')
            r = self._run([CLAUDE_BOTH, BUN_TG, OTHER, OTHER_BUN], home)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(self.seen[0][1]["chat_id"], "876500")


class DefaultStatePathTest(unittest.TestCase):
    """The default state path must come from the INSTALL ROOT, not from $HOME.

    Why this class exists (upstream review, 2026-09-15): the old default was
    `~/marveen/store/...`, which assumes the checkout sits at a fixed path under
    the home directory. On an install rooted elsewhere the gate CREATED an orphan
    `~/marveen/store` -- os.makedirs is permissive -- and parked its state where
    nobody looks.

    It is a separate class because every other test in this file passes
    `--state`, so the DEFAULT path is otherwise never exercised: reverting the
    fix leaves the suite 16/16 green. Measured.
    """

    def _run(self, root, home):
        with tempfile.TemporaryDirectory() as d:
            ps = os.path.join(d, "ps.txt")
            tm = os.path.join(d, "tmux.txt")
            with open(ps, "w") as fh:
                fh.write("\n".join([HEADER, CLAUDE_BOTH, BUN_TG, BUN_DC]) + "\n")
            with open(tm, "w") as fh:
                fh.write(TMUX)
            env = dict(os.environ)
            env["CLAUDE_PROJECT_DIR"] = root
            env["HOME"] = home
            # No --state: this is the point of the class.
            return subprocess.run([sys.executable, GATE, "--ps-file", ps, "--tmux-file", tm],
                                  capture_output=True, text=True, env=env)

    def test_state_lands_under_the_install_root_not_under_home(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(root, "store"))
            r = self._run(root, home)
            self.assertIn(r.returncode, (0, 1), r.stdout + r.stderr)
            self.assertTrue(
                os.path.exists(os.path.join(root, "store", ".channel-process-gate-state.json")),
                "the state did not land under the install root: " + r.stdout + r.stderr)
            self.assertFalse(os.path.exists(os.path.join(home, "marveen")),
                             "the gate conjured an orphan ~/marveen")

    def test_missing_store_is_a_measurement_error_and_creates_nothing(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as home:
            r = self._run(root, home)  # no store/ under root
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertFalse(os.path.exists(os.path.join(root, "store")),
                             "the gate created store/ in a tree it does not own")
            self.assertFalse(os.path.exists(os.path.join(home, "marveen")),
                             "the gate conjured an orphan ~/marveen")


if __name__ == "__main__":
    unittest.main(verbosity=2)
