#!/usr/bin/env python3
"""Egress-drift scan over procedure files (SKILL.md under skills and scheduled tasks).

TASKEGRESSDRIFT913: the first sweep after the #1218 egress deny searched
PHYSICAL lines for `curl ... https://`. A shell command split with a trailing
backslash puts `curl` on one line and `https://` on the next, so two files
passed the sweep unseen. This scan works on LOGICAL lines (backslash
continuations joined), only counts commands inside fenced code blocks, and
then asks the question that matters: is the forbidden step MARKED (a block
note that says it cannot run and why) or is it a bare prescription?

Kinds:
  unmarked     a prescribed command with no block note reaching it   -> FINDING (exit 1)
  marked       a block note within the same section above the hit     -> not a finding
  marked-file  a block note elsewhere in the file (typically the
               Buktatok bullet "A FENTI recept nem futtathato") that
               is NOT scope-limited                                   -> read it, not counted
  prose        the pattern mentioned outside a code block              -> informational

A note that limits its own scope ("CSAK ez a szakasz", "es CSAK ez") marks
only hits inside its own section; it never reaches the rest of the file. The
2026-09-11 banner on supabase-edge-function-deploy is the measured case: it
covered one section while eight bare Management-API curls sat above it.

Usage:
  egress-drift-scan.py [--json] [--roots DIR ...] [--marker-window N]
Default roots: ~/.claude/skills and ~/.claude/scheduled-tasks (every */SKILL.md).
"""
import argparse
import glob
import json
import os
import re
import sys

VERB_RX = re.compile(r'(?:^|[\s;&|(`])(?:[\w./-]*/)?(?:curl|wget)\b')
URL_RX = re.compile(r'https://')
# The block-note wording the fleet used when marking a step that cannot run
# (SKILLEGRESSDRIFT911 rounds). Loose on purpose: catch bare prescriptions,
# do not grade the phrasing.
MARKER_RX = re.compile(r'NEM FUTTATHAT|#1218|egress-deny|egress deny|DENY \(#|flotta-szinten (?:DENY|tilt)|ELAVULT UT|ELAVULT ÚT|ELAVULT:', re.I)
SCOPED_RX = re.compile(r'CSAK ez|csak ez a szakasz|es CSAK ez|és CSAK ez', re.I)
FENCE_RX = re.compile(r'^\s*(```|~~~)')
H2_RX = re.compile(r'^##\s')


def logical_lines(text):
    """Yield (start_line_no, end_line_no, joined_text, in_code_block), 1-based."""
    lines = text.split('\n')
    in_code = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if FENCE_RX.match(line):
            in_code = not in_code
            i += 1
            continue
        start = i
        buf = [line]
        while lines[i].rstrip().endswith('\\') and i + 1 < len(lines):
            i += 1
            buf.append(lines[i])
        joined = ' '.join(b.strip().rstrip('\\').strip() for b in buf)
        yield start + 1, i + 1, joined, in_code
        i += 1


def section_bounds(lines, line_no):
    """(first, last) 1-based physical line numbers of the H2 section holding line_no."""
    first = 1
    for i in range(line_no - 1, -1, -1):
        if H2_RX.match(lines[i]):
            first = i + 1
            break
    last = len(lines)
    for i in range(line_no, len(lines)):
        if H2_RX.match(lines[i]):
            last = i
            break
    return first, last


def scan_file(path, marker_window):
    text = open(path, encoding='utf-8', errors='replace').read()
    lines = text.split('\n')
    # Markers: (line_no, scoped?) over the whole file, prose lines only.
    # A note is a PARAGRAPH (contiguous non-blank prose lines), and its scope
    # phrase may sit on any line of it: judge the paragraph, not the line.
    markers = []
    for start, end, joined, in_code in logical_lines(text):
        # A note written as a shell comment inside the code block is still a note.
        if not MARKER_RX.search(joined) or (in_code and not joined.lstrip().startswith('#')):
            continue
        lo = start - 1
        while lo > 0 and lines[lo - 1].strip():
            lo -= 1
        hi = start - 1
        while hi + 1 < len(lines) and lines[hi + 1].strip() and not FENCE_RX.match(lines[hi + 1]):
            hi += 1
        paragraph = '\n'.join(lines[lo:hi + 1])
        markers.append((start, bool(SCOPED_RX.search(paragraph))))
    hits = []
    for start, end, joined, in_code in logical_lines(text):
        if not (VERB_RX.search(joined) and URL_RX.search(joined)):
            continue
        if not in_code or joined.lstrip().startswith('#'):
            # Prose, or a shell comment inside the block: a mention, not a command.
            kind = 'prose'
        else:
            s_first, s_last = section_bounds(lines, start)
            reach = [m for m, scoped in markers
                     if (s_first <= m < start and (start - m) <= marker_window)
                     or (s_first <= m < start and not scoped)]
            if reach:
                kind = 'marked'
            elif any(not scoped for m, scoped in markers):
                kind = 'marked-file'
            else:
                kind = 'unmarked'
        hits.append({'line': start, 'end': end, 'kind': kind, 'continuation': end > start, 'text': joined[:160]})
    return hits


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--roots', nargs='*', default=None, help='directories holding */SKILL.md')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--marker-window', type=int, default=40, help='lines above a hit searched for a scoped note')
    a = ap.parse_args(argv)
    roots = a.roots or [os.path.expanduser('~/.claude/skills'), os.path.expanduser('~/.claude/scheduled-tasks')]
    files = []
    for r in roots:
        files += sorted(glob.glob(os.path.join(r, '*', 'SKILL.md')))
    summary = {'unmarked': 0, 'marked': 0, 'marked-file': 0, 'prose': 0, 'continuation_only_files': 0}
    report = {'files': len(files), 'hits': {}, 'summary': summary}
    for f in files:
        hits = scan_file(f, a.marker_window)
        if not hits:
            continue
        report['hits'][f] = hits
        for h in hits:
            summary[h['kind']] += 1
        code_hits = [h for h in hits if h['kind'] != 'prose']
        if code_hits and all(h['continuation'] for h in code_hits):
            summary['continuation_only_files'] += 1
    if a.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        home = os.path.expanduser('~')
        for f, hits in report['hits'].items():
            print(f.replace(home, '~'))
            for h in hits:
                span = f"L{h['line']}" + (f"-{h['end']}" if h['continuation'] else '')
                print(f"  {h['kind']:11s} {span:10s} {h['text'][:105]}")
        print(f"\n{report['files']} files scanned; hits in {len(report['hits'])}: "
              f"unmarked={summary['unmarked']} marked={summary['marked']} marked-file={summary['marked-file']} "
              f"prose={summary['prose']}; files a physical-line sweep would miss entirely: {summary['continuation_only_files']}")
    return 1 if summary['unmarked'] else 0


if __name__ == '__main__':
    sys.exit(main())
