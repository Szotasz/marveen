#!/usr/bin/env python3
"""Inventory of the open-source code the agents adopted.

The connectors page's "GitHub repos" counter reads only the repos installed
through the dashboard, so it says 0 while the agents may well have vendored
pinned open-source code into their own folders (skills rewritten from GitHub
repos, npm packages, Python venvs, git clones). This script makes that visible.

It reads, strictly read-only and without any network access:
  - agents/*/.claude/skills/**   GitHub sources cited in the skill headers
  - agents/*/**/package.json     npm dependencies (node_modules is not walked;
                                 the installed copy is read only for its
                                 version / license / repository metadata)
  - agents/*/**/pyvenv.cfg       Python venvs -> site-packages/*.dist-info
  - agents/*/**/.git             git clones the scan reaches (origin + HEAD
                                 commit); some are counted instead of listed
                                 (summary.unlisted_clones), see "Git clones"
  - agents/*/**/vendor/**        unpacked packages, nested too: a PKG-INFO, or
                                 a package.json with name + version that is not
                                 private (a shipped lockfile does not change
                                 that); with node_modules next to it, its
                                 dependencies are listed as transitive
  - agents/*/.mcp.json           npx/uvx MCP servers
  - agents/*/<notes-dir>/*.md    research notes (--notes-dir, default
                                 "research"): a star count or a measured
                                 before/after is taken ONLY when the note states
                                 it, and always with its file:line source

Nothing is guessed: a field the sources do not state is null.

Output (default store/opensource-inventory.json):
  {generated_at, summary: {total, direct, by_type, by_agent, unlisted_clones,
   own_package_refs}, entries: [...]}
No absolute path is written: every entry path is relative to the agents
folder's parent.
Every entry: agent, name, type (skill|npm|pip|mcp|vendor), source_url, version,
declared, license, license_source, stars, stars_source, effect, effect_source,
path, direct, used_in.

Source strings never carry credentials: every stored URL or spec (a git
remote, an npm git spec, an MCP spec, a homepage) loses its userinfo
("https://user:TOKEN@host/..." -> "https://host/...") and its query string.

Git clones. Clones the scan reaches that have a readable http(s) or ssh
origin are listed (type vendor) unless their origin owner name is in
OSS_INVENTORY_OWN_OWNERS (passed as --own-owner). The scan does not look
inside another clone, node_modules, caches, virtual environments, unpacked
vendor packages or symlinked folders.
  - Readable http(s) or ssh origin: the clone's own "origin" remote, read
    from its git config (a .git file is followed to its gitdir), parses as
    a URL with the scheme http, https, ssh, git+ssh, git+http or git+https,
    or has the scp-like form user@host:path. Other forms (git://,
    ftp(s)://, a user-less host:path, a local path, file://, an unparsable
    URL, a .git file whose gitdir is missing, no origin) are not.
  - Owner name: the first path segment of that origin URL ("owner" in
    github.com/owner/repo), on any host, an ssh host alias included; the
    host is not compared; case-insensitive. A fork of third-party code kept
    under a named owner is matched too.
  - Ownership is not inferred from the installation's remotes.
Counted, not listed, in summary.unlisted_clones ({total, by_reason:
{owner_in_setting, no_http_ssh_origin}, by_agent, owners_in_setting,
listed_network_clones}), without its name, path or origin:
  - a clone whose origin owner name is in --own-owner (owner_in_setting);
  - a clone without a readable http(s) or ssh origin (no_http_ssh_origin).
owners_in_setting is the number of --own-owner names (not the names);
listed_network_clones is the number of clones listed, counted before
de-duplication into vendor rows.

npm self-references: a package.json dependency on the package itself, or on
a sibling package of the SAME workspace, is that project's own code and is
skipped. The workspace is the nearest ancestor package.json (the folder's own
included) whose "workspaces" patterns cover the folder; its members are the
package.json files it covers, plus itself. A package.json outside any
workspace has no siblings: a name declared elsewhere in the agent folder (an
unpacked copy of a third-party package, another project) does not hide a
registry dependency. Skips are counted in summary.own_package_refs
({total, self, workspace_sibling, by_agent}).

Dependency specs and MCP launches: a registry link and a registry name are
never guessed from them. For a package.json dependency or an .mcp.json
launch, an npmjs.com / pypi.org link and a registry name are emitted only for
a bare registry spec that matches the registry's grammar (npm package name +
optional semver range or dist-tag; PEP 508 name + optional extras + optional
==version), in full (a trailing newline included), at most 256 characters,
with no name or version part that looks like an archive or file (pip's archive
extensions, npm's .tgz/.tar.gz/.tar rule, case-insensitive), and for an MCP
launch only when the launcher has no option other than npx/bunx/pnpx
-y/--yes. Anything else (URL, git, github:, tarball, alias, local path,
--package/-p/--from, an unknown option) keeps its row with source_url null
and declared set to "non-registry spec" or "unparsed launcher", never the
raw value; such an MCP row is named by its config key. A local package.json
dependency (/, ~/, ./, ../, file:, git+file:, link:, ...) is the agent's own
code and is skipped.

Installed or vendored metadata is not a spec: a venv dist-info, a vendored
PKG-INFO or package.json, and the installed copy of a registry dependency
take their link from their own metadata (repository / Project-URL /
homepage); when the metadata names none, the link falls back to the registry
page of the name the metadata declares (pypi.org/project/<name>/ for a dist,
npmjs.com/package/<name> for a vendored npm package).

The entry list is deterministic: same tree in, byte-identical entries out.

Usage:
  python3 scripts/opensource-inventory.py [--agents-dir DIR] [--notes-dir NAME ...]
                                          [--own-owner NAME ...] [--out FILE] [--stdout]

The dashboard route passes the OSS_INVENTORY_NOTES_DIRS setting (comma
separated, default "research") as --notes-dir, and the OSS_INVENTORY_OWN_OWNERS
setting (comma separated, default empty) as --own-owner.
"""
import argparse
import datetime
import email.parser
import fnmatch
import json
import os
import re
import signal
import sys
import tempfile
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)

TYPE_ORDER = {'skill': 0, 'vendor': 1, 'mcp': 2, 'npm': 3, 'pip': 4}

# Directories never walked for package.json / venv / .git discovery.
SKIP_DIRS = {'node_modules', '.git', '__pycache__', 'site-packages', 'hf-cache', '.cache'}

# Tooling that every venv carries; not an adopted project.
PIP_TOOLING = {'pip', 'setuptools', 'wheel'}

SKILL_HEADER_LINES = 60

GITHUB_RE = re.compile(r'https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)')
MCP_NAME_RE = re.compile(r'(^|[/@_-])mcp([/_-]|$)', re.I)
# Validation patterns below are used with fullmatch(): '$' would also accept a
# trailing newline.
EXACT_VERSION_RE = re.compile(r'\d+\.\d+\.\d+([.+-][0-9A-Za-z.-]+)?')

HEADER_LICENSE_RE = re.compile(
    r'\b(MIT|Apache-2\.0|BSD-[234]-Clause|ISC|MPL-2\.0|AGPL-3\.0|LGPL-[23]\.[01]|GPL-[23]\.0|'
    r'CC BY(?:-SA|-NC)? \d\.\d|CC0-1\.0|Unlicense)\b')

# --- research-note patterns -------------------------------------------------
# The dashboard ships Hungarian and English, and research notes are written in
# either, so the word tokens below match both: "csillag" = star(s),
# "előtte" / "utána" = before / after, "repó" / "forrás" / "csomag" /
# "projekt" = repo / source / package / project.

DEFAULT_NOTES_DIRS = ('research',)
_NUM = r'~?\d{1,3}(?:[   ]\d{3})+|~?\d+(?:[.,]\d+)?\s?[kK]\b|~?\d+'
STARS_AFTER_RE = re.compile(r'(' + _NUM + r')\s*(?:\*\*)?\s*(?:csillag|stars?\b)', re.I)
STARS_LABEL_RE = re.compile(r'(?:csillag\w*|stars?)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(' + _NUM + r')', re.I)
STARS_ADJ_RE = re.compile(r'^[\s*`:(]{0,6}(~?\d+(?:[.,]\d+)?\s?[kK])\b')
STARS_LINE_RE = re.compile(r'csillag|\bstars?\b', re.I)
BEFORE_RE = re.compile(r'el[őo]tte|before', re.I)
AFTER_RE = re.compile(r'ut[áa]na|after', re.I)
ARROW_RE = re.compile(r'\d[\d.,]*\s*%?\s*(?:->|→)\s*\d')
SECTION_RE = re.compile(r'^#{1,2}\s')


URL_SCHEME_RE = re.compile(r'^[A-Za-z][A-Za-z0-9+.-]*://')
# scp-like git remote: user@host:path (no scheme, no slash before the colon)
SCP_REMOTE_RE = re.compile(r'[^\s/@:]+@(?P<host>[^\s/:@]+):(?P<path>.*)')
REMOTE_SCHEMES = {'http', 'https', 'ssh', 'git+ssh', 'git+https', 'git+http'}


def clean_source(s):
    """A URL or spec without credentials: userinfo and the query string are
    dropped from a URL-like value (scheme://...); an scp-like user@host:path
    becomes ssh://host/path.
    Anything else (an npm range, "@scope/pkg@1.2.3", "owner/repo#ref") is
    returned unchanged. An unparsable URL becomes None rather than verbatim."""
    if not isinstance(s, str):
        return s
    if URL_SCHEME_RE.match(s):
        try:
            u = urllib.parse.urlsplit(s)
            host = u.hostname or ''
            port = u.port
        except ValueError:
            return None
        if ':' in host:
            host = '[%s]' % host
        if port is not None:
            host = '%s:%d' % (host, port)
        return urllib.parse.urlunsplit((u.scheme, host, u.path, '', u.fragment))
    m = SCP_REMOTE_RE.fullmatch(s)
    if m:
        return 'ssh://%s/%s' % (m.group('host'), m.group('path').lstrip('/'))
    return s


def is_network_remote(url):
    """True for an http(s) / ssh git remote (scp-like included)."""
    if not isinstance(url, str) or not url:
        return False
    if URL_SCHEME_RE.match(url):
        return url.split('://', 1)[0].lower() in REMOTE_SCHEMES
    return bool(SCP_REMOTE_RE.fullmatch(url))


def norm_pip(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def rel(path, base):
    return os.path.relpath(path, base).replace(os.sep, '/')


def read_text(path, limit=None):
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read() if limit is None else f.read(limit)
    except OSError:
        return None


def read_json(path):
    text = read_text(path)
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def github_slug(url):
    """'git+https://github.com/A/B.git#x' -> ('A/B', 'https://github.com/A/B')."""
    if not url:
        return None, None
    m = GITHUB_RE.search(url.replace('git+', '').replace('git://', 'https://')
                         .replace('ssh://git@github.com/', 'https://github.com/')
                         .replace('ssh://github.com/', 'https://github.com/')
                         .replace('git@github.com:', 'https://github.com/'))
    if not m:
        return None, None
    owner, repo = m.group(1), m.group(2)
    repo = re.sub(r'\.git$', '', repo).rstrip('.')
    return '%s/%s' % (owner, repo), 'https://github.com/%s/%s' % (owner, repo)


def license_from_file(dirpath):
    """SPDX-ish id from a LICENSE file's opening text, or None."""
    try:
        names = sorted(os.listdir(dirpath))
    except OSError:
        return None
    for n in names:
        if not re.fullmatch(r'(LICEN[CS]E|COPYING)(\.(md|txt|rst))?', n, re.I):
            continue
        head = read_text(os.path.join(dirpath, n), 4000) or ''
        h = ' '.join(head.split())
        if re.search(r'Apache License,? Version 2\.0', h, re.I):
            return 'Apache-2.0'
        if h.upper().startswith('MIT LICENSE') or 'Permission is hereby granted, free of charge' in h:
            return 'MIT'
        if re.search(r'GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3', h, re.I):
            return 'AGPL-3.0'
        if re.search(r'GNU LESSER GENERAL PUBLIC LICENSE', h, re.I):
            return 'LGPL'
        if re.search(r'GNU GENERAL PUBLIC LICENSE\s+Version 3', h, re.I):
            return 'GPL-3.0'
        if re.search(r'GNU GENERAL PUBLIC LICENSE\s+Version 2', h, re.I):
            return 'GPL-2.0'
        if re.search(r'Mozilla Public License,? v(ersion)?\.? ?2\.0', h, re.I):
            return 'MPL-2.0'
        if re.search(r'Redistribution and use in source and binary forms', h):
            return 'BSD-3-Clause' if re.search(r'Neither the name', h) else 'BSD-2-Clause'
        if re.search(r'ISC License', h):
            return 'ISC'
        return None
    return None


def entry(agent, name, type_, path, **kw):
    e = {
        'agent': agent, 'name': name, 'type': type_, 'source_url': None,
        'version': None, 'declared': None, 'license': None, 'license_source': None,
        'stars': None, 'stars_source': None, 'effect': None, 'effect_source': None,
        'path': path, 'direct': True, 'used_in': [],
    }
    e.update(kw)
    for k in ('name', 'source_url', 'declared'):
        e[k] = clean_source(e[k])
    return e


# --- discovery --------------------------------------------------------------

def is_vendored_npm(root):
    """A vendored npm package (an unpacked tarball): its package.json names
    the package and its version and is not private. A lockfile or a
    shrinkwrap does not make it an install folder (published tarballs ship
    them); only private: true does."""
    pkg = read_json(os.path.join(root, 'package.json'))
    if not isinstance(pkg, dict) or pkg.get('private') is True:
        return False
    name, version = pkg.get('name'), pkg.get('version')
    return isinstance(name, str) and bool(name.strip()) and isinstance(version, str) and bool(version.strip())


# A package.json dependency spec that points at the local filesystem: such a
# dependency is the agent's own code, not adopted open-source code, and is
# skipped. '~/' is a home path; a bare '~' starts an npm tilde range.
LOCAL_SPEC_PREFIXES = ('/', '~/', './', '../', 'file:', 'git+file:', 'link:', 'workspace:', 'portal:')
WINDOWS_PATH_RE = re.compile(r'^[A-Za-z]:[\\/]')


def is_local_spec(spec):
    return isinstance(spec, str) and (spec in ('.', '..') or spec.startswith(LOCAL_SPEC_PREFIXES)
                                      or bool(WINDOWS_PATH_RE.match(spec)))


# --- registry identity: a strict grammar, never a guess -----------------------
# A registry link (npmjs.com / pypi.org) and a registry name are emitted ONLY
# for a bare registry spec: a package name that matches the registry's naming
# rule, optionally with a version. Anything else (a URL, git or github: spec,
# a tarball, a local path, an alias) keeps its row, but with source_url null
# and declared reduced to a fixed label, never the raw value.
NON_REGISTRY_SPEC = 'non-registry spec'
UNPARSED_LAUNCHER = 'unparsed launcher'

# A spec longer than this is not a registry spec (and is not fed to the
# range grammar).
MAX_SPEC_LEN = 256

# npm's package-name rule (validate-npm-package-name, new packages): lower case,
# optional @scope/, at most 214 characters.
NPM_NAME_RE = re.compile(r'(?:@[a-z0-9~-][a-z0-9._~-]*/)?[a-z0-9~-][a-z0-9._~-]*')

# "Looks like an archive or a file", applied to every name AND every range /
# tag / version part on both the npm and the PyPI side, case-insensitive:
# pip's ARCHIVE_EXTENSIONS, plus npm-package-arg's own looser isFileType rule
# ([.](?:tgz|tar.gz|tar)$ with the unescaped dot, so "x.tar_gz" counts too).
# npm and pip resolve such a spec as a file, never as a registry name.
ARCHIVE_RE = re.compile(
    r'(?:\.(?:zip|whl|tar\.bz2|tbz|tar\.xz|txz|tlz|tar\.lz|tar\.lzma|tar\.gz|tgz|tar)'
    r'|[.](?:tgz|tar.gz|tar))\Z', re.I)


def looks_like_archive(s):
    return isinstance(s, str) and bool(ARCHIVE_RE.search(s))


# semver ranges. Each whitespace run has exactly one way to match: the
# whitespace after an operator belongs to the operator, the whitespace between
# comparators to the separator, so a failing spec is rejected in linear time.
_SV_PART = r'(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?'
_SV_COMP = r'(?:(?:[~^]|[<>]=?|=)\s*)?v?' + _SV_PART
_SV_SET = r'(?:' + _SV_PART + r'\s+-\s+' + _SV_PART + r'|' + _SV_COMP + r'(?:\s+' + _SV_COMP + r')*)'
NPM_RANGE_RE = re.compile(r'(?:' + _SV_SET + r'(?:\s*\|\|\s*' + _SV_SET + r')*|[a-z][a-z0-9._-]*)?')
NPM_SPEC_RE = re.compile(r'(?P<name>@[^@/\s]+/[^@/\s]+|[^@/\s]+)(?:@(?P<range>[^\s]*))?')

# PEP 508 project name, optional [extras] (stripped for the link), optional
# ==version (PEP 440 public version).
_PEP508_NAME = r'[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?'
PYPI_SPEC_RE = re.compile(r'(?P<name>' + _PEP508_NAME + r')'
                          r'(?:\[\s*' + _PEP508_NAME + r'(?:\s*,\s*' + _PEP508_NAME + r')*\s*\])?'
                          r'(?:==(?P<version>(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?'
                          r'(?:\+[a-z0-9]+(?:\.[a-z0-9]+)*)?))?', re.I)


def is_npm_name(name):
    return (isinstance(name, str) and 0 < len(name) <= 214 and bool(NPM_NAME_RE.fullmatch(name))
            and not looks_like_archive(name))


def is_npm_range(spec):
    # A file name in the range / tag position ("pkg-1.0.0.tgz", even a valid
    # semver like "1.0.0-rc.TGZ") is resolved by npm as a local file
    # (npm-package-arg isFileType), so it is not a registry range.
    return (isinstance(spec, str) and len(spec) <= MAX_SPEC_LEN and bool(NPM_RANGE_RE.fullmatch(spec))
            and not looks_like_archive(spec))


def parse_npm_spec(spec):
    """(name, range) for a bare npm registry spec "name" / "name@range", else None."""
    if not isinstance(spec, str) or len(spec) > MAX_SPEC_LEN or looks_like_archive(spec):
        return None
    m = NPM_SPEC_RE.fullmatch(spec)
    if not m or not is_npm_name(m.group('name')):
        return None
    rng = m.group('range')
    if rng is not None and (rng == '' or not is_npm_range(rng)):
        return None
    return m.group('name'), rng


def parse_pypi_spec(spec):
    """(name, version) for a bare PyPI spec "name", "name[extras]", "name==ver", else None.
    A wheel / sdist file name ("x-1.0-py3-none-any.whl", "x-1.0.tar.gz") is a file, not a name."""
    if not isinstance(spec, str) or len(spec) > MAX_SPEC_LEN or looks_like_archive(spec):
        return None
    m = PYPI_SPEC_RE.fullmatch(spec)
    if not m or looks_like_archive(m.group('name')) or looks_like_archive(m.group('version') or ''):
        return None
    return m.group('name'), m.group('version')


def walk_agent(agent_dir):
    """[(kind, path)] under one agent: package / venv / git / sdist."""
    found = []
    for root, dirs, files in os.walk(agent_dir):
        dirs.sort()
        if root != agent_dir and '.git' in dirs + files:
            found.append(('git', root))
            dirs[:] = []
            continue
        # A source tree unpacked anywhere under a vendor/ folder without git (a
        # PyPI sdist, an npm tarball, also nested like
        # vendor/<group>/<pkg>-<version>): its own metadata names it, and it is
        # not walked further. Its package.json lists ITS dependencies, not the
        # agent's: they are reported only when installed next to it
        # (node_modules), and then as transitive (direct: false).
        # A private package.json is the agent's own install folder: it falls
        # through to the npm scanner, which reports its pinned dependencies.
        under_vendor = 'vendor' in os.path.relpath(root, agent_dir).split(os.sep)[:-1]
        if under_vendor and ('PKG-INFO' in files or ('package.json' in files and is_vendored_npm(root))):
            found.append(('sdist', root))
            if 'PKG-INFO' not in files and 'node_modules' in dirs:
                found.append(('package-transitive', os.path.join(root, 'package.json')))
            dirs[:] = []
            continue
        if 'pyvenv.cfg' in files:
            found.append(('venv', root))
            dirs[:] = []
            continue
        if 'package.json' in files:
            found.append(('package', os.path.join(root, 'package.json')))
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not os.path.islink(os.path.join(root, d))]
    return found


def scan_skills(agent, agent_dir, base):
    skills_dir = os.path.join(agent_dir, '.claude', 'skills')
    by_slug = {}
    if not os.path.isdir(skills_dir):
        return []
    for root, dirs, files in os.walk(skills_dir):
        dirs.sort()
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in sorted(files):
            fp = os.path.join(root, fn)
            text = read_text(fp, 200_000)
            if text is None or '\x00' in text:
                continue
            skill_name = rel(fp, skills_dir).split('/')[0]
            for line in text.splitlines()[:SKILL_HEADER_LINES]:
                for m in GITHUB_RE.finditer(line):
                    slug, url = github_slug(m.group(0))
                    if not slug:
                        continue
                    lic = None
                    tail = line[m.end():]
                    lm = HEADER_LICENSE_RE.search(tail)
                    if lm:
                        lic = lm.group(1)
                    e = by_slug.get(slug.lower())
                    if e is None:
                        e = entry(agent, slug, 'skill', rel(fp, base), source_url=url,
                                  license=lic, license_source='skill-header' if lic else None)
                        by_slug[slug.lower()] = e
                    elif e['license'] is None and lic:
                        e['license'], e['license_source'] = lic, 'skill-header'
                    if skill_name not in e['used_in']:
                        e['used_in'].append(skill_name)
    for e in by_slug.values():
        e['used_in'].sort()
    return list(by_slug.values())


def npm_license(pkg):
    lic = pkg.get('license')
    if isinstance(lic, dict):
        lic = lic.get('type')
    if not lic and isinstance(pkg.get('licenses'), list) and pkg['licenses']:
        first = pkg['licenses'][0]
        lic = first.get('type') if isinstance(first, dict) else first
    return lic if isinstance(lic, str) and lic.strip() else None


def npm_repo_url(pkg):
    repo = pkg.get('repository')
    if isinstance(repo, dict):
        repo = repo.get('url')
    if isinstance(repo, str) and repo:
        repo = clean_source(repo) or ''
        if re.fullmatch(r'[\w.-]+/[\w.-]+', repo):  # "owner/repo" shorthand
            repo = 'https://github.com/' + repo
        elif repo.startswith('github:'):
            repo = 'https://github.com/' + repo[len('github:'):]
        slug, url = github_slug(repo)
        if url:
            return url
    hp = clean_source(pkg.get('homepage'))
    if isinstance(hp, str) and hp.startswith('http'):
        slug, url = github_slug(hp)
        return url or hp
    return None


def package_name(pkg_path):
    pkg = read_json(pkg_path)
    name = pkg.get('name') if isinstance(pkg, dict) else None
    return name if isinstance(name, str) and name.strip() else None


def workspace_patterns(pkg):
    """The "workspaces" globs of a package.json (npm/yarn array, or yarn's
    {packages: [...]}), else None."""
    ws = pkg.get('workspaces') if isinstance(pkg, dict) else None
    if isinstance(ws, dict):
        ws = ws.get('packages')
    if not isinstance(ws, list):
        return None
    return [p for p in ws if isinstance(p, str) and p.strip()]


def _glob_segments(pat, segs):
    """Per-segment glob match, '**' = any number of segments. Consecutive
    '**' collapse into one and each (pattern index, segment index) state is
    solved once, so the cost is bounded by (len(pat) + 1) * (len(segs) + 1)
    states instead of growing exponentially with the number of '**'."""
    collapsed = []
    for p in pat:
        if not (p == '**' and collapsed and collapsed[-1] == '**'):
            collapsed.append(p)
    pat = collapsed
    memo = {}
    # Iterative over the state table (no recursion-depth limit on deep paths):
    # ok[i][j] = pat[i:] matches segs[j:], filled from the end.
    for i in range(len(pat), -1, -1):
        for j in range(len(segs), -1, -1):
            if i == len(pat):
                r = j == len(segs)
            elif pat[i] == '**':
                r = memo[(i + 1, j)] or (j < len(segs) and memo[(i, j + 1)])
            else:
                r = j < len(segs) and fnmatch.fnmatchcase(segs[j], pat[i]) and memo[(i + 1, j + 1)]
            memo[(i, j)] = bool(r)
    return memo[(0, 0)]


def workspace_covers(patterns, relpath):
    """True when a member folder (relpath from the workspace root, '/'
    separated) matches the patterns: per-segment globs, '**' for any depth,
    '!pattern' excludes. Surrounding whitespace is stripped first; a pattern
    leaving the root ('..', absolute) does not match."""
    segs = [s for s in relpath.split('/') if s and s != '.']
    hit = False
    for raw in patterns:
        body = raw.strip()
        neg = body.startswith('!')
        if neg:
            body = body[1:].strip()
        pat = [s for s in body.split('/') if s and s != '.']
        if not pat or body.startswith('/') or '..' in pat:
            continue
        if _glob_segments(pat, segs):
            hit = not neg
    return hit


def workspace_root(pkg_dir, agent_dir):
    """The folder of the workspace pkg_dir belongs to, or None: the nearest
    folder from pkg_dir up to agent_dir whose package.json declares
    workspaces that cover pkg_dir (pkg_dir itself when it declares them)."""
    d = pkg_dir
    while True:
        pats = workspace_patterns(read_json(os.path.join(d, 'package.json')))
        if pats is not None and (d == pkg_dir or workspace_covers(pats, rel(pkg_dir, d))):
            return d
        if d == agent_dir or os.path.dirname(d) == d:
            return None
        d = os.path.dirname(d)


SELF_REF = 'self'
SIBLING_REF = 'workspace_sibling'


def scan_package(agent, pkg_path, base, direct=True, siblings=frozenset(), skipped=None):
    """The dependencies of one package.json. A dependency on the package
    itself, or on a name in siblings (the other members of its own
    workspace), is the project's own code: it is skipped and counted in
    skipped[SELF_REF] / skipped[SIBLING_REF]."""
    pkg = read_json(pkg_path)
    if not isinstance(pkg, dict):
        return []
    pkg_dir = os.path.dirname(pkg_path)
    self_name = package_name(pkg_path)
    out = []
    for field in ('dependencies', 'optionalDependencies', 'devDependencies'):
        deps = pkg.get(field)
        if not isinstance(deps, dict):
            continue
        for name in sorted(deps):
            spec = deps[name]
            if not isinstance(spec, str) or is_local_spec(spec):
                continue
            ref = SELF_REF if name == self_name else SIBLING_REF if name in siblings else None
            if ref:
                if skipped is not None:
                    skipped[ref] = skipped.get(ref, 0) + 1
                continue
            registry = is_npm_name(name) and is_npm_range(spec)
            inst = read_json(os.path.join(pkg_dir, 'node_modules', *name.split('/'), 'package.json')) \
                if is_npm_name(name) else None
            inst = inst if isinstance(inst, dict) else {}
            lic = npm_license(inst)
            out.append(entry(
                agent, name, 'mcp' if MCP_NAME_RE.search(name) else 'npm', rel(pkg_path, base),
                source_url=(npm_repo_url(inst) or 'https://www.npmjs.com/package/%s' % name) if registry else None,
                version=inst.get('version') if isinstance(inst.get('version'), str) else None,
                declared=spec if registry else NON_REGISTRY_SPEC,
                license=lic, license_source='package-metadata' if lic else None,
                direct=direct,
            ))
    return out


def pip_license(meta):
    expr = (meta.get('License-Expression') or '').strip()
    if expr:
        return expr
    lic = (meta.get('License') or '').strip()
    if lic and lic.upper() != 'UNKNOWN' and '\n' not in lic and len(lic) <= 80:
        return lic
    classes = [c.split('::')[-1].strip() for c in (meta.get_all('Classifier') or [])
               if c.startswith('License ::') and c.split('::')[-1].strip() not in ('OSI Approved',)]
    if classes:
        return '; '.join(sorted(set(classes)))
    return None


def pip_source_url(meta, name):
    urls = []
    for pu in meta.get_all('Project-URL') or []:
        if ',' in pu:
            urls.append(pu.split(',', 1)[1].strip())
    hp = (meta.get('Home-page') or '').strip()
    if hp:
        urls.append(hp)
    for u in urls:
        slug, gh = github_slug(u)
        if gh:
            return gh
    for u in urls:
        if u.startswith('http'):
            return u
    return 'https://pypi.org/project/%s/' % name


def scan_venv(agent, venv_dir, base):
    sites = []
    lib = os.path.join(venv_dir, 'lib')
    if os.path.isdir(lib):
        for py in sorted(os.listdir(lib)):
            sp = os.path.join(lib, py, 'site-packages')
            if os.path.isdir(sp):
                sites.append(sp)
    dists = {}
    parser = email.parser.Parser()
    for sp in sites:
        for d in sorted(os.listdir(sp)):
            if not d.endswith('.dist-info'):
                continue
            text = read_text(os.path.join(sp, d, 'METADATA'))
            if text is None:
                continue
            meta = parser.parsestr(text, headersonly=True)
            name, version = meta.get('Name'), meta.get('Version')
            if not name:
                continue
            key = norm_pip(name)
            if key in PIP_TOOLING or key in dists:
                continue
            requires = set()
            for r in meta.get_all('Requires-Dist') or []:
                # An optional extra is not a dependency: counting it would mark
                # e.g. an explicitly installed duckdb as pandas' transitive.
                if re.search(r'\bextra\s*==', r):
                    continue
                m = re.match(r'\s*([A-Za-z0-9][A-Za-z0-9._-]*)', r)
                if m:
                    requires.add(norm_pip(m.group(1)))
            dists[key] = (name, version, meta, requires)
    required = set()
    for key, (_, _, _, reqs) in dists.items():
        required |= {r for r in reqs if r != key}
    out = []
    for key in sorted(dists):
        name, version, meta, _ = dists[key]
        lic = pip_license(meta)
        out.append(entry(
            agent, name, 'pip', rel(venv_dir, base),
            source_url=pip_source_url(meta, name), version=version,
            license=lic, license_source='package-metadata' if lic else None,
            direct=key not in required,
        ))
    return out


def git_dirs(repo_dir):
    """(gitdir, commondir) of a checkout, or (None, None). A '.git' FILE (a
    git worktree or submodule: "gitdir: <path>") is followed; the config of a
    worktree lives in the main repo's gitdir (its 'commondir')."""
    gd = os.path.join(repo_dir, '.git')
    if os.path.isfile(gd):
        line = (read_text(gd, 4096) or '').strip()
        if not line.startswith('gitdir:'):
            return None, None
        gd = os.path.normpath(os.path.join(repo_dir, line[len('gitdir:'):].strip()))
    if not os.path.isdir(gd):
        return None, None
    common = (read_text(os.path.join(gd, 'commondir'), 4096) or '').strip()
    cd = os.path.normpath(os.path.join(gd, common)) if common else gd
    return gd, cd


REMOTE_SECTION_RE = re.compile(r'\[remote\s+"([^"]*)"\]')


def git_remotes(commondir):
    """{remote name: cleaned url} from a gitdir's config."""
    cfg = (read_text(os.path.join(commondir, 'config')) or '') if commondir else ''
    out, cur = {}, None
    for line in cfg.splitlines():
        s = line.strip()
        if s.startswith('['):
            m = REMOTE_SECTION_RE.fullmatch(s)
            cur = m.group(1) if m else None
        elif cur is not None and re.match(r'url\s*=', s) and cur not in out:
            out[cur] = clean_source(s.split('=', 1)[1].strip())
    return out


def remote_owner(url):
    """The owner of a network git remote (first path segment, lower case:
    'acme' for https://github.com/acme/x.git, git@github.com:acme/x.git or
    git@my-host-alias:acme/x.git), else None."""
    if not is_network_remote(url):
        return None
    url = clean_source(url)
    try:
        path = urllib.parse.urlsplit(url).path if url else ''
    except ValueError:
        return None
    parts = [p for p in path.split('/') if p]
    return parts[0].lower() if len(parts) >= 2 else None


OWNER_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}')


def git_info(repo_dir):
    gd, cd = git_dirs(repo_dir)
    if gd is None:
        return None, None
    url = git_remotes(cd).get('origin')
    head = (read_text(os.path.join(gd, 'HEAD')) or '').strip()
    commit = None
    if re.fullmatch(r'[0-9a-f]{40}', head):
        commit = head
    elif head.startswith('ref: '):
        ref = head[5:].strip()
        # A worktree keeps its branch refs in the main repo's gitdir.
        for d in dict.fromkeys((gd, cd)):
            loose = (read_text(os.path.join(d, *ref.split('/'))) or '').strip()
            if re.fullmatch(r'[0-9a-f]{40}', loose):
                commit = loose
                break
            for line in (read_text(os.path.join(d, 'packed-refs')) or '').splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[1] == ref and re.fullmatch(r'[0-9a-f]{40}', parts[0]):
                    commit = parts[0]
            if commit:
                break
    return url, commit


OWNER_IN_SETTING = 'owner_in_setting'
NO_HTTP_SSH_ORIGIN = 'no_http_ssh_origin'
LISTED = 'listed'


def classify_clone(repo_dir, setting_owners):
    """(LISTED, url, commit) for a clone with a readable http(s) or ssh origin
    (is_network_remote on the cleaned URL) whose owner name is not in
    setting_owners (the --own-owner names, lower case), else
    (OWNER_IN_SETTING | NO_HTTP_SSH_ORIGIN, None, None). The input is the
    clone's own origin URL."""
    url, commit = git_info(repo_dir)
    if not is_network_remote(url):
        return NO_HTTP_SSH_ORIGIN, None, None
    if remote_owner(url) in setting_owners:
        return OWNER_IN_SETTING, None, None
    return LISTED, url, commit


def scan_vendor(agent, repo_dir, base, url, commit):
    slug, gh = github_slug(url)
    lic = license_from_file(repo_dir)
    return [entry(agent, slug or os.path.basename(repo_dir), 'vendor', rel(repo_dir, base),
                  source_url=gh or url, version=commit[:12] if commit else None,
                  license=lic, license_source='license-file' if lic else None)]


def scan_sdist(agent, src_dir, base):
    name = version = url = lic = None
    lic_src = None
    if os.path.isfile(os.path.join(src_dir, 'PKG-INFO')):
        meta = email.parser.Parser().parsestr(read_text(os.path.join(src_dir, 'PKG-INFO')) or '', headersonly=True)
        name, version = meta.get('Name'), meta.get('Version')
        if name:
            url = pip_source_url(meta, name)
            lic = pip_license(meta)
    else:
        pkg = read_json(os.path.join(src_dir, 'package.json'))
        if isinstance(pkg, dict) and isinstance(pkg.get('name'), str):
            name = pkg['name']
            version = pkg.get('version') if isinstance(pkg.get('version'), str) else None
            url = npm_repo_url(pkg) or 'https://www.npmjs.com/package/%s' % name
            lic = npm_license(pkg)
    if not name:
        return []
    if lic:
        lic_src = 'package-metadata'
    else:
        lic = license_from_file(src_dir)
        lic_src = 'license-file' if lic else None
    slug, _ = github_slug(url)
    return [entry(agent, slug or name, 'vendor', rel(src_dir, base), source_url=url,
                  version=version, declared=name if slug else None,
                  license=lic, license_source=lic_src)]


# The only launcher options that leave "the first positional argument is the
# package" true. Any other option (--package / -p / --from in any form, an
# unknown option, '--') makes the launch unparsed: which project it runs is
# not decided here.
HARMLESS_LAUNCHER_OPTS = {'npx': {'-y', '--yes'}, 'bunx': {'-y', '--yes'}, 'pnpx': {'-y', '--yes'}, 'uvx': set()}
REGISTRY_URL = {'uvx': 'https://pypi.org/project/%s/'}
NPM_URL = 'https://www.npmjs.com/package/%s'


def classify_mcp_launch(cmd, args):
    """('registry', name, version, spec) for a bare registry launch, else
    ('unparsed launcher' | 'non-registry spec', None, None, None)."""
    harmless = HARMLESS_LAUNCHER_OPTS.get(cmd, set())
    i = 0
    while i < len(args) and args[i].startswith('-'):
        if args[i] not in harmless:
            return UNPARSED_LAUNCHER, None, None, None
        i += 1
    if i >= len(args):
        return UNPARSED_LAUNCHER, None, None, None
    spec = args[i]
    if cmd == 'uvx':
        parsed = parse_pypi_spec(spec)
        if not parsed:
            return NON_REGISTRY_SPEC, None, None, None
        return 'registry', parsed[0], parsed[1], spec
    parsed = parse_npm_spec(spec)
    if not parsed:
        return NON_REGISTRY_SPEC, None, None, None
    name, rng = parsed
    return 'registry', name, rng if rng and EXACT_VERSION_RE.fullmatch(rng) else None, spec


def scan_mcp_json(agent, agent_dir, base):
    fp = os.path.join(agent_dir, '.mcp.json')
    cfg = read_json(fp)
    servers = cfg.get('mcpServers') if isinstance(cfg, dict) else None
    if not isinstance(servers, dict):
        return []
    out = []
    for key in sorted(servers):
        s = servers[key]
        if not isinstance(s, dict):
            continue
        cmd = os.path.basename(str(s.get('command') or ''))
        if cmd not in ('npx', 'bunx', 'uvx', 'pnpx'):
            continue
        args = [a for a in (s.get('args') or []) if isinstance(a, str)]
        kind, name, ver, spec = classify_mcp_launch(cmd, args)
        if kind != 'registry':
            # The row stays (the server exists), named by its config key only:
            # no link, no raw launch value.
            out.append(entry(agent, key, 'mcp', rel(fp, base), source_url=None,
                             declared=kind, used_in=[key]))
            continue
        url = REGISTRY_URL.get(cmd, NPM_URL) % name
        out.append(entry(agent, name, 'mcp', rel(fp, base), source_url=url,
                         version=ver, declared=spec, used_in=[key]))
    return out


# --- research notes ---------------------------------------------------------

def load_research(agents_dir, agents, notes_dirs=DEFAULT_NOTES_DIRS):
    notes = {}
    for a in agents:
        files = []
        for nd in notes_dirs:
            d = os.path.join(agents_dir, a, nd)
            if os.path.isdir(d):
                for fn in sorted(os.listdir(d)):
                    fp = os.path.join(d, fn)
                    if fn.endswith('.md') and os.path.isfile(fp):
                        files.append((fp, (read_text(fp) or '').splitlines()))
        notes[a] = files
    return notes


def notes_dirs_from(cli_value):
    """--notes-dir values, else the default. A name is one plain directory
    under the agent folder: no separator, no '..'."""
    names = list(cli_value) if cli_value else list(DEFAULT_NOTES_DIRS)
    out = []
    for n in names:
        if n in ('.', '..') or '/' in n or os.sep in n or not n:
            raise ValueError('notes dir must be one directory name, got %r' % n)
        if n not in out:
            out.append(n)
    return tuple(out)


def ident_patterns(e):
    """(strong, bare) regexes naming this entry in prose.

    strong: a GitHub owner/repo or a scoped npm name -- specific enough that
    the nearest star count AFTER it on the same line is its own.
    bare: a plain package name ("playwright", "remotion") -- ambiguous in
    prose ("Playwright MCP" is a different project), so it only counts when
    the number sits right next to it, or in a table row that names it.
    """
    slug, _ = github_slug(e.get('source_url') or '')
    strong, bare = set(), set()
    if slug:
        strong.add(slug)
    (strong if '/' in e['name'] else bare).add(e['name'])

    def compile_(i, slugish):
        if slugish and not i.startswith('@'):
            return re.compile(r'(?<![A-Za-z0-9_.-])' + re.escape(i) + r'(?![A-Za-z0-9_-])', re.I)
        return re.compile(r'(?<![A-Za-z0-9_/@.-])' + re.escape(i) + r'(?![A-Za-z0-9_/-])', re.I)
    return ([compile_(i, True) for i in sorted(strong) if len(i) >= 3],
            [compile_(i, False) for i in sorted(bare) if len(i) >= 3])


TABLE_SEP_RE = re.compile(r'^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$')
NUM_RE = re.compile(_NUM)
STARS_NEXT_RE = re.compile(r'^[\s*`:(]{0,6}(' + _NUM + r')\s*(?:\*\*)?\s*(?:csillag|stars?\b)', re.I)


def split_row(line):
    s = line.strip()
    if not s.startswith('|'):
        return None
    return [c.strip() for c in s.strip('|').split('|')]


def table_star_cells(lines):
    """{line_no: star-cell text} for rows of markdown tables with a star column."""
    out = {}
    col = None
    for i, line in enumerate(lines):
        cells = split_row(line)
        if cells is None:
            col = None
            continue
        if TABLE_SEP_RE.match(line) and i > 0:
            head = split_row(lines[i - 1]) or []
            col = next((k for k, h in enumerate(head) if STARS_LINE_RE.search(h)), None)
            continue
        if col is not None and col < len(cells):
            out[i + 1] = cells[col]
    return out


SUBJECT_KEY_RE = re.compile(r'rep[óo]|forr[áa]s|csomag|source|package|project|projekt', re.I)


def kv_star_tables(lines):
    """[(subject_lines, star_line, star_cell)] for 2-column key/value tables
    that carry a star row. The star belongs to what the table's subject row
    (repo / source / package) names -- NOT to anything else a row mentions
    (a "dependency | numpy only" row must not hand numpy the table's stars)."""
    out = []
    i = 0
    while i < len(lines):
        if split_row(lines[i]) is None:
            i += 1
            continue
        j = i
        while j < len(lines) and split_row(lines[j]) is not None:
            j += 1
        star, subjects = None, set()
        for k in range(i, j):
            cells = split_row(lines[k])
            if len(cells) != 2 or TABLE_SEP_RE.match(lines[k]):
                continue
            if star is None and STARS_LINE_RE.search(cells[0]):
                star = (k + 1, cells[1])
            elif SUBJECT_KEY_RE.search(cells[0]):
                subjects.add(k + 1)
        if star:
            out.append((subjects, star[0], star[1]))
        i = j
    return out


def star_from_cell(cell):
    """The single number in a star cell; None if absent or ambiguous ("11k + 6k")."""
    nums = NUM_RE.findall(cell.split('/')[0])
    return nums[0].strip() if len(nums) == 1 else None


def star_tables(files):
    return [(fp, lines, table_star_cells(lines), kv_star_tables(lines)) for fp, lines in files]


def find_stars(strong, bare, tables, base):
    for pats, lenient in ((strong, True), (bare, False)):
        if not pats:
            continue
        for fp, lines, cells, kvs in tables:
            for n, line in enumerate(lines, 1):
                hits = [m for m in (p.search(line) for p in pats) if m]
                if not hits:
                    continue
                src = '%s:%d' % (rel(fp, base), n)
                kv = next((t for t in kvs if n in t[0]), None)
                if kv:
                    v = star_from_cell(kv[2])
                    if v:
                        return v, '%s:%d' % (rel(fp, base), kv[1])
                    continue
                if n in cells:
                    v = star_from_cell(cells[n])
                    if v:
                        return v, src
                    continue
                if not STARS_LINE_RE.search(line):
                    continue
                for m in hits:
                    after = line[m.end():]
                    adj = STARS_ADJ_RE.match(after) or STARS_NEXT_RE.match(after)
                    if adj:
                        return adj.group(1).strip(), src
                    if not lenient:
                        continue
                    best = None
                    for rx in (STARS_AFTER_RE, STARS_LABEL_RE):
                        sm = rx.search(line, m.end())
                        if sm and (best is None or sm.start() < best.start()):
                            best = sm
                    if best is not None:
                        return best.group(1).strip(), src
    return None, None


def clean(line, limit=240):
    s = re.sub(r'\*\*|`', '', line).strip()
    s = re.sub(r'^[-|#>\s]+', '', s)
    s = re.sub(r'\s*\|\s*', ' | ', s).strip(' |')
    s = ' '.join(s.split())
    return s if len(s) <= limit else s[:limit - 1].rstrip() + '…'


def find_effect(pats, files, base):
    for fp, lines in files:
        sections, cur = [], []
        for n, line in enumerate(lines, 1):
            if SECTION_RE.match(line) and cur:
                sections.append(cur)
                cur = []
            cur.append((n, line))
        if cur:
            sections.append(cur)
        for sec in sections:
            if not any(p.search(line) for _, line in sec for p in pats):
                continue
            for idx, (n, line) in enumerate(sec):
                if BEFORE_RE.search(line) and ARROW_RE.search(line):
                    return clean(line), '%s:%d' % (rel(fp, base), n)
                # A table whose header has a before AND an after column: its
                # first data row is the stated measurement.
                head = split_row(line)
                if (head and BEFORE_RE.search(line) and AFTER_RE.search(line)
                        and idx + 2 < len(sec) and TABLE_SEP_RE.match(sec[idx + 1][1])):
                    # First data row whose before AND after cells are filled.
                    for rn, row in sec[idx + 2:]:
                        cells = split_row(row)
                        if cells is None:
                            break
                        if len(cells) == 3 and len(head) == 3:
                            if not (clean(cells[1]) and clean(cells[2])):
                                continue
                            text = '%s: %s -> %s' % tuple(clean(c, 120) for c in cells)
                        else:
                            text = clean(row)
                        return clean(text), '%s:%d' % (rel(fp, base), rn)
    return None, None


def annotate(entries, notes, base):
    agents = sorted(notes)
    # The star tables of every note, parsed once (not once per entry).
    tables = {a: star_tables(notes[a]) for a in agents}
    for e in entries:
        strong, bare = ident_patterns(e)
        if e['type'] == 'pip' and not e['direct']:
            # A transitive dist is named in notes only by its repo slug; its
            # bare name ("six", "regex") is far too common in prose.
            bare = []
        own = notes.get(e['agent'], [])
        own_t = tables.get(e['agent'], [])
        others_t = [t for a in agents if a != e['agent'] for t in tables[a]]
        e['stars'], e['stars_source'] = find_stars(strong, bare, own_t + others_t, base)
        # Effect only via the strong identifier: a bare name in a section
        # is usually a tool used for the measurement, not its subject.
        e['effect'], e['effect_source'] = find_effect(strong, own, base)


# --- main -------------------------------------------------------------------

def build(agents_dir, notes_dirs=DEFAULT_NOTES_DIRS, own_owners=()):
    agents_dir = os.path.abspath(agents_dir)
    base = os.path.dirname(agents_dir)
    # Owner names from the setting (--own-owner). Ownership is not inferred
    # from the installation's remotes.
    owners = {o.lower() for o in own_owners}
    agents = sorted(a for a in os.listdir(agents_dir)
                    if os.path.isdir(os.path.join(agents_dir, a)) and not a.startswith('.')) \
        if os.path.isdir(agents_dir) else []
    entries = []
    # Counts only: the summary holds no owner name, repo name, path or origin.
    unlisted = {'total': 0, 'by_reason': {OWNER_IN_SETTING: 0, NO_HTTP_SSH_ORIGIN: 0}, 'by_agent': {},
                'owners_in_setting': len(owners), 'listed_network_clones': 0}
    own_refs = {'total': 0, SELF_REF: 0, SIBLING_REF: 0, 'by_agent': {}}
    for agent in agents:
        ad = os.path.join(agents_dir, agent)
        entries += scan_skills(agent, ad, base)
        entries += scan_mcp_json(agent, ad, base)
        found = walk_agent(ad)
        # Workspace membership, per package.json: a dependency is a sibling
        # only between members of the SAME workspace, not agent-wide.
        roots = {p: workspace_root(os.path.dirname(p), ad) for kind, p in found if kind == 'package'}
        members = {}
        for p, root in roots.items():
            n = package_name(p)
            if root is not None and n:
                members.setdefault(root, set()).add(n)
        skipped = {}
        for kind, p in found:
            if kind == 'package':
                entries += scan_package(agent, p, base, siblings=frozenset(members.get(roots[p], ())),
                                        skipped=skipped)
            elif kind == 'package-transitive':
                entries += scan_package(agent, p, base, direct=False, skipped=skipped)
            elif kind == 'venv':
                entries += scan_venv(agent, p, base)
            elif kind == 'git':
                cls, url, commit = classify_clone(p, owners)
                if cls == LISTED:
                    entries += scan_vendor(agent, p, base, url, commit)
                    unlisted['listed_network_clones'] += 1
                else:
                    unlisted['total'] += 1
                    unlisted['by_reason'][cls] += 1
                    unlisted['by_agent'][agent] = unlisted['by_agent'].get(agent, 0) + 1
            elif kind == 'sdist':
                entries += scan_sdist(agent, p, base)
        n_skipped = sum(skipped.values())
        if n_skipped:
            own_refs['total'] += n_skipped
            for k, v in skipped.items():
                own_refs[k] += v
            own_refs['by_agent'][agent] = n_skipped
    # One row per (agent, type, name, version): the same pinned version in two
    # folders of one agent is one adoption (first path kept, the rest noted in
    # used_in); a DIFFERENT version stays a separate row, so no pin is hidden.
    seen = {}
    deduped = []
    for e in entries:
        # Registry-or-not is part of the key: a labelled row (source_url null,
        # e.g. an MCP server named by its config key) never merges with, or
        # swallows, a registry row that happens to share the name.
        k = (e['agent'], e['type'], e['name'].lower(), e['version'], e['source_url'] is None)
        if k in seen:
            first = seen[k]
            if e['path'] != first['path'] and e['path'] not in first['used_in']:
                first['used_in'].append(e['path'])
            first['direct'] = first['direct'] or e['direct']
            continue
        seen[k] = e
        deduped.append(e)
    entries = deduped
    annotate(entries, load_research(agents_dir, agents, notes_dirs), base)
    entries.sort(key=lambda e: (e['agent'], TYPE_ORDER.get(e['type'], 9), e['name'].lower(), e['path']))

    by_type, by_agent = {}, {}
    for e in entries:
        by_type[e['type']] = by_type.get(e['type'], 0) + 1
        a = by_agent.setdefault(e['agent'], {'total': 0, 'direct': 0})
        a['total'] += 1
        a['direct'] += 1 if e['direct'] else 0
        a[e['type']] = a.get(e['type'], 0) + 1
    for a in agents:
        by_agent.setdefault(a, {'total': 0, 'direct': 0})
    return {
        'summary': {
            'total': len(entries),
            'direct': sum(1 for e in entries if e['direct']),
            'by_type': dict(sorted(by_type.items())),
            'by_agent': dict(sorted(by_agent.items())),
            # Not entries: clones whose origin owner name is in --own-owner,
            # and clones without a readable http(s) or ssh origin; counted, no
            # name, path or origin.
            'unlisted_clones': dict(unlisted, by_agent=dict(sorted(unlisted['by_agent'].items()))),
            # Not entries either: npm dependencies on the package itself or on
            # a sibling of its own workspace, skipped as own code (counts only).
            'own_package_refs': dict(own_refs, by_agent=dict(sorted(own_refs['by_agent'].items()))),
        },
        'entries': entries,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--agents-dir', default=os.path.join(REPO_ROOT, 'agents'))
    ap.add_argument('--notes-dir', action='append', default=None,
                    help='research-notes directory name under each agent folder (repeatable; '
                         'default "research")')
    ap.add_argument('--own-owner', action='append', default=None,
                    help='Owner name(s) whose clones are counted instead of listed, matched against '
                         'the first path segment of each clone\'s own origin URL on any host. '
                         'Ownership is not inferred from any remote. Clones without a readable '
                         'http(s) or ssh origin are also counted, not listed.')
    ap.add_argument('--out', default=os.path.join(REPO_ROOT, 'store', 'opensource-inventory.json'))
    ap.add_argument('--stdout', action='store_true', help='print instead of writing --out')
    args = ap.parse_args(argv)
    try:
        notes_dirs = notes_dirs_from(args.notes_dir)
    except ValueError as err:
        ap.error(str(err))
    own_owners = args.own_owner or []
    for o in own_owners:
        if not OWNER_RE.fullmatch(o):
            ap.error('own owner must be a plain account name, got %r' % o)

    data = build(args.agents_dir, notes_dirs, own_owners)
    doc = {
        'generated_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    doc.update(data)
    text = json.dumps(doc, ensure_ascii=False, indent=2) + '\n'
    if args.stdout:
        sys.stdout.write(text)
        return 0
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    # A SIGTERM (the route's timeout) unwinds through the cleanup below.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(128 + signal.SIGTERM))
    fd, tmp = tempfile.mkstemp(prefix='.opensource-inventory.', dir=out_dir)
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
    print('%s: %d entries (%d direct)' % (args.out, data['summary']['total'], data['summary']['direct']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
