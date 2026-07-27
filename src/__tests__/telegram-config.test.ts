import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_AGENT_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfg-test-'))
  const fakeAgentDir = path.join(fakeHome, 'agents', 'test-agent')

  for (const ch of ['telegram', 'discord', 'googlechat', 'teams', 'slack']) {
    fs.mkdirSync(path.join(fakeHome, '.claude', 'channels', ch), { recursive: true })
  }
  fs.writeFileSync(path.join(fakeHome, '.claude', 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=marveen-token\n')
  fs.writeFileSync(path.join(fakeHome, '.claude', 'channels', 'discord', '.env'), 'DISCORD_BOT_TOKEN=marveen-discord\n')
  fs.writeFileSync(path.join(fakeHome, '.claude', 'channels', 'googlechat', '.env'), 'GOOGLECHAT_PROJECT_ID=marveen-gc\n')
  fs.writeFileSync(path.join(fakeHome, '.claude', 'channels', 'teams', '.env'), 'TEAMS_BOT_APP_ID=marveen-teams\n')
  fs.writeFileSync(path.join(fakeHome, '.claude', 'channels', 'slack', '.env'), 'SLACK_BOT_TOKEN=xoxb-marveen\n')

  for (const ch of ['telegram', 'discord', 'googlechat', 'teams']) {
    fs.mkdirSync(path.join(fakeAgentDir, '.claude', 'channels', ch), { recursive: true })
  }
  fs.writeFileSync(path.join(fakeAgentDir, '.claude', 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=agent-tg-token\n')
  fs.writeFileSync(path.join(fakeAgentDir, '.claude', 'channels', 'discord', '.env'), 'DISCORD_BOT_TOKEN=agent-dc-token\n')
  fs.writeFileSync(path.join(fakeAgentDir, '.claude', 'channels', 'googlechat', '.env'), 'GOOGLECHAT_PROJECT_ID=agent-gc-proj\n')
  fs.writeFileSync(path.join(fakeAgentDir, '.claude', 'channels', 'teams', '.env'), 'TEAMS_BOT_APP_ID=agent-teams-app\n')

  fs.writeFileSync(path.join(fakeHome, '.env'), 'TELEGRAM_BOT_TOKEN=marveen-alert-token\n')

  return { FAKE_HOME: fakeHome, FAKE_AGENT_DIR: fakeAgentDir }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn().mockReturnValue(FAKE_HOME) }
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: FAKE_HOME,
  ALLOWED_CHAT_ID: '999888777',
}))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: vi.fn().mockImplementation((name: string) => nodePath.join(FAKE_HOME, 'agents', name)),
    readFileOr: vi.fn().mockImplementation((filePath: string, def: string) => {
      try { return nodeFs.readFileSync(filePath, 'utf-8') } catch { return def }
    }),
    findAvatarForAgent: vi.fn().mockReturnValue(null),
  }
})

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('../tool-timeouts.js', () => ({
  TOOL_TIMEOUTS: { telegram: 100 },
}))

import {
  readAgentTelegramConfig,
  readAgentDiscordConfig,
  readAgentGooglechatConfig,
  readAgentTeamsConfig,
  readMarveenTelegramConfig,
  readMarveenDiscordConfig,
  readMarveenGooglechatConfig,
  readMarveenTeamsConfig,
  readMarveenSlackConfig,
  parseTelegramToken,
  validateTelegramToken,
  sendTelegramMessage,
  sendMarveenAlert,
  refreshMarveenBotUsername,
  marveenBotUsernameCache,
} from '../web/telegram.js'

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
})

describe('readAgentTelegramConfig', () => {
  it('returns hasTelegram:true when env file has token', () => {
    const result = readAgentTelegramConfig('test-agent')
    expect(result.hasTelegram).toBe(true)
  })

  it('returns hasTelegram:false when env file does not exist', () => {
    const result = readAgentTelegramConfig('nonexistent-agent')
    expect(result.hasTelegram).toBe(false)
  })

  it('returns hasTelegram:false when env file has empty token', () => {
    const emptyDir = join(FAKE_HOME, 'agents', 'empty-token-agent', '.claude', 'channels', 'telegram')
    mkdirSync(emptyDir, { recursive: true })
    writeFileSync(join(emptyDir, '.env'), 'TELEGRAM_BOT_TOKEN=\n')
    const result = readAgentTelegramConfig('empty-token-agent')
    expect(result.hasTelegram).toBe(false)
  })
})

describe('readAgentDiscordConfig', () => {
  it('returns hasDiscord:true when env file has token', () => {
    expect(readAgentDiscordConfig('test-agent').hasDiscord).toBe(true)
  })

  it('returns hasDiscord:false when env file does not exist', () => {
    expect(readAgentDiscordConfig('no-discord-agent').hasDiscord).toBe(false)
  })

  it('returns hasDiscord:false when env file has empty token', () => {
    const dir = join(FAKE_HOME, 'agents', 'dc-empty', '.claude', 'channels', 'discord')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.env'), 'DISCORD_BOT_TOKEN=   \n')
    expect(readAgentDiscordConfig('dc-empty').hasDiscord).toBe(false)
  })
})

describe('readAgentGooglechatConfig', () => {
  it('returns hasGooglechat:true when env file has project id', () => {
    expect(readAgentGooglechatConfig('test-agent').hasGooglechat).toBe(true)
  })

  it('returns hasGooglechat:false when env file does not exist', () => {
    expect(readAgentGooglechatConfig('no-gc-agent').hasGooglechat).toBe(false)
  })
})

describe('readAgentTeamsConfig', () => {
  it('returns hasTeams:true when env file has app id', () => {
    expect(readAgentTeamsConfig('test-agent').hasTeams).toBe(true)
  })

  it('returns hasTeams:false when env file does not exist', () => {
    expect(readAgentTeamsConfig('no-teams-agent').hasTeams).toBe(false)
  })
})

describe('readMarveenTelegramConfig', () => {
  it('returns hasTelegram:true when home .env has token', () => {
    const result = readMarveenTelegramConfig()
    expect(result.hasTelegram).toBe(true)
  })
})

describe('readMarveenDiscordConfig', () => {
  it('returns hasDiscord:true', () => {
    expect(readMarveenDiscordConfig().hasDiscord).toBe(true)
  })
})

describe('readMarveenGooglechatConfig', () => {
  it('returns hasGooglechat:true', () => {
    expect(readMarveenGooglechatConfig().hasGooglechat).toBe(true)
  })
})

describe('readMarveenTeamsConfig', () => {
  it('returns hasTeams:true', () => {
    expect(readMarveenTeamsConfig().hasTeams).toBe(true)
  })
})

describe('readMarveenSlackConfig', () => {
  it('returns hasSlack:true', () => {
    expect(readMarveenSlackConfig().hasSlack).toBe(true)
  })
})

describe('parseTelegramToken', () => {
  it('returns token string for configured agent', () => {
    expect(parseTelegramToken('test-agent')).toBe('agent-tg-token')
  })

  it('returns null when no env file', () => {
    expect(parseTelegramToken('no-tg-agent')).toBeNull()
  })
})

describe('validateTelegramToken', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('returns ok:true with botUsername when API succeeds', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: { username: 'TestBot', id: 12345 } }),
    }) as any
    const result = await validateTelegramToken('fake-token')
    expect(result.ok).toBe(true)
    expect(result.botUsername).toBe('TestBot')
    expect(result.botId).toBe(12345)
  })

  it('returns ok:false when API returns ok:false', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false }),
    }) as any
    const result = await validateTelegramToken('bad-token')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid')
  })

  it('returns ok:false when fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as any
    const result = await validateTelegramToken('bad-token')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('connect')
  })
})

describe('sendTelegramMessage', () => {
  it('resolves without error when fetch returns ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true }) as any
    await expect(sendTelegramMessage('token', '123', 'hello')).resolves.toBeUndefined()
  })

  it('throws when fetch returns non-ok status', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request'),
    }) as any
    await expect(sendTelegramMessage('token', 'bad-chat', 'msg')).rejects.toThrow('400')
  })
})

describe('sendMarveenAlert', () => {
  it('reads token from PROJECT_ROOT/.env and sends message', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true }) as any
    global.fetch = mockFetch
    await sendMarveenAlert('test alert message')
    expect(mockFetch).toHaveBeenCalled()
  })
})

describe('refreshMarveenBotUsername', () => {
  it('fetches and caches bot username', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: { username: 'MarveenBot' } }),
    }) as any
    await refreshMarveenBotUsername()
    expect(marveenBotUsernameCache.value).toBe('@MarveenBot')
  })

  it('handles network error silently (does not throw)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as any
    await expect(refreshMarveenBotUsername()).resolves.toBeUndefined()
  })
})
