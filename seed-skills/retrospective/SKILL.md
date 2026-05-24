---
name: retrospective
description: Analyze the current session for improvement opportunities in skills, memory, and workflow. Spawns a sub-agent for unbiased analysis. Use when a session involved complex problem-solving, error recovery, user corrections, or multi-step workflows. Trigger on "/retrospective" command or at session end after significant work.
---

# Retrospective -- Session Analysis & Improvement

## When to use

- After a complex session (5+ tool calls, error recovery, multi-step workflow)
- When the user corrected your approach ("no, do it this way")
- After a failed attempt that required a different strategy
- Before context window exhaustion on a productive session
- Explicitly via `/retrospective` command

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `scope` | no | What to analyze: `session` (default), `last-task`, `last-hour` |
| `focus` | no | Narrow analysis: `skills`, `memory`, `workflow`, or `all` (default) |

Examples:
- `/retrospective` -- full session analysis
- `/retrospective scope=last-task focus=skills` -- only skill improvements for the last task
- `/retrospective focus=memory` -- only memory tier/content suggestions

## Procedure

### 1. Gather session data

Collect from the current conversation context:
- What tasks were attempted
- Which approaches succeeded vs failed
- User corrections and their reasoning
- Tools/skills used and their effectiveness
- Errors encountered and how they were resolved
- Time spent on dead ends vs productive work

Also pull external state:

```bash
AGENT_ID="$(echo $BOT_NAME | tr '[:upper:]' '[:lower:]')"

# Recent memories written this session
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:3420/api/memories?agent=$AGENT_ID&category=hot&limit=20"

# Today's daily log entries
DATE=$(date +%Y-%m-%d)
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:3420/api/daily-log?agent=$AGENT_ID&date=$DATE"

# Skills that were referenced or used
ls ~/.claude/skills/ | head -30
```

### 2. Analyze with A/B/C framework

For each significant event in the session, evaluate:

**A -- What happened?**
State the fact: what was attempted, what was the outcome.

**B -- Why did it happen that way?**
Root cause: was it a missing skill, wrong memory tier, incorrect assumption, tooling gap, or communication issue?

**C -- What should change?**
Concrete action: new skill, skill patch, memory write/update, workflow change, or nothing (if the outcome was correct).

### 3. Generate improvement proposals

Organize findings into categories:

#### Skill proposals
For each skill-related finding:
```
SKILL_ACTION: create | patch | delete
SKILL_NAME: name-of-skill
REASON: why this change helps
CHANGE: what specifically to add/modify/remove
```

Rules:
- Only propose a NEW skill if the pattern appeared 2+ times or was complex enough (5+ steps)
- Prefer PATCH over CREATE -- check if an existing skill covers 80% of the case
- Check `~/.claude/skills/.skill-index.md` before proposing duplicates

#### Memory proposals
For each memory-related finding:
```
MEMORY_ACTION: save | update | delete | retier
MEMORY_TIER: hot | warm | cold | shared
CONTENT: what to remember
REASON: why this tier, why now
```

Rules:
- User corrections -> always save as warm (stable preference)
- Task-specific findings -> hot (will decay naturally)
- Architectural decisions -> cold (long-term reference)
- Cross-agent learnings -> shared

#### Workflow proposals
For process improvements that don't fit skills or memory:
```
WORKFLOW_CHANGE: description of the process change
APPLIES_TO: this agent | all agents | specific agent
REASON: what problem it solves
```

### 4. Present to user for approval

Format the output as a concise action list:

```
## Retrospective Summary

Session: [brief description]
Duration: ~[estimate]
Key events: [count] tasks, [count] corrections, [count] errors

### Proposed Changes

#### Skills
1. [PATCH] skill-name: add X because Y
2. [CREATE] new-skill: handles Z pattern (seen 3x this session)

#### Memory
1. [SAVE warm] "user prefers X over Y" -- correction at [context]
2. [RETIER hot->cold] "project Z deadline" -- no longer active

#### Workflow
1. [ALL AGENTS] Always check CI before merging -- 2 failed merges this session

Apply all? (y/n/select)
```

### 5. Execute approved changes

On user approval:
- Skills: create/patch SKILL.md files, regenerate `.skill-index.md`
- Memory: write/update via the memory API
- Workflow: update CLAUDE.md or inter-agent message to affected agents

After execution, log the retrospective to the daily log:
```bash
curl -s -X POST -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/daily-log \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"content\":\"## $(date +%H:%M) -- Retrospective\n[count] skill changes, [count] memory updates, [count] workflow changes applied.\"}"
```

## Pitfalls

- Do NOT auto-apply changes without user approval -- always present first
- Do NOT create skills for one-off tasks that won't repeat
- Do NOT save ephemeral debugging context as cold memory
- If the session was straightforward with no issues, say so and skip -- not every session needs changes
- Keep proposals actionable and specific -- "be better at X" is not a proposal

## Relation to existing mechanisms

| Mechanism | Retrospective's role |
|-----------|---------------------|
| memoria-heartbeat | Retrospective is the dedicated, deeper version. Heartbeat does inline A/B/C; retrospective does it thoroughly with user approval |
| skill-factory | Retrospective proposes skills; skill-factory creates them. Retrospective may invoke skill-factory for CREATE actions |
| DREAM.md | Nightly consolidation. Retrospective is on-demand, immediate |
| /handoff | Retrospective analyzes; handoff transfers. Different purposes |
