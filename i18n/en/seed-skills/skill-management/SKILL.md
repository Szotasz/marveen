---
name: skill-management
description: List, inspect, create, patch, or delete skills. Your own (the .claude/skills folder of your working directory) are changed directly; the global ones (~/.claude/skills/) are read here and changed only through a proposal. Use when the user asks about available skills, wants to modify an existing skill, or when a retrospective proposes skill changes. Trigger on "/skills" command or skill-related retrospective actions.
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
| `scope` | no | `own` (default, ./.claude/skills/ in your working directory: you change these directly) or `global` (~/.claude/skills/: read here, changed only as a proposal) |

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
for SKILL_DIR in "./.claude/skills" "${HOME}/.claude/skills"; do
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
done
```

Present as a compact table, own and global separately. An own skill shadows a global one of the same name.

### action=show

1. Read `./.claude/skills/{name}/SKILL.md` (own) or `~/.claude/skills/{name}/SKILL.md` (global)
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

4. Own (the default): write `./.claude/skills/{name}/SKILL.md` in your working directory.
   For every agent (global): do NOT write `~/.claude/skills/`; send it as a proposal (see "Changing a global skill").
5. Own: refresh your index (see "Skill Index Regeneration")

Rules:
- Keep SKILL.md under 500 lines
- Large reference material goes in `references/` subdirectory
- Description must be specific enough for L0 matching (not "does stuff")
- Procedure steps must be concrete and executable

### action=patch

Targeted modification of an existing skill:

1. Read the current SKILL.md. An own skill is patched in place; a global one is never edited where it lives: the
   WHOLE fixed text goes as a proposal under the same name (see "Changing a global skill")
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
3. On confirmation, an OWN skill only:
```bash
rm -rf "./.claude/skills/${NAME}"
```
   (Some agent profiles deny `rm`: then ask the main agent.) A global skill is not deleted by an agent: removing it
   from the fleet is the owner's call, on the dashboard's Skills page.
4. Refresh your index (see "Skill Index Regeneration")

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

When your own skills are created, patched, or deleted, regenerate YOUR index: the install's `scripts/skill-index.sh`
with your working directory as its argument (the exact path is in your CLAUDE.md). It writes
`./.claude/skills/.skill-index.md`, merging the global skills with yours. The global index
(`~/.claude/skills/.skill-index.md`) is not yours to write.

## Changing a global skill

`~/.claude/skills/` is loaded by every agent, so a new global skill or a fix to one goes only as a proposal:

1. Write the complete SKILL.md as a draft in your working directory (e.g. `./.claude/skill-javaslat/SKILL.md`);
   for a fix, start from the current text (`cat ~/.claude/skills/{name}/SKILL.md`) and send the WHOLE fixed text
2. Write one or two sentences on why into a reason file next to it
3. Send it with the dashboard helper named in your CLAUDE.md (`marveen-api.sh`), verb `skill-propose`:
   `skill-propose {name} <draft SKILL.md> --reason-file <reason file>` (it calls `POST /api/skills/propose`)

Whether it goes live at once or waits for the owner's approval depends on the install's skill quarantine switch; the
answer's `live` field tells which. An existing name becomes a replacement, and the old version is backed up.

## Pitfalls

- Do NOT write `~/.claude/skills/`, another agent's `.claude/skills/` or the install root's `.claude/skills/`: every
  one of them is loaded by sessions other than yours, and a sub-agent's write gate denies them. Your own folder is free.
- The main agent has no private skill folder: its working directory is the install root, so its `./.claude/skills` is
  loaded by every sub-agent too. The main agent therefore proposes every new or changed skill as well.
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
