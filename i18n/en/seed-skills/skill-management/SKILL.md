---
name: skill-management
description: List, inspect, patch, or delete skills from ~/.claude/skills/. Use when the user asks about available skills, wants to modify an existing skill, or when a retrospective proposes skill changes. Trigger on "/skills" command or skill-related retrospective actions.
---

# Skill Management -- CRUD for the Skill Library

## When to use

- User asks "what skills do I have?" or "list skills"
- User wants to inspect a specific skill's content
- A `/retrospective` proposes CREATE, PATCH, or DELETE actions on skills
- User says "update skill X" or "fix skill Y"
- Periodic audit: check for stale or duplicate skills

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `action` | YES | One of: `list`, `show`, `create`, `patch`, `delete`, `audit` |
| `name` | for show/patch/delete | Skill directory name (e.g. `github-pr-rebase-merge`) |
| `scope` | no | `global` (default, ~/.claude/skills/) or `local` (./claude/skills/) |

Examples:
- `/skills action=list` -- list all skills with descriptions
- `/skills action=show name=github-pr-rebase-merge` -- show full SKILL.md
- `/skills action=create name=new-skill` -- interactive skill creation
- `/skills action=patch name=existing-skill` -- modify specific sections
- `/skills action=delete name=old-skill` -- remove with confirmation
- `/skills action=audit` -- find stale, duplicate, or oversized skills

## Procedure

### action=list

```bash
SKILL_DIR="${HOME}/.claude/skills"
if [ "$SCOPE" = "local" ]; then SKILL_DIR="./.claude/skills"; fi

echo "=== Skills in $SKILL_DIR ==="
for dir in "$SKILL_DIR"/*/; do
  skill_file="$dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    name=$(basename "$dir")
    # Extract description from frontmatter
    desc=$(sed -n '/^description:/{ s/^description: *//; p; q; }' "$skill_file")
    printf "  %-35s %s\n" "$name" "$desc"
  fi
done
```

Present as a compact table. If both global and local exist, show both.

### action=show

1. Read `~/.claude/skills/{name}/SKILL.md`
2. If it has a `references/` subdirectory, list those files too
3. Present the full content

### action=create

Interactive skill creation workflow:

1. Ask for trigger context: "When should this skill activate?"
2. Ask for procedure steps: "What does it do, step by step?"
3. Generate SKILL.md with proper frontmatter:

```markdown
---
name: {name}
description: {one-line, specific about triggers}
---

# {Title}

## When to use
{Concrete triggers and contexts}

## Procedure
1. {Step}
2. {Step}
...

## Pitfalls
- {Known issues, if any}
```

4. Write to `~/.claude/skills/{name}/SKILL.md`
5. Update `.skill-index.md` if it exists

Rules:
- Keep SKILL.md under 500 lines
- Large reference material goes in `references/` subdirectory
- Description must be specific enough for L0 matching (not "does stuff")
- Procedure steps must be concrete and executable

### action=patch

Targeted modification of an existing skill:

1. Read the current SKILL.md
2. Identify the section to change based on user input or retrospective proposal
3. Apply targeted edit (old text -> new text), not full rewrite
4. If adding a pitfall from a runtime discovery, append to the Pitfalls section
5. Log the patch reason in the Pitfalls section if it came from an error recovery

Rules:
- Never rewrite the entire skill for a small change
- Preserve existing pitfalls and procedure steps unless explicitly removing
- If the patch changes triggers, update the description in frontmatter too

### action=delete

1. Show the skill content first
2. Ask for confirmation: "Delete skill '{name}'? This removes the entire directory."
3. On confirmation:
```bash
rm -rf "${HOME}/.claude/skills/${NAME}"
```
4. Update `.skill-index.md` if it exists

Rules:
- Never delete without showing content first
- Never delete without explicit user confirmation
- If the skill is referenced by other skills, warn before deleting

### action=audit

Comprehensive skill library health check:

1. **Stale detection**: Skills not referenced in any CLAUDE.md and with no git activity in 60+ days
```bash
for dir in ~/.claude/skills/*/; do
  name=$(basename "$dir")
  skill_file="$dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    mod_date=$(stat -f '%Sm' -t '%Y-%m-%d' "$skill_file" 2>/dev/null || stat -c '%y' "$skill_file" 2>/dev/null | cut -d' ' -f1)
    echo "$mod_date  $name"
  fi
done | sort
```

2. **Duplicate detection**: Skills with overlapping descriptions or triggers
```bash
for dir in ~/.claude/skills/*/; do
  skill_file="$dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    desc=$(sed -n '/^description:/{ s/^description: *//; p; q; }' "$skill_file")
    echo "$(basename "$dir"): $desc"
  fi
done
```
Review for semantic overlaps manually.

3. **Size check**: Skills over 500 lines that should be refactored
```bash
for dir in ~/.claude/skills/*/; do
  skill_file="$dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    lines=$(wc -l < "$skill_file")
    if [ "$lines" -gt 500 ]; then
      echo "OVERSIZED ($lines lines): $(basename "$dir")"
    fi
  fi
done
```

4. **Index sync**: Check `.skill-index.md` matches actual directories
```bash
if [ -f ~/.claude/skills/.skill-index.md ]; then
  echo "Index exists, checking sync..."
  # Compare index entries vs actual directories
  indexed=$(grep -oP '(?<=\[)[^\]]+' ~/.claude/skills/.skill-index.md | sort)
  actual=$(ls -d ~/.claude/skills/*/ 2>/dev/null | xargs -I{} basename {} | sort)
  diff <(echo "$indexed") <(echo "$actual")
fi
```

Present findings as:
```
## Skill Audit Results

Total skills: {count} (global) + {count} (local)
Disk usage: {size}

### Issues Found
- [STALE] skill-name: last modified 2025-01-15 (130 days ago)
- [DUPLICATE] skill-a / skill-b: overlapping trigger "when deploying..."
- [OVERSIZED] skill-name: 720 lines (max 500)
- [UNINDEXED] skill-name: exists on disk but not in .skill-index.md

### Recommended Actions
1. DELETE skill-a (superseded by skill-b)
2. PATCH skill-c: move 300 lines to references/
3. REINDEX: regenerate .skill-index.md
```

## Skill Index Regeneration

When skills are created, patched, or deleted, regenerate the index:

```bash
INDEX_FILE="${HOME}/.claude/skills/.skill-index.md"
echo "# Skill Index" > "$INDEX_FILE"
echo "" >> "$INDEX_FILE"
echo "Auto-generated. Do not edit manually." >> "$INDEX_FILE"
echo "" >> "$INDEX_FILE"

for dir in ~/.claude/skills/*/; do
  skill_file="$dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    name=$(basename "$dir")
    desc=$(sed -n '/^description:/{ s/^description: *//; p; q; }' "$skill_file")
    echo "- **$name**: $desc" >> "$INDEX_FILE"
  fi
done
```

## Pitfalls

- Do NOT auto-delete skills without user confirmation
- Do NOT create skills for one-off tasks (check the 2+ occurrence rule)
- Audit results are advisory, not auto-executed
- The `.skill-index.md` is for L0 matching only; the full SKILL.md is L1
- On macOS, `stat` syntax differs from Linux; the audit commands handle both
- If a skill references external APIs or tokens, never include the actual values

## Relation to other mechanisms

| Mechanism | Skill-management's role |
|-----------|------------------------|
| retrospective | Retrospective proposes changes; skill-management executes them |
| CLAUDE.md | CLAUDE.md references skills; skill-management maintains the library |
| .skill-index.md | Skill-management regenerates this after mutations |
| seed-skills/ | Seed skills are templates; once installed they become regular skills managed here |
