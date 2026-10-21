#!/usr/bin/env python3
"""The adopted open-source inventory generator.

The dashboard's "GitHub repos" counter says 0 while the agents may run on
vendored open-source projects; scripts/opensource-inventory.py makes those
visible. What this suite pins, on a fixture tree built in a temp dir:

  1. every source kind is found: skill headers, package.json deps (with the
     installed copy's version/license/repo), venv dist-infos, git clones,
     unpacked sdists under vendor/, npx MCP servers in .mcp.json
  2. node_modules is never walked as a project, pip/setuptools are dropped,
     a github link in a skill BODY (past the header) is not an adoption
  3. direct vs transitive pip: an optional extra is not a dependency
  4. stars / effect are taken only where a research note states them, with
     file:line, and the known false-attribution traps stay null:
       - a bare package name inside a different project's name
         ("Playwright MCP ... 37,5k" is not the pip playwright's star count)
       - a key/value table's "dependency | numpy only" row does not hand numpy
         the table's stars
       - effect is read from the adopting agent's own notes only
  5. deterministic entries, atomic --out write, the tree is not modified,
     and the script has no network-capable import
  6. the notes directory is configurable (--notes-dir) and a note written in
     Hungarian (the dashboard's other locale) is read too
  7. no private data in the output: credentials in a git remote, an npm git
     spec, an MCP spec or a homepage are stripped; a local-path remote is not
     listed as adopted code; no absolute path is written
  8. vendored npm packages: any named + versioned, non-private package.json
     anywhere under vendor/ (nested too) is a vendor row, whatever lockfile it
     ships; with node_modules next to it, its dependencies are listed as
     transitive (direct: false); a private package.json is an install folder
     whose pinned dependencies are reported like any package.json
  9. no local path reaches the output: file:/git+file:/absolute/home/relative
     specs in package.json are skipped, a local MCP launch is a labelled row
     without its raw value, and the whole output never contains the
     fixture's temp path
 10. registry identity is never guessed: an npmjs/pypi link and a registry
     name only for a bare spec matching the registry grammar (npm name +
     semver range or tag, tilde and caret included; PEP 508 name + extras +
     ==version), and for MCP only with no launcher option beyond -y/--yes;
     anything else keeps its row with source_url null and a fixed label
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'opensource-inventory.py')


def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def dist(site, name, version, extra_headers=''):
    w(os.path.join(site, '%s-%s.dist-info' % (name.replace('-', '_'), version), 'METADATA'),
      'Metadata-Version: 2.1\nName: %s\nVersion: %s\n%s\nbody\n' % (name, version, extra_headers))


def build_fixture(root):
    A = os.path.join(root, 'agents')
    alfa = os.path.join(A, 'alfa')
    # 1a. skill header citing two repos; a third link only in the body
    body = '\n'.join('filler %d' % i for i in range(80))
    w(os.path.join(alfa, '.claude', 'skills', 'image', 'SKILL.md'),
      '---\nname: image\n---\n<!--\nSOURCES:\n'
      '- https://github.com/acme/widget-skills : skills/x/SKILL.md. License: MIT (OK).\n'
      '- https://github.com/nolic/agents : ideas only. License: NOT SEEN.\n'
      '-->\n' + body + '\nsee https://github.com/body/only for more\n')
    w(os.path.join(alfa, '.claude', 'skills', 'other', 'SKILL.md'),
      '---\nname: other\n---\nSource: https://github.com/acme/widget-skills.git\n')
    # 1b. npm project + installed copies; a nested node_modules package.json
    w(os.path.join(alfa, 'tool', 'package.json'), json.dumps({
        'name': 'tool', 'private': True,
        'dependencies': {'left-pad': '1.3.0', '@acme/thing-mcp': '^2.0.0'}}))
    w(os.path.join(alfa, 'tool', 'node_modules', 'left-pad', 'package.json'), json.dumps({
        'name': 'left-pad', 'version': '1.3.0', 'license': 'WTFPL',
        'repository': {'type': 'git', 'url': 'git+https://github.com/stevemao/left-pad.git'},
        'dependencies': {'must-not-appear': '1.0.0'}}))
    w(os.path.join(alfa, 'tool', 'node_modules', '@acme', 'thing-mcp', 'package.json'), json.dumps({
        'name': '@acme/thing-mcp', 'version': '2.4.1', 'license': {'type': 'Apache-2.0'}}))
    # 1c. venv
    site = os.path.join(alfa, '.venv', 'lib', 'python3.12', 'site-packages')
    w(os.path.join(alfa, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n')
    dist(site, 'duckdb', '1.0.0', 'License-Expression: MIT\nProject-URL: Source, https://github.com/duckdb/duckdb')
    dist(site, 'six', '1.17.0', 'Classifier: License :: OSI Approved :: MIT License')
    dist(site, 'numpy', '2.2.6', 'License: BSD License')
    dist(site, 'reqpkg', '1.0', 'Requires-Dist: six>=1.0\nRequires-Dist: duckdb ; extra == "db"')
    dist(site, 'pip', '24.0')
    # 1d. git clone under vendor/ (packed ref)
    lib1 = os.path.join(alfa, 'vendor', 'lib1')
    w(os.path.join(lib1, '.git', 'config'),
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/smart/lib1.git\n')
    w(os.path.join(lib1, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    w(os.path.join(lib1, '.git', 'packed-refs'), '# pack-refs\n' + 'a' * 40 + ' refs/heads/main\n')
    w(os.path.join(lib1, 'LICENSE'), '   Apache License\n  Version 2.0, January 2004\n')
    w(os.path.join(lib1, 'package.json'), json.dumps({'dependencies': {'inside-clone': '1.0.0'}}))
    # 1e. unpacked sdist under vendor/
    w(os.path.join(alfa, 'vendor', 'bayes-1.0', 'PKG-INFO'),
      'Metadata-Version: 2.4\nName: bayes-testing\nVersion: 1.0\nLicense: MIT\n'
      'Project-URL: Repository, https://github.com/Matt/bayes-testing\n\nreadme\n')
    # 1f. .mcp.json: npx (pinned), npx (unpinned), a local node plugin
    w(os.path.join(alfa, '.mcp.json'), json.dumps({'mcpServers': {
        'cal': {'command': 'npx', 'args': ['-y', '@acme/cal-mcp@1.2.3']},
        'drive': {'command': 'npx', 'args': ['-y', '@acme/drive-mcp']},
        'local': {'command': '/usr/bin/node', 'args': ['/x/plugins/worksource/server.mjs']}}}))
    # 4. research notes
    w(os.path.join(alfa, 'research', 'benchmark.md'),
      '# Benchmark\n\n## 1. Adopted code\n'
      '- Repo: `github.com/acme/widget-skills`. **Stars: 3.1k [H]**, fork 290.\n'
      '- duckdb/duckdb wired in.\n\n'
      '**Before/after: 60.5% -> 90.1%** (target 80%).\n\n'
      '## 2. Bayes\n\n| | |\n| --- | --- |\n| repo | Matt/bayes-testing |\n'
      '| dependency | numpy only |\n| stars | 82 [excerpt] |\n\n'
      '| | BEFORE | AFTER |\n| --- | --- | --- |\n| false winner | | |\n| false winner 2 | 17.3% | 3.8% |\n')
    bravo = os.path.join(A, 'bravo')
    site_b = os.path.join(bravo, '.venv', 'lib', 'python3.12', 'site-packages')
    w(os.path.join(bravo, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n')
    dist(site_b, 'playwright', '1.63.0', 'License: Apache-2.0')
    # A note written in Hungarian: "csillag" = stars, "elotte/utana" = before/after.
    w(os.path.join(bravo, 'research', 'self-audit.md'),
      '## MCP\n1. **Playwright MCP** (`@playwright/mcp`). **Csillag: 37,5k [H]**.\n'
      '## Masik\n- github.com/smart/lib1 (1 234 csillag)\n'
      '- acme/widget-skills elotte/utana: 1 -> 999\n'
      '- lib1 elotte/utana: 2 -> 777\n')
    return A


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def tree_digest(root):
    h = hashlib.sha256()
    for dp, dns, fns in sorted(os.walk(root)):
        dns.sort()
        for fn in sorted(fns):
            p = os.path.join(dp, fn)
            st = os.stat(p)
            h.update(('%s|%d|%d\n' % (os.path.relpath(p, root), st.st_size, st.st_mtime_ns)).encode())
            with open(p, 'rb') as f:
                h.update(f.read())
    return h.hexdigest()


def run(agents_dir, *extra):
    res = subprocess.run([sys.executable, SCRIPT, '--agents-dir', agents_dir] + list(extra),
                         capture_output=True, text=True, timeout=60)
    if res.returncode != 0:
        raise AssertionError('generator failed: %s\n%s' % (res.stdout, res.stderr))
    return res.stdout


class Inventory(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.agents = build_fixture(cls.tmp.name)
        cls.before = tree_digest(cls.agents)
        cls.doc = json.loads(run(cls.agents, '--stdout'))
        cls.rows = {(e['agent'], e['type'], e['name']): e for e in cls.doc['entries']}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def row(self, agent, type_, name):
        self.assertIn((agent, type_, name), self.rows, sorted(self.rows))
        return self.rows[(agent, type_, name)]

    # 1 + 2 ------------------------------------------------------------------
    def test_skill_header_sources(self):
        e = self.row('alfa', 'skill', 'acme/widget-skills')
        self.assertEqual(e['source_url'], 'https://github.com/acme/widget-skills')
        self.assertEqual((e['license'], e['license_source']), ('MIT', 'skill-header'))
        self.assertEqual(e['used_in'], ['image', 'other'])  # .git suffix folded into one row
        nolic = self.row('alfa', 'skill', 'nolic/agents')
        self.assertIsNone(nolic['license'])
        self.assertNotIn(('alfa', 'skill', 'body/only'), self.rows)

    def test_npm_with_installed_metadata(self):
        e = self.row('alfa', 'npm', 'left-pad')
        self.assertEqual((e['version'], e['declared'], e['license']), ('1.3.0', '1.3.0', 'WTFPL'))
        self.assertEqual(e['source_url'], 'https://github.com/stevemao/left-pad')
        self.assertEqual(e['path'], 'agents/alfa/tool/package.json')
        m = self.row('alfa', 'mcp', '@acme/thing-mcp')
        self.assertEqual((m['version'], m['declared'], m['license']), ('2.4.1', '^2.0.0', 'Apache-2.0'))
        self.assertEqual(m['source_url'], 'https://www.npmjs.com/package/@acme/thing-mcp')
        names = {k[2] for k in self.rows}
        self.assertNotIn('must-not-appear', names)  # node_modules never walked
        self.assertNotIn('inside-clone', names)     # a clone's own manifest is not the agent's

    def test_pip_direct_transitive_and_tooling(self):
        duck = self.row('alfa', 'pip', 'duckdb')
        self.assertTrue(duck['direct'], 'an optional extra must not make duckdb transitive')
        self.assertEqual((duck['license'], duck['source_url']), ('MIT', 'https://github.com/duckdb/duckdb'))
        six = self.row('alfa', 'pip', 'six')
        self.assertFalse(six['direct'])
        self.assertEqual(six['license'], 'MIT License')
        self.assertNotIn(('alfa', 'pip', 'pip'), self.rows)

    def test_vendor_clone_and_sdist(self):
        g = self.row('alfa', 'vendor', 'smart/lib1')
        self.assertEqual((g['version'], g['license'], g['license_source']), ('a' * 12, 'Apache-2.0', 'license-file'))
        s = self.row('alfa', 'vendor', 'Matt/bayes-testing')
        self.assertEqual((s['version'], s['license'], s['declared']), ('1.0', 'MIT', 'bayes-testing'))

    def test_mcp_json(self):
        cal = self.row('alfa', 'mcp', '@acme/cal-mcp')
        self.assertEqual((cal['version'], cal['declared'], cal['used_in']), ('1.2.3', '@acme/cal-mcp@1.2.3', ['cal']))
        self.assertEqual(cal['source_url'], 'https://www.npmjs.com/package/@acme/cal-mcp')
        drive = self.row('alfa', 'mcp', '@acme/drive-mcp')
        self.assertIsNone(drive['version'])
        self.assertEqual(drive['source_url'], 'https://www.npmjs.com/package/@acme/drive-mcp')
        self.assertFalse(any('worksource' in k[2] or 'server.mjs' in k[2] for k in self.rows))

    # 4 ----------------------------------------------------------------------
    def test_stars_and_effect_with_sources(self):
        e = self.row('alfa', 'skill', 'acme/widget-skills')
        self.assertEqual((e['stars'], e['stars_source']), ('3.1k', 'agents/alfa/research/benchmark.md:4'))
        self.assertEqual(e['effect_source'], 'agents/alfa/research/benchmark.md:7')
        self.assertIn('60.5% -> 90.1%', e['effect'])
        duck = self.row('alfa', 'pip', 'duckdb')
        self.assertEqual(duck['effect_source'], 'agents/alfa/research/benchmark.md:7')
        bayes = self.row('alfa', 'vendor', 'Matt/bayes-testing')
        self.assertEqual((bayes['stars'], bayes['stars_source']), ('82', 'agents/alfa/research/benchmark.md:15'))
        # first before/after row with BOTH cells filled
        self.assertEqual(bayes['effect'], 'false winner 2: 17.3% -> 3.8%')
        # stars from ANOTHER agent's note are allowed (with the source)
        lib1 = self.row('alfa', 'vendor', 'smart/lib1')
        # ...and from a note written in Hungarian
        self.assertEqual((lib1['stars'], lib1['stars_source']), ('1 234', 'agents/bravo/research/self-audit.md:4'))

    def test_false_attribution_traps_stay_null(self):
        pw = self.row('bravo', 'pip', 'playwright')
        self.assertIsNone(pw['stars'], '"Playwright MCP ... 37,5k" belongs to another project')
        numpy = self.row('alfa', 'pip', 'numpy')
        self.assertIsNone(numpy['stars'], 'a dependency row must not inherit the table stars')
        self.assertIsNone(numpy['effect'])
        # bravo's note claims an effect for alfa's skill: effect is own-notes only
        e = self.row('alfa', 'skill', 'acme/widget-skills')
        self.assertNotIn('999', e['effect'])
        lib1 = self.row('alfa', 'vendor', 'smart/lib1')
        self.assertIsNone(lib1['effect'], "another agent's before/after is not this adoption's effect")
        for key, e in self.rows.items():
            if e['stars'] is None:
                self.assertIsNone(e['stars_source'], key)
            if e['effect'] is None:
                self.assertIsNone(e['effect_source'], key)

    # 5 ----------------------------------------------------------------------
    def test_summary_counts(self):
        s = self.doc['summary']
        self.assertEqual(s['total'], len(self.doc['entries']))
        self.assertEqual(sum(a['total'] for a in s['by_agent'].values()), s['total'])
        self.assertEqual(s['direct'], sum(1 for e in self.doc['entries'] if e['direct']))
        self.assertEqual(set(s['by_agent']), {'alfa', 'bravo'})

    def test_deterministic_atomic_readonly(self):
        out = os.path.join(self.tmp.name, 'store', 'inventory.json')
        run(self.agents, '--out', out)
        first = json.loads(read(out))
        run(self.agents, '--out', out)
        second = json.loads(read(out))
        self.assertEqual(first['entries'], second['entries'])
        self.assertEqual(first['entries'], self.doc['entries'])
        self.assertRegex(first['generated_at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        leftovers = [f for f in os.listdir(os.path.dirname(out)) if f != 'inventory.json']
        self.assertEqual(leftovers, [], 'no temp file left behind')
        self.assertEqual(tree_digest(self.agents), self.before, 'the agents tree was modified')

    def test_no_network_capable_import(self):
        src = read(SCRIPT)
        for mod in ('socket', 'urllib.request', 'urllib3', 'http.client', 'requests', 'ssl'):
            self.assertNotRegex(src, r'(?m)^\s*(import|from)\s+%s\b' % mod.replace('.', r'\.'))
        # urllib.parse (string parsing only) is the one urllib module allowed.
        urllib_imports = re.findall(r'(?m)^\s*(?:import|from)\s+(urllib\S*)', src)
        self.assertLessEqual(set(urllib_imports), {'urllib.parse'})
        self.assertNotRegex(src, r'(?m)^\s*from\s+urllib\s+import')

    def test_missing_agents_dir_is_empty_not_error(self):
        doc = json.loads(run(os.path.join(self.tmp.name, 'missing'), '--stdout'))
        self.assertEqual((doc['summary']['total'], doc['entries']), (0, []))

    # 6 ----------------------------------------------------------------------
    def test_notes_dir_is_configurable(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        agents = os.path.join(tmp.name, 'agents')
        w(os.path.join(agents, 'solo', '.claude', 'skills', 's', 'SKILL.md'),
          '---\nname: s\n---\nSource: https://github.com/acme/solo-skill\n')
        w(os.path.join(agents, 'solo', 'notes', 'n.md'), '- acme/solo-skill **Stars: 42**\n')

        def stars(*extra):
            res = subprocess.run([sys.executable, SCRIPT, '--agents-dir', agents, '--stdout'] + list(extra),
                                 capture_output=True, text=True, timeout=60)
            self.assertEqual(res.returncode, 0, res.stderr)
            (e,) = json.loads(res.stdout)['entries']
            return e['stars'], e['stars_source']

        self.assertEqual(stars(), (None, None), 'the default "research" dir does not read notes/')
        self.assertEqual(stars('--notes-dir', 'notes'), ('42', 'agents/solo/notes/n.md:1'))
        self.assertEqual(stars('--notes-dir', 'research', '--notes-dir', 'notes'), ('42', 'agents/solo/notes/n.md:1'))
        for bad in ('..', 'a/b', '.'):
            res = subprocess.run([sys.executable, SCRIPT, '--agents-dir', agents, '--stdout', '--notes-dir', bad],
                                 capture_output=True, text=True, timeout=60)
            self.assertEqual(res.returncode, 2, bad)


SECRETS = ('TOKEN1', 'TOKEN2', 'TOKEN3', 'TOKEN4', 'deployuser')


def build_private_fixture(root):
    A = os.path.join(root, 'agents')
    ag = os.path.join(A, 'priv')
    # 7a. a vendored clone whose origin carries a token
    cl = os.path.join(ag, 'vendor', 'secret-lib')
    w(os.path.join(cl, '.git', 'config'),
      '[remote "origin"]\n\turl = https://deployuser:TOKEN1@github.com/acme/secret-lib.git\n')
    w(os.path.join(cl, '.git', 'HEAD'), 'b' * 40 + '\n')
    # 7b. an scp-like ssh remote is a network remote and is listed
    sc = os.path.join(ag, 'vendor', 'ssh-lib')
    w(os.path.join(sc, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/ssh-lib.git\n')
    w(os.path.join(sc, '.git', 'HEAD'), 'c' * 40 + '\n')
    # 7c. a local-path remote (a scratch clone of another checkout) and a file:// one
    lp = os.path.join(ag, 'vendor', 'scratch')
    w(os.path.join(lp, '.git', 'config'), '[remote "origin"]\n\turl = /home/someone/work/checkout\n')
    w(os.path.join(lp, '.git', 'HEAD'), 'd' * 40 + '\n')
    fp = os.path.join(ag, 'vendor', 'fileremote')
    w(os.path.join(fp, '.git', 'config'), '[remote "origin"]\n\turl = file:///srv/mirror/x.git\n')
    w(os.path.join(fp, '.git', 'HEAD'), 'e' * 40 + '\n')
    # 7d. an npm git spec with credentials, a homepage with a token query
    w(os.path.join(ag, 'tool', 'package.json'), json.dumps({
        'name': 'tool', 'private': True,
        'dependencies': {'privpkg': 'git+https://deployuser:TOKEN2@gitlab.example.com/team/privpkg.git#v1.0.0',
                         'homepkg': '2.0.0'}}))
    w(os.path.join(ag, 'tool', 'node_modules', 'homepkg', 'package.json'), json.dumps({
        'name': 'homepkg', 'version': '2.0.0', 'homepage': 'https://docs.example.com/homepkg?token=TOKEN4'}))
    # 7e. an MCP server launched from a credentialed URL spec
    w(os.path.join(ag, '.mcp.json'), json.dumps({'mcpServers': {
        'remote': {'command': 'npx', 'args': ['-y', 'https://x:TOKEN3@registry.example.com/pkg.tgz']}}}))
    # 8a. an npm install folder under vendor/: private, with a lockfile and node_modules
    inst = os.path.join(ag, 'vendor', 'install-dir')
    w(os.path.join(inst, 'package.json'), json.dumps({'private': True, 'dependencies': {'left-pad': '1.3.0'}}))
    w(os.path.join(inst, 'package-lock.json'), '{}')
    w(os.path.join(inst, 'node_modules', 'left-pad', 'package.json'), json.dumps({
        'name': 'left-pad', 'version': '1.3.0', 'license': 'WTFPL'}))
    # 8b. a named (not private) folder that has only a lockfile
    lk = os.path.join(ag, 'vendor', 'locked')
    w(os.path.join(lk, 'package.json'), json.dumps({'name': 'locked-app', 'dependencies': {'is-odd': '3.0.1'}}))
    w(os.path.join(lk, 'yarn.lock'), '')
    # 8c. a genuine unpacked npm tarball is still one vendor entry
    tb = os.path.join(ag, 'vendor', 'tarball-1.2.0')
    w(os.path.join(tb, 'package.json'), json.dumps({
        'name': 'tarball', 'version': '1.2.0', 'license': 'MIT', 'dependencies': {'not-mine': '1.0.0'}}))
    # 8d. nested unpacked tarballs: vendor/<group>/<pkg>-<version> (npm and sdist)
    nested = os.path.join(ag, 'vendor', 'fonts-fontsource', 'fontsource-inter-5.3.0')
    w(os.path.join(nested, 'package.json'), json.dumps({
        'name': '@fontsource/inter', 'version': '5.3.0', 'license': 'OFL-1.1'}))
    w(os.path.join(ag, 'vendor', 'py', 'deep-pkg-0.4', 'PKG-INFO'),
      'Metadata-Version: 2.1\nName: deep-pkg\nVersion: 0.4\nLicense: MIT\n\nbody\n')
    # 8e. a published tarball that ships a shrinkwrap / lockfiles is still a tarball
    sw = os.path.join(ag, 'vendor', 'shrink-1.0.0')
    w(os.path.join(sw, 'package.json'), json.dumps({'name': 'shrink', 'version': '1.0.0',
                                                    'dependencies': {'not-mine-either': '1.0.0'}}))
    w(os.path.join(sw, 'npm-shrinkwrap.json'), '{}')
    w(os.path.join(sw, 'yarn.lock'), '')
    w(os.path.join(sw, 'pnpm-lock.yaml'), '')
    # 8f. a named, non-private package with its own node_modules: vendor row + transitive deps
    wm = os.path.join(ag, 'vendor', 'withmods-2.0.0')
    w(os.path.join(wm, 'package.json'), json.dumps({'name': 'withmods', 'version': '2.0.0',
                                                    'dependencies': {'dep-a': '1.0.0'}}))
    w(os.path.join(wm, 'node_modules', 'dep-a', 'package.json'), json.dumps({
        'name': 'dep-a', 'version': '1.0.0', 'license': 'MIT'}))
    # 9. local-path specs (absolute paths inside the fixture, so a leak is greppable)
    local = os.path.join(root, 'local-src')
    w(os.path.join(ag, 'app', 'package.json'), json.dumps({'name': 'app', 'private': True, 'dependencies': {
        'l-file': 'file:' + local + '/a',
        'l-gitfile': 'git+file://' + local + '/b.git',
        'l-abs': local + '/c',
        'l-home': '~/d',
        'l-rel': './e',
        'l-up': '../f',
        'real-dep': '4.0.0'}}))
    return A


def build_local_mcp_fixture(root):
    A = os.path.join(root, 'agents')
    local = os.path.join(root, 'local-src')
    w(os.path.join(A, 'mcpx', '.mcp.json'), json.dumps({'mcpServers': {
        'uv-from-local': {'command': 'uvx', 'args': ['--from', local + '/srv', 'some-server']},
        'uv-from-eq': {'command': 'uvx', 'args': ['--from=' + local + '/srv2', 'other-server']},
        'uv-with-python': {'command': 'uvx', 'args': ['--python', local + '/bin/python3',
                                                      '--with', local + '/extra', 'real-uv-server==1.2.3']},
        'npx-abs': {'command': 'npx', 'args': ['-y', local + '/server.js']},
        'npx-rel': {'command': 'npx', 'args': ['-y', './server.js']},
        'npx-home': {'command': 'npx', 'args': ['~/srv/server.js']},
        'npx-file': {'command': 'npx', 'args': ['-y', 'file:' + local + '/pkg']},
        'npx-pkg-local': {'command': 'npx', 'args': ['--package', local + '/pkg', 'bin-name']},
        'npx-real': {'command': 'npx', 'args': ['-y', '@acme/real-mcp@2.0.0']}}}))
    return A


class PrivateDataAndInstallFolders(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.agents = build_private_fixture(cls.tmp.name)
        cls.raw = run(cls.agents, '--stdout')
        cls.doc = json.loads(cls.raw)
        cls.rows = {(e['agent'], e['type'], e['name']): e for e in cls.doc['entries']}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def row(self, type_, name):
        self.assertIn(('priv', type_, name), self.rows, sorted(self.rows))
        return self.rows[('priv', type_, name)]

    def test_no_secret_anywhere_in_the_output(self):
        for s in SECRETS:
            self.assertNotIn(s, self.raw)

    def test_credentialed_remote_is_listed_without_its_userinfo(self):
        e = self.row('vendor', 'acme/secret-lib')
        self.assertEqual(e['source_url'], 'https://github.com/acme/secret-lib')
        s = self.row('vendor', 'acme/ssh-lib')
        self.assertEqual(s['source_url'], 'https://github.com/acme/ssh-lib')

    def test_local_path_and_file_remotes_are_not_adopted_code(self):
        names = {k[2] for k in self.rows}
        self.assertNotIn('scratch', names)
        self.assertNotIn('fileremote', names)
        self.assertNotIn('/home/someone', self.raw)
        self.assertNotIn('/srv/mirror', self.raw)

    def test_credentialed_npm_git_spec_and_homepage(self):
        # a git spec is not a registry spec: the row stays, labelled, without a link or the raw value
        e = self.row('npm', 'privpkg')
        self.assertEqual((e['declared'], e['source_url']), ('non-registry spec', None))
        h = self.row('npm', 'homepkg')
        self.assertEqual((h['declared'], h['source_url']), ('2.0.0', 'https://docs.example.com/homepkg'))

    def test_credentialed_mcp_spec(self):
        # a URL launch is not a registry spec: named by its config key, no link, no raw value
        e = self.row('mcp', 'remote')
        self.assertEqual((e['declared'], e['version'], e['source_url'], e['used_in']),
                         ('non-registry spec', None, None, ['remote']))

    def test_no_absolute_path_in_the_output(self):
        self.assertNotIn('agents_dir', self.doc)
        self.assertNotIn(self.tmp.name, self.raw)

    def test_npm_install_folder_under_vendor_reports_its_dependencies(self):
        lp = self.row('npm', 'left-pad')
        self.assertEqual((lp['version'], lp['path']), ('1.3.0', 'agents/priv/vendor/install-dir/package.json'))
        odd = self.row('npm', 'is-odd')
        self.assertEqual(odd['path'], 'agents/priv/vendor/locked/package.json')
        vendor_names = {k[2] for k in self.rows if k[1] == 'vendor'}
        self.assertNotIn('locked-app', vendor_names)
        self.assertFalse(any(k[1] == 'vendor' and 'install-dir' in self.rows[k]['path'] for k in self.rows))

    def test_nested_tarballs_are_vendor_rows(self):
        f = self.row('vendor', '@fontsource/inter')
        self.assertEqual((f['version'], f['license'], f['path']),
                         ('5.3.0', 'OFL-1.1', 'agents/priv/vendor/fonts-fontsource/fontsource-inter-5.3.0'))
        d = self.row('vendor', 'deep-pkg')
        self.assertEqual((d['version'], d['path']), ('0.4', 'agents/priv/vendor/py/deep-pkg-0.4'))

    def test_a_lockfile_is_not_proof_of_an_install_folder(self):
        sw = self.row('vendor', 'shrink')
        self.assertEqual((sw['version'], sw['path']), ('1.0.0', 'agents/priv/vendor/shrink-1.0.0'))
        self.assertNotIn('not-mine-either', {k[2] for k in self.rows})

    def test_named_package_with_node_modules_keeps_its_row_and_its_deps_are_transitive(self):
        wm = self.row('vendor', 'withmods')
        self.assertEqual((wm['version'], wm['path']), ('2.0.0', 'agents/priv/vendor/withmods-2.0.0'))
        dep = self.row('npm', 'dep-a')
        self.assertEqual((dep['version'], dep['direct'], dep['path']),
                         ('1.0.0', False, 'agents/priv/vendor/withmods-2.0.0/package.json'))

    def test_local_path_dependency_specs_are_skipped(self):
        names = {k[2] for k in self.rows}
        for n in ('l-file', 'l-gitfile', 'l-abs', 'l-home', 'l-rel', 'l-up'):
            self.assertNotIn(n, names)
        self.assertTrue(self.row('npm', 'real-dep')['direct'])
        self.assertNotIn('local-src', self.raw)

    def test_genuine_npm_tarball_is_still_one_vendor_entry(self):
        t = self.row('vendor', 'tarball')
        self.assertEqual((t['version'], t['license']), ('1.2.0', 'MIT'))
        self.assertNotIn('not-mine', {k[2] for k in self.rows})


class LocalMcpSpecs(unittest.TestCase):
    def test_local_mcp_launches_are_labelled_rows_and_nothing_local_leaks(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        raw = run(build_local_mcp_fixture(tmp.name), '--stdout')
        rows = {e['used_in'][0]: e for e in json.loads(raw)['entries']}
        expect = {
            'uv-from-local': ('uv-from-local', 'unparsed launcher', None),
            'uv-from-eq': ('uv-from-eq', 'unparsed launcher', None),
            'uv-with-python': ('uv-with-python', 'unparsed launcher', None),
            'npx-abs': ('npx-abs', 'non-registry spec', None),
            'npx-rel': ('npx-rel', 'non-registry spec', None),
            'npx-home': ('npx-home', 'non-registry spec', None),
            'npx-file': ('npx-file', 'non-registry spec', None),
            'npx-pkg-local': ('npx-pkg-local', 'unparsed launcher', None),
            'npx-real': ('@acme/real-mcp', '@acme/real-mcp@2.0.0', 'https://www.npmjs.com/package/@acme/real-mcp'),
        }
        self.assertEqual({k: (r['name'], r['declared'], r['source_url']) for k, r in rows.items()}, expect)
        self.assertEqual(rows['npx-real']['version'], '2.0.0')
        # the whole output: no temp path, no home or relative path, anywhere
        self.assertEqual(raw.count(tmp.name), 0)
        for frag in ('local-src', '~/srv', './server.js', 'file:', 'real-uv-server'):
            self.assertNotIn(frag, raw)


def build_grammar_fixture(root):
    A = os.path.join(root, 'agents')
    g = os.path.join(A, 'gram')
    w(os.path.join(g, 'tool', 'package.json'), json.dumps({'name': 'tool', 'private': True, 'dependencies': {
        'lodash': '~4.17.21',
        '@scope/caret': '^1.2.0',
        'ranged': '>=1.0.0 <2.0.0 || 3.x',
        'tagged': 'latest',
        'star': '*',
        'gh-dep': 'github:acme/gh-dep',
        'shorthand': 'acme/shorthand#v1',
        'git-dep': 'git+https://github.com/acme/git-dep.git',
        'url-dep': 'https://registry.example.com/url-dep-1.0.0.tgz',
        'alias-dep': 'npm:real-pkg@1.0.0',
        'BadName': '1.0.0',
        'home-dep': '~/src/home-dep',
        # a tarball file name in the range/tag position: npm reads it as a local file
        'tag-tgz': 'pkg-1.0.0.tgz',
        'tag-targz': 'x.tar.gz',
        'tag-tar': 'x.tar',
        'tag-upper': 'x.TGZ',
        # a valid semver whose prerelease ends like an archive: npm reads it as a file
        'pre-tgz': '1.0.0-rc.TGZ',
        # a dependency KEY that looks like an archive is not a registry name either
        'named.tgz': '1.0.0',
        # same name as a labelled MCP row below: the two must not merge
        'dup-mcp': '^1.0.0'}}))
    srv = {
        'tilde': ('npx', ['-y', 'pkg-tilde@~1.2.3']),
        'caret': ('npx', ['--yes', '@acme/scoped@^2.0.0']),
        'exact': ('bunx', ['@acme/exact@1.2.3', '--port', '3000']),
        'plain': ('pnpx', ['plain-mcp']),
        'url': ('npx', ['-y', 'https://registry.example.com/pkg.tgz']),
        'gh': ('npx', ['-y', 'github:acme/repo']),
        'gitplus': ('npx', ['-y', 'git+https://github.com/acme/repo.git']),
        'tarball': ('npx', ['-y', 'pkg-1.0.0.tgz']),
        'alias': ('npx', ['-y', 'npm:real@1.0.0']),
        'upper': ('npx', ['-y', 'BadName']),
        'unknown-opt': ('npx', ['--registry', 'https://r.example.com', 'pkg']),
        'p-remote': ('npx', ['-p', 'remote-pkg', 'bin-name']),
        'package-eq': ('npx', ['--package=remote-pkg', 'bin-name']),
        'dashdash': ('npx', ['--', 'pkg']),
        'noargs': ('npx', ['-y']),
        'uv-plain': ('uvx', ['mcp-server-fetch']),
        'uv-pinned': ('uvx', ['mcp-server-fetch==1.2.3']),
        'uv-extras': ('uvx', ['tool-pkg[cli, extra]==2.0']),
        'uv-from-remote': ('uvx', ['--from', 'git+https://github.com/acme/x.git', 'x']),
        'uv-with': ('uvx', ['--with', 'dep', 'realpkg']),
        'uv-y': ('uvx', ['-y', 'realpkg']),
        'uv-at': ('uvx', ['pkg@1.0']),
        'uv-url': ('uvx', ['https://files.example.com/x-1.0-py3-none-any.whl']),
        'tag-tarball': ('npx', ['-y', 'pkg@foo.tgz']),
        'tag-tar': ('npx', ['-y', 'pkg@x.TAR.GZ']),
        'dup-mcp': ('npx', ['-y', 'github:acme/dup-mcp']),
        'uv-whl': ('uvx', ['x-1.0-py3-none-any.whl']),
        'uv-sdist': ('uvx', ['x-1.0.tar.gz']),
        'uv-zip': ('uvx', ['x-1.0.ZIP']),
        'npx-tar-gz-loose': ('npx', ['-y', 'x.tar_gz']),
        'newline': ('npx', ['-y', 'foo\n']),
        'uv-newline': ('uvx', ['foo\n']),
    }
    w(os.path.join(g, '.mcp.json'), json.dumps({'mcpServers': {
        k: {'command': c, 'args': a} for k, (c, a) in srv.items()}}))
    return A


NPM = 'https://www.npmjs.com/package/%s'
PYPI = 'https://pypi.org/project/%s/'


class RegistryGrammar(unittest.TestCase):
    """A registry link and a registry name only for a spec that matches the grammar."""
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.raw = run(build_grammar_fixture(cls.tmp.name), '--stdout')
        cls.entries = json.loads(cls.raw)['entries']

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_package_json_specs(self):
        rows = {e['name']: e for e in self.entries if e['path'].endswith('package.json')}
        expect = {
            'lodash': ('~4.17.21', NPM % 'lodash'),
            '@scope/caret': ('^1.2.0', NPM % '@scope/caret'),
            'ranged': ('>=1.0.0 <2.0.0 || 3.x', NPM % 'ranged'),
            'tagged': ('latest', NPM % 'tagged'),
            'star': ('*', NPM % 'star'),
            'gh-dep': ('non-registry spec', None),
            'shorthand': ('non-registry spec', None),
            'git-dep': ('non-registry spec', None),
            'url-dep': ('non-registry spec', None),
            'alias-dep': ('non-registry spec', None),
            'BadName': ('non-registry spec', None),
            'tag-tgz': ('non-registry spec', None),
            'tag-targz': ('non-registry spec', None),
            'tag-tar': ('non-registry spec', None),
            'tag-upper': ('non-registry spec', None),
            'pre-tgz': ('non-registry spec', None),
            'named.tgz': ('non-registry spec', None),
            'dup-mcp': ('^1.0.0', NPM % 'dup-mcp'),
        }
        self.assertEqual({n: (r['declared'], r['source_url']) for n, r in rows.items()}, expect)

    def test_mcp_launches(self):
        rows = {e['used_in'][0]: e for e in self.entries if e['type'] == 'mcp' and e['path'].endswith('.mcp.json')}
        U, N = 'unparsed launcher', 'non-registry spec'
        expect = {
            'tilde': ('pkg-tilde', None, NPM % 'pkg-tilde'),
            'caret': ('@acme/scoped', None, NPM % '@acme/scoped'),
            'exact': ('@acme/exact', '1.2.3', NPM % '@acme/exact'),
            'plain': ('plain-mcp', None, NPM % 'plain-mcp'),
            'url': ('url', None, None),
            'gh': ('gh', None, None),
            'gitplus': ('gitplus', None, None),
            'tarball': ('tarball', None, None),
            'alias': ('alias', None, None),
            'upper': ('upper', None, None),
            'unknown-opt': ('unknown-opt', None, None),
            'p-remote': ('p-remote', None, None),
            'package-eq': ('package-eq', None, None),
            'dashdash': ('dashdash', None, None),
            'noargs': ('noargs', None, None),
            'uv-plain': ('mcp-server-fetch', None, PYPI % 'mcp-server-fetch'),
            'uv-pinned': ('mcp-server-fetch', '1.2.3', PYPI % 'mcp-server-fetch'),
            'uv-extras': ('tool-pkg', '2.0', PYPI % 'tool-pkg'),
            'uv-from-remote': ('uv-from-remote', None, None),
            'uv-with': ('uv-with', None, None),
            'uv-y': ('uv-y', None, None),
            'uv-at': ('uv-at', None, None),
            'uv-url': ('uv-url', None, None),
            'tag-tarball': ('tag-tarball', None, None),
            'tag-tar': ('tag-tar', None, None),
            'dup-mcp': ('dup-mcp', None, None),
            'uv-whl': ('uv-whl', None, None),
            'uv-sdist': ('uv-sdist', None, None),
            'uv-zip': ('uv-zip', None, None),
            'npx-tar-gz-loose': ('npx-tar-gz-loose', None, None),
            'newline': ('newline', None, None),
            'uv-newline': ('uv-newline', None, None),
        }
        self.assertEqual({k: (r['name'], r['version'], r['source_url']) for k, r in rows.items()}, expect)
        labels = {k: r['declared'] for k, r in rows.items() if r['source_url'] is None}
        self.assertEqual(labels, {
            'url': N, 'gh': N, 'gitplus': N, 'tarball': N, 'alias': N, 'upper': N,
            'unknown-opt': U, 'p-remote': U, 'package-eq': U, 'dashdash': U, 'noargs': U,
            'uv-from-remote': U, 'uv-with': U, 'uv-y': U, 'uv-at': N, 'uv-url': N,
            'tag-tarball': N, 'tag-tar': N, 'dup-mcp': N, 'uv-whl': N, 'uv-sdist': N, 'uv-zip': N,
            'npx-tar-gz-loose': N, 'newline': N, 'uv-newline': N})
        # no raw non-registry value anywhere in the output
        for frag in ('registry.example.com', 'github:', 'git+https', 'pkg-1.0.0.tgz', 'npm:real',
                     'remote-pkg', 'files.example.com', 'bin-name', 'foo.tgz', '.tar', '.TGZ',
                     'py3-none-any', '.whl', 'x-1.0.tar.gz', '.ZIP', 'tar_gz', 'rc.TGZ', 'foo\\n'):
            self.assertNotIn(frag, self.raw)

    def test_a_labelled_row_never_swallows_a_registry_row_of_the_same_name(self):
        dups = sorted((e['path'].rsplit('/', 1)[-1], e['declared'], e['source_url'])
                      for e in self.entries if e['name'] == 'dup-mcp')
        self.assertEqual(dups, [('.mcp.json', 'non-registry spec', None),
                                ('package.json', '^1.0.0', NPM % 'dup-mcp')])

    def test_every_link_is_null_or_the_exact_registry_page(self):
        for e in self.entries:
            if e['type'] not in ('npm', 'mcp'):
                continue
            if e['declared'] in ('non-registry spec', 'unparsed launcher'):
                self.assertIsNone(e['source_url'], e)
            else:
                self.assertIn(e['source_url'], (NPM % e['name'], PYPI % e['name']), e)
                # ...and the linked name itself is a registry name, checked here independently
                if e['source_url'] == NPM % e['name']:
                    self.assertRegex(e['name'], r'^(?:@[a-z0-9~-][a-z0-9._~-]*/)?[a-z0-9~-][a-z0-9._~-]*$')
                    self.assertNotRegex(e['name'], r'\.(?:tgz|tar|tar\.gz)$')
                else:
                    self.assertRegex(e['name'], r'^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$')

    def test_grammar_table(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('oss_inventory_g', SCRIPT)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        npm_pos = {'lodash': ('lodash', None), 'lodash@~4.17.21': ('lodash', '~4.17.21'),
                   'x@^1.2.0': ('x', '^1.2.0'), '@scope/pkg': ('@scope/pkg', None),
                   '@scope/pkg@1.2.3': ('@scope/pkg', '1.2.3'), 'pkg@latest': ('pkg', 'latest'),
                   'pkg@>=1.0.0': ('pkg', '>=1.0.0'), 'pkg@1.x': ('pkg', '1.x'), 'a.b-c_d': ('a.b-c_d', None)}
        for raw, want in npm_pos.items():
            self.assertEqual(m.parse_npm_spec(raw), want, raw)
        for raw in ('https://registry.example.com/pkg.tgz', 'github:acme/repo', 'git+https://github.com/a/b.git',
                    'pkg-1.0.0.tgz', 'pkg.tar.gz', 'npm:real@1', 'acme/repo', 'BadName', '.hidden', '_under',
                    'pkg@', 'pkg@not a range!', '/abs/x', './x', '~/x', 'file:x', '@scope', 'pkg@1.0.0@2',
                    'x' * 215, 'pkg@foo.tgz', 'pkg@x.tar', 'pkg@x.TAR.GZ', '@s/p@pkg-1.0.0.tgz',
                    'pkg@1.0.0-x.TGZ', 'x.tar_gz', 'pkg@x.tar_gz', 'x-1.0.zip', 'foo\n', 'pkg@1.0.0\n'):
            self.assertIsNone(m.parse_npm_spec(raw), raw)
        for rng in ('~4.17.21', '^1.2.0', '>=1.0.0 <2.0.0', '1.2.3 - 2.0.0', '1.x || 2.x', '*', '', 'latest', 'v1.2.3'):
            self.assertTrue(m.is_npm_range(rng), rng)
        for rng in ('github:a/b', 'git+https://h/x.git', 'https://h/x.tgz', 'file:../x', 'npm:x@1', 'a/b',
                    'pkg-1.0.0.tgz', 'x.tar.gz', 'x.tar', 'x.TGZ', 'foo.Tar.Gz',
                    '1.0.0-x.TGZ', '1.0.0-rc.tgz', 'x.tar_gz', '1.0.0\n', 'latest\n'):
            self.assertFalse(m.is_npm_range(rng), rng)
        pypi_pos = {'mcp-server-fetch': ('mcp-server-fetch', None), 'pkg==1.2.3': ('pkg', '1.2.3'),
                    'pkg[cli]': ('pkg', None), 'pkg[cli, x]==2.0rc1': ('pkg', '2.0rc1'), 'A_b.c': ('A_b.c', None)}
        for raw, want in pypi_pos.items():
            self.assertEqual(m.parse_pypi_spec(raw), want, raw)
        for raw in ('pkg@1.0', 'pkg>=1.0', 'git+https://h/x.git', 'https://h/x.whl', './x', '-pkg', 'pkg==',
                    'pkg[', 'pkg==1.0; python_version>"3"', 'pkg ==1.0',
                    'x-1.0-py3-none-any.whl', 'x-1.0.tar.gz', 'x-1.0.TAR.GZ', 'x-1.0.zip', 'x-1.0.tar.bz2',
                    'x-1.0.tbz', 'x-1.0.tar.xz', 'x-1.0.txz', 'x-1.0.tlz', 'x-1.0.tar.lz', 'x-1.0.tar.lzma',
                    'x-1.0.tgz', 'x-1.0.tar', 'x.tar_gz', 'foo\n', 'pkg==1.2.3\n'):
            self.assertIsNone(m.parse_pypi_spec(raw), raw)
        # local-path rule (package.json deps only): '~/' is a path, a bare '~' starts a tilde range
        for raw in ('/abs', '~/x', './x', '../x', '.', 'file:x', 'git+file:///x', 'link:x', 'workspace:*', 'C:\\x'):
            self.assertTrue(m.is_local_spec(raw), raw)
        for raw in ('~4.17.21', '~1', '^1.0.0', 'latest', 'github:a/b'):
            self.assertFalse(m.is_local_spec(raw), raw)


class WholeOutputNoTempPath(unittest.TestCase):
    def test_both_fixtures_whole_output_has_no_temp_path(self):
        for build in (build_fixture, build_private_fixture, build_local_mcp_fixture, build_grammar_fixture):
            tmp = tempfile.TemporaryDirectory()
            self.addCleanup(tmp.cleanup)
            raw = run(build(tmp.name), '--stdout')
            self.assertEqual(raw.count(tmp.name), 0, build.__name__)
            self.assertEqual(raw.count(os.path.realpath(tmp.name)), 0, build.__name__)


def _load_script(modname):
    import importlib.util
    spec = importlib.util.spec_from_file_location(modname, SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class GrammarHardening(unittest.TestCase):
    def test_archive_check_table_and_newline(self):
        m = _load_script('oss_inventory_h')
        for raw in ('x.zip', 'x.WHL', 'x.tar.bz2', 'x.tbz', 'x.tar.xz', 'x.txz', 'x.tlz', 'x.tar.lz',
                    'x.tar.lzma', 'x.tar.gz', 'x.tgz', 'x.tar', 'x.tar_gz', '1.0.0-rc.TGZ', 'X.Tar.Gz'):
            self.assertTrue(m.looks_like_archive(raw), raw)
        for raw in ('tarball', 'x.targz', 'zipper', 'pkg', '1.0.0', 'x.tar.gz.sig', 'x.tgz\n'):
            self.assertFalse(m.looks_like_archive(raw), raw)
        # '$' would accept a trailing newline; every grammar check is a full match
        self.assertFalse(m.is_npm_name('foo\n'))
        self.assertIsNone(m.parse_npm_spec('foo\n'))
        self.assertIsNone(m.parse_pypi_spec('foo\n'))
        self.assertFalse(m.is_npm_range('1.0.0\n'))
        self.assertIsNone(m.EXACT_VERSION_RE.fullmatch('1.2.3\n'))

    def test_length_cap(self):
        m = _load_script('oss_inventory_c')
        ok = ' '.join(['>=1.2.3'] * 32)
        self.assertLessEqual(len(ok), 256)
        self.assertTrue(m.is_npm_range(ok))
        long = ' '.join(['>=1.2.3'] * 40)
        self.assertGreater(len(long), 256)
        self.assertFalse(m.is_npm_range(long), 'a spec over the cap is not a registry spec')
        self.assertIsNone(m.parse_npm_spec('a' * 200 + '@' + '1' * 60))
        self.assertIsNone(m.parse_pypi_spec('a' * 257))

    def test_failing_200_char_ranges_are_rejected_in_under_50_ms(self):
        # Each shape runs in its own child with a hard timeout, so a regex that
        # backtracks exponentially fails here instead of hanging the suite.
        shapes = {
            'space-runs': '1' + '   1' * 60,
            'operators': ' '.join(['>= 1.2.3'] * 30),
            'or-sets': ' || '.join(['1.2.3 2.3.4'] * 20),
            'prerelease': ' '.join(['1.0.0-a.b-c'] * 20),
        }
        child = (
            'import importlib.util, sys, time\n'
            'spec = importlib.util.spec_from_file_location("m", sys.argv[1])\n'
            'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n'
            's = sys.argv[2]\n'
            't = time.perf_counter(); r = m.is_npm_range(s); dt = time.perf_counter() - t\n'
            'print("%s %.6f" % (r, dt))\n')
        for label, body in shapes.items():
            spec = body[:199] + '!'
            self.assertEqual(len(spec), 200)
            try:
                res = subprocess.run([sys.executable, '-I', '-c', child, SCRIPT, spec],
                                     capture_output=True, text=True, timeout=10)
            except subprocess.TimeoutExpired:
                self.fail('%s: a failing 200-char range did not finish within 10 s' % label)
            self.assertEqual(res.returncode, 0, res.stderr)
            result, secs = res.stdout.split()
            self.assertEqual(result, 'False', label)
            self.assertLess(float(secs), 0.050, '%s took %.1f ms' % (label, float(secs) * 1000))


class Clean(unittest.TestCase):
    def test_clean_source(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('oss_inventory', SCRIPT)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        cases = {
            'https://u:p@github.com/a/b.git': 'https://github.com/a/b.git',
            'git+https://u:p@github.com/a/b.git#v1': 'git+https://github.com/a/b.git#v1',
            'git@github.com:a/b.git': 'ssh://github.com/a/b.git',
            'https://tok@host:8443/p?access_token=z': 'https://host:8443/p',
            '^1.2.3': '^1.2.3',
            '@scope/pkg@1.2.3': '@scope/pkg@1.2.3',
            'npm:@s/p@1': 'npm:@s/p@1',
            'owner/repo#ref': 'owner/repo#ref',
            'https://h:99999/x': None,
        }
        for raw, want in cases.items():
            self.assertEqual(m.clean_source(raw), want, raw)
        self.assertFalse(m.is_network_remote('/tmp/clone'))
        self.assertFalse(m.is_network_remote('file:///tmp/x'))
        self.assertTrue(m.is_network_remote('ssh://github.com/a/b.git'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
