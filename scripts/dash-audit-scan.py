#!/usr/bin/env python3
"""Em-dash audit with the marked-vs-bare convention (DASHAUDITZAJ915).

The risk is not the raw hit count. A sweep that reports 96 files teaches its
reader to discount findings, and then one REAL outgoing em dash reads as
noise -- a false-alarm rate is the slow way to switch a gate off. The fix is
the #1319 egress-drift shape: classify every occurrence, exclude what is not
ours from the denominator, and let only the BARE occurrences be findings.

The convention (Marveen + Mira, 2026-09-15, final form on the card):
  PROSE      the word ("em dash", "gondolatjel") is enough -- a literal
             U+2014 in prose or rule documentation is a FINDING to be
             REWRITTEN to the word, never to be marked.
  CODE       a code example that needs the character compares the CODEPOINT
             (\\u2014 spelled out); a literal is a finding here too.
  TEST       the one place a literal is legitimate (a dash filter cannot be
             tested without the character), and it carries a MARKER so the
             audit can tell "justified" from "drifted in". An unmarked test
             literal is a finding until someone marks it.
  VENDOR     vendored/harness state (lockfiles, minified bundles, cached
             service text) is neither fixed nor counted -- it leaves the
             DENOMINATOR, visibly.

Marker (file-level, anywhere in a test file):
    dash-audit: literal indokolt -- <miert>
The marker is only honored in TEST files: prose and code examples have a
clean rewrite (word / codepoint), so marking them would just relocate the
noise. This tool never grades the reason text.

Kinds:
  bare-doc       literal U+2014 in a non-test, non-excluded file -> FINDING
  bare-test      literal in a test file with NO marker           -> FINDING
  marked-test    literal in a test file with the marker          -> ok
  excluded       vendor/harness file                             -> out of the
                                                                    denominator

Usage:
  dash-audit-scan.py [--json] [--gate] [--repo DIR] [--roots DIR ...]
Default: scan the git-tracked files of the repo this script lives in.
--roots adds Markdown trees outside the repo (e.g. ~/.claude/skills,
~/.claude/scheduled-tasks). --gate exits 1 on any finding; the default is a
report (there is no scheduled audit yet -- the instrument comes first).
"""
import argparse
import json
import os
import re
import subprocess
import sys

EM_DASH = '—'
MARKER_RX = re.compile(r'dash-audit:\s*literal\s+indokolt', re.I)
TEST_PATH_RX = re.compile(r'(^|/)__tests__/|\.test\.|_test\.|(^|/)tests?/')
# Vendor/harness: not ours to fix, and counting it makes the number lie about
# our own surface. The list is visible on purpose -- extending it is a diff.
EXCLUDE_RX = re.compile(
    r'(^|/)node_modules/|(^|/)dist/|(^|/)vendor/|(^|/)third_party/'
    r'|\.lock$|package-lock\.json$|\.min\.(js|css)$'
    r'|(^|/)\.claude-config/'
)


def repo_tracked_files(repo):
    out = subprocess.run(
        ['git', '-C', repo, 'ls-files', '-z'],
        capture_output=True, check=True,
    ).stdout
    return [os.path.join(repo, p.decode('utf-8')) for p in out.split(b'\0') if p]


def root_files(root):
    hits = []
    for dirpath, dirnames, filenames in os.walk(os.path.expanduser(root)):
        dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.git')]
        for f in filenames:
            if f.endswith('.md'):
                hits.append(os.path.join(dirpath, f))
    return hits


def classify(path, rel):
    if EXCLUDE_RX.search(rel):
        return 'excluded'
    if TEST_PATH_RX.search(rel):
        return 'test'
    return 'doc'


def scan_file(path):
    """Return (has_marker, [line_numbers with a literal em dash]) or None for binary."""
    try:
        with open(path, encoding='utf-8') as fh:
            text = fh.read()
    except (UnicodeDecodeError, OSError):
        return None
    if '\0' in text:
        return None
    lines = text.split('\n')
    hits = [i + 1 for i, line in enumerate(lines) if EM_DASH in line]
    return (bool(MARKER_RX.search(text)), hits)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--gate', action='store_true',
                    help='exit 1 on any finding (default: report only)')
    ap.add_argument('--repo', default=None,
                    help='git repo whose tracked files are scanned (default: the repo this script lives in)')
    ap.add_argument('--roots', nargs='*', default=[],
                    help='extra Markdown trees to scan (procedure files outside the repo)')
    args = ap.parse_args()

    repo = args.repo or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    targets = [(p, os.path.relpath(p, repo)) for p in repo_tracked_files(repo)]
    for root in args.roots:
        targets += [(p, p) for p in root_files(root)]

    results = []
    counts = {'bare-doc': 0, 'bare-test': 0, 'marked-test': 0, 'excluded-hits': 0}
    scanned = 0
    excluded_files = 0
    for path, rel in targets:
        cls = classify(path, rel)
        scanned_pair = scan_file(path)
        if scanned_pair is None:
            continue
        scanned += 1
        has_marker, hits = scanned_pair
        if not hits:
            continue
        if cls == 'excluded':
            excluded_files += 1
            counts['excluded-hits'] += len(hits)
            continue
        if cls == 'test':
            kind = 'marked-test' if has_marker else 'bare-test'
        else:
            kind = 'bare-doc'
        counts[kind] += len(hits)
        results.append({'file': rel, 'kind': kind, 'lines': hits[:20], 'hit_count': len(hits)})

    findings = [r for r in results if r['kind'] in ('bare-doc', 'bare-test')]
    summary = {
        'files_scanned': scanned,
        'files_excluded_with_hits': excluded_files,
        'counts': counts,
        'finding_files': len(findings),
    }
    if args.json:
        print(json.dumps({'summary': summary, 'results': results}, ensure_ascii=False, indent=1))
    else:
        for r in sorted(results, key=lambda r: (r['kind'], r['file'])):
            print(f"{r['kind']:12} {r['file']}  ({r['hit_count']} hit, lines {','.join(map(str, r['lines']))})")
        print(f"\n{scanned} files scanned; {excluded_files} vendor/harness files with hits "
              f"left the denominator ({counts['excluded-hits']} hits, not counted).")
        print(f"findings: {len(findings)} files "
              f"(bare-doc {counts['bare-doc']}, bare-test {counts['bare-test']} hits); "
              f"marked-test ok: {counts['marked-test']} hits.")
    if args.gate and findings:
        sys.exit(1)
    sys.exit(0)


if __name__ == '__main__':
    main()
