# Agent Fleet + Inter-agent Communication

> Not one assistant, but a team. Specialised agents that message each other directly and carry projects through together.

---

## 🎯 What it does / why it matters

Marveen acts as an **orchestrator** (PM role), coordinating a fleet of specialised agents — each with its own role (e.g. backend development, marketing/frontend, video, research). For a large task the orchestrator breaks down the work, assigns it to the right agent, and integrates the results.

Agents **message each other directly** over a shared message queue — not everything passes through you. The orchestrator delegates, the specialist agent works and reports back, you receive only what matters.

**Highlight:** the fleet autonomously carries complex multi-step projects for hours — e.g. one agent is done with the PR, the marketing agent writes the announcement from the same session, both notify via Telegram. You get the milestones, not the internal chatter.

---

## 🛠 How it works

### Structure

- Every agent is a Claude Code instance running in a separate **tmux session**, with its own working directory and `CLAUDE.md` (role-specific instructions).
- The orchestrator (main agent) also runs the dashboard + channel integration; sub-agents work on their tasks.

### Inter-agent messages

Shared SQLite message queue + API:

```
POST /api/messages   { "from": "<agent>", "to": "<agent>", "content": "..." }
GET  /api/messages?agent=<agent>      # status
```

The system delivers the message into the target agent's tmux session (`[Message @<sender>]: ...` format), where it is processed and the agent replies via its own channel. Only a running agent (with a tmux session) can receive messages. For remote agents this means the ssh connection and the laptop's tmux server must be reachable in the delivery-loop cycle; if not, the message stays in the queue and is delivered on reconnect (see [Remote agents](#-remote-remote-agents)).

### Lifecycle

```
POST /api/agents/<name>/start   # start agent (tmux + claude --continue)
POST /api/agents/<name>/stop
GET  /api/agents/<name>/status
GET  /api/agents                # fleet list
```

Startup handles automatic dismissal of the Claude Code "resume summary" modal so a fresh session doesn't get stuck.

The full lifecycle (start/stop/status/list) and inter-agent messaging **also work for remote agents**, over ssh (see below) — local agent behaviour is unchanged.

---

## 🌐 Remote agents

Marveen runs on an always-on orchestrator machine. An agent can be configured so its **tmux session runs on a remote machine** (e.g. a developer laptop) in a specified working directory there, while Marveen starts, stops, queries, and messages it from the orchestrator — all over ssh.

### ⭐ Core principle: the agent's life is independent of the ssh connection

The remote agent runs in a **detached tmux session** on the remote machine's own tmux server (`tmux new-session -d`), so the `claude` process is a child of tmux, NOT of ssh. Consequences:

- An ssh disconnect NEVER stops the remote agent. It keeps running and working; only Marveen's messaging/observing capability pauses, resuming on reconnect.
- Queued inter-agent messages and scheduled tasks wait out the disconnect and are delivered on reconnect (the router drops a message after 1 hour if still unreachable).
- The dashboard shows `unreachable` state (not `stopped`), and auto-restart does NOT restart an unreachable agent.
- Stop ONLY happens on explicit `POST /stop`.

### Configuration

```
PUT /api/agents/<name>/remote   { "host": "devbox", "workdir": "/home/user/project" }
PUT /api/agents/<name>/remote   { "host": "", "workdir": "" }   # delete -> back to local
```

- `host`: ssh destination — alias from `~/.ssh/config` (recommended) or `user@host`. **NO `:port`** in the host string; put the port in the `~/.ssh/config` `Port` directive. Shell metacharacters not allowed.
- `workdir`: **absolute** path on the remote machine (relative/tilde not allowed, to keep `--continue` project encoding deterministic).
- Only if BOTH are valid will the agent be remote; a half-configured agent stays local. The main agent (`marveen`) is always local.
- `GET /api/agents` response includes `remoteHost`, `remoteWorkdir`, and `runState` (`running` | `stopped` | `unreachable`).

### ssh-config prerequisite (orchestrator side)

The code passes every ControlMaster/keepalive/ConnectTimeout/BatchMode option as `-o` flags, so a minimal stanza is sufficient:

```
Host devbox
  HostName <remote-ip-or-host>
  User <username>
  # Port 22   # if non-default
```

Also needed: passwordless ssh key from the orchestrator to the remote machine (because `BatchMode=yes` never blocks on a prompt). The code uses `ControlMaster` multiplexing with a private socket directory (`$XDG_RUNTIME_DIR/marveen-ssh`, mode 0700) so the 5s delivery-loop and watchers reuse one connection.

### Startup / auth prerequisite on the remote machine

- `tmux` and `claude` must be on PATH on the remote machine, and `claude` must be logged in.
- **Verify in a non-interactive ssh context** (macOS Keychain may not be available to an ssh-spawned process):

  ```
  ssh devbox 'which claude && claude --version'
  ```

  This must succeed. If the OAuth credential is not available non-interactively, switch the remote `claude` to API-key login. `start` already rejects startup if `which claude` fails.

### Operating model: launch-only, channel-less

The remote agent uses the remote machine's own `~/.claude` login and the remote working directory's `CLAUDE.md`. It does not transfer channel tokens/vault secrets/settings.json — inter-agent only (Marveen delegates, the agent reports back via inter-agent message).

### Scaffolding sync

The `agents/<name>/` directory is **gitignored**, so the remote agent's behaviour is governed by the remote working directory's `CLAUDE.md` + the remote machine's `~/.claude` login — the orchestrator-side persona files (CLAUDE.md/SOUL.md/skills) do not sync automatically to the remote machine.

If you want the remote agent to carry the fleet persona, put those files in the remote working directory (via its own git/sync channel), or add `agents/<name>/` to a synced path. This is an operational (infra) decision, not a repo change.

### Delegation principle

For clear role-scoped tasks the orchestrator delegates automatically (without asking at every step). Tasks run on kanban cards (see [kanban](kanban.md)), with `assignee` as the responsible agent. Asset-producing agents (e.g. video) deliver the final result directly to the user's channel.

---

## 🔍 Persona-model fit analysis

> Every agent's assigned model is **analysable and optimisable** based on actual workload signals.

### What it is

The **"Model suggestion"** button on the Agents screen evaluates whether the Claude model assigned to each agent matches their persona role and measured workload indicators. The analysis produces:

- A confirmation ("current model is appropriate"), or
- A model-change suggestion with justification (e.g. "this agent does simple short tasks — Haiku is sufficient and cheaper")

If any agent has a suggested change, the system asks: should a kanban card be created for the change?

### When to run it

- When creating a new agent (the default model is general, not persona-specific)
- After expanding or reorganising the fleet
- When token consumption (see [Token Usage](token-usage.md)) is surprisingly high for an agent

### Measured signals (AgentSignals)

The analysis uses five TIER-1 signals — collected from the agent's actual activity:

| Field | Description |
|-------|-------------|
| `tokenAvgInputPerCall` | Average input tokens per call |
| `kanbanOpenCount` | Number of open kanban cards |
| `kanbanUrgentCount` | Number of urgent-priority cards |
| `scheduledFreqPerDay` | Scheduled task daily frequency |
| `mcpServerCount` | Number of connected MCP servers |

### Thresholds and their effect

| Condition | Effect |
|-----------|--------|
| `tokenAvgInputPerCall > 10,000` | +1 point toward Opus (high context demand) |
| `mcpServerCount >= 4` | +1 point toward Opus (deep integration) |
| `kanbanUrgentCount >= 2` | +1 point toward Opus (high load, business-critical) |
| `scheduledFreqPerDay >= 10` | +1 point toward Haiku (repetitive, simple tasks) |

### Suggestion text structure

Each agent's generated text has six sections:

1. **Current model** — the currently assigned model name
2. **Observed usage** — token consumption, kanban load, scheduling frequency, integration depth
3. **Signal assessment** — ✅ / ⚠️ / ❌ markers for each signal
4. **Recommendation** — suggested model + the two most dominant factors highlighted
5. **Estimated cost impact** — expected monthly delta based on token pricing
6. **Uncertainty** — data gaps or low sample size flagged

### API

```
POST /api/agents/model-suggest     # runs analysis for all agents
```

Response: per agent `{ agent, currentModel, suggestedModel, reason, changeAdvised }`.

### Kanban integration

If `changeAdvised: true` for any agent and the user confirms, the system automatically creates a kanban card for the affected agent (`assignee: marveen`, status: `planned`).
