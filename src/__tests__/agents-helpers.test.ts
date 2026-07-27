import { describe, it, expect, vi } from 'vitest'

// Most imports in agents-helpers.ts are unused in the pure-function tests below.
// We mock the ones that would trigger DB/process/shell side-effects at import time.
vi.mock('../../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channel-provider.js')>()
  return {
    ...actual,
    channelStateDir: vi.fn().mockReturnValue('/tmp/channel-state'),
    readChannelToken: vi.fn().mockReturnValue(null),
  }
})
vi.mock('../vault.js', () => ({
  getSecret: vi.fn().mockResolvedValue(null),
}))
vi.mock('../telegram.js', () => ({
  readAgentTelegramConfig: vi.fn().mockReturnValue(null),
  readAgentDiscordConfig: vi.fn().mockReturnValue(null),
  readAgentGooglechatConfig: vi.fn().mockReturnValue(null),
  readAgentTeamsConfig: vi.fn().mockReturnValue(null),
}))
vi.mock('../agent-process.js', () => ({
  agentRunState: vi.fn().mockReturnValue('stopped'),
  getAgentRunningSince: vi.fn().mockReturnValue(null),
  agentSessionName: vi.fn().mockImplementation((n: string) => `agent-${n}`),
  capturePane: vi.fn().mockReturnValue(null),
}))
vi.mock('../reauth-detect.js', () => ({
  detectReauthNeeded: vi.fn().mockReturnValue({ needed: false }),
}))
vi.mock('../auto-restart-store.js', () => ({
  readAutoRestartConfig: vi.fn().mockReturnValue({ enabled: false, maxRestarts: 5 }),
}))
vi.mock('../active-model.js', () => ({
  readActiveModelFromProjectDir: vi.fn().mockReturnValue(null),
  readContextTokensFromProjectDir: vi.fn().mockReturnValue(null),
}))
vi.mock('../claude-plans.js', () => ({
  resolveAgentConfigDir: vi.fn().mockReturnValue(null),
}))
vi.mock('../agent-team.js', () => ({
  readAgentTeam: vi.fn().mockReturnValue({ members: [] }),
}))

import {
  validateDiscordChannelId,
  parseChannelProvider,
  matchChannelRoute,
  extractBotId,
  findBotTokenDuplicate,
  VALID_PROVIDERS,
} from '../web/routes/agents-helpers.js'

describe('validateDiscordChannelId', () => {
  it('accepts a valid 17-digit snowflake', () => {
    expect(validateDiscordChannelId('12345678901234567')).toEqual({ ok: true })
  })

  it('accepts a valid 20-digit snowflake', () => {
    expect(validateDiscordChannelId('12345678901234567890')).toEqual({ ok: true })
  })

  it('rejects undefined', () => {
    expect(validateDiscordChannelId(undefined)).toEqual({ ok: false, error: expect.stringContaining('snowflake') })
  })

  it('rejects empty string', () => {
    expect(validateDiscordChannelId('')).toEqual({ ok: false, error: expect.any(String) })
  })

  it('rejects non-numeric string', () => {
    expect(validateDiscordChannelId('abc12345678901234')).toEqual({ ok: false, error: expect.any(String) })
  })

  it('rejects too-short numeric string (16 digits)', () => {
    expect(validateDiscordChannelId('1234567890123456')).toEqual({ ok: false, error: expect.any(String) })
  })

  it('rejects too-long numeric string (21 digits)', () => {
    expect(validateDiscordChannelId('123456789012345678901')).toEqual({ ok: false, error: expect.any(String) })
  })
})

describe('parseChannelProvider', () => {
  it('returns telegram for "telegram"', () => {
    expect(parseChannelProvider('telegram')).toBe('telegram')
  })

  it('returns slack for "slack"', () => {
    expect(parseChannelProvider('slack')).toBe('slack')
  })

  it('returns discord for "discord"', () => {
    expect(parseChannelProvider('discord')).toBe('discord')
  })

  it('returns null for unknown provider', () => {
    expect(parseChannelProvider('whatsapp')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseChannelProvider('')).toBeNull()
  })
})

describe('matchChannelRoute', () => {
  it('matches a telegram channel path with no suffix', () => {
    const result = matchChannelRoute('/api/agents/myagent/channels/telegram', '')
    expect(result).toEqual(['myagent', 'telegram'])
  })

  it('matches a slack channel path with a suffix', () => {
    const result = matchChannelRoute('/api/agents/myagent/channels/slack/manifest', '/manifest')
    expect(result).toEqual(['myagent', 'slack'])
  })

  it('URL-decodes the agent name', () => {
    const result = matchChannelRoute('/api/agents/my%20agent/channels/telegram', '')
    expect(result).toEqual(['my agent', 'telegram'])
  })

  it('returns null for unmatched path', () => {
    expect(matchChannelRoute('/api/agents/myagent/other', '')).toBeNull()
  })

  it('returns null when provider is invalid', () => {
    expect(matchChannelRoute('/api/agents/myagent/channels/unknownprovider', '')).toBeNull()
  })
})

describe('extractBotId', () => {
  it('extracts numeric id from a telegram token', () => {
    expect(extractBotId('123456789:ABC-token')).toBe('123456789')
  })

  it('returns null when no colon present', () => {
    expect(extractBotId('notavalidtoken')).toBeNull()
  })

  it('returns null when id part is not numeric', () => {
    expect(extractBotId('abc:rest')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(extractBotId('')).toBeNull()
  })

  it('returns null when colon is at position 0', () => {
    expect(extractBotId(':noprefix')).toBeNull()
  })
})

describe('VALID_PROVIDERS', () => {
  it('contains all expected providers', () => {
    expect(VALID_PROVIDERS.has('telegram')).toBe(true)
    expect(VALID_PROVIDERS.has('slack')).toBe(true)
    expect(VALID_PROVIDERS.has('discord')).toBe(true)
    expect(VALID_PROVIDERS.has('googlechat')).toBe(true)
    expect(VALID_PROVIDERS.has('teams')).toBe(true)
  })
})

describe('findBotTokenDuplicate', () => {
  it('returns null when token has no colon (not a valid bot token)', () => {
    expect(findBotTokenDuplicate('telegram', 'invalid', 'myagent')).toBeNull()
  })

  it('returns null when no existing agents share the same bot id', () => {
    // readChannelToken is mocked to return null → no duplicates
    expect(findBotTokenDuplicate('telegram', '123:abc', 'myagent')).toBeNull()
  })
})
