# Marveen — Feature Documentation

Marveen is a self-improving, proactive AI assistant system built on Claude Code. Not a chatbot — an agent fleet that notices what needs doing, remembers, learns, and works in the background.

Every page presents a feature from two angles:
- **🎯 What it does / why it matters** — plain-language overview, highlights, usage examples
- **🛠 How it works** — technical architecture, how to extend it

---

## Getting started

| Document | Description |
|----------|-------------|
| [Security model](security.md) | Prompt-safety layer, trust graph, unknown sender handling |
| [Onboarding — new assistant](onboarding-new-assistant.md) | Setting up a new fleet agent with a Telegram bot and Google access |

---

## Memory and learning

| Document | Description |
|----------|-------------|
| [Memory system](memory-system.md) | 3-tier (hot/warm/cold) FTS5 + daily salience decay + daily log |
| [Recall](recall.md) | Date-based log and memory retrieval with natural-language expressions |
| [Skill factory (self-learning)](skill-factory.md) | Reusable skills built from recurring workflows |

---

## Task management

| Document | Description |
|----------|-------------|
| [Heartbeat + progressive autonomy](heartbeat-autonomy.md) | Self-driven scheduled checks + per-category trust ladder (notify → suggest → autonomous) |
| [Kanban + auto-breakdown](kanban.md) | Task management with LLM-driven subtask decomposition |
| [Idea box](ideas.md) | Quick idea capture, AI breakdown, one-click kanban promotion |
| [Scheduled tasks](scheduled-tasks.md) | Cron-based, filesystem-driven automations |
| [Dream engine](dream-engine.md) | Nightly knowledge consolidation + morning priority suggestions |
| [Background tasks](background-tasks.md) | Detached long-running tasks with notification on completion |
| [Agent task state](agent-taskstate.md) | Amnesia prevention during context compaction |

---

## Agent fleet

| Document | Description |
|----------|-------------|
| [Agent fleet + inter-agent communication](agent-fleet.md) | Multiple specialised agents over a shared message queue, remote agents, model suggestion |
| [Permission profiles](permission-profiles.md) | Tool permissions and filesystem access templates per agent |
| [Hooks](hooks.md) | PreCompact, SessionStart, UserPromptSubmit, PostToolUse and more — settings.json configuration |

---

## Channels and communication

| Document | Description |
|----------|-------------|
| [Channels (Telegram / Slack)](channels.md) | Native messenger integration with proactive notifications and pairing flow |
| [Channel providers](channel-providers.md) | Telegram vs. Slack provider details |
| [Channel reply guard](channel-reply-guard.md) | Duplicate-send prevention, reply-guard mechanism |
| [Telegram progress indicator](telegram-progress-indicator.md) | "✍️ Working on it..." indicator and delivery enforcement |
| [Conversation continuity](conversation-continuity.md) | Long context and continuation handling |

---

## Integrations

| Document | Description |
|----------|-------------|
| [Connectors](connectors.md) | Business API gateway (NAV, Billingo, Wise, fal.ai) over MCP |
| [Printing-press CLIs](printing-press-cli.md) | Agent-native CLI generation — even for services with no public API |
| [Skool CLI](skool-cli.md) | Community platform management from the command line (no API) |
| [MCP configuration](mcp-config.md) | Adding and configuring MCP servers |

---

## Monitoring

| Document | Description |
|----------|-------------|
| [Vault & encryption](vault.md) | Encrypted secret store (AES-256-GCM) with OS keychain |
| [Token usage](token-usage.md) | Token consumption tracking per agent |
| [Activity log](activity-tool-log.md) | Real-time tool call log, workflow candidate detector |
| [Dashboard settings](dashboard-updates.md) | GitHub repo integration, update checker |

---

## Operations

| Document | Description |
|----------|-------------|
| [Backup](backup.md) | One-command data backup with WAL checkpoint and retention limit |
| [Migration](MIGRATION.md) | Full machine migration with Docker volumes, launchd, zero data loss |

---

## Reference

| Document | Description |
|----------|-------------|
| [Configuration reference](config-reference.md) | All configuration files in one place: store/, agents/, templates/, .env, .mcp.json |

---

*Documentation is a living document; corrections and additions are welcome.*
