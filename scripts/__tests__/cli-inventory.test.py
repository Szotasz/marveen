#!/usr/bin/env python3
"""The CLI inventory generator (scripts/cli-inventory.py).

What this suite pins, on fixture trees built in a temp dir, with fake
binaries that the generator really runs:

  1. a Printing Press folder is listed with exactly the documented fields;
     from the manifest only display_name / version / description / license
     (the author and user_config never reach the output), from agent-context
     only the command tree, the auth mode and the env var NAMES (not the
     per-command read-only annotations)
  2. a hostile binary (writes a file, tries a network connection, prints
     extra fields and secrets) runs with PATH, HOME and LANG only: an
     inherited secret is not in its environment, its HOME is an empty temp
     folder that is gone afterwards, and nothing but the listed fields of its
     output reaches the JSON
  3. a hanging binary is stopped by the timeout, its forked child with it
  4. without agent-context, the command list comes from --help
  5. symlinks are not followed: a symlinked tool folder and a symlinked binary
     pointing outside the configured folder are neither listed nor run
  6. the redaction pass: e-mail addresses, URL query strings (?token=, ?key=),
     key=value secrets and token shapes are gone from the README excerpt and
     every other string; the plain URL stays
  7. skills: a global and a per-agent SKILL.md naming the binary are listed
     with agent and skill name only; a longer name that merely starts with the
     binary name is not a match
  8. deterministic output, atomic --out write, no temp file left, a missing
     folder is reported, and the script has no network-capable import
  9. there is no default folder: without --dir the generator stops with a
     usage error before it starts anything
"""
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'cli-inventory.py')

TOOL_KEYS = {'name', 'display_name', 'description', 'version', 'license', 'source', 'root', 'dir', 'binary',
             'probe', 'auth', 'commands', 'docs', 'readme_excerpt', 'skills'}
SECRET = 'sk-' + 'Q7f' * 10
GH_TOKEN = 'ghp_' + 'a1B2' * 9
EMAIL = 'owner.person@example.com'


def w(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    if mode is not None:
        os.chmod(path, mode)


def fake_binary(path, body):
    """An executable Python script; the shebang is absolute, PATH is scrubbed."""
    w(path, '#!%s\nimport json, os, sys, time\nargs = sys.argv[1:]\n%s\n' % (sys.executable, body), 0o755)


def manifest(tool_dir, **extra):
    data = {
        'manifest_version': '0.3', 'name': 'x-pp-mcp', 'display_name': 'Acme Tool', 'version': '1.2.0',
        'description': 'Acme from the terminal', 'license': 'MIT',
        'author': {'name': 'Author Person', 'email': EMAIL},
        'user_config': {'acme_token': {'default': SECRET}},
        'server': {'mcp_config': {'env': {'ACME_TOKEN': SECRET}}},
    }
    data.update(extra)
    w(os.path.join(tool_dir, 'manifest.json'), json.dumps(data))


AGENT_CONTEXT = {
    'schema_version': '4',
    'cli': {'name': 'acme-pp-cli', 'version': '0.0.0-dev'},
    'auth': {'mode': 'api_key', 'env_vars': [
        {'name': 'ACME_TOKEN', 'value': SECRET, 'description': 'token ' + SECRET},
        {'name': 'not a name; rm -rf', 'value': 'x'}]},
    'paths': {'config_dir': '/home/someone/.config/acme'},
    'discovery': {'target_url': 'https://api.example.com/v1?token=' + SECRET},
    'account': {'email': EMAIL, 'api_key': SECRET},
    'commands': [
        {'name': 'users', 'short': 'User accounts', 'annotations': {'mcp:read-only': 'false'},
         'subcommands': [{'name': 'get'}, {'name': 'list'}, {'name': '$(evil)'}]},
        {'name': 'address', 'short': 'Address risk', 'annotations': {'mcp:read-only': 'true'}, 'subcommands': []},
        {'name': '; bad name', 'short': 'dropped'},
    ],
}


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def run(*args, env=None, timeout=60):
    res = subprocess.run([sys.executable, SCRIPT] + list(args), capture_output=True, text=True,
                         timeout=timeout, env=env)
    if res.returncode != 0:
        raise AssertionError('generator failed: %s\n%s' % (res.stdout, res.stderr))
    return res.stdout


def inventory(*args, **kw):
    return json.loads(run('--stdout', *args, **kw))


def child_env_keys(env):
    """The environment keys a fake binary saw. On macOS the fake binary's own
    Python (CoreFoundation) adds __CF_USER_TEXT_ENCODING to its environment at
    start, after the generator handed it the scrubbed one, so those keys are not
    the generator's."""
    if sys.platform == 'darwin':
        return {k for k in env if not k.startswith('__CF_')}
    return set(env)


class Fixture(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.lib = os.path.join(self.root, 'library')
        self.agents = os.path.join(self.root, 'agents')
        self.skills = os.path.join(self.root, 'global-skills')
        os.makedirs(self.lib)
        os.makedirs(self.agents)
        os.makedirs(self.skills)

    def base_args(self, *extra):
        return ['--dir', self.lib, '--agents-dir', self.agents, '--skills-dir', self.skills] + list(extra)

    def acme(self, body=None):
        tool = os.path.join(self.lib, 'acme')
        manifest(tool)
        fake_binary(os.path.join(tool, 'acme-pp-cli'), body or (
            'if args == ["agent-context"]:\n    print(json.dumps(%r))\nelse:\n    sys.exit(2)' % (AGENT_CONTEXT,)))
        return tool


class Listing(Fixture):
    def test_listed_fields_only(self):
        tool = self.acme()
        w(os.path.join(tool, 'README.md'), '# Acme CLI\n\nScreens addresses.\n')
        w(os.path.join(tool, 'HASZNALAT.md'), 'hu\n')
        w(os.path.join(tool, 'notes.txt'), 'not a doc\n')
        doc = inventory(*self.base_args())
        self.assertEqual(doc['summary']['total'], 1)
        t = doc['tools'][0]
        self.assertEqual(set(t), TOOL_KEYS)
        self.assertEqual(
            {k: t[k] for k in ('name', 'display_name', 'description', 'version', 'license', 'source', 'binary')},
            {'name': 'acme-pp-cli', 'display_name': 'Acme Tool', 'description': 'Acme from the terminal',
             'version': '1.2.0', 'license': 'MIT', 'source': 'printing-press', 'binary': 'acme-pp-cli'})
        self.assertEqual((t['root'], t['dir']), (self.lib, self.lib + '/acme'))
        self.assertEqual(t['probe'], {'status': 'ok', 'command_source': 'agent-context'})
        self.assertEqual(t['auth'], {'mode': 'api_key', 'env_vars': ['ACME_TOKEN']})
        self.assertEqual(t['commands'], [
            {'name': 'address', 'description': 'Address risk', 'subcommands': []},
            {'name': 'users', 'description': 'User accounts', 'subcommands': ['get', 'list']},
        ])
        # The CLI's own read-only annotations are not carried over (see the generator's docstring).
        self.assertNotIn('read-only', json.dumps(t['commands']))
        self.assertEqual(t['docs'], ['HASZNALAT.md', 'README.md'])
        self.assertEqual(t['readme_excerpt'], '# Acme CLI\n\nScreens addresses.')
        text = json.dumps(doc)
        for needle in (SECRET, EMAIL, 'Author Person', 'user_config', 'acme_token', 'config_dir',
                       '/home/someone', 'api.example.com', '"account"', 'evil'):
            self.assertNotIn(needle, text, needle)

    def test_manifest_only_folder_is_listed_without_a_binary(self):
        manifest(os.path.join(self.lib, 'plain'))
        os.makedirs(os.path.join(self.lib, 'no-manifest'))
        doc = inventory(*self.base_args())
        self.assertEqual([t['name'] for t in doc['tools']], ['plain'])
        t = doc['tools'][0]
        self.assertEqual((t['binary'], t['probe']['status'], t['commands'], t['auth']), (None, 'no_binary', [], None))
        self.assertEqual(doc['summary']['probe_failures'], 0)

    def test_help_fallback(self):
        tool = os.path.join(self.lib, 'helpy')
        manifest(tool)
        fake_binary(os.path.join(tool, 'helpy-pp-cli'), '\n'.join([
            'if args == ["--help"]:',
            '    print("Helpy CLI\\n\\nUsage:\\n  helpy-pp-cli [command]\\n\\nAvailable Commands:\\n"',
            '          "  list        List things\\n  get         Get one thing\\n\\nFlags:\\n  -h, --help   help")',
            'else:',
            '    sys.exit(1)']))
        t = inventory(*self.base_args())['tools'][0]
        self.assertEqual(t['probe'], {'status': 'ok', 'command_source': 'help'})
        self.assertEqual([c['name'] for c in t['commands']], ['get', 'list'])
        self.assertIsNone(t['auth'])

    def test_no_dir_is_an_error_and_starts_nothing(self):
        trace = os.path.join(self.root, 'trace.txt')
        self.acme('open(%r, "a").write("ran\\n")' % trace)
        out = os.path.join(self.root, 'out.json')
        res = subprocess.run([sys.executable, SCRIPT, '--agents-dir', self.agents, '--skills-dir', self.skills,
                              '--out', out], capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 2)
        self.assertIn('--dir', res.stderr)
        self.assertFalse(os.path.exists(out))
        self.assertFalse(os.path.exists(trace))

    def test_missing_dir_is_reported(self):
        gone = os.path.join(self.root, 'nope')
        doc = inventory('--dir', gone, '--agents-dir', self.agents)
        self.assertEqual(doc['summary']['dirs'], [{'dir': gone, 'found': False, 'tools': 0}])
        self.assertEqual(doc['tools'], [])


class HostileBinary(Fixture):
    def test_scrubbed_env_and_only_listed_fields(self):
        trace = os.path.join(self.root, 'trace.json')
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        body = '\n'.join([
            'import socket',
            'home = os.environ.get("HOME", "")',
            'open(os.path.join(home, "dropped.txt"), "w").write("x")',
            'with open(%r, "a") as f:' % trace,
            '    f.write(json.dumps({"args": args, "env": dict(os.environ), "home": home,'
            ' "cwd": os.getcwd(), "home_files": os.listdir(home)}) + "\\n")',
            'try:',
            '    s = socket.create_connection(("127.0.0.1", %d), timeout=1)' % port,
            '    s.sendall(json.dumps(dict(os.environ)).encode()); s.close()',
            'except OSError:',
            '    pass',
            'ctx = %r' % (AGENT_CONTEXT,),
            'ctx["leak"] = {"env": dict(os.environ), "token": %r}' % SECRET,
            'ctx["commands"][0]["short"] = "User accounts"',
            'print(json.dumps(ctx))',
        ])
        self.acme(body)
        env = dict(os.environ, CLI_INV_PARENT_SECRET='parent-' + SECRET, ACME_TOKEN=SECRET)
        doc = inventory(*self.base_args(), env=env)

        with open(trace) as f:
            calls = [json.loads(line) for line in f]
        self.assertEqual([c['args'] for c in calls], [['agent-context']])
        call = calls[0]
        self.assertEqual(child_env_keys(call['env']), {'PATH', 'HOME', 'LANG'})
        self.assertNotEqual(call['home'], os.environ.get('HOME'))
        self.assertEqual(call['cwd'], os.path.realpath(call['home']))
        self.assertEqual(call['home_files'], ['dropped.txt'])
        self.assertFalse(os.path.exists(call['home']), 'the temporary HOME is removed after the call')
        self.assertNotIn(SECRET, json.dumps(call['env']))

        t = doc['tools'][0]
        self.assertEqual(set(t), TOOL_KEYS)
        self.assertEqual(t['auth'], {'mode': 'api_key', 'env_vars': ['ACME_TOKEN']})
        text = json.dumps(doc)
        for needle in (SECRET, 'leak', 'parent-', 'dropped.txt', call['home'], 'PATH'):
            self.assertNotIn(needle, text, needle)

    def test_hanging_binary_and_its_child_are_stopped(self):
        pidfile = os.path.join(self.root, 'child.pid')
        self.acme('\n'.join([
            'import subprocess',
            'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])',
            'open(%r, "w").write(str(child.pid))' % pidfile,
            'time.sleep(60)']))
        started = time.monotonic()
        doc = inventory(*self.base_args('--timeout', '1'))
        self.assertLess(time.monotonic() - started, 15)
        t = doc['tools'][0]
        self.assertEqual(t['probe'], {'status': 'timeout', 'command_source': None})
        self.assertEqual(t['commands'], [])
        self.assertEqual(doc['summary']['probe_failures'], 1)
        pid = int(read(pidfile))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            self.fail('the forked child outlived the probe')


class Symlinks(Fixture):
    def test_symlinks_are_not_followed(self):
        outside = os.path.join(self.root, 'outside')
        marker = os.path.join(self.root, 'ran.txt')
        manifest(os.path.join(outside, 'evil'))
        fake_binary(os.path.join(outside, 'evil', 'evil-pp-cli'), 'open(%r, "w").write("ran")' % marker)
        os.symlink(os.path.join(outside, 'evil'), os.path.join(self.lib, 'evil'))
        tool = os.path.join(self.lib, 'linked')
        manifest(tool)
        os.symlink(os.path.join(outside, 'evil', 'evil-pp-cli'), os.path.join(tool, 'linked-pp-cli'))
        os.symlink(os.path.join(outside, 'evil', 'manifest.json'), os.path.join(self.lib, 'linked', 'README.md'))
        doc = inventory(*self.base_args())
        self.assertEqual([t['name'] for t in doc['tools']], ['linked'])
        t = doc['tools'][0]
        self.assertEqual((t['binary'], t['probe']['status']), (None, 'no_binary'))
        self.assertEqual((t['docs'], t['readme_excerpt']), ([], None))
        self.assertEqual(doc['summary']['skipped_symlinks'], 1)
        self.assertFalse(os.path.exists(marker), 'a binary outside the configured folder was run')
        self.assertNotIn(outside, json.dumps(doc))


class Redaction(Fixture):
    def test_readme_secrets_and_query_strings_are_redacted(self):
        tool = self.acme()
        # Built at run time so the literal is not a JWT in the repository (secret-gate).
        jwt = '.'.join(['ey' + 'J' + 'hbGciOiJIUzI1NiJ9', 'ey' + 'J' + 'zdWIiOiIxMjM0NTY3ODkwIn0', 'Sfl' + 'Kxw' * 8])
        w(os.path.join(tool, 'README.md'), '\n'.join([
            '# Acme',
            'Docs: https://docs.example.com/guide',
            'Login: https://app.example.com/login?token=abc123SECRETvalue&next=/home',
            'API: https://api.example.com/v1/items?key=K3yValu3x&limit=5',
            'Fragment: https://app.example.com/cb#access_token=frag123SECRET',
            'Contact: %s' % EMAIL,
            'export ACME_API_KEY=plainsecretvalue123',
            'password: hunter2hunter2',
            'Authorization: Bearer %s' % ('Zz9' * 8),
            'github %s' % GH_TOKEN,
            'jwt %s' % jwt,
            'openai %s' % SECRET,
        ]))
        doc = inventory(*self.base_args())
        excerpt = doc['tools'][0]['readme_excerpt']
        for needle in ('abc123SECRETvalue', 'token=', 'next=', 'K3yValu3x', 'key=K', 'limit=5', 'frag123SECRET',
                       'access_token', EMAIL, 'plainsecretvalue123', 'hunter2hunter2', 'Zz9Zz9', GH_TOKEN,
                       jwt, SECRET):
            self.assertNotIn(needle, excerpt, needle)
        self.assertIn('https://docs.example.com/guide', excerpt)
        self.assertIn('https://app.example.com/login[redacted]', excerpt)
        self.assertIn('https://api.example.com/v1/items[redacted]', excerpt)
        self.assertGreaterEqual(doc['summary']['redactions'], 10)

    def test_a_long_path_or_name_is_not_taken_for_a_key(self):
        manifest(os.path.join(self.lib, 'plain'),
                 description='Reads /var/lib/some-very-long-folder-name-2024/and-another-long-segment-v2')
        t = inventory(*self.base_args())['tools'][0]
        self.assertEqual(t['description'], 'Reads /var/lib/some-very-long-folder-name-2024/and-another-long-segment-v2')


class Skills(Fixture):
    def test_skills_naming_the_binary(self):
        self.acme()
        w(os.path.join(self.skills, 'acme-global', 'SKILL.md'),
          '---\nname: acme-global\n---\nRun `acme-pp-cli users list`. token %s\n' % SECRET)
        w(os.path.join(self.agents, 'beta', '.claude', 'skills', 'acme-use', 'SKILL.md'),
          '---\nname: acme-use\n---\nacme-pp-cli address get\n')
        w(os.path.join(self.agents, 'beta', '.claude', 'skills', 'other', 'SKILL.md'),
          '---\nname: other\n---\nacme-pp-cli-extra is a different tool; acme is a word\n')
        t = inventory(*self.base_args())['tools'][0]
        self.assertEqual(t['skills'], [
            {'scope': 'global', 'agent': None, 'skill': 'acme-global'},
            {'scope': 'agent', 'agent': 'beta', 'skill': 'acme-use'},
        ])
        self.assertNotIn(SECRET, json.dumps(t))


class Output(Fixture):
    def test_deterministic_atomic(self):
        self.acme()
        manifest(os.path.join(self.lib, 'zeta'))
        out_dir = os.path.join(self.root, 'store')
        out = os.path.join(out_dir, 'cli-inventory.json')
        strip = lambda p: re.sub(r'"generated_at": "[^"]*"', '', read(p))
        run(*self.base_args('--out', out))
        first = strip(out)
        run(*self.base_args('--out', out))
        self.assertEqual(strip(out), first)
        self.assertEqual(os.listdir(out_dir), ['cli-inventory.json'])
        names = [t['name'] for t in json.loads(read(out))['tools']]
        self.assertEqual(names, ['acme-pp-cli', 'zeta'])

    def test_no_network_capable_import(self):
        src = read(SCRIPT)
        for mod in ('socket', 'urllib', 'urllib3', 'http.client', 'requests', 'ssl'):
            self.assertNotRegex(src, r'(?m)^\s*(?:import|from)\s+%s\b' % re.escape(mod), mod)


if __name__ == '__main__':
    unittest.main(verbosity=2)
