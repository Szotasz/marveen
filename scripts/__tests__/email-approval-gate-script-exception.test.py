#!/usr/bin/env python3
"""Named-script approval and parser conformance. Run with python3; exit 0 = pass."""
import errno
import hashlib
import importlib.util
import json
import os
from unittest.mock import patch
from pathlib import Path
import shutil
import re
import sqlite3
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
CORPUS = json.loads((ROOT / 'src/__tests__/fixtures/agent-send-exception-cases.json').read_text())
LOADER_CORPUS = json.loads((ROOT / 'src/__tests__/fixtures/agent-send-exception-loader-cases.json').read_text())
# The send exception is disabled on macOS; positive cases are bound to the platform.
SEND_EXCEPTION_PLATFORM = sys.platform != 'darwin'


def load_gate(path):
    spec = importlib.util.spec_from_file_location('script_exception_gate', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.script_path_writable = lambda path: False
    module.probe_node_version = lambda interp: "v22.22.2"
    return module


def main():
    with tempfile.TemporaryDirectory(prefix='script-approval-') as td:
        install = Path(os.path.realpath(td))
        # Match email-approval-gate.test.py: abspath preserves this tmp install.
        (install / 'scripts').symlink_to(ROOT / 'scripts', target_is_directory=True)
        store = install / 'store'
        store.mkdir()
        gate_path = install / 'scripts/hooks/email-approval-gate.py'
        gate = load_gate(gate_path)
        # Test-only subprocess wrapper; production has no bypass switch.
        wrapper = install / 'run-gate.py'
        wrapper.write_text(
            "import importlib.util\n"
            f"spec = importlib.util.spec_from_file_location('gate', {str(gate_path)!r})\n"
            "gate = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(gate)\n"
            "gate.script_path_writable = lambda path: False\n"
            "gate.probe_node_version = lambda interp: 'v22.22.2'\n"
            "gate.main()\n")
        for case in LOADER_CORPUS['cases']:
            assert gate.script_source_loads_only_builtins(case['source'].encode('utf-8')) == case['allowed'], case['name']
        assert gate.script_source_loads_only_builtins(b'\xff\xfe') is False
        print('PASS: shared loader corpus and strict UTF-8')
        # SCRIPTBIND (card f2ccb0bb, round 3): the grant binds the script CONTENT.
        # The corpus entry carries the SHAPE only (a placeholder path and sha256);
        # it is bound here to a real temp script, the expected sha256 computed from
        # the exact bytes written at setup -- never a hardcoded digest.
        script = install / 'runner.ext'
        script_body = b'#!/usr/bin/env node\nconsole.log("sanctioned runner")\n'
        script.write_bytes(script_body)
        script_sha = hashlib.sha256(script_body).hexdigest()
        entry = json.loads(json.dumps(CORPUS['entry']))
        entry['readFiles'] = ['/absolute/path/to/extra.json']
        entry['scripts'] = [{'path': str(script), 'sha256': script_sha}]
        config = {'agents': {CORPUS['agentName']: entry}}
        bind = lambda cmd: cmd.replace('/absolute/path/to/runner.ext', str(script))  # noqa: E731
        assert gate.valid_agent_send_exception({k: v for k, v in entry.items() if k != 'readFiles'})
        for reads in ([], ['/a', '/b']):
            assert gate.valid_agent_send_exception(dict(entry, readFiles=reads))
        for reads in (['relative'], ['/a', '/a'], [1], '/a', [''], '/'):
            assert not gate.valid_agent_send_exception(dict(entry, readFiles=reads)), reads
        print('PASS: readFiles schema')

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
                bad = dict(entry)
                bad['valueArgs'] = [f for f in bad['valueArgs'] if f != flag]
                bad['repeatableArgs'] = repeatable
                assert gate.valid_agent_send_exception(bad) is False, (flag, repeatable)
                (store / 'agent-send-exceptions.json').write_text(
                    json.dumps({'agents': {CORPUS['agentName']: bad, 'clean': entry}}))
                kept = gate.read_agent_send_exceptions()
                assert kept == {'agents': {'clean': entry}}, (flag, repeatable)
        # C1 (PR #2843 review): recipient channels outside --to and --cc are reserved.
        for flag in ('--bcc', '--reply-to', '--from', '--sender', '--return-path'):
            for key in ('valueArgs', 'repeatableArgs', 'booleanArgs'):
                bad = {**entry, key: entry[key] + [flag]}
                assert gate.valid_agent_send_exception(bad) is False, (flag, key)
                (store / 'agent-send-exceptions.json').write_text(
                    json.dumps({'agents': {CORPUS['agentName']: bad, 'clean': entry}}))
                kept = gate.read_agent_send_exceptions()
                assert kept == {'agents': {'clean': entry}}, (flag, key)
        print('PASS: gate-reserved recipient flags invalidate the entry in all three flag lists')
        clean = dict(entry)
        clean['repeatableArgs'] = list(entry['repeatableArgs'])
        assert gate.valid_agent_send_exception(clean) is True
        assert gate.valid_agent_send_exception({**clean, 'repeatableArgs': []}) is True
        (store / 'agent-send-exceptions.json').unlink()
        assert gate.read_agent_send_exceptions() == {}
        print('PASS: repeatable envelope flags invalidate the entry in the py validator')

        # B1 (card f2ccb0bb R4): an entry whose other four keys are valid but which
        # has NO "scripts" key raised KeyError in the py validator, and
        # read_agent_send_exceptions catches only (OSError, ValueError) -- so the
        # hook crashed on every gated command while such an entry sat in the store.
        # The mjs twin and the TS reader return false/null for the same shape; the
        # fixed py validator must return False, and the invalid sibling must
        # neither revoke the valid entry next to it nor crash the reader.
        no_scripts = {k: v for k, v in entry.items() if k != 'scripts'}
        assert gate.valid_agent_send_exception(no_scripts) is False
        (store / 'agent-send-exceptions.json').write_text(
            json.dumps({'agents': {'a': no_scripts, 'b': entry}}))
        assert gate.read_agent_send_exceptions() == {'agents': {'b': entry}}
        print('PASS: a missing scripts key invalidates only that entry, without a KeyError')
        (store / 'agent-send-exceptions.json').unlink()

        if not SEND_EXCEPTION_PLATFORM:
            darwin_gate_spec = importlib.util.spec_from_file_location('darwin_gate', gate_path)
            darwin_gate = importlib.util.module_from_spec(darwin_gate_spec)
            darwin_gate_spec.loader.exec_module(darwin_gate)
            for case in CORPUS['cases']:
                if case['match']:
                    assert darwin_gate.agent_script_exception(case['command'], CORPUS['agentName'],
                                                              {'agents': {CORPUS['agentName']: CORPUS['entry']}}) is None, case['name']
            print('SKIP: positive send-exception cases need a non-darwin platform; every positive case is refused here')
            return
        # A separate, unpatched module exercises actual filesystem permissions.
        spec = importlib.util.spec_from_file_location('real_gate', gate_path)
        real_gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(real_gate)
        probe_file = install / 'probe-file'
        probe_file.write_bytes(b'probe')
        assert real_gate.script_path_writable(str(probe_file)) is True
        assert real_gate.script_path_writable('/') == os.access('/', os.W_OK)
        if os.getuid() == 0:
            print('SKIP: unwritable system path check runs as root')
        else:
            assert real_gate.script_path_writable(os.path.realpath('/usr/bin/env')) is False
        with patch.object(real_gate, '_access_w_errno', side_effect=OSError('unknown state')):
            assert real_gate.script_path_writable(str(probe_file)) is True
        # Only one ancestor writable also fails, even when the file itself is not.
        with patch.object(real_gate, '_access_w_errno', side_effect=lambda path: 0 if path == str(install) else errno.EACCES):
            assert real_gate.script_path_writable(str(probe_file)) is True
        print('PASS: real path writability and fail-closed probe')
        target_parent = install / 'target-parent'
        target = target_parent / 'real'
        target.mkdir(parents=True)
        (target / 'runner.ext').write_bytes(b'probe')
        link_dir = install / 'link-dir'
        link_dir.mkdir()
        (link_dir / 'via').symlink_to(target, target_is_directory=True)
        via_path = str(link_dir / 'via' / 'runner.ext')
        with patch.object(real_gate, '_access_w_errno', side_effect=lambda path: errno.EACCES):
            assert real_gate.script_path_writable(str(target / 'runner.ext')) is False
            assert real_gate.script_path_writable(via_path) is True
            assert real_gate.script_path_writable(str(install / 'missing-dir' / 'x.ext')) is True
        print('PASS: symlinked path refused, real path accepted, unresolvable path fails closed')
        for code, expected in [(errno.EACCES, False), (errno.EPERM, False), (errno.EROFS, False),
                               (errno.ENOENT, True), (errno.EIO, True), (errno.ELOOP, True)]:
            with patch.object(real_gate, '_access_w_errno', side_effect=lambda path: code):
                assert real_gate.script_path_writable(str(target / 'runner.ext')) is expected
        with patch.object(real_gate, '_access_w_errno', side_effect=lambda path: errno.EACCES):
            with patch.object(real_gate.os, 'geteuid', return_value=1000):
                assert real_gate.script_path_writable(str(target / 'runner.ext')) is False
            with patch.object(real_gate.os, 'geteuid', return_value=0):
                assert real_gate.script_path_writable(str(target / 'runner.ext')) is True
        print('PASS: errno parity with the JS gate (EACCES/EPERM/EROFS unwritable, other errors fail closed); root never grants')
        for version, expected in [
                ('v22.13.0', True), ('v22.12.9', False), ('v23.5.0', True), ('v23.4.0', False),
                ('v24.0.0', True), ('v21.9.9', False), ('v20.18.0', False), ('22.13.0', False),
                ('v22.13', False), ('', False), ('v22.13.0\nextra', False)]:
            assert real_gate.node_permission_version_ok(version) is expected, version
        resolved_node = real_gate.resolve_node_interpreter('node')
        if not resolved_node:
            print('SKIP: no node on PATH for real version probe')
        elif real_gate.script_path_writable(resolved_node):
            assert real_gate.probe_node_version('node') is None
        else:
            assert re.fullmatch(r'v\d+\.\d+\.\d+', real_gate.probe_node_version('node'))
        probe_dir = Path(os.path.realpath(tempfile.mkdtemp(prefix='script-node-path-')))
        try:
            (probe_dir / 'bin').mkdir()
            (probe_dir / 'real/bin').mkdir(parents=True)
            (probe_dir / 'real/sub').mkdir()
            for relative, version in (('bin/node', 'v22.22.2'), ('real/bin/node', 'v20.0.0')):
                executable = probe_dir / relative
                executable.write_text(f"#!/bin/sh\ntouch '{probe_dir}/ran'\necho {version}\n")
                executable.chmod(0o755)
            (probe_dir / 'link').symlink_to(probe_dir / 'real/sub', target_is_directory=True)
            for path, resolved in (
                    (f'{probe_dir}/bin', f'{probe_dir}/bin/node'),
                    (f'{probe_dir}/link/../bin', f'{probe_dir}/link/../bin/node'),
                    (f'relative-dir:{probe_dir}/bin', None),
                    (f':{probe_dir}/bin', None),
                    (f'{probe_dir}/nonexistent:{probe_dir}/bin', f'{probe_dir}/bin/node')):
                with patch.dict(os.environ, {'PATH': path}):
                    assert real_gate.resolve_node_interpreter('node') == resolved, path
                    assert real_gate.probe_node_version('node') is None, path
            assert real_gate.probe_node_version(f'{probe_dir}/bin/node') is None
            # A planted node first on PATH: the REAL writability check runs for paths under probe_dir, and every other
            # path (the granted temp script) counts as unwritable, so a refusal can only come from the interpreter.
            real_writable = real_gate.script_path_writable
            planted_only = lambda p: real_writable(p) if str(p).startswith(str(probe_dir) + '/') else False  # noqa: E731
            planted_cmd = bind(CORPUS['cases'][0]['command'])
            with patch.dict(os.environ, {'PATH': f"{probe_dir}/bin:{os.environ.get('PATH', '/usr/bin:/bin')}"}), \
                    patch.object(real_gate, 'script_path_writable', side_effect=planted_only):
                assert real_gate.resolve_node_interpreter('node') == f'{probe_dir}/bin/node'
                assert real_writable(f'{probe_dir}/bin/node') is True
                assert real_gate.agent_script_exception(planted_cmd, CORPUS['agentName'], config) is None
                # Positive control: with a trusted runtime the same command still gets the exception.
                with patch.object(real_gate, 'probe_node_version', return_value='v22.22.2'):
                    assert real_gate.agent_script_exception(planted_cmd, CORPUS['agentName'], config)
            assert not (probe_dir / 'ran').exists()
        finally:
            shutil.rmtree(probe_dir)
        print('PASS: version probe follows shell PATH resolution, rejects relative or empty entries, and never runs an untrusted interpreter')
        positive = bind(CORPUS['cases'][0]['command'])
        with patch.object(real_gate, 'script_path_writable', return_value=False):
            for check_paths in (True, False):
                with patch.object(real_gate, 'probe_node_version', return_value='v22.22.2'):
                    assert real_gate.agent_script_exception(positive, CORPUS['agentName'], config, check_paths=check_paths)
                for version in ('v22.12.0', None):
                    with patch.object(real_gate, 'probe_node_version', return_value=version):
                        assert real_gate.agent_script_exception(positive, CORPUS['agentName'], config, check_paths=check_paths) is None
            with patch.object(real_gate.sys, 'platform', 'darwin'), patch.object(real_gate, 'probe_node_version', return_value='v22.22.2'):
                assert real_gate.agent_script_exception(positive, CORPUS['agentName'], config) is None
            with patch.object(real_gate, 'probe_node_version', return_value='v22.22.2') as probe:
                assert real_gate.agent_script_exception(positive + ' --unknown x', CORPUS['agentName'], config) is None
                probe.assert_not_called()
        print('PASS: runtime versions, macOS refusal and last probe')
        for case in CORPUS['cases']:
            actual = gate.agent_script_exception(bind(case['command']), CORPUS['agentName'], config)
            assert bool(actual) == case['match'], case['name']
        print('PASS: shared JavaScript/Python parser corpus')

        # SCRIPTBIND red cases: the path alone is not the grant. After the script
        # path matches, the matcher reads the file's raw bytes and compares the
        # sha256 to the granted value on EVERY invocation (also on the
        # check_paths=False pass); missing or unreadable file, or a hash mismatch,
        # means the invocation does not qualify (fail-closed: None).
        wrong_sha = dict(entry, scripts=[{'path': str(script), 'sha256': 'f' * 64}])
        gone = install / 'gone.ext'
        missing = dict(entry, scripts=[{'path': str(gone), 'sha256': script_sha}])
        as_dir = install / 'as-a-directory'
        as_dir.mkdir()
        unreadable = dict(entry, scripts=[{'path': str(as_dir), 'sha256': script_sha}])
        for bad, path, name in ((wrong_sha, script, 'wrong granted sha256'),
                                (missing, gone, 'missing script file'),
                                (unreadable, as_dir, 'unreadable script file')):
            bad_config = {'agents': {CORPUS['agentName']: bad}}
            cmd = bind(CORPUS['cases'][0]['command']).replace(str(script), str(path))
            assert gate.valid_agent_send_exception(bad) is True, name  # the entry itself is well-formed
            assert gate.agent_script_exception(cmd, CORPUS['agentName'], bad_config) is None, name
            assert gate.agent_script_exception(cmd, CORPUS['agentName'], bad_config, check_paths=False) is None, name
        script.write_bytes(b'#!/usr/bin/env node\nconsole.log("tampered runner")\n')
        cmd = bind(CORPUS['cases'][0]['command'])
        assert gate.agent_script_exception(cmd, CORPUS['agentName'], config) is None, 'content changed after the grant'
        assert gate.agent_script_exception(cmd, CORPUS['agentName'], config, check_paths=False) is None
        script.write_bytes(script_body)
        assert gate.agent_script_exception(cmd, CORPUS['agentName'], config) is not None, 'restored content'
        # NUL byte in the granted path (card f2ccb0bb R4): open() raises ValueError
        # for it, not OSError, so an `except OSError` alone let the hook crash
        # instead of failing closed; the check must return False like any
        # unreadable file.
        assert gate._script_content_matches('/x\x00y', '0' * 64) is False
        for bad_scripts in ([], ['runner.ext'], [{'path': str(script)}],
                            [{'path': 'runner.ext', 'sha256': script_sha}],
                            [{'path': str(script), 'sha256': '0A' * 32}],  # uppercase hex
                            [{'path': str(script), 'sha256': 'abcd'}],
                            [{'path': str(script), 'sha256': script_sha, 'extra': 1}],
                            [{'path': str(script), 'sha256': script_sha},
                             {'path': str(script), 'sha256': '0' * 64}]):
            assert gate.valid_agent_send_exception({**entry, 'scripts': bad_scripts}) is False, bad_scripts
        assert gate.valid_agent_send_exception(entry) is True
        unsafe_source = b"require('./lib.js');"
        script.write_bytes(unsafe_source)
        unsafe_entry = dict(entry, scripts=[{'path': str(script), 'sha256': hashlib.sha256(unsafe_source).hexdigest()}])
        for check_paths in (True, False):
            assert gate.agent_script_exception(cmd, CORPUS['agentName'], {'agents': {CORPUS['agentName']: unsafe_entry}},
                                               check_paths=check_paths) is None
        script.write_bytes(script_body)
        with patch.object(gate, 'script_path_writable', return_value=True):
            for check_paths in (True, False):
                assert gate.agent_script_exception(cmd, CORPUS['agentName'], config, check_paths=check_paths) is None
        for key in ('valueArgs', 'repeatableArgs', 'booleanArgs'):
            assert gate.valid_agent_send_exception({**entry, key: entry[key] + ['--envelope-sha256']}) is False
        parsed = gate.agent_script_exception(cmd, CORPUS['agentName'], config)
        assert parsed['envelopeSha256'] == 'a' * 64
        draft = bind(next(c['command'] for c in CORPUS['cases'] if c['name'] == 'draft'))
        assert 'envelopeSha256' not in gate.agent_script_exception(draft, CORPUS['agentName'], config)
        print('PASS: script content binding (sha256 verified per invocation, fail-closed)')

        read_dir = Path(os.path.realpath(tempfile.mkdtemp(prefix='script-read-grants-')))
        try:
            read_body = read_dir / 'body.txt'
            read_attachment = read_dir / 'attachment.bin'
            read_extra = read_dir / 'extra.json'
            read_body.write_bytes(b'Example body')
            read_attachment.write_bytes(b'Example attachment')
            read_extra.write_bytes(b'{}')
            directory_link = read_dir / 'directory-link'
            file_link = read_dir / 'file-link'
            directory_link.symlink_to(read_dir, target_is_directory=True)
            file_link.symlink_to(read_body)
            (read_dir / 'sub' / 'sub2').mkdir(parents=True)
            (read_dir / 'sub' / 'body.txt').write_bytes(b'Subdirectory body')
            (read_dir / 'sublink').symlink_to(read_dir / 'sub' / 'sub2', target_is_directory=True)
            draft_case = next(c['command'] for c in CORPUS['cases'] if c['name'] == 'draft')
            def bound_draft(body_path=read_body, attachment_path=read_attachment):
                return bind(draft_case).replace('/absolute/path/to/body.txt', str(body_path)).replace(
                    '/absolute/path/to/attachment.bin', str(attachment_path))
            agent = CORPUS['agentName']
            assert gate.agent_script_exception(bound_draft(), agent, config) is not None
            assert gate.agent_script_exception(bound_draft(read_dir), agent, config) is None
            assert gate.agent_script_exception(bound_draft(read_dir), agent, config, check_paths=False) is not None
            assert gate.agent_script_exception(bound_draft('/'), agent, config) is None
            assert gate.agent_script_exception(bound_draft(read_body, directory_link), agent, config) is None
            assert gate.agent_script_exception(bound_draft(file_link), agent, config) is None
            assert gate.agent_script_exception(bound_draft(str(read_dir) + '/missing-parent/..'), agent, config) is None
            assert gate.agent_script_exception(bound_draft(str(read_dir) + '/./body.txt'), agent, config) is None
            assert gate.agent_script_exception(bound_draft(str(read_dir) + '//body.txt'), agent, config) is None
            assert gate.agent_script_exception(bound_draft(str(read_body) + '/'), agent, config) is None
            assert gate.agent_script_exception(bound_draft(str(read_dir) + '/sublink/../body.txt'), agent, config) is None
            assert gate.agent_script_exception(bound_draft(read_dir / 'missing.txt'), agent, config) is not None
            for read_file, accepted in ((read_dir, False), (read_extra, True)):
                read_config = {'agents': {agent: dict(entry, readFiles=[str(read_file)])}}
                cmd = bound_draft().replace(' --permission ', f' --permission --allow-fs-read={read_file} ')
                assert bool(gate.agent_script_exception(cmd, agent, read_config)) is accepted
        finally:
            shutil.rmtree(read_dir)
        print('PASS: read grants accept canonical regular or missing files and reject directories, symlinks and non-canonical paths')

        body = install / 'body.txt'
        attachment = install / 'attachment.bin'
        body.write_bytes('Example body.\r\nSecond line.\n'.encode())
        attachment.write_bytes(b'Example attachment\x00\xff')
        command = bind(CORPUS['cases'][0]['command']).replace('/absolute/path/to/body.txt', str(body)).replace(
            '/absolute/path/to/attachment.bin', str(attachment))
        # Independent script envelope v1 canon: command values, raw file bytes, CLI attachment order.
        digest_text = ("marveen-script-envelope-v1\n"
                       "to=verified@example.invalid\ncc=copy@example.invalid\nsubject=Example subject\n"
                       f"body={hashlib.sha256(body.read_bytes()).hexdigest()}\n"
                       f"attach={hashlib.sha256(attachment.read_bytes()).hexdigest()}\n")
        envelope_digest = hashlib.sha256(digest_text.encode('utf-8')).hexdigest()
        command = command.replace('a' * 64, envelope_digest)
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
            result = subprocess.run([sys.executable, str(wrapper)], input=json.dumps({
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
        rc, error = run(command.replace(envelope_digest, '0' * 64))
        assert rc == 2 and '--envelope-sha256 does not match' in error, error
        assert run()[0] == 0, 'matching one-shot approval'
        assert run()[0] == 2, 'one-shot consumption'
        approve(anchor)
        body.write_text('Changed body.\n')
        # Pins the envelope-digest deny, which now fires before the approval-hash deny.
        rc, error = run()
        assert rc == 2 and '--envelope-sha256 does not match' in error, error
        body.write_bytes('Example body.\r\nSecond line.\n'.encode())
        con.execute('DELETE FROM approvals')
        con.commit()
        approve(anchor, age=1801)
        assert run()[0] == 2, 'expired approval'
        assert run(command.replace(' send ', ' draft ').replace(' --envelope-sha256 ' + envelope_digest, ''))[0] == 0, 'draft'
        rc, error = run(command.replace(str(body), 'body.txt'))
        assert rc == 2, error
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
        # SCRIPTBIND end to end: with a fresh approval that WOULD satisfy the
        # envelope, a wrong granted sha256 in the STORE config must keep the
        # invocation off the exception path -- whatever the ordinary Bash
        # analysis then decides, the approval is not consumed (the exception
        # pass at level 2/3 is the only consumer here).
        level(2)
        approve(anchor)
        (store / 'agent-send-exceptions.json').write_text(json.dumps({'agents': {
            CORPUS['agentName']: dict(entry, scripts=[{'path': str(script), 'sha256': 'f' * 64}])}}))
        run()
        # A5 (card f2ccb0bb R4): the freshest approval row only -- a bare fetchone()
        # could pick up an older aged approval that also matches the anchor.
        consumed = con.execute('SELECT consumed_at FROM approvals ORDER BY rowid DESC LIMIT 1').fetchone()[0]
        assert consumed is None, 'a wrong granted sha256 must not reach the exception approval path'
        (store / 'agent-send-exceptions.json').write_text(json.dumps(config))
        body.unlink()
        assert run()[0] == 2, 'unreadable body at every level'
        con.close()
        print('PASS: named-script approval, one-shot, content, window, modes, paths and levels')


if __name__ == '__main__':
    main()
