#!/usr/bin/env python3
"""Named-script approval and parser conformance. Run with python3; exit 0 = pass."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
CORPUS = json.loads((ROOT / 'src/__tests__/fixtures/agent-send-exception-cases.json').read_text())


def load_gate(path):
    spec = importlib.util.spec_from_file_location('script_exception_gate', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    with tempfile.TemporaryDirectory(prefix='script-approval-') as td:
        install = Path(td)
        # Match email-approval-gate.test.py: abspath preserves this tmp install.
        (install / 'scripts').symlink_to(ROOT / 'scripts', target_is_directory=True)
        store = install / 'store'
        store.mkdir()
        gate_path = install / 'scripts/hooks/email-approval-gate.py'
        gate = load_gate(gate_path)
        config = {'agents': {CORPUS['agentName']: CORPUS['entry']}}
        for case in CORPUS['cases']:
            actual = gate.agent_script_exception(case['command'], CORPUS['agentName'], config)
            assert bool(actual) == case['match'], case['name']
        print('PASS: shared JavaScript/Python parser corpus')

        # REPEATENVELOPE (card f2ccb0bb, round 2): the mjs argument parser
        # returns only the FIRST value of a repeatable flag, so an entry that
        # makes an envelope flag (--to/--cc/--subject/--body-file) repeatable
        # would let recipient verification and the envelope hash see only the
        # first recipient. Such an entry is invalid in ALL THREE validators
        # (mjs, py, TS) and drops exactly like any other shape-invalid entry.
        for flag in ('--to', '--cc', '--subject', '--body-file'):
            # The dangerous shape MOVES the envelope flag from valueArgs to
            # repeatableArgs (no duplicate): without the fix the entry
            # validates and the mjs parser then returns only the first value.
            for repeatable in ([flag], list(CORPUS['entry']['repeatableArgs']) + [flag]):
                bad = dict(CORPUS['entry'])
                bad['valueArgs'] = [f for f in bad['valueArgs'] if f != flag]
                bad['repeatableArgs'] = repeatable
                assert gate.valid_agent_send_exception(bad) is False, (flag, repeatable)
                (store / 'agent-send-exceptions.json').write_text(
                    json.dumps({'agents': {CORPUS['agentName']: bad, 'clean': CORPUS['entry']}}))
                kept = gate.read_agent_send_exceptions()
                assert kept == {'agents': {'clean': CORPUS['entry']}}, (flag, repeatable)
        clean = dict(CORPUS['entry'])
        clean['repeatableArgs'] = list(CORPUS['entry']['repeatableArgs'])
        assert gate.valid_agent_send_exception(clean) is True
        assert gate.valid_agent_send_exception({**clean, 'repeatableArgs': []}) is True
        (store / 'agent-send-exceptions.json').unlink()
        assert gate.read_agent_send_exceptions() == {}
        print('PASS: repeatable envelope flags invalidate the entry in the py validator')

        body = install / 'body.txt'
        attachment = install / 'attachment.bin'
        body.write_bytes('Example body.\r\nSecond line.\n'.encode())
        attachment.write_bytes(b'Example attachment\x00\xff')
        command = CORPUS['cases'][0]['command'].replace('/absolute/path/to/body.txt', str(body)).replace(
            '/absolute/path/to/attachment.bin', str(attachment))
        (store / 'agent-send-exceptions.json').write_text(json.dumps(config))
        autonomy = store / 'autonomy-config.json'
        def level(value):
            autonomy.write_text(json.dumps({'version': 1, 'categories': [{'key': 'email_send', 'level': value}]}))
        level(2)
        db = store / 'claudeclaw.db'
        con = sqlite3.connect(db)
        con.execute('''CREATE TABLE approvals (
            id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
            action_description TEXT NOT NULL, status TEXT NOT NULL,
            requested_at INTEGER, resolved_at INTEGER, resolved_by TEXT,
            content_hash TEXT, consumed_at INTEGER)''')
        con.commit()
        def run(cmd=command):
            result = subprocess.run([sys.executable, str(gate_path)], input=json.dumps({
                'tool_name': 'Bash', 'tool_input': {'command': cmd}, 'cwd': str(install),
            }), text=True, capture_output=True)
            assert result.returncode in (0, 2), result.stderr
            return result.returncode, result.stderr
        def approve(anchor, age=0):
            now = int(time.time())
            con.execute('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)', (
                str(time.time_ns()), CORPUS['agentName'], 'email_send', 'Example envelope', 'approved',
                now - 60, now - age, '<owner>', anchor))
            con.commit()
        # Independent canon, using the existing extractor's subject/body convention.
        env = gate._load_collect_email_envelope()('send_email', {
            'to': 'verified@example.invalid', 'cc': 'copy@example.invalid',
            'subject': 'Example subject', 'body': body.read_bytes().decode(),
        })
        env['attachments'] = [{'name': attachment.name, 'sha256': hashlib.sha256(attachment.read_bytes()).hexdigest(),
                               'size': len(attachment.read_bytes())}]
        anchor = gate.content_anchor(env)
        rc, error = run()
        assert rc == 2 and anchor in error, error
        approve(anchor)
        assert run()[0] == 0, 'matching one-shot approval'
        assert run()[0] == 2, 'one-shot consumption'
        approve(anchor)
        body.write_text('Changed body.\n')
        assert run()[0] == 2, 'different body'
        body.write_bytes('Example body.\r\nSecond line.\n'.encode())
        con.execute('DELETE FROM approvals')
        con.commit()
        approve(anchor, age=1801)
        assert run()[0] == 2, 'expired approval'
        assert run(command.replace(' send ', ' draft '))[0] == 0, 'draft'
        rc, error = run(command.replace(str(body), 'body.txt'))
        assert rc == 2 and 'sanctioned form' in error, error
        assert run(command.replace(str(attachment), 'attachment.bin'))[0] == 2, 'relative attachment'
        extra = command + ' --extra value'
        assert gate.agent_script_exception(extra, CORPUS['agentName'], config) is None
        # Unknown shapes retain the original Bash behavior, measured without config.
        with_config = run(extra)
        (store / 'agent-send-exceptions.json').unlink()
        without_config = run(extra)
        assert with_config == without_config, (with_config, without_config)
        (store / 'agent-send-exceptions.json').write_text(json.dumps(config))
        level(1)
        assert run()[0] == 2, 'level 1'
        level(3)
        assert run()[0] == 0, 'level 3'
        body.unlink()
        assert run()[0] == 2, 'unreadable body at every level'
        con.close()
        print('PASS: named-script approval, one-shot, content, window, modes, paths and levels')


if __name__ == '__main__':
    main()
