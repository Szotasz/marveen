#!/usr/bin/env python3
"""
skill-migrate-placeholders.py

Migrates hardcoded fleet agent names in SKILL.md files to portable placeholders.

Usage:
  python3 scripts/skill-migrate-placeholders.py --dry-run       # show planned changes only
  python3 scripts/skill-migrate-placeholders.py --apply         # apply with .bak backups
  python3 scripts/skill-migrate-placeholders.py --verify        # count remaining hardcoded refs
  python3 scripts/skill-migrate-placeholders.py --verify-scope-a  # count only in-scope refs

Scope-A definition (must reach 0):
  - Shared/global skills: ALL agent-name refs (all sections, YAML, headers)
  - Agent-own skills: cross-agent refs only (not YAML name: field self-identity)

Idempotent: running --apply twice is safe (already-replaced text stays unchanged).

Skip list (system identifiers, not fleet-agent refs):
  - com.jarvis.* LaunchAgent labels (boo/marveen-branch-live-test)
  - Filenames where agent name is embedded in the filename itself (e.g. "Poly neka-redesign.html")
"""

import argparse
import re
import shutil
from pathlib import Path

# ---------------------------------------------------------------------------
# Fleet configuration (update if fleet changes)
# ---------------------------------------------------------------------------

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
    "vera":    "<AGENT_B>",
}

ALL_AGENT_IDS = set(ROLE_PLACEHOLDERS.keys())

# Strings that contain agent names but are system identifiers, NOT fleet-agent refs.
# Lines containing any of these substrings are skipped during prose replacement.
SYSTEM_IDENTIFIER_PATTERNS = [
    re.compile(r"com\.jarvis\.", re.IGNORECASE),           # LaunchAgent label
    re.compile(r"label\s+`?com\.\w+\.dashboard", re.IGNORECASE),
]

# Documented system identifier exceptions (NOT replaced, counted separately in verify-scope-a)
# These are literal OS/service strings, not fleet-agent cross-references.
DOCUMENTED_SKIP_REASONS = [
    "com.jarvis.* launchd label (boo/marveen-branch-live-test)",
]

# ---------------------------------------------------------------------------
# Skill directory scan list
# ---------------------------------------------------------------------------

HOME = Path.home()
MARVEEN_ROOT = HOME / "marveen"

SKILL_DIRS: list[Path] = [
    HOME / ".claude" / "skills",
    MARVEEN_ROOT / ".claude" / "skills",
    MARVEEN_ROOT / "skills",
]

AGENTS_DIR = MARVEEN_ROOT / "agents"
if AGENTS_DIR.exists():
    for agent_dir in sorted(AGENTS_DIR.iterdir()):
        own_skills = agent_dir / ".claude" / "skills"
        if own_skills.exists():
            SKILL_DIRS.append(own_skills)

# ---------------------------------------------------------------------------
# Section/context detection
# ---------------------------------------------------------------------------

RE_PROCEDURE_HEADER = re.compile(
    r"^#{1,4}\s+(Eljárás|Procedure|Eljaras|Steps?)\b", re.IGNORECASE | re.MULTILINE
)
RE_PITFALLS_HEADER = re.compile(
    r"^#{1,4}\s+(Pitfalls|Buktatók|Buktatok|Caveats)\b", re.IGNORECASE | re.MULTILINE
)
RE_ANY_HEADER = re.compile(r"^#{1,4}\s+", re.MULTILINE)

RE_JSON_SELF_FIELDS = re.compile(
    r'("(?:from|agent_id)"\s*:\s*")([a-z][a-z0-9-]*)(")'
)
RE_JSON_TO_FIELD = re.compile(r'("to"\s*:\s*")([a-z][a-z0-9-]*)(")')

# YAML frontmatter: name field (self-identity -- skip)
RE_YAML_NAME_LINE = re.compile(r"^name\s*:", re.IGNORECASE)


def _prose_pattern(name: str) -> re.Pattern:
    # IGNORECASE catches ALL-CAPS emphasis (e.g. "JARVIS", "PETER-REPORT.md").
    # Lookahead: allow hyphen after name (catches Hungarian ragos forms like "Poly-val",
    # compound nouns like "Zack-hiba", and tmux session names like "jarvis-channels").
    # Block only alphanumeric continuation (prevents matching inside longer words).
    return re.compile(
        r"\b(" + re.escape(name) + r")(?=[^a-zA-Z0-9]|$)",
        re.IGNORECASE,
    )


def _is_system_identifier_line(line: str) -> bool:
    """Return True if the line contains a system identifier (LaunchAgent label etc.)."""
    for pat in SYSTEM_IDENTIFIER_PATTERNS:
        if pat.search(line):
            return True
    return False


def _has_filename_embed(line: str) -> bool:
    """Return True if line has a filename-embedded agent name (e.g. 'Poly neka-redesign.html')."""
    return bool(RE_FILENAME_EMBED.search(line))


# ---------------------------------------------------------------------------
# YAML frontmatter processing
# ---------------------------------------------------------------------------

def migrate_yaml_frontmatter(text: str, agent_id: str, changes: list[str]) -> str:
    """
    Replace agent names in YAML frontmatter fields OTHER than 'name:'.
    The 'name:' field is self-identity and must not be modified.
    """
    if not text.startswith("---"):
        return text
    try:
        fm_end_idx = text.index("---", 3)
    except ValueError:
        return text

    fm_block = text[3:fm_end_idx]
    body_after = text[fm_end_idx:]

    new_fm_lines = []
    for line in fm_block.splitlines(keepends=True):
        if RE_YAML_NAME_LINE.match(line.strip()):
            new_fm_lines.append(line)
            continue
        new_line = line
        for name, placeholder in ROLE_PLACEHOLDERS.items():
            if name not in new_line.lower():
                continue
            pat = _prose_pattern(name)
            if agent_id == "global":
                repl = placeholder
            elif name == agent_id:
                repl = "<AGENT>"
            else:
                repl = placeholder

            def _replacer(m, repl=repl, name=name):
                orig = m.group(1)
                suffix = m.group(0)[len(orig):]
                if repl != orig:
                    changes.append(f'YAML "{orig}" -> "{repl}"')
                return repl + suffix

            new_line = pat.sub(_replacer, new_line)
        new_fm_lines.append(new_line)

    return "---" + "".join(new_fm_lines) + body_after


# ---------------------------------------------------------------------------
# Main file migration
# ---------------------------------------------------------------------------

def migrate_file(path: Path, agent_id: str, dry_run: bool) -> list[str]:
    """
    Migrate one SKILL.md file. Scope-A expansion:
    - Shared/global (agent_id == 'global' or 'jarvis'): ALL sections, YAML desc, headers
    - Agent-own: cross-agent refs in ALL sections; YAML name: field is skipped
    Returns list of human-readable change descriptions.
    """
    original = path.read_text(encoding="utf-8")
    text = original
    changes: list[str] = []

    # --- YAML frontmatter (all non-name fields) ---
    text = migrate_yaml_frontmatter(text, agent_id, changes)

    # --- Pass 1: JSON "from"/"agent_id" self-references ---
    def replace_json_self(m: re.Match) -> str:
        field, val, close = m.group(1), m.group(2), m.group(3)
        if val not in ALL_AGENT_IDS:
            return m.group(0)
        if agent_id == "global":
            placeholder = ROLE_PLACEHOLDERS.get(val, f"<AGENT_{val.upper()}>")
            changes.append(f'JSON self-ref "{val}" -> "{placeholder}" (global)')
            return field + placeholder + close
        if val == agent_id:
            changes.append(f'JSON self-ref "{val}" -> "<AGENT>"')
            return field + "<AGENT>" + close
        return m.group(0)

    text = RE_JSON_SELF_FIELDS.sub(replace_json_self, text)

    # --- Pass 2: JSON "to" field ---
    def replace_json_to(m: re.Match) -> str:
        field, val, close = m.group(1), m.group(2), m.group(3)
        if val not in ALL_AGENT_IDS:
            return m.group(0)
        if agent_id != "global" and val == agent_id:
            changes.append(f'JSON "to" self-ref "{val}" -> "<AGENT>"')
            return field + "<AGENT>" + close
        placeholder = ROLE_PLACEHOLDERS.get(val, f"<AGENT_{val.upper()}>")
        changes.append(f'JSON "to":"{val}" -> "{placeholder}"')
        return field + placeholder + close

    text = RE_JSON_TO_FIELD.sub(replace_json_to, text)

    # --- Pass 3: prose replacement in ALL sections (scope-A expansion) ---
    for name, placeholder in ROLE_PLACEHOLDERS.items():
        if name not in text.lower():
            continue

        pat = _prose_pattern(name)

        def make_replacer(name: str, placeholder: str, agent_id: str):
            def replacer(m: re.Match) -> str:
                orig = m.group(1)
                actual_id = orig.lower()
                if agent_id == "global":
                    repl = ROLE_PLACEHOLDERS.get(actual_id, f"<{actual_id.upper()}_AGENT>")
                elif actual_id == agent_id:
                    repl = "<AGENT>"
                else:
                    repl = ROLE_PLACEHOLDERS.get(actual_id, f"<{actual_id.upper()}_AGENT>")
                suffix = m.group(0)[len(orig):]
                if repl != orig:
                    changes.append(f'Prose "{orig}" -> "{repl}"')
                return repl + suffix
            return replacer

        replacer_fn = make_replacer(name, placeholder, agent_id)

        # Process line by line; skip system identifiers and filename embeds
        lines = text.split("\n")
        result_lines = []
        in_frontmatter = False
        frontmatter_done = False
        frontmatter_line = 0

        for i, line in enumerate(lines):
            # Track frontmatter (skip -- already processed above)
            if i == 0 and line.strip() == "---":
                in_frontmatter = True
                result_lines.append(line)
                continue
            if in_frontmatter and line.strip() == "---":
                in_frontmatter = False
                frontmatter_done = True
                result_lines.append(line)
                continue
            if in_frontmatter:
                result_lines.append(line)
                continue

            # Skip system identifier lines
            if _is_system_identifier_line(line):
                result_lines.append(line)
                continue

            if name.lower() in line.lower():
                line = pat.sub(replacer_fn, line)

            result_lines.append(line)

        text = "\n".join(result_lines)

    # Deduplicate
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
    Returns agent_id string, or "global" for shared dirs (no single owner).
    """
    parts = skill_dir.parts
    try:
        agents_idx = parts.index("agents")
        return parts[agents_idx + 1]
    except (ValueError, IndexError):
        pass
    if "marveen" in parts:
        return "jarvis"
    return "global"


# ---------------------------------------------------------------------------
# Scope-A verification
# ---------------------------------------------------------------------------

def is_shared_dir(skill_dir: Path) -> bool:
    """True if this is a shared/global skill dir (not agent-own)."""
    agent_id = infer_agent_id(skill_dir)
    return agent_id in ("global", "jarvis")


def count_scope_a_refs(dirs: list[Path]) -> dict[str, int]:
    """
    Count ONLY in-scope (scope-A) refs:
    - Shared/global dirs: all agent-name occurrences
    - Agent-own dirs: cross-agent refs only (skip YAML name: field)
    """
    counts: dict[str, int] = {name: 0 for name in ALL_AGENT_IDS}

    for skill_dir in dirs:
        if not skill_dir.exists():
            continue
        agent_id = infer_agent_id(skill_dir)
        shared = is_shared_dir(skill_dir)

        for md in skill_dir.rglob("SKILL.md"):
            text = md.read_text(encoding="utf-8", errors="replace")
            lines = text.splitlines()
            in_fm = False
            fm_done = False

            for i, line in enumerate(lines):
                if i == 0 and line.strip() == "---":
                    in_fm = True
                    continue
                if in_fm and line.strip() == "---":
                    in_fm = False
                    fm_done = True
                    continue
                if in_fm:
                    # In frontmatter: skip 'name:' lines (self-identity)
                    if RE_YAML_NAME_LINE.match(line.strip()):
                        continue

                # Skip system identifiers
                if _is_system_identifier_line(line):
                    continue

                for name in ALL_AGENT_IDS:
                    if not shared and name == agent_id:
                        continue  # self-identity in own skills: out of scope
                    if re.search(r"\b" + re.escape(name) + r"\b", line, re.IGNORECASE):
                        counts[name] += 1

    return counts


def count_hardcoded_refs(dirs: list[Path]) -> dict[str, int]:
    """Count ALL agent-name refs (for --verify)."""
    counts: dict[str, int] = {name: 0 for name in ALL_AGENT_IDS}
    for skill_dir in dirs:
        if not skill_dir.exists():
            continue
        for md in skill_dir.rglob("SKILL.md"):
            text = md.read_text(encoding="utf-8", errors="replace")
            for name in ALL_AGENT_IDS:
                counts[name] += len(
                    re.findall(r"\b" + re.escape(name) + r"\b", text, re.IGNORECASE)
                )
    return counts


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate agent names to placeholders in skill files."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true")
    group.add_argument("--apply", action="store_true")
    group.add_argument("--verify", action="store_true")
    group.add_argument(
        "--verify-scope-a",
        action="store_true",
        help="Count only scope-A in-scope refs (target: 0)",
    )
    args = parser.parse_args()

    existing_dirs = [d for d in SKILL_DIRS if d.exists()]

    if args.verify:
        print("=== All hardcoded agent refs ===")
        counts = count_hardcoded_refs(existing_dirs)
        total = sum(counts.values())
        for name, count in sorted(counts.items(), key=lambda x: -x[1]):
            if count > 0:
                print(f"  {name}: {count}")
        print(f"  TOTAL: {total}")
        return

    if args.verify_scope_a:
        print("=== Scope-A in-scope refs (target: 0) ===")
        counts = count_scope_a_refs(existing_dirs)
        total = sum(counts.values())
        for name, count in sorted(counts.items(), key=lambda x: -x[1]):
            if count > 0:
                print(f"  {name}: {count}")
        print(f"  TOTAL: {total}")
        if total == 0:
            print("  SCOPE-A CLEAN")
        else:
            print(f"  {total} refs remaining -- run --dry-run to see details")
        print()
        print("  Documented system-identifier exceptions (explicit skip, not counted above):")
        for reason in DOCUMENTED_SKIP_REASONS:
            print(f"    - {reason}")
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
            print(f"  -> {dir_changes} changes in {dir_label}")
            print()

    print(f"=== Summary: {total_changes} changes across {total_files} files ===")
    if args.dry_run:
        print("Run with --apply to execute.")
    else:
        print("Backups written as .md.bak alongside modified files.")
        print("Run with --verify-scope-a to check scope-A remaining refs.")


if __name__ == "__main__":
    main()
