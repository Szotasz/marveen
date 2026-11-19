---
name: channel-plugin-duplicate-socket
description: When a new channel plugin (slack-channel, telegram, etc.) is installed in the Marveen fleet, the user-level ~/.claude/settings.json enabledPlugins loads the plugin server for every agent, and if it opens a Socket Mode connection (Slack), SEVERAL agents open a connection on the same workspace at once. Use it when an agent uses a Socket Mode channel plugin and inbound events "half disappear".
---
# Channel plugin duplicate Socket Mode connection

## When to use
- A new channel plugin (slack-channel, or anything with Socket Mode) is installed in the fleet
- An agent (e.g. the Slack agent) uses Slack, and the operator reports sending DMs but "nothing happens"
- Slack auth.test OK, manifest OK, tokens OK, bot scopes fine, but events do not arrive at server.ts
- Several claude processes are running with the `--channels` flag in the fleet at the same time

## Procedure
1. `ps aux | grep server.ts | grep -v grep` -- count how many slack-channel server.ts processes are running
2. If >1 instance: `ps -o pid,ppid,command -p <pid>` for every parent process. At the end of the ppid chain there should be `claude --continue ... --channels plugin:...`. If the `--channels` flag is NOT the same as the plugin, the plugin was loaded secondarily from `enabledPlugins`.
3. Check the user-level enablement: `grep -A5 enabledPlugins ~/.claude/settings.json`. If the problematic plugin is `true` here, every agent loads it.
4. Override it at project level: `<projekt>/.claude/settings.json` -> `{"enabledPlugins": {"<plugin>@<marketplace>": false}}`. Project > user precedence.
5. In the given agent's own project-level settings.json LEAVE it `true`; there it stays explicitly enabled.
6. Kill the superfluous channel processes (kill <pid>), or restart the tmux session it runs in.
7. Verify: `ps aux | grep server.ts | grep -v grep` -- the plugin should run only in the agent-level session.

## Pitfalls
- The Socket Mode bug is SILENT: Slack load-balances two active Socket Mode connections in a round-robin-like way, so HALF of the events go to the "non-listening" server.ts and are dropped there. NO warning, NO error -- just "messages disappear".
- The user-level `~/.claude/settings.json.allowedChannelPlugins` and `enabledPlugins` are *DIFFERENT* things. `allowedChannelPlugins` only whitelists the `--channels plugin:X` flag, but `enabledPlugins.X: true` is what loads the MCP in every agent.
- BECAUSE OF the fleet architecture (every agent is a claude-code instance) this is not a single-host problem -- every agent opens a Socket independently, and the Slack side cannot tell them apart on one workspace.
- With Telegram it does NOT show up as "events disappearing" but as a **lockfight**: the Telegram Bot API is long-poll based, and Telegram locks the session (409 Conflict) if two instances poll -- the two agents keep kicking each other out. Symptom: when the agent-X tmux session restarts, the agent-Y telegram MCP reports "disconnected", and vice versa. **Solution**: in the project-level `.claude/settings.json` of every agent that does NOT communicate on telegram, set `enabledPlugins.telegram@claude-plugins-official: false`. A global `unset TELEGRAM_BOT_TOKEN` in the agent-process.ts launcher script is NOT enough, because the telegram plugin also reads from the state-dir `.env` (the SLACK_STATE_DIR env is set, but TELEGRAM_STATE_DIR is not -- so the telegram plugin falls back to the global `~/.claude/channels/telegram/.env`, which contains the orchestrator agent's token).
- **Channel policy is separate from DM policy**: at the slack-channel plugin's gate, the DM policy (`access.dmPolicy` + `allowFrom`) and the channel policy (`access.channels[channelId]`) are COMPLETELY separate. An empty `channels: {}` drops every channel message (even an @-mention). Per-channel opt-in: `channels[C...]: {allowFrom: [U...], requireMention: true}`. Source of a UX bug: after setup the user @-tags the bot in a channel and it stays silent, half an hour of debugging. User-friendly solution: the dashboard polls the journal written to the SLACK_AUDIT_LOG env, a pending_channel_requests table from the gate.inbound.drop entries, and an Approve/Reject button on the dashboard.
- **MANAGED allowlist trap (Claude Code 2.1.143)**: `allowedChannelPlugins` is a MANAGED setting (system-level admin policy). On macOS it is `/Library/Application Support/ClaudeCode/managed-settings.json`. Neither the user-level `~/.claude/settings.json` nor the project-level `.claude/settings.json` is enough -- the tmux pane shows the warning "plugin:X · not on the approved channels allowlist". The MCP plugin tools are still connected (8 tools), BUT Claude Code disables the `notifications/claude/channel` inbound notification path into the chat. server.ts receives the events (it writes into sessions/, a smoke test confirms it), yet Claude Code swallows them -- the pane stays idle, and no `<channel source="slack" ...>` tag appears. Solution: sudo is needed for `mkdir -p "/Library/Application Support/ClaudeCode"` + creating managed-settings.json with allowedChannelPlugins.

## Verification
- 1 slack-channel server.ts process is running (`pgrep -af 'slack-channel.*server.ts' | wc -l` == 1)
- Its parent process belongs to the AGENT (`ps -o command -p <ppid>` contains the agent's name or the `--channels plugin:slack-channel` flag)
- The operator's DM appears on the Slack agent's tmux pane in a `<channel source="slack" ...>` tag
