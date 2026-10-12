#!/usr/bin/env python3
"""Count the `](...md)` links of the memory index whose target is NOT on disk.

WHY A SECOND NUMBER NEXT TO THE SIZE
The index gate measures the SIZE of the shared MEMORY.md, because above the
load limit the end of the file is truncated in silence. A dangling pointer is
the same class of silent failure with a different shape: the index line is
still there, it still reads like knowledge, and the page behind it does not
exist. Measured 2026-09-18: line 90 pointed at a page that had never been
written; it surfaced from a human re-reading, not from any gate.

WHY A CANDIDATE, AND ONLY THEN A FINDING
The checker itself can lie, and BOTH directions have already fired here in one
round (2026-09-10, three false alarms):
  * it FINDS something that does not exist -- a `](...md)` shape standing in
    PROSE that merely describes the pattern, or a target lifted out of the link
    TEXT (`- [A [[X]] envelope...](real-target.md)`) instead of the link.
  * it MISSES something that does exist -- a truncated key checked instead of
    the whole target, so a 2564 B page reads as absent.
So: code spans and fenced blocks are removed before matching (that is where a
described pattern lives), a target whose stem has no alphanumeric character is
not a target (`...md` is prose), the WHOLE link target is taken rather than a
fragment of a key, and every surviving candidate is looked at ON DISK before it
is reported. Coming up with a defect that does not exist costs the same as
hiding one that does -- it just costs trust instead of knowledge.

SCOPE: the index plus the pages the index points at (the hubs). That is the set
the cut-and-move rounds actually touch; a hub is where a line goes when it
leaves the index, so a hub that lost its own target is the next silent hole.

THE UNIT OF AN ALARM IS THE TARGET, NOT THE OCCURRENCE. Measured 2026-09-18 on
one page: 43 occurrences, 27 distinct targets -- both numbers correct, and they
answer different questions. A page that is missing and linked from four places
is ONE hole to fill, so it is reported once, with `occurrences` next to it as
context. Counting occurrences instead would make a single gap look like four,
and the bigger number is the one people act on.

Usage: memory-index-linkcheck.py <index.md> [--max-report N]
Prints ONE JSON object on stdout. Exit 0 when the scan ran (with or without
findings), 2 when it could not run -- the caller decides what a failed scan
means, and the gate turns it into a wake, never into silence.
"""
import json
import os
import re
import sys

FENCE = re.compile(r"^\s*(?:```+|~~~+)")
INLINE_CODE = re.compile(r"(`+)(?:.+?)\1")
# A markdown link TARGET: what stands between `](` and `)`. Anchored on the
# closing bracket of the link text, so a `[[wikilink]]` inside that text cannot
# be mistaken for the target -- the shape that produced two of the three false
# alarms.
LINK = re.compile(r"\]\(\s*<?([^()<>\s]+?\.md)>?(?:#[^()\s]*)?\s*\)")
# Glob/placeholder characters never appear in a real memory filename.
IMPLAUSIBLE = set("*?{}|<>$")


def strip_code(text):
    """Blank out fenced blocks and inline code spans, KEEPING line numbers.

    A pattern written down to be read about is code, not a pointer. Line
    numbers are preserved so a finding can name the line a human will open.
    """
    out = []
    in_fence = False
    for line in text.split("\n"):
        if FENCE.match(line):
            in_fence = not in_fence
            out.append("")
            continue
        if in_fence:
            out.append("")
            continue
        out.append(INLINE_CODE.sub(lambda m: " " * len(m.group(0)), line))
    return "\n".join(out)


def plausible(target):
    """A candidate, not yet a finding. Deliberately narrow: what is dropped
    here is never looked at again, so only drop what cannot be a filename."""
    if "://" in target or target.startswith("#"):
        return False
    if any(c in IMPLAUSIBLE for c in target):
        return False
    stem = target.rsplit("/", 1)[-1][: -len(".md")]
    # `...md` is the pattern being described, not a file: no letter, no digit.
    return bool(re.search(r"[A-Za-z0-9]", stem))


def links_of(path):
    """(lineno, target) pairs of one file. Unreadable file -> raises."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = strip_code(fh.read())
    found = []
    for n, line in enumerate(text.split("\n"), start=1):
        for m in LINK.finditer(line):
            target = m.group(1)
            if plausible(target):
                found.append((n, target))
    return found


def main(argv):
    if len(argv) < 2:
        print(json.dumps({"error": "usage: memory-index-linkcheck.py <index.md>"}))
        return 2
    index = os.path.abspath(argv[1])
    max_report = 10
    if "--max-report" in argv:
        try:
            max_report = int(argv[argv.index("--max-report") + 1])
        except (ValueError, IndexError):
            print(json.dumps({"error": "--max-report needs a number"}))
            return 2
    if not os.path.isfile(index):
        print(json.dumps({"error": "index not found", "path": index}))
        return 2

    root = os.path.dirname(index)
    try:
        index_links = links_of(index)
    except OSError as exc:
        print(json.dumps({"error": "index unreadable: %s" % exc.__class__.__name__}))
        return 2

    # The hubs: index targets that ARE on disk. A missing one is a finding
    # below; it cannot also be a file to scan.
    scope = [index]
    for _, target in index_links:
        hub = os.path.normpath(os.path.join(root, target))
        if os.path.isfile(hub) and hub not in scope:
            scope.append(hub)

    checked = 0
    # Keyed by the RESOLVED path, so the same page reached from two directories
    # is one hole, and two different pages that share a basename stay two.
    holes = {}
    seen_targets = set()

    def note(key, entry):
        if key in holes:
            holes[key]["occurrences"] += 1
        else:
            entry["occurrences"] = 1
            holes[key] = entry

    for path in scope:
        try:
            pairs = links_of(path)
        except OSError:
            # One unreadable hub must not silence the whole scan; it is named
            # in the report so the number is not quietly short.
            note(path, {"in": os.path.relpath(path, root), "line": 0,
                        "target": "(unreadable, not scanned)"})
            continue
        for lineno, target in pairs:
            checked += 1
            resolved = os.path.normpath(os.path.join(os.path.dirname(path), target))
            seen_targets.add(resolved)
            if not os.path.isfile(resolved):
                note(resolved, {"in": os.path.relpath(path, root),
                                "line": lineno, "target": target})

    missing = sorted(holes.values(), key=lambda e: (e["in"], e["line"]))
    print(json.dumps({
        "files_scanned": len(scope),
        "links_checked": checked,
        "unique_targets": len(seen_targets),
        "missing": len(missing),
        "missing_occurrences": sum(e["occurrences"] for e in missing),
        "missing_list": missing[:max_report],
        "truncated": len(missing) > max_report,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
