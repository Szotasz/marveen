# Channel Provider Architecture

> Marveen supports multiple channel types (Telegram, Slack). Each provider uses a different connection model, which determines which agent listens on which channel.

---

## Core Principle: One Main Agent, One Native Plugin

Channel communication goes through the Claude Code native channel plugin system. The main agent (marveen/Jarvis) runs a single `CHANNEL_PROVIDER` type -- defined by the `enabledPlugins` field in `~/.claude/settings.json`.

**Sub-agents do not run their own channel plugins.** They communicate via the inter-agent message queue, and notify through the main agent's channel.

---

## Provider Comparison

| Property | Telegram | Slack |
|----------|----------|-------|
| Connection model | HTTP long-polling | Socket Mode (WebSocket) |
| Token type | Bot token (`TELEGRAM_BOT_TOKEN`) | Bot + App token (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`) |
| Chat identification | `ALLOWED_CHAT_ID` (numeric) | `SLACK_CHANNEL_ID` |
| Security preamble | Same prompt-safety layer | Same |
| Multi-agent channel duplication risk | Low (polling, one process) | **High** (Socket Mode, see below) |

---

## Telegram Provider -- Polling Mode

The Telegram integration is based on HTTP long-polling: `telegram-client.ts` continuously calls the `getUpdates` API, processes incoming messages, and delivers them to the agent via the `channel-coordinator`.

### Flow

```
Telegram API
    ↓ getUpdates (long-poll)
channel-coordinator (separate process)
    ↓ store/claudeclaw.db incoming_events table
message-router (60s tick)
    ↓ tmux send-keys
Marveen/Jarvis session
```

### Liveness Monitoring

`channel-monitor.ts` watches whether the native plugin is active. The plugin refreshes `store/.channel-keepalive` every ~6 minutes -- if more than 18 minutes pass without a refresh while the process is alive, the monitor flags a wedged state and restarts.

### Backfill (channel-coordinator)

If the native plugin is temporarily unavailable (e.g. during dashboard restart), the `channel-coordinator` independently collects messages and backfills them to the main agent. Backfilled messages arrive in a `<channel>` tag -- the agent responds to them the same way as native arrivals.

---

## Slack Provider -- Socket Mode

The Slack integration uses WebSocket (Socket Mode). The connection is persistent and bidirectional -- not poll-based.

### Channel Duplication Hazard

**This is one of the most common misconfiguration bugs in fleet environments.**

The `enabledPlugins` field lives in the **user-level** `~/.claude/settings.json`. This means that if multiple agents run under the same user (as all Marveen sub-agents do), **each of them loads** the Slack Socket Mode plugin -- and each independently opens a WebSocket connection to the Slack workspace.

Consequence: inbound events are distributed across connections; messages "disappear" (different agents receive them, but only one agent replies).

### Fix: Scoped enabledPlugins

Enable the Slack plugin only in the main agent's `agents/<name>/.claude/settings.json`, and remove it from the user-level settings. This ensures only one process opens a Socket Mode connection.

```json
// agents/marveen/.claude/settings.json -- CORRECT
{
  "enabledPlugins": ["slack-channel"]
}

// ~/.claude/settings.json -- NOT the right place for Slack
// (if placed here, EVERY agent connects)
```

**This is less critical for Telegram** (polling: multiple processes can poll, the API deduplicates), but Slack Socket Mode requires exclusive ownership of the connection.

---

## enabledPlugins -- Where It Lives, What It Contains

```json
// ~/.claude/settings.json (user-level, affects all agents)
{
  "enabledPlugins": ["telegram"]
}

// agents/<name>/.claude/settings.json (agent-level, this agent only)
{
  "enabledPlugins": ["slack-channel"]
}
```

The plugin name matches the folder name under `~/.claude/plugins/` (e.g. `telegram`, `slack-channel`, `discord`).

---

## Which Agent Responds on Which Channel?

In the fleet's base configuration:
- **Marveen/Jarvis** (main agent): receives Telegram/Slack messages and replies via the channel plugin
- **Sub-agents** (Rick, Dave, Zoe, Peter, Zack): each has their own Telegram bot token and their own channel plugin -- each agent has a separate bot on a separate channel

Sub-agent channel configuration: `agents/<name>/agent-config.json` + the appropriate bot token in the launchd plist or `.env`.

---

## Diagnostics

### Channel not responding

```bash
# Check keepalive file freshness
ls -la ~/Documents/marveen/store/.channel-keepalive

# Dashboard channel-monitor status
curl -s -H "Authorization: Bearer $(cat ~/Documents/marveen/store/.dashboard-token)" \
  http://localhost:3420/api/status
```

### Slack: half of messages disappear

Check how many processes have Socket Mode connections:

```bash
ps aux | grep "slack\|claude" | grep -v grep
```

If multiple `claude` processes are running with the Slack plugin enabled: remove `enabledPlugins` from the user-level `~/.claude/settings.json` and place it only in the main agent's settings.

---

## Related Documents

- [Channels (Telegram/Slack) -- usage](channels.md)
- [Security Model](security.md)
- [Agent Fleet](agent-fleet.md)
