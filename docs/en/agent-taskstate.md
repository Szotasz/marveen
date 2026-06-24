# Agent Task State

> Amnesia prevention during context compaction: saving and re-injecting structured task state so the agent resumes exactly where it left off.

---

## What it does / why it matters

During long-running tasks Claude Code automatically **compacts the context** (PreCompact hook). In the process the "exactly where I am, what I've done, what NOT to repeat" information can be lost — the agent resumes "amnesically", and in the worst case **re-delegates already-issued tasks** or re-executes already-completed steps.

The Agent Task State system solves this:

1. **PreCompact hook** (before compaction): the agent writes a structured record — done steps, already-delegated tasks, next action, open decisions
2. **SessionStart hook** (on restart): if the source is `compact` or `resume`, the record is re-injected into the agent's context
3. The agent knows precisely: "this is done, do NOT repeat it, continue from here"

**Fail-safe design**: if the PreCompact extraction fails, no record is written — re-injection is a no-op, and Claude's own summary remains valid. The system can only help, never harm.

---

## Record structure

```json
{
  "agent": "zack",
  "doneSteps": [
    "PR branch created and pushed",
    "Cross-fork compare verified"
  ],
  "alreadyDelegated": [
    "Compare link handed off to Jarvis"
  ],
  "nextAction": "Wait for Jarvis confirmation that the PR is open",
  "pendingDecision": "",
  "summary": "docs/scheduled-tasks PR prep and push to cett fork",
  "ts": 1748956800000,
  "consumed": false
}
```

| Field | Description |
|-------|-------------|
| `agent` | Agent identifier (becomes the filename) |
| `doneSteps` | Completed steps — **do NOT repeat** |
| `alreadyDelegated` | Already-issued delegations — **do NOT re-send** |
| `nextAction` | Where to continue from |
| `pendingDecision` | Open decision/blocker, if any |
| `summary` | One line: what is currently in progress |
| `ts` | Write timestamp (epoch ms) |
| `consumed` | `true` = already re-injected, will not replay |

---

## Lifecycle

```
Task running
    │
    ▼
[context fills up]
    │
    ▼
PreCompact hook
    └─ agent writes structured record
       store/agent-taskstate/<agent>.json
    │
    ▼
Claude Code compacts
    │
    ▼
SessionStart hook (source=compact)
    └─ record exists + not consumed + TTL ok?
       ├─ yes: inject into additionalContext, set consumed=true
       └─ no: no-op
    │
    ▼
Agent continues the task
(knows exactly what's done and what isn't)
```

---

## Record location

```
store/agent-taskstate/
  jarvis.json
  zack.json
  ...
```

One file per agent. The agent name is sanitised (only `a-z`, `A-Z`, `0-9`, `_`, `-` are allowed in filenames).

---

## TTL (time to live)

The record is automatically deleted after **12 hours** by an orphan sweep, so stale state is never re-injected. For genuinely long-running tasks this is sufficient — the PreCompact hook updates the record on every compaction.

---

## Re-injection conditions

A record is re-injected **only if**:

| Condition | Explanation |
|-----------|-------------|
| Record exists | `store/agent-taskstate/<agent>.json` is present |
| `consumed == false` | Not yet replayed |
| `source` = `compact` or `resume` | Does NOT fire on cold startup (`startup`) — only on continuation |
| Within TTL | At most 12 hours old |
| Non-empty record | At least one done step, delegation, next action, or open decision |

---

## Injected text format

The following structure is injected into the agent's context (intentionally prominent):

```
=== TASK-CONTINUATION (NOT a new task) ===

Your context was compacted during an IN-PROGRESS task.
This is NOT a new task — CONTINUE from where you left off.
Do NOT restart already-completed steps, and do NOT re-delegate what you already handed off.

TASK: docs/scheduled-tasks PR preparation

ALREADY DONE (do NOT repeat):
  - PR branch created and pushed
  - Cross-fork compare verified

ALREADY DELEGATED (do NOT re-send):
  - Compare link handed off to Jarvis

NEXT ACTION (continue from here): Wait for Jarvis confirmation
```

---

## API

Task-state management happens primarily at the hook and agent-code level. Viewable on the dashboard (for dev/debug purposes):

```
GET /api/agents/<name>/taskstate
```

Returns the current record if one exists.

---

## Related documents

- [Agent fleet](agent-fleet.md) — agent lifecycle, hooks
- [Skill factory](skill-factory.md) — PreCompact hook and skill reflection
- [Background tasks](background-tasks.md) — long-running workflows
