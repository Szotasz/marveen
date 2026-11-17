#!/usr/bin/env python3
"""Inventory of the command-line tools the fleet can run.

The connectors page lists MCP servers only, so a CLI that reaches a live
account (a Printing Press CLI, for example) runs out of the owner's sight.
This script makes those tools visible.

It reads, without any network access of its own:
  - <dir>/*/manifest.json      one tool per immediate subfolder of every --dir
                               (the Printing Press library layout); only
                               display_name, version, description and license
                               are taken (author, user_config and server are
                               not read into the output)
  - <dir>/*/*-pp-cli           the tool's binary: a regular, executable file
  - <binary> agent-context     the command tree, auth mode and the NAMES of the
                               auth environment variables; when the binary has
                               no agent-context, <binary> --help is read instead.
                               Per-command read-only annotations are NOT taken:
                               a parent's annotation does not cover its
                               subcommands (a read-only parent can hold writing
                               subcommands), so it would read as a permission
  - <dir>/*/*.md               which docs the folder ships, plus a README excerpt
  - SKILL.md files under every --skills-dir (global skills) and under
    <agents-dir>/*/.claude/skills that name the binary: only the agent name and
    the skill name are written, nothing of the skill text

Running the binary: the generator STARTS each binary it finds, with the
dashboard's user rights. Only the descriptive calls above are made, each with a
timeout, stdin closed, an empty temporary HOME and working directory, and an
environment of PATH, HOME and LANG only (no inherited token). That does not
sandbox the binary: configure only folders whose binaries you trust.

Folders: symlinks inside a --dir are not followed (counted in
summary.skipped_symlinks), and nothing outside the configured folders is read.

Redaction: every string in the output passes a final scrub. E-mail addresses,
URL query strings and fragments, key=value secrets and token-shaped values are
replaced by [redacted]; the number of replacements is summary.redactions.

Output (default store/cli-inventory.json):
  {generated_at, summary: {total, dirs, skipped_symlinks, probe_failures,
   redactions}, tools: [...]}
Every tool: name, display_name, description, version, license, source, root
(the --dir it was found in, as given), dir,
binary, probe, auth, commands, docs, readme_excerpt, skills.
"""
import argparse
import datetime
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
PROBE_TIMEOUT_S = 5.0
MAX_JSON_BYTES = 1024 * 1024
MAX_PROBE_BYTES = 4 * 1024 * 1024
MAX_SKILL_BYTES = 512 * 1024
README_LINES = 40
README_CHARS = 4000
MAX_COMMANDS = 200
BINARY_SUFFIX = '-pp-cli'
README_NAMES = ('README.md', 'readme.md', 'README')
PROBE_PATH = '/usr/local/bin:/usr/bin:/bin'
ENV_NAME_RE = re.compile(r'^[A-Z][A-Z0-9_]{0,63}$')
COMMAND_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')
REDACTED = '[redacted]'

# The scrub. Order matters: URL query strings first (a token in ?key= is gone
# with its whole query), then assignments, then bare token shapes.
_URL_QUERY_RE = re.compile(r'((?:https?|wss?|ftp)://[^\s?#<>"\'`)\]]*)[?#][^\s<>"\'`)\]]*', re.I)
_EMAIL_RE = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
_ASSIGN_RE = re.compile(
    r'(?i)\b([A-Za-z0-9_-]*?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)'
    r'["\']?\s*[:=]\s*["\']?)([^\s"\'&,;]{6,})')
_BEARER_RE = re.compile(r'(?i)\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})')
_TOKEN_RES = [
    re.compile(r'\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}'),
    re.compile(r'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}'),
    re.compile(r'\bgithub_pat_[A-Za-z0-9_]{20,}'),
    re.compile(r'\bxox[abposr]-[A-Za-z0-9-]{10,}'),
    re.compile(r'\bAKIA[0-9A-Z]{16}\b'),
    re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'),
    re.compile(r'\b[0-9a-fA-F]{32,}\b'),
    # A long run mixing digits, upper and lower case (a base64/base62 key). A
    # path separator ends the run, so a long file path is not taken for a key.
    re.compile(r'(?<![A-Za-z0-9_+-])(?=[A-Za-z0-9_+-]*\d)(?=[A-Za-z0-9_+-]*[a-z])(?=[A-Za-z0-9_+-]*[A-Z])'
               r'[A-Za-z0-9_+-]{40,}={0,2}'),
]


class Scrubber:
    def __init__(self):
        self.count = 0

    def text(self, s):
        def sub(regex, repl, value):
            value, n = regex.subn(repl, value)
            self.count += n
            return value
        s = sub(_URL_QUERY_RE, lambda m: m.group(1) + REDACTED, s)
        s = sub(_EMAIL_RE, REDACTED, s)
        s = sub(_ASSIGN_RE, lambda m: m.group(1) + REDACTED, s)
        s = sub(_BEARER_RE, lambda m: m.group(1) + REDACTED, s)
        for regex in _TOKEN_RES:
            s = sub(regex, REDACTED, s)
        return s

    def walk(self, value):
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.walk(v) for v in value]
        if isinstance(value, dict):
            return {k: self.walk(v) for k, v in value.items()}
        return value


def is_regular_file(path):
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def read_text(path, limit):
    if not is_regular_file(path):
        return None
    try:
        with open(path, 'rb') as f:
            raw = f.read(limit + 1)
    except OSError:
        return None
    if len(raw) > limit:
        return None
    return raw.decode('utf-8', errors='replace')


def read_json(path):
    text = read_text(path, MAX_JSON_BYTES)
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def str_or_none(value, limit=500):
    if isinstance(value, str) and value.strip():
        return value.strip()[:limit]
    return None


def inside(path, root):
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)


def list_subdirs(root, skipped):
    """Immediate, non-symlinked subfolders of root, sorted by name."""
    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name)
    except OSError:
        return []
    out = []
    for e in entries:
        if e.is_symlink():
            skipped[0] += 1
            continue
        if e.is_dir(follow_symlinks=False):
            out.append(e)
    return out


def find_binary(tool_dir, real_root):
    names = []
    try:
        entries = sorted(os.scandir(tool_dir), key=lambda e: e.name)
    except OSError:
        return None
    for e in entries:
        if not e.name.endswith(BINARY_SUFFIX) or e.is_symlink():
            continue
        if e.is_file(follow_symlinks=False) and os.access(e.path, os.X_OK) and inside(e.path, real_root):
            names.append(e.name)
    return names[0] if names else None


def run_probe(binary_path, args, timeout):
    """Run one descriptive call. Returns (status, stdout)."""
    with tempfile.TemporaryDirectory(prefix='cli-inventory-home.') as home:
        env = {'PATH': PROBE_PATH, 'HOME': home, 'LANG': 'C.UTF-8'}
        try:
            proc = subprocess.Popen(
                [binary_path] + args, cwd=home, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        except OSError:
            return 'failed', ''
        try:
            out, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            # The whole process group: a child the binary forked must not outlive the probe.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            # Not communicate(): a grandchild that left the group may still hold the pipe.
            proc.stdout.close()
            proc.wait()
            return 'timeout', ''
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
    if len(out) > MAX_PROBE_BYTES:
        return 'failed', ''
    text = out.decode('utf-8', errors='replace')
    return ('ok' if proc.returncode == 0 else 'failed'), text


def commands_from_agent_context(data):
    cmds = data.get('commands')
    if not isinstance(cmds, list):
        return None
    out = []
    for c in cmds:
        if not isinstance(c, dict):
            continue
        name = c.get('name')
        if not isinstance(name, str) or not COMMAND_NAME_RE.match(name):
            continue
        subs = c.get('subcommands') if isinstance(c.get('subcommands'), list) else []
        out.append({
            'name': name,
            'description': str_or_none(c.get('short'), 300),
            'subcommands': sorted({s['name'] for s in subs
                                   if isinstance(s, dict) and isinstance(s.get('name'), str)
                                   and COMMAND_NAME_RE.match(s['name'])}),
        })
    out.sort(key=lambda c: c['name'])
    return out[:MAX_COMMANDS]


def auth_from_agent_context(data):
    auth = data.get('auth')
    if not isinstance(auth, dict):
        return None
    names = []
    for v in auth.get('env_vars') or []:
        if isinstance(v, dict) and isinstance(v.get('name'), str) and ENV_NAME_RE.match(v['name']):
            names.append(v['name'])
    mode = auth.get('mode')
    return {
        'mode': mode if isinstance(mode, str) and COMMAND_NAME_RE.match(mode) else None,
        'env_vars': sorted(set(names)),
    }


_HELP_SECTION_RE = re.compile(r'^(?:Available )?Commands:\s*$', re.I)
_HELP_LINE_RE = re.compile(r'^\s{2,}([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})\s{2,}(\S.*)$')


def commands_from_help(text):
    out, in_section = [], False
    for line in text.splitlines():
        if _HELP_SECTION_RE.match(line.strip()):
            in_section = True
            continue
        if in_section:
            if not line.strip():
                if out:
                    break
                continue
            m = _HELP_LINE_RE.match(line)
            if not m:
                break
            out.append({'name': m.group(1), 'description': m.group(2).strip()[:300], 'subcommands': []})
    out.sort(key=lambda c: c['name'])
    return out[:MAX_COMMANDS]


def probe(binary_path, timeout):
    """(probe status, command source, commands, auth) from the descriptive calls."""
    status, text = run_probe(binary_path, ['agent-context'], timeout)
    if status == 'ok':
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if isinstance(data, dict):
            cmds = commands_from_agent_context(data)
            if cmds is not None:
                return 'ok', 'agent-context', cmds, auth_from_agent_context(data)
    if status == 'timeout':
        return 'timeout', None, [], None
    status, text = run_probe(binary_path, ['--help'], timeout)
    if status != 'ok':
        return status, None, [], None
    cmds = commands_from_help(text)
    return ('ok' if cmds else 'unparsed'), 'help', cmds, None


def docs_of(tool_dir):
    try:
        names = sorted(e.name for e in os.scandir(tool_dir)
                       if e.name.lower().endswith('.md') and e.is_file(follow_symlinks=False))
    except OSError:
        return []
    return names


def readme_excerpt(tool_dir):
    for name in README_NAMES:
        text = read_text(os.path.join(tool_dir, name), MAX_JSON_BYTES)
        if text is not None:
            return '\n'.join(text.splitlines()[:README_LINES])[:README_CHARS]
    return None


def skill_files(skills_root):
    """(skill name, SKILL.md path) for every non-symlinked skill folder."""
    real_root = os.path.realpath(skills_root)
    if not os.path.isdir(real_root):
        return []
    out = []
    for e in list_subdirs(real_root, [0]):
        path = os.path.join(e.path, 'SKILL.md')
        if is_regular_file(path):
            out.append((e.name, path))
    return out


def skill_index(skills_dirs, agents_dir):
    """[(agent or None, skill, text)] for the global and the per-agent skills."""
    rows = []
    for d in skills_dirs:
        for name, path in skill_files(os.path.expanduser(d)):
            rows.append((None, name, read_text(path, MAX_SKILL_BYTES) or ''))
    if agents_dir and os.path.isdir(agents_dir):
        for agent in list_subdirs(agents_dir, [0]):
            for name, path in skill_files(os.path.join(agent.path, '.claude', 'skills')):
                rows.append((agent.name, name, read_text(path, MAX_SKILL_BYTES) or ''))
    return rows


def skills_naming(binary, index):
    pat = re.compile(r'(?<![\w-])' + re.escape(binary) + r'(?![\w-])')
    hits = [{'scope': 'global' if agent is None else 'agent', 'agent': agent, 'skill': skill}
            for agent, skill, text in index if pat.search(text)]
    hits.sort(key=lambda h: (h['scope'] != 'global', h['agent'] or '', h['skill']))
    return hits


def scan_dir(configured, index, timeout, skipped):
    root = os.path.expanduser(configured)
    real_root = os.path.realpath(root)
    if not os.path.isdir(real_root):
        return False, []
    tools = []
    for sub in list_subdirs(real_root, skipped):
        manifest = read_json(os.path.join(sub.path, 'manifest.json'))
        if manifest is None:
            continue
        binary = find_binary(sub.path, real_root)
        if binary:
            status, source, cmds, auth = probe(os.path.join(sub.path, binary), timeout)
        else:
            status, source, cmds, auth = 'no_binary', None, [], None
        tools.append({
            'name': binary or sub.name,
            'display_name': str_or_none(manifest.get('display_name'), 200),
            'description': str_or_none(manifest.get('description')),
            'version': str_or_none(manifest.get('version'), 64),
            'license': str_or_none(manifest.get('license'), 64),
            'source': 'printing-press',
            'root': configured,
            'dir': configured.rstrip('/') + '/' + sub.name,
            'binary': binary,
            'probe': {'status': status, 'command_source': source},
            'auth': auth,
            'commands': cmds,
            'docs': docs_of(sub.path),
            'readme_excerpt': readme_excerpt(sub.path),
            'skills': skills_naming(binary, index) if binary else [],
        })
    return True, tools


def build(dirs, skills_dirs, agents_dir, timeout=PROBE_TIMEOUT_S):
    index = skill_index(skills_dirs, agents_dir)
    skipped = [0]
    tools, dir_rows = [], []
    for d in dirs:
        found, found_tools = scan_dir(d, index, timeout, skipped)
        dir_rows.append({'dir': d, 'found': found, 'tools': len(found_tools)})
        tools += found_tools
    tools.sort(key=lambda t: (t['name'].lower(), t['dir']))
    scrub = Scrubber()
    tools = scrub.walk(tools)
    dir_rows = scrub.walk(dir_rows)
    return {
        'summary': {
            'total': len(tools),
            'dirs': dir_rows,
            'skipped_symlinks': skipped[0],
            'probe_failures': sum(1 for t in tools if t['probe']['status'] not in ('ok', 'no_binary')),
            'redactions': scrub.count,
        },
        'tools': tools,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    # No default folder: every binary found is started, so the folders are
    # always named (the dashboard passes the owner's setting, and runs nothing
    # while it is empty).
    ap.add_argument('--dir', action='append', required=True,
                    help='folder holding one tool per subfolder, whose binaries you trust (repeatable, required)')
    ap.add_argument('--skills-dir', action='append', default=[],
                    help='global skills folder searched for skills naming a binary (repeatable)')
    ap.add_argument('--agents-dir', default=os.path.join(REPO_ROOT, 'agents'))
    ap.add_argument('--timeout', type=float, default=PROBE_TIMEOUT_S,
                    help='seconds per descriptive call (default %s)' % PROBE_TIMEOUT_S)
    ap.add_argument('--out', default=os.path.join(REPO_ROOT, 'store', 'cli-inventory.json'))
    ap.add_argument('--stdout', action='store_true', help='print instead of writing --out')
    args = ap.parse_args(argv)
    dirs = args.dir
    if not 0 < args.timeout <= 60:
        ap.error('--timeout must be between 0 and 60 seconds')

    # A SIGTERM (the route's timeout) unwinds through the cleanup below.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(128 + signal.SIGTERM))
    data = build(dirs, args.skills_dir, args.agents_dir, args.timeout)
    doc = {'generated_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
    doc.update(data)
    text = json.dumps(doc, ensure_ascii=False, indent=2) + '\n'
    if args.stdout:
        sys.stdout.write(text)
        return 0
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.cli-inventory.', dir=out_dir)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(tmp, args.out)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    print('%s: %d tools' % (args.out, data['summary']['total']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
