# Hooks

> Claude Code hooks let an agent react to its own lifecycle events — saving memories before context compaction, reloading task state on session start, showing a "thinking" indicator when a prompt arrives.

---

## How they work

Hooks are defined in the `hooks` block of `settings.json`. Each hook event maps to an array; each array entry contains an optional `matcher` and the actual hook commands.

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "optional-regex",
        "hooks": [
          {
            "type": "command",
            "command": "python3 /path/to/script.py",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

### Two hook types

| `type` | Description |
|--------|-------------|
| `command` | Runs a shell command. Exit 0 = success; stdout (for UserPromptSubmit) is injected into the agent's context |
| `agent` | Spawns a sub-agent with the given `prompt`. For tasks requiring LLM logic (e.g. saving memories, skill reflection) |

### The `matcher` field

- **PostToolUse / PreToolUse**: regex matched against the tool name (`"Read"`, `"Bash"`, `"telegram.*reply"`)
- **SessionStart**: regex matched against the session `source` field (`"compact|resume"`, `"startup"`)
- **PreCompact**: `"auto"` (always fires) or can be omitted
- Other events typically have no matcher — the hook fires every time

---

## Available hook events

### PreCompact

Fires when Claude Code is about to compact the context (at roughly 90% context-window utilisation).

**Type:** `agent` (requires LLM logic)
**Marveen default:** memory save + skill reflection + active task state save

```json
"PreCompact": [
  {
    "matcher": "auto",
    "hooks": [
      {
        "type": "agent",
        "prompt": "The context is about to be compacted. Save memories, inspect skill-generation opportunities, and save the active task state (if any).",
        "timeout": 180
      }
    ]
  }
]
```

**Related:** [Agent Task State](agent-taskstate.md), [Skill Factory](skill-factory.md)

---

### SessionStart

Fires when an agent session starts. The `matcher` filters by the `source` field.

| `source` value | When |
|----------------|------|
| `startup` | Completely fresh start (new chat) |
| `compact` | Continuation after automatic context compaction |
| `resume` | Continuation via `claude --continue` |

**Marveen default:** on `compact|resume`, re-injects the active task state.

```json
"SessionStart": [
  {
    "matcher": "compact|resume",
    "hooks": [
      {
        "type": "command",
        "command": "python3 /path/to/scripts/hooks/taskstate-replay.py",
        "timeout": 15
      }
    ]
  }
]
```

**Related:** [Agent Task State](agent-taskstate.md)

---

### UserPromptSubmit

Fires when the user (or a channel plugin) submits a prompt — BEFORE the agent starts responding.

**Important:** the hook's stdout is **injected into the agent's context**. If the hook does not intend to inject anything, it must stay completely silent (log to stderr, not stdout).

**Marveen default:** display a Telegram "✍️ Working on it..." indicator and add a ✍️ reaction to the message.

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "python3 ~/.claude/hooks/telegram_progress.py",
        "timeout": 15
      }
    ]
  }
]
```

**Related:** [Telegram Progress Indicator](telegram-progress-indicator.md)

---

### Stop

Fires when the agent finishes responding (end of turn).

**Marveen default:** two jobs in one:
1. Removes the "Working on it..." placeholder posted by UserPromptSubmit
2. If the agent received a Telegram message but sent no `reply` tool call, it enforces delivery

```json
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "python3 ~/.claude/hooks/telegram_progress_clear.py",
        "timeout": 15
      }
    ]
  }
]
```

---

### PostToolUse

Fires after every tool call. The `matcher` regex is matched against the tool name.

**Marveen examples:**

```json
"PostToolUse": [
  {
    "matcher": "telegram.*reply",
    "hooks": [
      {
        "type": "command",
        "command": "python3 ~/.claude/hooks/telegram_progress_reply_clear.py",
        "timeout": 15
      }
    ]
  }
]
```

Used for: clearing the "Working on it..." indicator after a Telegram reply; logging every tool call to the Activity Tool Log.

---

### PreToolUse

Fires before every tool call. The `matcher` regex is matched against the tool name.

**Marveen example:** automatic image resizing for images arriving via a Telegram channel, before a Read call.

```json
"PreToolUse": [
  {
    "matcher": "Read",
    "hooks": [
      {
        "type": "command",
        "command": "~/.claude/hooks/channel-image-resize.sh",
        "timeout": 15
      }
    ]
  }
]
```

---

## settings.json location

Hooks live in a `settings.json` file — but which one?

| Scope | File | Applies to |
|-------|------|------------|
| Global | `~/.claude/settings.json` | All Claude Code sessions |
| Agent-specific | `agents/<name>/.claude/settings.json` | Only that agent's sessions |
| Project-level | `<project>/.claude/settings.json` | Sessions running in that project directory |

In the Marveen fleet, the agent startup template (`templates/settings.json.template`) includes the default PreCompact and SessionStart hooks, which are automatically seeded into every new agent.

---

## Full default configuration (template)

This is the essential hook block from `templates/settings.json.template` — what every fleet agent receives on creation:

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "agent",
            "prompt": "Memory save + skill reflection + active task state save (if any).",
            "timeout": 180
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact|resume",
        "hooks": [
          {
            "type": "command",
            "command": "python3 {{PROJECT_ROOT}}/scripts/hooks/taskstate-replay.py",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

The `{{PROJECT_ROOT}}` placeholder is replaced with the actual installation path during agent scaffolding.

---

## Adding a custom hook

1. Write the hook script (bash or Python)
2. Add it to the appropriate `settings.json`
3. Test: start the agent and check the hook log (`~/.claude/hooks/*.log` if present)

**Timeout:** always specify a `timeout` — if a hook hangs, the session blocks. 10-30 seconds is generally enough for command hooks; 120-180 seconds for agent hooks (PreCompact).

---

## Related documents

- [Agent Task State](agent-taskstate.md) — PreCompact + SessionStart details
- [Activity Tool Log](activity-tool-log.md) — PostToolUse-based logging
- [Telegram Progress Indicator](telegram-progress-indicator.md) — UserPromptSubmit + Stop + PostToolUse cooperation
- [Skill Factory](skill-factory.md) — PreCompact skill reflection
