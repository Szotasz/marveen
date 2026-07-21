// Single source of truth for channel plugin IDs.
// Add a new provider here and every consumer (agent-process, heartbeat,
// heartbeat-agent-scaffold, agents route) picks it up automatically.
export const CHANNEL_PLUGIN_IDS = {
  telegram: 'telegram@claude-plugins-official',
  slack: 'slack-channel@marveen-marketplace',
  discord: 'discord@claude-plugins-official',
  googlechat: 'googlechat@claude-channel-googlechat',
  teams: 'teams@marveen-marketplace',
} as const

export type ChannelPluginId = (typeof CHANNEL_PLUGIN_IDS)[keyof typeof CHANNEL_PLUGIN_IDS]
