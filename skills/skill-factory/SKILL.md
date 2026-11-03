---
name: skill-factory
description: Turn any workflow, conversation, or demonstrated process into a reusable SKILL.md. Use when the user says "turn this into a skill", "make a skill from this", "save this workflow", "remember how to do this", or after completing a complex multi-step task that should be repeatable. Also triggers on "tanítsd meg magad", "jegyezd meg ezt a folyamatot", "csinálj ebből skill-t".
---

# Skill Factory

Convert demonstrated workflows into reusable skills. This is a meta-skill: it creates other skills.

## When to Use

- User explicitly asks to create a skill from a workflow
- User says "remember how to do this" or "save this process"
- After a complex task (5+ tool calls) that could be reusable
- When user corrects your approach and the correction is generalizable
- Hungarian triggers: "tanítsd meg magad", "csinálj skill-t", "jegyezd meg"

## Procedure

### Step 1: Extract the Workflow

Analyze the current conversation (or specified workflow) and identify:

1. **Trigger conditions**: When should this skill activate?
2. **Input**: What does the skill need to start?
3. **Steps**: What are the concrete steps (in order)?
4. **Tools used**: Which tools/commands were involved?
5. **Decision points**: Where did you need to make choices?
6. **Error handling**: What went wrong and how was it fixed?
7. **Output**: What's the expected result?

### Step 2: Generalize

Don't just copy the specific instance. Abstract it:

- Replace specific file names with `[input-file]` patterns
- Replace specific URLs with `[target-url]` patterns
- Identify which parts are constant vs. variable
- Note any prerequisites or dependencies
- Think about edge cases the original workflow didn't cover

### Step 3: Write SKILL.md

**Where first.** The block below writes into YOUR OWN folder, for a skill only you use. Do NOT run it for a skill
meant for every agent, for a fix to a global skill, or if you are the main agent (its working directory is the
project root, whose `.claude/skills` every sub-agent loads): draft those outside every skills folder and propose
them, as the note after the block says.

```bash
SKILL_NAME="[kebab-case-name]"
mkdir -p .claude/skills/$SKILL_NAME

cat > .claude/skills/$SKILL_NAME/SKILL.md << 'EOF'
---
name: [skill-name]
description: [What it does + when to trigger. Be specific and "pushy" -- include multiple trigger phrases so the skill activates when needed.]
---

# [Skill Name]

## When to Use
[List concrete trigger conditions and contexts]

## Prerequisites
[Dependencies, tools, access needed -- skip if none]

## Procedure
1. [First step -- be specific, include commands]
2. [Second step]
...

## Pitfalls
- **[Problem]**: [How to solve it]

## Verification
- [How to confirm the result is correct]

## Examples
**Example 1:**
Input: [what the user said]
Output: [what was produced]
EOF
```

This writes the skill into YOUR OWN folder (your working directory's `.claude/skills`), which only you load. A skill
for every agent, or a fix to an existing global skill (`~/.claude/skills`), is never written there directly: send the
complete SKILL.md to `POST /api/skills/propose` (body `{"name": ..., "skill_md": ..., "reason": ...}`, with the dashboard
token). It waits in quarantine until the owner approves it; an existing name becomes a replacement, and the approval backs
the old version up; on a replacement the live skill's other files are kept. A proposal carries the SKILL.md only: a NEW
global skill that needs scripts or references is the owner's call (ask them; they can import an archive on the
dashboard's Skills page, which is quarantined too). The main agent has no private folder, so it always proposes.

### Step 4: Add Supporting Files (if needed)

If the workflow involves scripts or templates:

```bash
mkdir -p .claude/skills/$SKILL_NAME/scripts
mkdir -p .claude/skills/$SKILL_NAME/references
```

- `scripts/`: Executable code for deterministic/repetitive tasks
- `references/`: Documentation loaded into context as needed
- `assets/`: Templates, icons, or other static files

### Step 5: Run the Linter (required)

Check the new or changed skill against Anthropic's "Skill authoring best practices" (https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices):

```bash
L=../../scripts/skill-lint.mjs; [ -f "$L" ] || L=scripts/skill-lint.mjs   # sub-agent cwd: agents/<name>/; main agent: the install root
node "$L" .claude/skills/$SKILL_NAME
```

If it reports a finding (non-zero exit), fix it and run it again until it is clean. The rules it checks:
- "Keep SKILL.md body under 500 lines for optimal performance" (the body after the frontmatter).
- "For reference files longer than 100 lines, include a table of contents at the top" (a `references/` file over 100 lines).
- "Keep references one level deep from SKILL.md": every supporting file is linked from SKILL.md itself, not only from another supporting file.
- Every relative markdown link in SKILL.md points to a file that exists.

The linter only reports; it never rewrites. Do not rewrite a skill installed from an outside source because of it.

### Step 6: Update Skill Index

```bash
bash scripts/skill-index.sh
```

### Step 7: Validate

Test the skill mentally:
- Would the description trigger on a realistic user message?
- Are the steps clear enough to follow without the original context?
- Are edge cases covered in Pitfalls?
- Is the SKILL.md body under 500 lines, and does the linter (Step 5) pass?

## Pitfalls

- **Overfitting to one example**: Don't just save the exact steps you did. Generalize so it works for similar but different inputs.
- **Too vague descriptions**: The description field is the primary trigger. Be specific and include multiple phrasings.
- **Missing error handling**: If you hit errors during the original workflow, document them in Pitfalls.
- **Too long**: Keep SKILL.md under 500 lines. Move large content to `references/` subdirectory.
- **Duplicate skills**: Before creating, check `~/.claude/skills/.skill-index.md` for existing similar skills. Patch instead of creating a new one.

## Skill Quality Checklist

Before finalizing, verify:
- [ ] Description includes multiple trigger phrases
- [ ] Steps are numbered and concrete
- [ ] Commands are copy-pasteable (no pseudocode)
- [ ] Variables are clearly marked with `[brackets]`
- [ ] Pitfalls section has at least one entry
- [ ] Verification section explains how to confirm success
- [ ] Under 500 lines, and `skill-lint` reports no finding
