#!/usr/bin/env python3
"""
skill-migrate-placeholders.py

Migrates hardcoded fleet agent names in SKILL.md files to portable placeholders.

Usage:
  python3 scripts/skill-migrate-placeholders.py --dry-run   # show planned changes only
  python3 scripts/skill-migrate-placeholders.py --apply     # apply with .bak backups
  python3 scripts/skill-migrate-placeholders.py --verify    # count remaining hardcoded refs

Idempotent: running --apply twice is safe (already-replaced text stays unchanged).
"""

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Fleet configuration (update if fleet changes)
# ---------------------------------------------------------------------------

# Canonical mapping: agent_id -> role placeholder(s) it can match
# Used for <ROLE_AGENT> replacement in Procedure sections.
# Priority: first match wins when an agent_id appears in an eljárás/Procedure context.
ROLE_PLACEHOLDERS: dict[str, str] = {
    "jarvis":  "<MAIN_AGENT>",
    "rick":    "<ARCHITECT_AGENT>",
    "zack":    "<BACKEND_AGENT>",
    "boo":     "<TESTER_AGENT>",
    "poly":    "<DESIGN_AGENT>",
    "zoe":     "<FINANCE_AGENT>",
    "dave":    "<IT_MANAGER_AGENT>",
    "peter":   "<HEALTH_AGENT>",
    "carmen":  "<MARKETING_AGENT>",
    "vera":    "<AGENT_B>",   # no specific role yet
}

# All known agent ids (used for scanning / verification)
ALL_AGENT_IDS = set(ROLE_PLACEHOLDERS.keys())

# ---------------------------------------------------------------------------
# Skill directory scan list
# (symlink copies like .claude-config/skills/ are intentionally excluded)
# ---------------------------------------------------------------------------

HOME = Path.home()
MARVEEN_ROOT = HOME / "marveen"

SKILL_DIRS: list[Path] = [
    HOME / ".claude" / "skills",
    MARVEEN_ROOT / ".claude" / "skills",
    MARVEEN_ROOT / "skills",
]

# Per-agent own skill dirs
AGENTS_DIR = MARVEEN_ROOT / "agents"
if AGENTS_DIR.exists():
    for agent_dir in sorted(AGENTS_DIR.iterdir()):
        own_skills = agent_dir / ".claude" / "skills"
        if own_skills.exists():
            SKILL_DIRS.append(own_skills)

# ---------------------------------------------------------------------------
# Replacement logic
# ---------------------------------------------------------------------------

# Section header regexes (used to identify context)
RE_PROCEDURE_HEADER = re.compile(
    r"^#{1,4}\s+(Eljárás|Procedure|Eljaras|Steps?)\b", re.IGNORECASE | re.MULTILINE
)
RE_PITFALLS_HEADER = re.compile(
    r"^#{1,4}\s+(Pitfalls|Buktatók|Buktatok|Caveats)\b", re.IGNORECASE | re.MULTILINE
)
RE_EXAMPLES_HEADER = re.compile(
    r"^#{1,4}\s+(Examples?|Példák|Peldak)\b", re.IGNORECASE | re.MULTILINE
)
RE_ANY_HEADER = re.compile(r"^#{1,4}\s+", re.MULTILINE)

# JSON field patterns where own-agent self-reference appears
# e.g. "from":"jarvis"  or  "agent_id":"jarvis"
RE_JSON_SELF_FIELDS = re.compile(
    r'("(?:from|agent_id)"\s*:\s*")([a-z][a-z0-9-]*)(")'
)

# JSON "to" field: orchestrator reference
RE_JSON_TO_FIELD = re.compile(r'("to"\s*:\s*")([a-z][a-z0-9-]*)(")')

# Hungarian/English prose reference patterns
# Matches: "Jarvisnak", "Jarvis-nak", "Jarvisra", "Jarvishoz", etc.
# Also plain lowercase agent id as a word token.
def _prose_pattern(name: str) -> re.Pattern:
    cap = name.capitalize()
    return re.compile(
        r"\b(" + re.escape(cap) + r"|" + re.escape(name) + r")(?=[^a-z0-9-]|$)"
    )


def _split_into_sections(text: str) -> list[tuple[str, str]]:
    """Split markdown into (header_line, body) tuples. First chunk has header=''."""
    parts = RE_ANY_HEADER.split(text)
    headers = [""] + RE_ANY_HEADER.findall(text)
    return list(zip(headers, parts))


def migrate_file(path: Path, agent_id: str, dry_run: bool) -> list[str]:
    """
    Migrate one SKILL.md file.

    Returns a list of human-readable change descriptions (empty = no changes).
    The `agent_id` is the owning agent's id (used for self-reference detection).
    """
    original = path.read_text(encoding="utf-8")
    text = original
    changes: list[str] = []

    # --- Pass 1: JSON "from"/"agent_id" self-references ---
    def replace_json_self(m: re.Match) -> str:
        field, val, close = m.group(1), m.group(2), m.group(3)
        if val not in ALL_AGENT_IDS:
            return m.group(0)
        if agent_id == "global":
            # Global skills have no owner: all names map to role placeholders
            placeholder = ROLE_PLACEHOLDERS.get(val, f"<AGENT_{val.upper()}>")
            changes.append(f'JSON self-ref "{val}" → "{placeholder}" (global)')
            return field + placeholder + close
        if val == agent_id:
            changes.append(f'JSON self-ref "{val}" → "<AGENT>"')
            return field + "<AGENT>" + close
        return m.group(0)

    text = RE_JSON_SELF_FIELDS.sub(replace_json_self, text)

    # --- Pass 2: JSON "to" field → orchestrator or role placeholder ---
    def replace_json_to(m: re.Match) -> str:
        field, val, close = m.group(1), m.group(2), m.group(3)
        if val not in ALL_AGENT_IDS:
            return m.group(0)
        if agent_id != "global" and val == agent_id:
            changes.append(f'JSON "to" self-ref "{val}" → "<AGENT>"')
            return field + "<AGENT>" + close
        placeholder = ROLE_PLACEHOLDERS.get(val, f"<AGENT_{val.upper()}>")
        changes.append(f'JSON "to":"{val}" → "{placeholder}"')
        return field + placeholder + close

    text = RE_JSON_TO_FIELD.sub(replace_json_to, text)

    # --- Pass 3: prose references in Procedure / Pitfalls / Examples sections ---
    # Strategy: identify section boundaries, apply targeted replacements per section.
    for name, placeholder in ROLE_PLACEHOLDERS.items():
        if name not in text:
            continue

        pat = _prose_pattern(name)

        # Determine replacement per location:
        # - Procedure: use role placeholder (semantic intent preserved)
        # - Pitfalls/Examples: use <AGENT_A>/<AGENT_B> for illustration names,
        #   but if it matches agent_id itself → <AGENT>, jarvis → <MAIN_AGENT>
        def _replacement_for_section(section_kind: str, val: str) -> str:
            if val == agent_id:
                return "<AGENT>"
            if val == "jarvis":
                return "<MAIN_AGENT>"
            if section_kind == "procedure":
                return placeholder
            # pitfalls / examples: use generic illustration placeholder
            # We keep jarvis as <MAIN_AGENT> (already handled above);
            # for others, assign <AGENT_A> for the first non-self name encountered.
            return placeholder  # role placeholder is still informative here

        def make_replacer(section_kind: str, name: str, placeholder: str):
            agent_id_cap = agent_id  # capture from outer scope

            def replacer(m: re.Match) -> str:
                orig = m.group(0)
                matched_name = m.group(1)
                actual_id = matched_name.lower()
                # "global" skill dirs have no single owner: every agent name
                # maps to its role placeholder (jarvis -> <MAIN_AGENT>, etc.)
                if agent_id_cap == "global":
                    repl = ROLE_PLACEHOLDERS.get(actual_id, f"<{actual_id.upper()}_AGENT>")
                elif actual_id == agent_id_cap:
                    repl = "<AGENT>"
                else:
                    repl = ROLE_PLACEHOLDERS.get(actual_id, f"<{actual_id.upper()}_AGENT>")
                # Preserve suffix (Hungarian suffixes attached directly)
                suffix = orig[len(matched_name):]
                if repl != matched_name and repl != orig:
                    changes.append(f'Prose "{matched_name}" → "{repl}" ({section_kind})')
                return repl + suffix

            return replacer

        # Split into sections and process each
        lines = text.split("\n")
        result_lines = []
        current_section = "other"
        for line in lines:
            if RE_PROCEDURE_HEADER.match(line):
                current_section = "procedure"
            elif RE_PITFALLS_HEADER.match(line) or RE_EXAMPLES_HEADER.match(line):
                current_section = "pitfalls"
            elif RE_ANY_HEADER.match(line):
                current_section = "other"

            if current_section in ("procedure", "pitfalls") and name.lower() in line.lower():
                line = pat.sub(make_replacer(current_section, name, placeholder), line)

            result_lines.append(line)

        text = "\n".join(result_lines)

    # --- Deduplicate changes list ---
    seen: set[str] = set()
    unique_changes: list[str] = []
    for c in changes:
        if c not in seen:
            seen.add(c)
            unique_changes.append(c)

    if text != original:
        if not dry_run:
            shutil.copy2(path, path.with_suffix(".md.bak"))
            path.write_text(text, encoding="utf-8")

    return unique_changes


def infer_agent_id(skill_dir: Path) -> str:
    """
    Infer the owning agent's id from the skill directory path.

    Returns the agent_id string, OR the sentinel "global" for skill directories
    that have no single owner (shared across all agents). In "global" context,
    no agent name is treated as a self-reference -- every name maps to its role
    placeholder (jarvis -> <MAIN_AGENT>, etc.).

    E.g.:
        agents/rick/.claude/skills/  -> "rick"
        ~/marveen/.claude/skills/    -> "jarvis"   (main agent owns these)
        ~/marveen/skills/            -> "jarvis"
        ~/.claude/skills/            -> "global"   (used by ALL agents)
    """
    parts = skill_dir.parts
    try:
        agents_idx = parts.index("agents")
        return parts[agents_idx + 1]
    except (ValueError, IndexError):
        pass
    # marveen/.claude/skills or marveen/skills -> jarvis (Jarvis owns these)
    if "marveen" in parts:
        return "jarvis"
    # ~/.claude/skills -> shared across all agents; no single owner
    return "global"


# ---------------------------------------------------------------------------
# Verification / baseline count
# ---------------------------------------------------------------------------

def count_hardcoded_refs(dirs: list[Path]) -> dict[str, int]:
    """Return {agent_id: count_of_occurrences} across all SKILL.md files."""
    counts: dict[str, int] = {name: 0 for name in ALL_AGENT_IDS}
    for skill_dir in dirs:
        if not skill_dir.exists():
            continue
        for md in skill_dir.rglob("SKILL.md"):
            text = md.read_text(encoding="utf-8", errors="replace")
            for name in ALL_AGENT_IDS:
                counts[name] += len(re.findall(r"\b" + re.escape(name) + r"\b", text, re.IGNORECASE))
    return counts


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate agent names to placeholders in skill files.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true", help="Show planned changes without modifying files")
    group.add_argument("--apply", action="store_true", help="Apply changes (creates .bak backups)")
    group.add_argument("--verify", action="store_true", help="Count remaining hardcoded agent references")
    args = parser.parse_args()

    existing_dirs = [d for d in SKILL_DIRS if d.exists()]

    if args.verify:
        print("=== Hardcoded agent reference count ===")
        counts = count_hardcoded_refs(existing_dirs)
        total = sum(counts.values())
        for name, count in sorted(counts.items(), key=lambda x: -x[1]):
            if count > 0:
                print(f"  {name}: {count}")
        print(f"  TOTAL: {total}")
        return

    mode = "DRY-RUN" if args.dry_run else "APPLY"
    print(f"=== Skill placeholder migration [{mode}] ===")
    print(f"Scanning {len(existing_dirs)} directories...")
    print()

    total_files = 0
    total_changes = 0

    for skill_dir in existing_dirs:
        agent_id = infer_agent_id(skill_dir)
        dir_label = str(skill_dir).replace(str(HOME), "~")
        dir_changes = 0

        for md in sorted(skill_dir.rglob("SKILL.md")):
            skill_name = md.parent.name
            changes = migrate_file(md, agent_id, dry_run=args.dry_run)
            if changes:
                total_files += 1
                dir_changes += len(changes)
                total_changes += len(changes)
                print(f"  [{dir_label}/{skill_name}]")
                for c in changes:
                    print(f"    - {c}")

        if dir_changes:
            print(f"  → {dir_changes} changes in {dir_label}")
            print()

    print(f"=== Summary: {total_changes} changes across {total_files} files ===")
    if args.dry_run:
        print("Run with --apply to execute.")
    else:
        print("Backups written as .md.bak alongside modified files.")
        print("Run with --verify to check remaining hardcoded references.")


if __name__ == "__main__":
    main()
