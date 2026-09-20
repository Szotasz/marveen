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
    """The alarm path, measured against a STUB notifier -- never the owner.

    CHANPROCGATE919 (2026-09-20): the send goes through scripts/notify.sh (the
    install's fallback Telegram path), pointed here at a stub script via
    CHANNEL_GATE_NOTIFY_CMD. The stub records every message it was handed and
    exits with STUB_RC, so both delivery outcomes are measurable. Sending is on
    TRANSITION against the `announced` set in the state file, and a failed send
    must NOT advance it.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.log = os.path.join(self.dir, "sent.log")
        self.stub = os.path.join(self.dir, "stub-notify.sh")
        with open(self.stub, "w") as fh:
            fh.write("#!/bin/bash\nprintf '%s\\n' \"$1\" >> \"$STUB_LOG\"\nexit \"${STUB_RC:-0}\"\n")
        os.chmod(self.stub, 0o755)
        self.state = os.path.join(self.dir, "state.json")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def sent(self):
        try:
            with open(self.log, encoding="utf-8") as fh:
                return [l for l in fh.read().splitlines() if l]
        except OSError:
            return []

    def state_of(self, key):
        import json as _json
        with open(self.state, encoding="utf-8") as fh:
            return _json.load(fh)[key]

    def _run(self, rows, notify=True, rc=0, extra_env=None):
        ps = os.path.join(self.dir, "ps.txt")
        tm = os.path.join(self.dir, "tmux.txt")
        with open(ps, "w") as fh:
            fh.write("\n".join([HEADER] + list(rows)) + "\n")
        with open(tm, "w") as fh:
            fh.write(TMUX)
        env = dict(os.environ)
        env["CHANNEL_GATE_NOTIFY_CMD"] = self.stub
        env["STUB_LOG"] = self.log
        env["STUB_RC"] = str(rc)
        env.update(extra_env or {})
        cmd = [sys.executable, GATE, "--ps-file", ps, "--tmux-file", tm, "--state", self.state]
        if notify:
            cmd.append("--notify")
        return subprocess.run(cmd, capture_output=True, text=True, env=env)

    def test_dead_worker_is_announced_once_through_the_notifier(self):
        r = self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(len(self.sent()), 1, self.sent())
        self.assertIn("HIANYZIK", self.sent()[0])
        self.assertIn("main-agent-channels", self.sent()[0])
        self.assertIn("telegram", self.sent()[0])
        self.assertIn("elkuldve", r.stderr)
        self.assertEqual(self.state_of("main-agent-channels")["announced"],
                         ["claude-plugins-official/telegram"])

    def test_same_state_next_run_is_not_announced_again(self):
        self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN])
        r = self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(len(self.sent()), 1, self.sent())
        self.assertNotIn("ERTESITES", r.stderr)

    def test_recovery_is_announced_and_clears_the_announced_set(self):
        self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN])
        r = self._run([CLAUDE_BOTH, BUN_TG, BUN_DC, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.sent()), 2, self.sent())
        self.assertIn("HELYREALLT", self.sent()[1])
        self.assertIn("main-agent-channels", self.sent()[1])
        self.assertEqual(self.state_of("main-agent-channels")["announced"], [])

    def test_green_from_the_start_sends_nothing(self):
        r = self._run([CLAUDE_BOTH, BUN_TG, BUN_DC, OTHER, OTHER_BUN])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.state_of("main-agent-channels")["announced"], [])

    def test_failed_send_is_exit_3_and_retried_next_run(self):
        # NOTIFYVAK826: a verdict the owner did not hear is not "sent". The
        # stub rejects, the gate says so with its own exit code, and the
        # announced set does not move -- so the next run sends again.
        r = self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN], rc=1)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("NEM ment ki", r.stderr)
        self.assertEqual(self.state_of("main-agent-channels")["announced"], [])
        r2 = self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN], rc=0)
        self.assertEqual(r2.returncode, 1, r2.stdout + r2.stderr)
        self.assertEqual(len(self.sent()), 2, self.sent())
        self.assertEqual(self.state_of("main-agent-channels")["announced"],
                         ["claude-plugins-official/telegram"])

    def test_without_notify_nothing_is_sent_and_announced_is_untouched(self):
        r = self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN], notify=False)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(self.sent(), [])
        st = self.state_of("main-agent-channels")
        self.assertEqual(st["missing"], ["claude-plugins-official/telegram"])
        self.assertEqual(st["announced"], [])
        # ...and the first --notify run afterwards still announces it.
        self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN])
        self.assertEqual(len(self.sent()), 1, self.sent())

    def test_message_is_html_safe(self):
        # notify.sh sends with parse_mode=HTML; a bare < in a session name
        # would be eaten as a tag or rejected by the Bot API. The tmux fixture
        # here names the broken session with angle brackets and an ampersand.
        ps = os.path.join(self.dir, "ps.txt")
        tm = os.path.join(self.dir, "tmux.txt")
        with open(ps, "w") as fh:
            fh.write("\n".join([HEADER, CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN]) + "\n")
        with open(tm, "w") as fh:
            fh.write(TMUX.replace("main-agent-channels", "main-<a&b>-channels"))
        env = dict(os.environ, CHANNEL_GATE_NOTIFY_CMD=self.stub, STUB_LOG=self.log, STUB_RC="0")
        r = subprocess.run([sys.executable, GATE, "--ps-file", ps, "--tmux-file", tm,
                            "--state", self.state, "--notify"], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(len(self.sent()), 1, self.sent())
        self.assertIn("main-&lt;a&amp;b&gt;-channels", self.sent()[0])
        self.assertNotIn("<a&b>", self.sent()[0])
        self.assertNotIn("**", self.sent()[0])

    def test_default_notifier_is_notify_sh_under_the_install_root(self):
        # No CHANNEL_GATE_NOTIFY_CMD: the gate must call <root>/scripts/notify.sh,
        # the install's own fallback path -- not a fixed path, not $HOME.
        root = os.path.join(self.dir, "root")
        os.makedirs(os.path.join(root, "store"))
        os.makedirs(os.path.join(root, "scripts"))
        with open(os.path.join(root, "scripts", "notify.sh"), "w") as fh:
            fh.write("#!/bin/bash\nprintf 'ROOT-NOTIFY %s\\n' \"$1\" >> \"$STUB_LOG\"\nexit 0\n")
        os.chmod(os.path.join(root, "scripts", "notify.sh"), 0o755)
        ps = os.path.join(self.dir, "ps.txt")
        tm = os.path.join(self.dir, "tmux.txt")
        with open(ps, "w") as fh:
            fh.write("\n".join([HEADER, CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN]) + "\n")
        with open(tm, "w") as fh:
            fh.write(TMUX)
        env = dict(os.environ)
        env.pop("CHANNEL_GATE_NOTIFY_CMD", None)
        env["CLAUDE_PROJECT_DIR"] = root
        env["STUB_LOG"] = self.log
        r = subprocess.run([sys.executable, GATE, "--ps-file", ps, "--tmux-file", tm, "--notify"],
                           capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(len(self.sent()), 1, self.sent())
        self.assertTrue(self.sent()[0].startswith("ROOT-NOTIFY "), self.sent()[0])

    def test_missing_notifier_is_a_failed_send_not_a_crash(self):
        r = self._run([CLAUDE_BOTH, BUN_DC, OTHER, OTHER_BUN],
                      extra_env={"CHANNEL_GATE_NOTIFY_CMD": os.path.join(self.dir, "no-such.sh")})
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("kuldes BUKOTT", r.stderr)
        self.assertEqual(self.state_of("main-agent-channels")["announced"], [])


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
