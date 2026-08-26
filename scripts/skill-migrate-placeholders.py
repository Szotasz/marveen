#!/usr/bin/env python3
"""
skill-migrate-placeholders.py

Migrates hardcoded fleet agent names AND the operator's personal name / email in SKILL.md files
to portable placeholders.

Usage:
  python3 scripts/skill-migrate-placeholders.py --dry-run         # show planned changes only
  python3 scripts/skill-migrate-placeholders.py --apply           # apply with .bak backups
  python3 scripts/skill-migrate-placeholders.py --verify          # count remaining hardcoded refs
  python3 scripts/skill-migrate-placeholders.py --verify-scope-a  # count only in-scope agent refs
  python3 scripts/skill-migrate-placeholders.py --verify-owner    # count remaining owner refs

Scope-A definition (must reach 0):
  - Shared/global skills: ALL agent-name refs (all sections, YAML, headers)
  - Agent-own skills: cross-agent refs only (not YAML name: field self-identity)

Idempotent: running --apply twice is safe (already-replaced text stays unchanged).

Skip list (system identifiers, not fleet-agent refs):
  - com.jarvis.* LaunchAgent labels (boo/marveen-branch-live-test)
  - Filenames where agent name is embedded in the filename itself (e.g. "Poly neka-redesign.html")

Owner name / email skip list (exceptions NOT replaced):
  - Domain contexts: jonasgergo.hu, aimit.hu, etc.
  - Python open() file paths -- Python does not expand $HOME; paths must stay absolute
  - Google MCP token filenames (tokens/jonas.json, account=jonas)
  - snake_case memory slugs (warm_jonas_*, feedback_gergo_*, etc.)
  - Wiki links ([[warm_jonas_infografika_preferenciak]])
  - grep privacy-filter pattern strings (where the name IS the grep search term)
  - Bash home paths /Users/<username>/ are normalised to $HOME/ separately (not a name ref)

Runtime token resolution:
  <OWNER> and <BACKEND_AGENT>-style tokens in skill files are DOCUMENTATION-ONLY placeholders.
  They are NOT resolved at runtime when agents read skill files. Agent scaffold templates use
  {{OWNER_NAME}} (double curly) syntax which resolveTemplatePlaceholders() handles at agent
  creation time. No additional wiring is needed for skill-file angle-bracket tokens.
"""

import argparse
import os
import re
import shutil
import unicodedata
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

# ---------------------------------------------------------------------------
# Owner name / email configuration
# ---------------------------------------------------------------------------
# Read from MARVEEN_ROOT/.env first, then override with os.environ.
# Matches how src/config.ts loads OWNER_NAME: env['OWNER_NAME'] ?? 'Owner'.
# OWNER_NAME_PLACEHOLDER keeps migration-safe: the literal word "Owner" is the
# generic default and not a person's name, so we never replace it.

def _load_dotenv(marveen_root: Path) -> dict[str, str]:
    """Parse key=value lines from .env without shell expansion."""
    env_file = marveen_root / ".env"
    result: dict[str, str] = {}
    if not env_file.exists():
        return result
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        # Strip optional surrounding quotes
        val = val.strip().strip('"').strip("'")
        result[key.strip()] = val
    return result


def _resolve_owner_config(marveen_root: Path) -> tuple[str, str]:
    """Return (OWNER_NAME, OWNER_EMAIL) from .env + os.environ."""
    dotenv = _load_dotenv(marveen_root)
    name = os.environ.get("OWNER_NAME") or dotenv.get("OWNER_NAME") or ""
    email = os.environ.get("OWNER_EMAIL") or dotenv.get("OWNER_EMAIL") or ""
    return name, email


# Resolved at startup (after MARVEEN_ROOT is set below).
# These are filled in main() or at module level after MARVEEN_ROOT is known.
OWNER_NAME: str = ""
OWNER_EMAIL: str = ""

# ---------------------------------------------------------------------------
# Owner name regex patterns
# ---------------------------------------------------------------------------
# Built at startup once OWNER_NAME is resolved (see _build_owner_patterns).
# Keeping them as module-level vars lets unit tests set them directly.

OWNER_NAME_RX: re.Pattern | None = None
OWNER_EMAIL_RX: re.Pattern | None = None

# Common Hungarian noun-case suffixes that attach directly to a name (no space).
# Listed longest-first so alternation prefers the longest match.
_HU_SUFFIXES = (
    "höz", "hez", "hoz",   # adessive
    "től", "tól",           # ablative
    "ből", "ból",           # elative
    "nek", "nak",           # dative
    "vel", "val",           # instrumental
    "nél", "nál",           # adessive-2
    "ről", "ről", "rol",    # delative
    "ből",                  # (listed again harmlessly; re deduplicates)
    "ben", "ban",           # inessive
    "nek", "nak",           # (harmless repeat)
    "re", "ra",             # sublative
    "t",                    # accusative (short; must be last to avoid masking longer ones)
)
_HU_SUFFIX_ALT = "|".join(dict.fromkeys(_HU_SUFFIXES))  # deduplicated, order preserved


def _build_owner_patterns(owner_name: str, owner_email: str) -> None:
    """Build OWNER_NAME_RX and OWNER_EMAIL_RX from the resolved config values."""
    global OWNER_NAME_RX, OWNER_EMAIL_RX

    if owner_name and owner_name.lower() not in ("owner", ""):
        # Split into first / last name to support accented and unaccented variants.
        # Canonical: "Jónás Gergő"; unaccented variant: "Jonas Gergo".
        # Also handle the OS username form as an atomic unit (e.g. "jonasgergo").
        parts = owner_name.split()
        if len(parts) >= 2:
            first_raw, last_raw = parts[0], parts[-1]

            def _accent_alts(s: str) -> str:
                """Return a regex that matches both accented and unaccented forms."""
                return (
                    s
                    .replace("á", "[aá]").replace("é", "[eé]")
                    .replace("í", "[ií]").replace("ó", "[oó]")
                    .replace("ö", "[oö]").replace("ő", "[oöő]")  # ő → o, ö, or ő
                    .replace("ú", "[uú]").replace("ü", "[uü]")
                    .replace("ű", "[uüű]")                       # ű → u, ü, or ű
                    .replace("A", "[aA]").replace("E", "[eE]")
                )

            first_rx = _accent_alts(first_raw)
            last_rx = _accent_alts(last_raw)

            # Derive the username form: lowercase, ASCII-only, concatenated.
            # unicodedata NFKD decomposes accented chars (á→a+combining, ő→o+combining)
            # so the ASCII filter strips the combining marks and leaves base letters.
            username = "".join(
                c for c in unicodedata.normalize("NFKD", owner_name.lower())
                if c.isascii() and (c.isalpha() or c.isdigit())
            )

            # Alternation: longest match first (full name before username).
            # Look-around instead of \b (unreliable with accented chars).
            # Capture group 1: matched name form.
            # Capture group 2: optional Hungarian suffix (consumed, recreated with hyphen).
            OWNER_NAME_RX = re.compile(
                r"(?<![a-zA-Z0-9_])"
                r"(" + first_rx + r"\s+" + last_rx
                + (r"|" + re.escape(username) if username else r"")
                + r")"
                r"(?:(" + _HU_SUFFIX_ALT + r"))?"
                r"(?![a-zA-Z0-9_])",
                re.IGNORECASE,
            )
        else:
            # Single-word owner name: match as-is.
            OWNER_NAME_RX = re.compile(
                r"(?<![a-zA-Z0-9_])(" + re.escape(owner_name) + r")(?![a-zA-Z0-9_])",
                re.IGNORECASE,
            )

    if owner_email and "@" in owner_email:
        OWNER_EMAIL_RX = re.compile(re.escape(owner_email), re.IGNORECASE)


# ---------------------------------------------------------------------------
# Owner exception detection
# ---------------------------------------------------------------------------

# Matches the OS home path that should become $HOME/ in bash contexts.
# Separate from name replacement: the path is a filesystem reference, not a name.
_OS_PATH_RX: re.Pattern | None = None  # built after MARVEEN_ROOT/HOME are known

# Lines where the owner name appears inside a Python open() call: keep as absolute path.
_PYTHON_OPEN_PREFIX_RX = re.compile(r"""open\s*\(\s*['"]""")

# snake_case identifier: underscore immediately before or after the match position.
_SNAKE_BEFORE_RX = re.compile(r"_$")
_SNAKE_AFTER_RX = re.compile(r"^_")

# Wiki link: match is between [[ and ]]
_WIKI_OPEN_RX = re.compile(r"\[\[[^\]]*$")
_WIKI_CLOSE_RX = re.compile(r"^[^\[]*\]\]")

# Domain context: name immediately before a TLD dot
_DOMAIN_AFTER_RX = re.compile(r"^\.(hu|com|net|org|io|eu)\b")

# Skill slug with hyphen (jonasgergo-hu, jonasgergo-hu-cikk, etc.)
_SLUG_AFTER_RX = re.compile(r"^-[a-z]")

# Google MCP account/token patterns: "account=jonas" or "tokens/jonas.json" or "jonas.json"
_GOOGLE_ACCOUNT_RX = re.compile(r"""account\s*=\s*['"]?\w+['"]?|tokens/\w+\.json|\w+\.json['"]""")

# grep pattern context: name appears as part of a grep search term (inside quotes after grep)
_GREP_PATTERN_RX = re.compile(r"""grep\b[^"']*['"][^'"]*$""")


def _is_owner_name_exception(line: str, match: re.Match) -> str | None:
    """Return a skip reason string if the owner name match should not be replaced, else None."""
    start, end = match.start(), match.end()
    before = line[:start]
    after = line[end:]

    # 1. Domain context (jonasgergo.hu, aimit.hu…)
    if _DOMAIN_AFTER_RX.match(after):
        return "domain context"

    # 2. Skill/slug: username form (no space) immediately before a hyphen+letter.
    # Full name form (with space) followed by hyphen is a ragozás, not a slug.
    if _SLUG_AFTER_RX.match(after) and " " not in (match.group(1) or ""):
        return "slug/skill-name context"

    # 3. Python open() path: an open(" or open(' appears before the match on the same line
    if _PYTHON_OPEN_PREFIX_RX.search(before):
        return "python open() path"

    # 4. Google MCP token / account references
    if _GOOGLE_ACCOUNT_RX.search(line):
        # Only skip if the matched text is related to the google pattern
        # (line contains account=... or tokens/*.json)
        return "google-mcp account/token"

    # 5. snake_case identifier: underscore immediately adjacent
    if _SNAKE_BEFORE_RX.search(before) or _SNAKE_AFTER_RX.match(after):
        return "snake_case identifier"

    # 6. Wiki link: match is between [[ and ]] on the same line
    if _WIKI_OPEN_RX.search(before) and _WIKI_CLOSE_RX.match(after):
        return "wiki link slug"

    # 7. grep privacy-filter line: grep appears earlier on the line and we're inside its quote
    if _GREP_PATTERN_RX.search(before):
        return "grep pattern string"

    return None


# ---------------------------------------------------------------------------
# Path normalisation (bash contexts)
# ---------------------------------------------------------------------------

def _normalize_bash_path(text: str, home_path: str, changes: list[str]) -> str:
    """Replace /Users/<username>/ with $HOME/ in bash contexts.

    Skips lines containing Python open() calls: Python does not expand $HOME.
    """
    if not home_path or home_path not in text:
        return text

    path_rx = re.compile(re.escape(home_path))
    lines = text.split("\n")
    result = []
    for line in lines:
        if home_path not in line:
            result.append(line)
            continue
        if _PYTHON_OPEN_PREFIX_RX.search(line):
            result.append(line)  # keep absolute path in Python open() calls
            continue
        new_line = path_rx.sub("$HOME/", line)
        if new_line != line:
            changes.append(f'Path "{home_path}" -> "$HOME/"')
        result.append(new_line)
    return "\n".join(result)


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
# Code-fence guard
# ---------------------------------------------------------------------------

def _is_fence_marker(line: str) -> bool:
    """Return True if this line opens or closes a Markdown code fence.

    Placeholders belong in prose, not in executable commands. Passes 3-5 must
    not fire inside code fences so that real agent IDs / owner tokens in shell
    commands are never silently replaced with placeholder literals that cause
    silent command failures (e.g. grep finding nothing, tmux finding no session).
    """
    return line.strip().startswith("```")


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

    # Pass 1 is line-by-line so code fences are not touched
    lines = text.split("\n")
    result_lines = []
    in_fence = False
    for line in lines:
        if _is_fence_marker(line):
            in_fence = not in_fence
            result_lines.append(line)
            continue
        if in_fence:
            result_lines.append(line)
            continue
        result_lines.append(RE_JSON_SELF_FIELDS.sub(replace_json_self, line))
    text = "\n".join(result_lines)

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

    # Pass 2 is also line-by-line: a "to":"peter" in a curl command must stay
    lines = text.split("\n")
    result_lines = []
    in_fence = False
    for line in lines:
        if _is_fence_marker(line):
            in_fence = not in_fence
            result_lines.append(line)
            continue
        if in_fence:
            result_lines.append(line)
            continue
        result_lines.append(RE_JSON_TO_FIELD.sub(replace_json_to, line))
    text = "\n".join(result_lines)

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
        in_fence = False

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

            # Track code fences: placeholders belong in prose, not in commands
            if _is_fence_marker(line):
                in_fence = not in_fence
                result_lines.append(line)
                continue
            if in_fence:
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

    # --- Pass 4: owner name replacement ---
    if OWNER_NAME_RX is not None:
        lines = text.split("\n")
        result_lines = []
        in_frontmatter = False
        in_fence = False

        for i, line in enumerate(lines):
            if i == 0 and line.strip() == "---":
                in_frontmatter = True
                result_lines.append(line)
                continue
            if in_frontmatter and line.strip() == "---":
                in_frontmatter = False
                result_lines.append(line)
                continue
            if in_frontmatter:
                result_lines.append(line)
                continue

            # Track code fences: owner name must not be replaced inside commands
            if _is_fence_marker(line):
                in_fence = not in_fence
                result_lines.append(line)
                continue
            if in_fence:
                result_lines.append(line)
                continue

            def _owner_replacer(m: re.Match) -> str:
                reason = _is_owner_name_exception(line, m)
                if reason:
                    return m.group(0)  # no change
                suffix = m.group(2)
                if suffix:
                    result = "<OWNER>-" + suffix.lower()
                else:
                    result = "<OWNER>"
                if result != m.group(0):
                    changes.append(f'Owner name "{m.group(0)}" -> "{result}"')
                return result

            new_line = OWNER_NAME_RX.sub(_owner_replacer, line)
            result_lines.append(new_line)

        text = "\n".join(result_lines)

    # --- Pass 5: owner email replacement ---
    if OWNER_EMAIL_RX is not None:
        def _email_replacer(m: re.Match) -> str:
            changes.append(f'Owner email "{m.group(0)}" -> "<OWNER_EMAIL>"')
            return "<OWNER_EMAIL>"
        lines = text.split("\n")
        result_lines = []
        in_fence = False
        for line in lines:
            if _is_fence_marker(line):
                in_fence = not in_fence
                result_lines.append(line)
                continue
            if in_fence:
                result_lines.append(line)
                continue
            result_lines.append(OWNER_EMAIL_RX.sub(_email_replacer, line))
        text = "\n".join(result_lines)

    # --- Pass 6: bash path normalisation ($HOME) ---
    home_path = str(Path.home()) + "/"
    text = _normalize_bash_path(text, home_path, changes)

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

def count_owner_refs(dirs: list[Path]) -> int:
    """Count remaining owner name/email refs (for --verify-owner)."""
    total = 0
    if OWNER_NAME_RX is None and OWNER_EMAIL_RX is None:
        return 0
    for skill_dir in dirs:
        if not skill_dir.exists():
            continue
        for md in skill_dir.rglob("SKILL.md"):
            if md.name == ".skill-index.md":
                continue
            text = md.read_text(encoding="utf-8", errors="replace")
            for line in text.splitlines():
                if OWNER_NAME_RX is not None:
                    for m in OWNER_NAME_RX.finditer(line):
                        if _is_owner_name_exception(line, m) is None:
                            total += 1
                if OWNER_EMAIL_RX is not None:
                    total += len(OWNER_EMAIL_RX.findall(line))
    return total


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate agent names and owner name to placeholders in skill files."
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
    group.add_argument(
        "--verify-owner",
        action="store_true",
        help="Count remaining owner name/email refs (target: 0)",
    )
    args = parser.parse_args()

    # Resolve and build owner patterns at startup.
    global OWNER_NAME, OWNER_EMAIL
    OWNER_NAME, OWNER_EMAIL = _resolve_owner_config(MARVEEN_ROOT)
    _build_owner_patterns(OWNER_NAME, OWNER_EMAIL)

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

    if args.verify_owner:
        if OWNER_NAME_RX is None and OWNER_EMAIL_RX is None:
            print("=== Owner refs: OWNER_NAME not configured (set OWNER_NAME in .env) ===")
            return
        print(f"=== Owner name refs (target: 0) -- OWNER_NAME={OWNER_NAME!r} ===")
        total = count_owner_refs(existing_dirs)
        print(f"  Remaining replaceable refs: {total}")
        if total == 0:
            print("  OWNER CLEAN")
        else:
            print(f"  {total} refs remaining -- run --dry-run to see details")
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
            if md.name == ".skill-index.md":
                continue  # auto-generated; regenerate with skill-index.sh after apply
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
