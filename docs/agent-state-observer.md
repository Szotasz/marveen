# agent-state-observer

An **observe-only** Claude Code mod that writes one agent's live state to a
JSON file. It is **off by default** and enabled per agent.

## What it does

On session, turn and tool events it writes `<install>/store/mod-state/<agent>.json`:

| Field | Meaning |
|---|---|
| `state` | `starting`, `idle`, `working`, `awaiting_approval` or `ended` |
| `since` / `updated_at` / `alive_at` | epoch ms; `alive_at` is refreshed every minute while the session lives |
| `history` | the last 200 state transitions (`ts`, `from`, `to`, `tool`, `reason`) |
| `usage` | the session's rate-limit readings (`rateLimits`: `kind`, `percentUsed`, `resetsAt`), context % and cost |
| `usage_history` | the last 200 changed usage readings |
| `first_usage_probe` | whether the first completed turn produced any rate-limit reading |

Notes on the readings:

- `rateLimits` come from the **session's own last API response**. An idle
  agent's values age while other agents use the same account.
- A `five_hour` entry disappears when its window resets and returns with the
  next API response: a missing `five_hour` means "no open window".

## What it never does

Every hook passes its event on and returns the engine's result unchanged: it
never denies, rewrites or delays a tool call or a turn, and it draws nothing.
A failed write is swallowed. **Nothing in the product reads the state file
yet**; alerting on it is a later, separately measured step.

## Turning it on and off

On, for one agent: add `"stateObserver": true` to `agents/<name>/agent-config.json`
and restart that agent. The launcher then exports, into that agent's launch
command only:

```
CLAUDE_CODE_PLUGIN_DIRS=<install>/plugins/agent-state-observer
MARVEEN_AGENT_ID=<name>
MARVEEN_STATE_OBSERVER_DIR=<install>/store/mod-state
```

The mod takes its name and output folder from these two variables and writes
nothing without them.

Off: remove the key (or set it to `false`) and restart the agent.

Pause without a restart:

- `touch <install>/store/mod-state/DISABLE` stops every agent's writes.
- `touch <install>/store/mod-state/DISABLE-<name>` stops one agent's writes.

Delete the file to resume.

## When it does not load

The launcher logs `agent-state-observer launch decision` with the reason, and
the agent starts exactly as before, with no error and no alert, when:

- Claude Code is older than **2.1.287** (mods), or its version cannot be measured;
- the agent is the main agent (it is started by the channels service, not by this launcher);
- the agent is remote, or runs as another OS user (the mod and state folders
  are local paths of the installing user).
