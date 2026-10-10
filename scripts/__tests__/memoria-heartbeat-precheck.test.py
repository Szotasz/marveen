#!/usr/bin/env python3
"""Tests for the memoria-heartbeat preCheck (PRECHECKSZURO1004).

Each test builds a throwaway state file, transcript folder, log and mode file,
runs the REAL wrapper (`bash memoria-heartbeat-precheck.sh`, as runPreCheck
does) with the paths pointed at them, and reads stdout, the exit code and the
log line. Nothing touches the live store or the main agent's transcripts.
"""
import json
import os
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
WRAPPER = os.path.join(os.path.dirname(HERE), 'prechecks', 'memoria-heartbeat-precheck.sh')


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.state = os.path.join(d, 'state.json')
        self.tdir = os.path.join(d, 'transcripts')
        os.makedirs(self.tdir)
        self.logp = os.path.join(d, 'log', 'precheck.jsonl')
        self.mode = os.path.join(d, 'mode')
        self.now = time.time()
        self.last = int(self.now - 900)
        self.write_state(self.last)
        self.rows = []

    def tearDown(self):
        self.tmp.cleanup()

    def write_state(self, last):
        with open(self.state, 'w') as fh:
            json.dump({'last_run_at': last, 'outcome': 'quiet'}, fh)

    def set_mode(self, mode):
        with open(self.mode, 'w') as fh:
            fh.write(mode + '\n')

    def add(self, row):
        self.rows.append(row)

    def tool(self, at, command='ls'):
        self.add({'type': 'assistant', 'timestamp': iso(at), 'message': {
            'content': [{'type': 'tool_use', 'name': 'Bash', 'input': {'command': command}}]}})

    def user(self, at, text, meta=False):
        row = {'type': 'user', 'timestamp': iso(at), 'message': {'content': text}}
        if meta:
            row['isMeta'] = True
        self.add(row)

    def run_check(self, env_extra=None):
        with open(os.path.join(self.tdir, 'main.jsonl'), 'w') as fh:
            for r in self.rows:
                fh.write(json.dumps(r) + '\n')
        env = dict(os.environ, MHP_STATE_PATH=self.state, MHP_TRANSCRIPT_DIR=self.tdir,
                   MHP_LOG_PATH=self.logp, MHP_MODE_PATH=self.mode)
        if env_extra:
            env.update(env_extra)
        r = subprocess.run(['/bin/bash', WRAPPER], env=env, capture_output=True, text=True, timeout=10)
        log = None
        if os.path.exists(self.logp):
            with open(self.logp) as fh:
                log = json.loads(fh.read().splitlines()[-1])
        return r.returncode, r.stdout.strip(), log

class DecisionTest(Base):
    # --- the decision ---------------------------------------------------

    def test_empty_window_live_skips(self):
        self.set_mode('live')
        self.tool(self.last - 60)  # before the stamp: not this window
        code, out, log = self.run_check()
        self.assertEqual((code, out), (0, 'SKIP'))
        self.assertEqual(log['reason'], 'empty-window')
        self.assertTrue(log['skipped'])

    def test_shadow_never_skips_but_logs_would_skip(self):
        self.set_mode('shadow')
        code, out, log = self.run_check()
        self.assertEqual((code, out), (0, ''))
        self.assertTrue(log['would_skip'])
        self.assertFalse(log['skipped'])
        self.assertEqual(log['mode'], 'shadow')

    def test_no_mode_file_is_the_shipped_default_live(self):
        code, out, log = self.run_check()
        self.assertEqual((code, out), (0, 'SKIP'))
        self.assertTrue(log['skipped'])
        self.assertEqual(log['mode'], 'live')

    def test_a_tool_call_after_the_stamp_runs_the_round(self):
        self.set_mode('live')
        self.tool(self.last + 30)
        code, out, log = self.run_check()
        self.assertEqual(out, '')
        self.assertEqual(log['tool_uses'], 1)
        self.assertFalse(log['would_skip'])

    def test_an_inbox_nudge_runs_the_round(self):
        self.set_mode('live')
        self.user(self.last + 30, '[Inbox] Ha fent uj bejovo blokk van...')
        code, out, log = self.run_check()
        self.assertEqual(out, '')
        self.assertEqual(log['inbox'], 1)

    def test_a_channel_message_runs_the_round(self):
        self.set_mode('live')
        self.user(self.last + 30, '<channel source="plugin:telegram:telegram" chat_id="1">szia</channel>')
        code, out, _ = self.run_check()
        self.assertEqual(out, '')

    def test_a_direct_prompt_runs_the_round(self):
        self.set_mode('live')
        self.user(self.last + 30, 'nezd meg a kartyat')
        code, out, log = self.run_check()
        self.assertEqual(out, '')
        self.assertEqual(log['prompts'], 1)

    def test_the_stamp_itself_scheduled_notices_and_meta_rows_are_not_activity(self):
        self.set_mode('live')
        self.tool(self.last + 1, "python3 -c \"json.dump({'last_run_at': 1, 'outcome': 'quiet'}, "
                                 "open('/x/store/memoria-heartbeat-state.json','w'))\"")
        self.user(self.last + 30, 'SCHEDULED TASK NOTICE -- the next <scheduled-task ...')
        self.user(self.last + 31, '<system-reminder>x</system-reminder>', meta=True)
        code, out, log = self.run_check()
        self.assertEqual(out, 'SKIP')
        self.assertEqual(log['tool_uses'], 0)

    def test_max_silence_runs_the_round_even_with_an_empty_window(self):
        self.set_mode('live')
        self.write_state(int(self.now - 5 * 3600))
        code, out, log = self.run_check()
        self.assertEqual(out, '')
        self.assertEqual(log['reason'], 'max-silence')

    def test_a_stamp_in_the_future_runs_the_round(self):
        # The window [last, now] is empty by construction and the max-silence net
        # cannot fire on a negative silence, so without the guard this SKIPs forever.
        self.set_mode('live')
        self.write_state(int(self.now + 86400))
        self.tool(self.now - 60)
        code, out, log = self.run_check()
        self.assertEqual((code, out), (0, ''))
        self.assertEqual(log['reason'], 'future-stamp')
        self.assertFalse(log['would_skip'])
        self.assertLess(log['silence_s'], 0)

    def test_a_millisecond_stamp_runs_the_round(self):
        self.set_mode('live')
        self.write_state(int(self.now * 1000))
        code, out, log = self.run_check()
        self.assertEqual((code, out), (0, ''))
        self.assertEqual(log['reason'], 'future-stamp')

    def test_a_stamp_within_the_clock_skew_tolerance_is_judged_normally(self):
        self.set_mode('live')
        self.write_state(int(self.now + 60))
        code, out, log = self.run_check()
        self.assertEqual((code, out), (0, 'SKIP'))
        self.assertEqual(log['reason'], 'empty-window')

    # --- failing open ---------------------------------------------------

    def test_missing_state_fails_open(self):
        self.set_mode('live')
        os.remove(self.state)
        code, out, log = self.run_check()
        self.assertEqual((code, out), (0, ''))
        self.assertIn('error', log)

    def test_corrupt_state_fails_open(self):
        self.set_mode('live')
        with open(self.state, 'w') as fh:
            fh.write('{not json')
        code, out, _ = self.run_check()
        self.assertEqual((code, out), (0, ''))

    def test_unknown_mode_is_shadow(self):
        self.set_mode('turbo')
        code, out, log = self.run_check()
        self.assertEqual(out, '')
        self.assertEqual(log['mode'], 'shadow')

    def test_python_that_cannot_start_still_exits_zero_with_no_output(self):
        code, out, _ = self.run_check({'PATH': '/nonexistent'})
        self.assertEqual((code, out), (0, ''))


class ResolutionTest(Base):
    """The install-agnostic path resolution: no override of the transcript
    folder, a fake HOME and a fake install root with a dot in its path."""

    def setUp(self):
        super().setUp()
        d = self.tmp.name
        self.home = os.path.join(d, 'home')
        self.root = os.path.join(d, 'inst.all', 'install-root')
        os.makedirs(os.path.join(self.root, 'store'))
        self.enc = self.root.replace('/', '-').replace('.', '-').replace('_', '-')

    def place(self, config_root, rows):
        pdir = os.path.join(config_root, 'projects', self.enc)
        os.makedirs(pdir, exist_ok=True)
        with open(os.path.join(pdir, 's.jsonl'), 'w') as fh:
            for r in rows:
                fh.write(json.dumps(r) + '\n')

    def run_resolved(self, extra=None):
        env = dict(os.environ, HOME=self.home, MHP_ROOT=self.root, MHP_STATE_PATH=self.state,
                   MHP_LOG_PATH=self.logp, MHP_MODE_PATH=self.mode)
        env.pop('MHP_TRANSCRIPT_DIR', None)
        env.pop('MAIN_AGENT_CONFIG_DIR', None)
        if extra:
            env.update(extra)
        r = subprocess.run(['/bin/bash', WRAPPER], env=env, capture_output=True, text=True, timeout=10)
        with open(self.logp) as fh:
            log = json.loads(fh.read().splitlines()[-1])
        return r.stdout.strip(), log

    def activity(self):
        return [{'type': 'assistant', 'timestamp': iso(self.last + 30), 'message': {
            'content': [{'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'ls'}}]}}]

    def test_the_folder_name_turns_every_non_alnum_into_a_dash(self):
        self.set_mode('live')
        self.place(os.path.join(self.root, '.channels-config'), self.activity())
        out, log = self.run_resolved()
        self.assertEqual(out, '')
        self.assertEqual(log['tool_uses'], 1)

    def test_activity_in_any_candidate_root_counts(self):
        self.set_mode('live')
        self.place(os.path.join(self.home, '.claude'), [])  # empty main candidate
        self.place(os.path.join(self.root, '.channels-config'), self.activity())
        out, log = self.run_resolved()
        self.assertEqual(out, '')
        self.assertEqual(log['tool_uses'], 1)
        self.assertEqual(log['files'], 2)

    def test_main_agent_config_dir_from_the_env_file_is_a_candidate(self):
        self.set_mode('live')
        own = os.path.join(self.tmp.name, 'botlogin')
        with open(os.path.join(self.root, '.env'), 'w') as fh:
            fh.write(f'OTHER=1\nMAIN_AGENT_CONFIG_DIR={own}\n')
        self.place(own, self.activity())
        out, log = self.run_resolved()
        self.assertEqual(out, '')
        self.assertEqual(log['tool_uses'], 1)

    def test_an_empty_window_in_the_resolved_folder_skips_in_live(self):
        self.set_mode('live')
        self.place(os.path.join(self.home, '.claude'), [])
        out, log = self.run_resolved()
        self.assertEqual(out, 'SKIP')

    def test_a_symlinked_projects_folder_is_read_once(self):
        self.set_mode('live')
        self.place(os.path.join(self.home, '.claude'), self.activity())
        os.makedirs(os.path.join(self.root, '.channels-config'))
        os.symlink(os.path.join(self.home, '.claude', 'projects'),
                   os.path.join(self.root, '.channels-config', 'projects'))
        out, log = self.run_resolved()
        self.assertEqual(log['files'], 1)
        self.assertEqual(log['tool_uses'], 1)

    def test_no_transcript_folder_anywhere_runs_the_round(self):
        self.set_mode('live')
        out, log = self.run_resolved()
        self.assertEqual(out, '')
        self.assertIn('error', log)


if __name__ == '__main__':
    unittest.main()
