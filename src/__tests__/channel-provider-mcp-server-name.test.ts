import { describe, it, expect } from 'vitest'
import { getProvider, type ChannelProviderType } from '../channel-provider.js'
import { isSafeMcpServerName } from '../web/mcp-inline-command.js'

const TYPES: ChannelProviderType[] = ['telegram', 'slack', 'discord', 'googlechat', 'teams']

describe('provider mcpServerName', () => {
  it('slack and teams register their own server names', () => {
    expect(getProvider('slack').mcpServerName).toBe('plugin:slack-channel:slack')
    expect(getProvider('teams').mcpServerName).toBe('plugin:teams:teams')
  })

  it('telegram, discord and googlechat have none', () => {
    for (const t of ['telegram', 'discord', 'googlechat'] as const) {
      expect(getProvider(t).mcpServerName).toBeUndefined()
    }
  })

  it.each(TYPES)('%s: the typed name is safe', (t) => {
    const p = getProvider(t)
    expect(isSafeMcpServerName(p.mcpServerName ?? p.pluginPaneId)).toBe(true)
  })
})
