#!/usr/bin/env python3
"""Audit [[wikilink]] references in the agent memory directory.

A naive "file does not exist -> broken" check conflates three different things,
and only one of them is a defect:

  MEMORY        the link resolves to a memory file (by filename or by its
                frontmatter `name:` field -- both forms are used in practice)
  SKILL / TASK  a valid cross-namespace reference to ~/.claude/skills/<n> or
                ~/.claude/scheduled-tasks/<n>. NOT broken. Existence is
                CHECKED here, never assumed from a hand-maintained list.
  ARTIFACT      prose that merely looks like a wikilink: POSIX character
                classes ([[:space:]]), placeholders ([[link]]), phrases.
  UNRESOLVED    none of the above -- the real repair queue.

Also reports name/filename drift, because a rename has to keep the filename,
the `name:` field and every [[link]] in sync; if they drift, the mixed-form
links that exist today get regenerated.

Usage: python3 scripts/memory-link-audit.py [memory_dir]

Findings never change the exit code -- this is a report, not a gate. An
unreadable or missing directory DOES fail loudly, on purpose: a silent empty
report reads as "all clean", which is the one failure this tool must not have.
"""
import os
import re
import sys

# Derive the project slug from this file's own location rather than hardcoding
# it: a wrong path here would fail silently -- an empty report reads as "all
# clean". The slug replaces both "/" and "." with "-", so a hidden directory
# yields a double dash, matching how the config tree names projects.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SLUG = _ROOT.replace("/", "-").replace(".", "-")
DEFAULT_DIR = os.path.join(_ROOT, ".channels-config", "projects", _SLUG, "memory")
SKILL_DIRS = [
    os.path.expanduser("~/.claude/skills"),
    os.path.expanduser("~/.claude/scheduled-tasks"),
]

WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")
NAME_FIELD = re.compile(r"^name:\s*(.*?)\s*$", re.MULTILINE)


def is_artifact(target):
    """Prose that only looks like a link. Deliberately conservative: anything
    matching here is dropped from the repair queue, so keep it narrow."""
    if target.startswith(":") or target.endswith(":"):
        return True  # POSIX character class, e.g. [[:space:]]
    if " " in target:
        return True  # phrases are never memory slugs
    return target in {"link", "name", "their-name"}


def load(memory_dir):
    """Return (filename stems, name-field -> stem, name/filename drift)."""
    stems, by_name, drift = set(), {}, []
    for fname in sorted(os.listdir(memory_dir)):
        if not fname.endswith(".md") or fname == "MEMORY.md":
            continue
        stem = fname[:-3]
        stems.add(stem)
        with open(os.path.join(memory_dir, fname), encoding="utf-8") as fh:
            head = fh.read(2048)
        m = NAME_FIELD.search(head)
        declared = m.group(1).strip().strip('"').strip("'") if m else ""
        if declared:
            by_name.setdefault(declared, stem)
        if declared != stem:
            drift.append((fname, declared or "(hianyzik)"))
    return stems, by_name, drift


def main():
    memory_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    stems, by_name, drift = load(memory_dir)

    skills = set()
    for root in SKILL_DIRS:
        if os.path.isdir(root):
            skills |= {d for d in os.listdir(root)
                       if os.path.isdir(os.path.join(root, d))}

    buckets = {k: {} for k in
               ("MEMORY", "MEMORY-NEV", "SKILL/TASK", "ARTIFACT", "UNRESOLVED")}
    for fname in sorted(os.listdir(memory_dir)):
        if not fname.endswith(".md"):
            continue
        with open(os.path.join(memory_dir, fname), encoding="utf-8") as fh:
            body = fh.read()
        for target in WIKILINK.findall(body):
            t = target.strip()
            if is_artifact(t):
                cls = "ARTIFACT"
            elif t in stems:
                cls = "MEMORY"
            elif t.endswith(".md") and t[:-3] in stems:
                cls = "UNRESOLVED"  # .md suffix inside a wikilink is a defect
            elif t in by_name:
                cls = "MEMORY-NEV"
            elif t in skills:
                cls = "SKILL/TASK"
            else:
                cls = "UNRESOLVED"
            buckets[cls].setdefault(t, []).append(fname)

    print(f"memoria-fajlok: {len(stems)}   skill/task nevek: {len(skills)}")
    for cls in ("MEMORY", "MEMORY-NEV", "SKILL/TASK", "ARTIFACT", "UNRESOLVED"):
        hits = buckets[cls]
        total = sum(len(v) for v in hits.values())
        print(f"\n{cls}: {len(hits)} egyedi / {total} elofordulas")
        if cls in ("MEMORY", "ARTIFACT"):
            continue
        for target in sorted(hits):
            where = ", ".join(sorted(set(hits[target]))[:3])
            print(f"  {target}  <- {where}")

    print(f"\nNEV/FAJLNEV ELTERES: {len(drift)}")
    for fname, declared in drift:
        print(f"  {fname}  name: {declared}")
    print("\nJAVITANDO = az UNRESOLVED csoport. A SKILL/TASK ervenyes "
          "kereszthivatkozas, az ARTIFACT proza.")


if __name__ == "__main__":
    main()
