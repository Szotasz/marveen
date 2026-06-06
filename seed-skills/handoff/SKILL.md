---
name: handoff
description: Generate a HANDOFF.md context transfer document for session continuity. Use when switching sessions, handing off to another agent, or preserving complex task context before a context window reset. Trigger on "/handoff" command or "handoff:" prefix in inter-agent messages.
---

# Handoff -- Session Context Transfer

## When to use

- You are about to hit context limits and need to preserve task state
- A task needs to continue in a fresh session (yours or another agent's)
- Inter-agent delegation of a complex, multi-step task
- User explicitly says `/handoff` or asks to "save context for later"
- Before a `/checkpoint` when the task is too complex for 3-5 bullet points

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `purpose` | YES | What the next session should do with this context |
| `target` | no | Agent name (e.g. `target=dev2`) -- sends via inter-agent message instead of writing file |
| `output` | no | File path override (default: project root `HANDOFF.md`) |

Examples:
- `/handoff purpose="Continue the Pipedrive connector PR review and address CI failures"`
- `/handoff purpose="Finish the scheduler forceSend implementation" target=dev2`
- `/handoff purpose="Debug the auth redirect loop" output=/tmp/handoff-auth.md`

## Procedure

### 1. Gather context

Collect data from these sources (skip any that return empty):

```bash
# Active kanban cards (assigned to current agent or recently touched)
AGENT_ID="$(echo $BOT_NAME | tr '[:upper:]' '[:lower:]')"
sqlite3 store/claudeclaw.db "SELECT id, title, status, priority, assignee, description FROM kanban_cards WHERE archived_at IS NULL AND (assignee = '$AGENT_ID' OR status = 'in_progress') ORDER BY priority DESC, updated_at DESC LIMIT 10"

# Hot memories from last 24h
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:3420/api/memories?agent=$AGENT_ID&category=hot&limit=10"

# Recent warm memories (project context)
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:3420/api/memories?agent=$AGENT_ID&category=warm&limit=5"

# Today's daily log
DATE=$(date +%Y-%m-%d)
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:3420/api/daily-log?agent=$AGENT_ID&date=$DATE"
```

Also include from your current conversation context:
- The last significant user/peer messages and decisions
- Any error patterns or debugging findings
- File paths and line numbers you were working on
- Git branch, uncommitted changes, open PRs

### 2. Generate HANDOFF.md

Structure with exactly these 5 sections:

```markdown
# Handoff: {purpose}

Generated: {ISO timestamp}
From: {agent name}
To: {target agent or "next session"}

## Goal
{What the overall task is trying to accomplish. 2-3 sentences max.}

## Current Progress
{What has been done so far. Bullet list with specifics:
- File paths changed
- PRs opened (with URLs)
- Kanban card IDs and their status
- Key decisions made}

## What Worked
{Approaches, tools, or patterns that succeeded:
- Specific commands or API calls that gave good results
- Architecture decisions that held up
- Workarounds that solved blockers}

## What Didn't Work
{Dead ends, failed approaches, gotchas:
- Commands or approaches that failed and WHY
- Assumptions that turned out wrong
- Edge cases discovered}

## Next Steps
{Concrete, actionable items for the receiving session:
1. First thing to do (most specific)
2. Second thing
3. ...
Keep each step concrete enough to execute without asking questions.}
```

### 3. Deliver

**File mode** (default): Write HANDOFF.md to the project root (or `output` path).

**Inter-agent mode** (`target=` specified): Send the full HANDOFF.md content as an inter-agent message:

```bash
curl -s -X POST http://localhost:3420/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d "{\"from\":\"$AGENT_ID\",\"to\":\"TARGET\",\"content\":\"[HANDOFF] purpose: ... \n\n$(cat HANDOFF.md)\"}"
```

### 4. Confirm

Report to the user/caller:
- Where the handoff was written (file path or inter-agent message ID)
- Summary: how many kanban cards, memories, and log entries were included
- The `purpose` line for quick reference

## Pitfalls

- Do NOT include secrets, tokens, or .env values in the handoff
- Do NOT include full file contents -- use paths and line numbers
- Keep it under 3000 words -- the receiving session needs room to work
- If `target=` agent is not running (check tmux), warn and fall back to file mode
- The handoff is a snapshot -- it goes stale. Include the timestamp prominently

## Relation to other persistence mechanisms

| Mechanism | Scope | Handoff uses it as |
|-----------|-------|--------------------|
| checkpoint | Session summary (SQLite) | Source: pulls recent checkpoint data |
| DREAM.md | Nightly consolidation | Not directly -- too high-level |
| hot memory | Active task state | Source: includes active hot memories |
| warm memory | Stable project context | Source: includes relevant warm context |
| kanban | Task tracking | Source: includes assigned/active cards |
| daily log | Chronological record | Source: includes today's log entries |

The handoff READS from these systems but does not REPLACE them. After a handoff, the receiving session should still check the live state of kanban/memory -- the handoff is a starting-context accelerator, not the source of truth.
